import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { unwrapWebhook } from "@whop/sdk/helpers";
import {
  createHttpTestServer,
  LOCAL_TEST_CREDENTIALS as credentials,
} from "../dist/http-server.js";

const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    );
  });
const close = (server) => new Promise((resolve) => server.close(resolve));
async function environment(t) {
  const received = [];
  const receivedHeaders = [];
  let secret;
  const receiver = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      received.push(
        unwrapWebhook(Buffer.concat(chunks).toString(), {
          key: secret,
          headers: req.headers,
        }),
      );
      receivedHeaders.push(req.headers);
      res.end('{"ok":true}');
    } catch {
      res.writeHead(400).end();
    }
  });
  const callback = await listen(receiver);
  const server = createHttpTestServer({
    ...credentials,
    webhookUrl: callback + "/",
    uploadProcessingDelayMs: 0,
    disputeWebhookDelayMs: 0,
    webhookRetryScale: 0.001,
  });
  const base = await listen(server);
  t.after(async () => {
    await close(server);
    await close(receiver);
  });
  async function request(
    path,
    method = "GET",
    body,
    token = credentials.apiToken,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "api-version-date": "2026-11-04",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body instanceof FormData
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return {
    base,
    callback: callback + "/",
    received,
    receivedHeaders,
    request,
    setSecret: (value) => {
      secret = value;
    },
    admin: (path, method, body) =>
      request(path, method, body, credentials.adminToken),
  };
}

test("real HTTP clients register hooks, verify signatures, inspect attempts and replay frozen payloads", async (t) => {
  const env = await environment(t);
  const hook = await env.request("/api/v1/webhooks", "POST", {
    resource_id: "biz_mock_primary",
    url: env.callback,
    events: ["dispute.updated"],
    api_version_date: "2099-01-01",
  });
  assert.equal(hook.status, 200);
  env.setSecret(hook.body.webhook_secret);
  const emitted = await env.admin("/_test/events", "POST", {
    type: "dispute.updated",
    resource_id: "dspt_mock_open",
    previous_attributes: { metadata: { investigation: "pending" } },
  });
  for (let i = 0; i < 40 && !env.received.length; i++) await delay(10);
  assert.equal(env.received.length, 1);
  assert.equal(env.received[0].api_version_date, "2099-01-01");
  assert.equal(
    env.receivedHeaders[0]["x-whop-mock-api-version"],
    "2026-11-04-1",
  );
  assert.notEqual(hook.body.webhook_secret, credentials.webhookSecret);
  const preview = emitted.body.delivery;
  assert.deepEqual(
    unwrapWebhook(preview.body, {
      key: credentials.webhookSecret,
      headers: preview.headers,
    }),
    emitted.body.event,
  );
  assert.throws(() =>
    unwrapWebhook(preview.body, {
      key: hook.body.webhook_secret,
      headers: preview.headers,
    }),
  );
  assert.deepEqual(env.received[0].previous_attributes, {
    metadata: { investigation: "pending" },
  });
  const deliveries = await env.request(
    `/api/v1/webhooks/${hook.body.id}/deliveries`,
  );
  assert.equal(deliveries.body.data.length, 1);
  assert.equal(deliveries.body.data[0].success, true);
  await env.request(
    `/api/v1/webhooks/${hook.body.id}/deliveries/${deliveries.body.data[0].id}/replay`,
    "POST",
    {},
  );
  assert.equal(env.received.length, 2);
  assert.deepEqual(env.received[0], env.received[1]);
  assert.equal(
    (
      await env.request(
        `/api/v1/webhooks/${hook.body.id}`,
        "GET",
        undefined,
        credentials.readOnlyToken,
      )
    ).status,
    403,
  );
});

test("buyer secrets, asynchronous capture and pending refund completion work over HTTP", async (t) => {
  const env = await environment(t);
  const seed = await env.admin("/_test/seed", "POST", {
    scenarios: [
      {
        payment: {
          total: 50,
          status: "authorized",
          substatus: "requires_capture",
          client_secret: "local_seeded_buyer",
          capture_expires_at: new Date(Date.now() + 86400000).toISOString(),
        },
        runtime: { manual_capture: true, refund_status: "pending" },
      },
    ],
  });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
  const id = seed.body.scenarios[0].payment_id,
    token = seed.body.credentials.api_token;
  const status = await env.request(
    `/api/v1/payments/${id}/status?client_secret=local_seeded_buyer`,
    "GET",
    undefined,
    null,
  );
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "requires_capture");
  assert.equal(
    (
      await env.request(
        `/api/v1/payments/${id}/status?client_secret=wrong`,
        "GET",
        undefined,
        null,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await env.request(
        `/api/v1/payments/${id}/capture`,
        "POST",
        {},
        seed.body.credentials.read_only_token,
      )
    ).status,
    403,
  );
  const capture = await env.request(
    `/api/v1/payments/${id}/capture`,
    "POST",
    {},
    token,
  );
  assert.equal(capture.body.status, "processing");
  await env.admin(`/_test/payments/${id}`, "PATCH", {
    status: "paid",
    substatus: "succeeded",
    refundable: true,
  });
  const refund = await env.request(
    `/api/v1/payments/${id}/refund`,
    "POST",
    { partial_amount: 12.34 },
    token,
  );
  assert.equal(refund.status, 200);
  assert.equal(refund.body.refunded_amount.amount, "0.00");
  const refunds = await env.request(
    `/api/v1/refunds?payment_id=${id}`,
    "GET",
    undefined,
    token,
  );
  assert.equal(refunds.body.data[0].status, "pending");
  await env.admin(`/_test/refunds/${refunds.body.data[0].id}`, "PATCH", {
    status: "succeeded",
  });
  const paid = await env.request(
    `/api/v1/payments/${id}`,
    "GET",
    undefined,
    token,
  );
  assert.equal(paid.body.refunded_amount.amount, "12.34");
  assert.equal(paid.body.substatus, "partially_refunded");
});

test("HTTP multipart evidence carries real bytes and generated receipt URLs download a PDF", async (t) => {
  const env = await environment(t);
  const data = new FormData();
  data.set("documents[0][document_type]", "digital_fulfillment");
  data.set(
    "documents[0][file]",
    new Blob(["%PDF-1.4\nSynthetic"], { type: "application/pdf" }),
    "proof.pdf",
  );
  const result = await env.request(
    "/api/v1/disputes/dspt_mock_open/upload_evidence",
    "POST",
    data,
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const download = await fetch(result.body.evidence.documents[0].url);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "%PDF-1.4\nSynthetic");
  const pdf = await env.request(
    "/api/v1/payments/pay_mock_primary/generate_pdf",
    "POST",
    {},
  );
  assert.equal(pdf.status, 200);
  const response = await fetch(pdf.body.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /^%PDF-1.4/);
});
