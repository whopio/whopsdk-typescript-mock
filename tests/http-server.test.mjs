import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, afterEach, test } from "node:test";
import { WhopClient } from "@whop/sdk";
import { unwrapWebhook } from "@whop/sdk/helpers";
import {
  createHttpTestServer,
  LOCAL_TEST_CREDENTIALS as credentials,
} from "../dist/http-server.js";
import { API_VERSION_DATE } from "../dist/index.js";

let server, receiver, base, client;
let received, receiverStatus;
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    );
  });
const close = (server) =>
  server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();

beforeEach(async () => {
  received = [];
  receiverStatus = 200;
  receiver = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      try {
        const event = unwrapWebhook(body, {
          headers: request.headers,
          key: credentials.webhookSecret,
        });
        received.push(event);
        response.writeHead(receiverStatus).end();
      } catch {
        response.writeHead(400).end();
      }
    })();
  });
  const receiverUrl = await listen(receiver);
  server = createHttpTestServer({
    ...credentials,
    webhookUrl: receiverUrl,
    uploadProcessingDelayMs: 60,
    webhookRetryScale: 0.002,
  });
  base = await listen(server);
  client = new WhopClient({
    token: credentials.apiToken,
    baseUrl: `${base}/api/v1`,
    apiVersionDate: API_VERSION_DATE,
    maxRetries: 0,
  });
});

test("merchant credentials isolate records and gate customer email over HTTP", async () => {
  const sdk = (token) =>
    new WhopClient({
      token,
      baseUrl: `${base}/api/v1`,
      apiVersionDate: API_VERSION_DATE,
      maxRetries: 0,
    });
  const other = sdk(credentials.otherAccountToken);
  const limited = sdk(credentials.noEmailToken);
  assert.equal(
    (await other.disputes.retrieve({ id: "dspt_mock_other" })).account_id,
    "biz_mock_other",
  );
  await assert.rejects(
    client.disputes.retrieve({ id: "dspt_mock_other" }),
    (error) => error.statusCode === 403,
  );
  assert.equal(
    (await limited.disputes.retrieve({ id: "dspt_mock_open" })).buyer.email,
    null,
  );
  assert.equal(
    (await limited.payments.retrieve({ id: "pay_mock_primary" }))
      .customer_email,
    null,
  );
  assert.equal(
    (await client.payments.retrieve({ id: "pay_mock_primary" }))
      .customer_email,
    "buyer@example.test",
  );
});

test("fresh HTTP scenarios create linked context and notify the client via a signed webhook", async () => {
  const created = await control("scenarios", {
    amount: 80,
    refund_amount: 15,
    deliver: true,
  });
  assert.ok(created.dispute_id.startsWith("dspt_"));
  assert.equal(created.delivery.delivered, true);
  const dispute = await client.disputes.retrieve({ id: created.dispute_id });
  assert.equal(dispute.payment.id, created.payment_id);
  const payment = await client.payments.retrieve({ id: created.payment_id });
  assert.equal(payment.total.amount, "80.00");
  assert.equal(payment.refunded_amount.amount, "15.00");
  assert.equal(
    (await client.refunds.list({ payment_id: payment.id })).data[0].id,
    created.refund_id,
  );
  assert.equal(received.at(-1).data.id, dispute.id);
});

test("HTTP idempotency replays exactly after file URL rewriting", async () => {
  const request = {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.apiToken}`,
      "api-version-date": API_VERSION_DATE,
      "idempotency-key": "create-file-once",
      "content-type": "application/json",
    },
    body: JSON.stringify({ filename: "once.pdf" }),
  };
  const first = await fetch(`${base}/api/v1/files`, request);
  const original = await first.text();
  const again = await fetch(`${base}/api/v1/files`, request);
  assert.equal(again.status, 201);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(await again.text(), original);
  assert.equal(
    (
      await fetch(`${base}/api/v1/files`, {
        ...request,
        body: JSON.stringify({ filename: "different.pdf" }),
      })
    ).status,
    400,
  );
});

test("HTTP public downloads are unsigned and become private when attached as evidence", async () => {
  const file = await client.files.create({
    filename: "public.pdf",
    visibility: "public",
  });
  await fetch(file.upload_url, {
    method: "PUT",
    headers: file.upload_headers,
    body: Buffer.from("%PDF-1.4\nfixture"),
  });
  const uploaded = await ready(file.id);
  assert.equal(new URL(uploaded.url).search, "");
  assert.equal((await fetch(uploaded.url)).status, 200);
  await client.disputes.update({
    id: "dspt_mock_open",
    evidence: {
      documents: [{ id: file.id, document_type: "digital_fulfillment" }],
    },
  });
  assert.equal((await fetch(uploaded.url)).status, 403);
  const privateFile = await client.files.retrieve({ id: file.id });
  assert.ok(new URL(privateFile.url).searchParams.has("signature"));
  assert.equal((await fetch(privateFile.url)).status, 200);
});

test("failed webhook delivery retries with the same ID and current resource state", async () => {
  receiverStatus = 500;
  const opened = await control("events", {
    type: "dispute.created",
    resource_id: "dspt_mock_open",
    deliver: true,
  });
  assert.equal(opened.result.delivered, false);
  assert.ok(opened.result.retry_in_ms > 0);
  await control("disputes/dspt_mock_open", { status: "won" }, "PATCH");
  receiverStatus = 200;
  const deadline = Date.now() + 2000;
  while (received.length < 2 && Date.now() < deadline) await delay(10);
  assert.equal(received[1].id, received[0].id);
  assert.equal(received[1].data.status, "won");
  const status = await control("status", undefined, "GET");
  assert.equal(status.deliveries.at(-1).delivered, true);
  assert.equal(status.deliveries.at(-1).attempt, 2);
});

test("accepted submissions and terminal changes deliver delayed signed dispute updates", async () => {
  const receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
  await close(server);
  server = createHttpTestServer({
    ...credentials,
    webhookUrl: receiverUrl,
    disputeWebhookDelayMs: 25,
  });
  base = await listen(server);
  client = new WhopClient({
    token: credentials.apiToken,
    baseUrl: `${base}/api/v1`,
    apiVersionDate: API_VERSION_DATE,
    maxRetries: 0,
  });
  await client.disputes.submit({ id: "dspt_mock_open" });
  await control("submissions/dspt_mock_open", { outcome: "accepted" });
  const waitFor = async (count) => {
    const deadline = Date.now() + 2000;
    while (received.length < count && Date.now() < deadline) await delay(10);
    assert.equal(received.length, count);
  };
  await waitFor(1);
  assert.equal(received[0].type, "dispute.updated");
  assert.equal(received[0].data.status, "under_review");
  assert.ok(received[0].data.evidence_submitted_at);
  await control("disputes/dspt_mock_open", { status: "won" }, "PATCH");
  await waitFor(2);
  assert.equal(received[1].data.status, "won");
  assert.notEqual(received[0].id, received[1].id);
});

test("HTTP one-shot failures reach the real SDK and then clear", async () => {
  await control("failures", { action: "retrieve_dispute", status: 429 });
  await assert.rejects(
    client.disputes.retrieve({ id: "dspt_mock_open" }),
    (error) => error.statusCode === 429,
  );
  assert.equal(
    (await client.disputes.retrieve({ id: "dspt_mock_open" })).id,
    "dspt_mock_open",
  );
});

test("multipart HTTP uploads return ETags and go through processing on completion", async () => {
  const file = await client.files.create({
    filename: "parts.pdf",
    multipart: true,
    byte_size: 5 * 1024 * 1024 + 3,
  });
  const parts = [];
  const chunks = [Buffer.alloc(5 * 1024 * 1024, 65), Buffer.from("end")];
  for (const item of file.multipart_upload_urls) {
    assert.ok(item.url.startsWith(base));
    const response = await fetch(item.url, {
      method: "PUT",
      body: chunks[item.part_number - 1],
    });
    assert.equal(response.status, 200);
    parts.push({
      part_number: item.part_number,
      etag: response.headers.get("etag"),
    });
  }
  const done = await client.files.complete({
    id: file.id,
    multipart_upload_id: file.multipart_upload_id,
    multipart_parts: parts,
  });
  assert.equal(done.upload_status, "processing");
  const complete = await ready(file.id);
  assert.deepEqual(
    Buffer.from(await (await fetch(complete.url)).arrayBuffer()),
    Buffer.concat(chunks),
  );
});
afterEach(async () => {
  await close(server);
  await close(receiver);
  server = receiver = null;
});

async function control(path, body, method = "POST") {
  const response = await fetch(`${base}/_test/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credentials.adminToken}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.ok(response.ok, JSON.stringify(data));
  return data;
}

async function ready(id) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const file = await client.files.retrieve({ id });
    if (file.upload_status === "ready") return file;
    assert.equal(file.upload_status, "processing");
    assert.equal(file.url, null);
    assert.equal(file.size, null);
    await delay(15);
  }
  assert.fail("Mock upload did not become ready");
}

test("real HTTP SDK requests read fixtures and enforce separate API/admin/read-only credentials", async () => {
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.backend_parity, "unverified");
  const d = await client.disputes.retrieve({ id: "dspt_mock_open" });
  const p = await client.payments.retrieve({ id: d.payment.id });
  const refunds = await client.refunds.list({ payment_id: p.id });
  assert.equal(d.account_id, "biz_mock_primary");
  assert.equal(p.total.amount, "99.99");
  assert.equal(refunds.data[0].amount.amount, "20.00");
  const ids = [];
  for await (const row of await client.disputes.list({
    account_id: d.account_id,
    first: 2,
  }))
    ids.push(row.id);
  assert.equal(ids.length, 6);
  assert.ok(!ids.includes("dspt_mock_other"));
  assert.equal((await fetch(`${base}/api/v1/disputes`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/_test/status`, {
        headers: { authorization: `Bearer ${credentials.apiToken}` },
      })
    ).status,
    401,
  );
  const ro = new WhopClient({
    token: credentials.readOnlyToken,
    baseUrl: `${base}/api/v1`,
    apiVersionDate: API_VERSION_DATE,
    maxRetries: 0,
  });
  assert.equal((await ro.disputes.retrieve({ id: d.id })).id, d.id);
  await assert.rejects(
    ro.disputes.update({ id: d.id, evidence: { notes: "no permission" } }),
    (error) => error.statusCode === 403,
  );
  const noVersion = await fetch(`${base}/api/v1/disputes`, {
    headers: { authorization: `Bearer ${credentials.apiToken}` },
  });
  assert.equal(noVersion.status, 200);
  assert.equal(noVersion.headers.get("x-whop-mock-api-version"), API_VERSION_DATE);
});

test("HTTP uploads process, download exact bytes, and reject tampered capability URLs", async () => {
  const pending = await client.files.create({
    filename: "mock.pdf",
    visibility: "private",
  });
  assert.ok(pending.upload_url.startsWith(`${base}/_uploads/`));
  const bytes = Buffer.from("%PDF-1.4\nSynthetic PDF transport fixture\n%%EOF");
  assert.equal(
    (
      await fetch(pending.upload_url, {
        method: "PUT",
        body: bytes,
        headers: { "content-type": "text/plain" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(pending.upload_url, {
        method: "PUT",
        body: bytes,
        headers: pending.upload_headers,
      })
    ).status,
    200,
  );
  const processing = await client.files.retrieve({ id: pending.id });
  assert.equal(processing.upload_status, "processing");
  assert.equal(processing.url, null);
  const file = await ready(pending.id);
  assert.equal(file.size, bytes.length);
  assert.ok(file.url.startsWith(`${base}/_files/`));
  const downloaded = await fetch(file.url);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  const badSignature = new URL(file.url);
  badSignature.searchParams.set("signature", "tampered");
  assert.equal((await fetch(badSignature)).status, 403);
  const badExpiry = new URL(file.url);
  badExpiry.searchParams.set("expires", "1");
  assert.equal((await fetch(badExpiry)).status, 403);
  await client.disputes.update({
    id: "dspt_mock_open",
    evidence: { uncategorized_attachment: { id: file.id } },
  });
  const d = await client.disputes.retrieve({ id: "dspt_mock_open" });
  assert.deepEqual(
    Buffer.from(
      await (
        await fetch(d.evidence.uncategorized_attachment.url)
      ).arrayBuffer(),
    ),
    bytes,
  );
});

test("HTTP submission and signed webhooks support explicit rejection, acceptance, replay and delayed events", async () => {
  const opened = await control("events", {
    type: "dispute.created",
    resource_id: "dspt_mock_open",
    deliver: true,
  });
  assert.equal(opened.result.delivered, true);
  assert.equal(received[0].id, opened.event.id);
  const submitting = await client.disputes.submit({ id: "dspt_mock_open" });
  assert.equal(submitting.evidence_submitted_at, null);
  await control("submissions/dspt_mock_open", { outcome: "rejected" });
  assert.equal(
    (await client.disputes.retrieve({ id: "dspt_mock_open" })).status,
    "needs_response",
  );
  await client.disputes.submit({ id: "dspt_mock_open" });
  await control("submissions/dspt_mock_open", { outcome: "accepted" });
  const updated = await control("events", {
    type: "dispute.updated",
    resource_id: "dspt_mock_open",
    deliver: true,
  });
  await control(`events/${opened.event.id}/deliver`, {});
  assert.deepEqual(
    received.map((event) => event.id),
    [opened.event.id, updated.event.id, opened.event.id],
  );
  assert.equal(received[0].data.status, "needs_response");
  assert.equal(received[1].data.status, "under_review");
  assert.equal(received[2].data.status, "needs_response"); // Stored event snapshot, not reserialized latest state.
  await assert.rejects(
    client.disputes.update({
      id: "dspt_mock_open",
      evidence: { notes: "late" },
    }),
    (error) => error.statusCode === 400,
  );
});

test("failed webhook delivery is observable and can be replayed without inventing a new event", async () => {
  receiverStatus = 503;
  const event = await control("events", {
    type: "dispute.created",
    resource_id: "dspt_mock_open",
    deliver: true,
  });
  assert.equal(event.result.delivered, false);
  assert.equal(event.result.status, 503);
  receiverStatus = 200;
  const replay = await control(`events/${event.event.id}/deliver`, {});
  assert.equal(replay.delivered, true);
  assert.equal(received[0].id, received[1].id);
  const status = await control("status", undefined, "GET");
  assert.deepEqual(
    status.deliveries.map((row) => row.status),
    [503, 200],
  );
});

test("admin reset restores scenarios and invalidates previous upload/download capabilities", async () => {
  const first = await control("status", undefined, "GET");
  const pending = await client.files.create({ filename: "reset.pdf" });
  await fetch(pending.upload_url, {
    method: "PUT",
    body: "fixture",
    headers: pending.upload_headers,
  });
  const file = await ready(pending.id);
  await client.disputes.update({
    id: "dspt_mock_open",
    evidence: { notes: "changed" },
  });
  await control("reset", {});
  const second = await control("status", undefined, "GET");
  assert.notEqual(first.generation, second.generation);
  assert.equal(
    (await client.disputes.retrieve({ id: "dspt_mock_open" })).evidence.notes,
    null,
  );
  assert.equal((await fetch(file.url)).status, 403);
  assert.equal(
    (
      await fetch(pending.upload_url, {
        method: "PUT",
        body: "old",
        headers: pending.upload_headers,
      })
    ).status,
    403,
  );
  await assert.rejects(
    client.files.retrieve({ id: file.id }),
    (error) => error.statusCode === 404,
  );
});

test("fixture regressions: PATCH allowlist and repeated/comma/bracket file filters", async () => {
  const response = await fetch(`${base}/api/v1/disputes/dspt_mock_open`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${credentials.apiToken}`,
      "api-version-date": API_VERSION_DATE,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      evidence: { customer_name: "Jane Doe", status: "won" },
      status: "won",
    }),
  });
  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.evidence.customer_name, "Jane Doe");
  assert.equal(updated.status, "needs_response");
  const a = await client.files.create({ filename: "a.pdf" });
  const b = await client.files.create({ filename: "b.pdf" });
  for (const query of [
    `file_ids=${a.id}&file_ids=${b.id}`,
    `file_ids=${a.id},${b.id}`,
    `file_ids[]=${a.id}&file_ids[]=${b.id}`,
  ]) {
    const result = await fetch(`${base}/api/v1/files?${query}`, {
      headers: {
        authorization: `Bearer ${credentials.apiToken}`,
        "api-version-date": API_VERSION_DATE,
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(
      (await result.json()).data.map((row) => row.id).sort(),
      [a.id, b.id].sort(),
    );
  }
});
