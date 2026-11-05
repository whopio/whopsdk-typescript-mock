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
  let responseBody = { ok: true };
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
      res.end(JSON.stringify(responseBody));
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
    setResponseBody: (value) => {
      responseBody = value;
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

test("evidence references cannot claim another merchant's private upload", async (t) => {
  const env = await environment(t);
  const a = await env.admin("/_test/seed", "POST", { scenarios: [{}] });
  const b = await env.admin("/_test/seed", "POST", { scenarios: [{}] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const aToken = a.body.credentials.api_token;
  const bToken = b.body.credentials.api_token;
  const aPath = `/api/v1/disputes/${a.body.scenarios[0].dispute_id}`;
  const bPath = `/api/v1/disputes/${b.body.scenarios[0].dispute_id}`;
  const bytes = "%PDF-1.4\nMerchant A private evidence";
  const file = await env.request(
    "/api/v1/files",
    "POST",
    {
      filename: "private.pdf",
      visibility: "private",
      byte_size: bytes.length,
    },
    aToken,
  );
  assert.equal(file.status, 201);
  assert.equal(
    (
      await fetch(file.body.upload_url, {
        method: "PUT",
        headers: file.body.upload_headers,
        body: bytes,
      })
    ).status,
    200,
  );
  let uploaded;
  for (let i = 0; i < 40; i++) {
    uploaded = await env.request(
      `/api/v1/files/${file.body.id}`,
      "GET",
      undefined,
      aToken,
    );
    if (uploaded.body.upload_status === "ready") break;
    await delay(10);
  }
  assert.equal(uploaded.body.upload_status, "ready");
  assert.equal(
    (
      await env.request(
        `/api/v1/files/${file.body.id}`,
        "GET",
        undefined,
        bToken,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await env.admin(`/_test/files/${file.body.id}`, "PATCH", {
        direct_upload_id: "synthetic_private_upload",
      })
    ).status,
    200,
  );
  const before = (await env.request(bPath, "GET", undefined, bToken)).body
    .evidence;
  for (const ref of [
    { id: file.body.id },
    { direct_upload_id: "synthetic_private_upload" },
  ]) {
    for (const evidence of [
      { uncategorized_attachment: ref },
      { documents: [{ ...ref, document_type: "digital_fulfillment" }] },
    ]) {
      const denied = await env.request(bPath, "PATCH", { evidence }, bToken);
      assert.equal(denied.status, 400, JSON.stringify(denied.body));
      assert.equal(
        denied.body.error.message,
        "File is unavailable to this dispute",
      );
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(ref))
      form.set(`documents[0][${key}]`, value);
    form.set("documents[0][document_type]", "digital_fulfillment");
    assert.equal(
      (await env.request(`${bPath}/upload_evidence`, "POST", form, bToken))
        .status,
      400,
    );
  }
  assert.deepEqual(
    (await env.request(bPath, "GET", undefined, bToken)).body.evidence,
    before,
  );
  const evidence = { uncategorized_attachment: { id: file.body.id } };
  const attached = await env.request(aPath, "PATCH", { evidence }, aToken);
  assert.equal(attached.status, 200);
  assert.equal(
    await (
      await fetch(attached.body.evidence.uncategorized_attachment.url)
    ).text(),
    bytes,
  );
  // Other authorized actors can retain an attachment already bound to this dispute.
  assert.equal(
    (
      await env.request(
        aPath,
        "PATCH",
        { evidence },
        a.body.credentials.no_email_token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await env.request(bPath, "PATCH", { evidence }, bToken)).status,
    400,
  );
});

test("payment failure and recovery transitions automatically deliver signed events once", async (t) => {
  const env = await environment(t);
  const seed = await env.admin("/_test/seed", "POST", {
    scenarios: [
      {
        payment: {
          status: "open",
          substatus: "pending",
          billing_reason: "subscription_cycle",
        },
      },
    ],
  });
  assert.equal(seed.status, 201, JSON.stringify(seed.body));
  const id = seed.body.scenarios[0].payment_id;
  const hook = await env.request(
    "/api/v1/webhooks",
    "POST",
    {
      resource_id: seed.body.account_id,
      url: env.callback,
      api_version_date: "2026-11-04",
      events: [
        "payment.failed",
        "payment.requires_action",
        "payment.succeeded",
      ],
    },
    seed.body.credentials.api_token,
  );
  assert.equal(hook.status, 200);
  env.setSecret(hook.body.webhook_secret);
  const transition = async (body) => {
    const response = await env.admin(`/_test/payments/${id}`, "PATCH", body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
  };
  await transition({ substatus: "failed" });
  await transition({ substatus: "failed" });
  await transition({
    substatus: "incomplete",
    payment_status: { status: "requires_action" },
  });
  for (let i = 0; i < 40 && !env.received.length; i++) await delay(10);
  assert.deepEqual(
    env.received.map((event) => event.type),
    ["payment.failed"],
  );
  const recovery_url = "https://example.test/recover";
  await transition({ recovery_url });
  await transition({ payment_status: { status: "requires_action" } });
  await transition({ status: "paid", substatus: "succeeded" });
  await transition({ substatus: "succeeded" });
  for (let i = 0; i < 40 && env.received.length < 3; i++) await delay(10);
  await delay(30);
  assert.deepEqual(
    env.received.map((event) => event.type),
    ["payment.failed", "payment.requires_action", "payment.succeeded"],
  );
  assert.equal(env.received[0].data.status, "open");
  assert.equal(env.received[0].data.substatus, "failed");
  assert.equal(env.received[1].data.recovery_url, recovery_url);
  assert.equal(env.received[2].data.status, "paid");
  assert.ok(env.received.every((event) => event.data.id === id));
});

test("caller-controlled URLs and JSON cannot mint another merchant's file capabilities", async (t) => {
  const env = await environment(t);
  const a = await env.admin("/_test/seed", "POST", { scenarios: [{}] });
  const b = await env.admin("/_test/seed", "POST", {
    scenarios: [{ payment: { refundable: true } }],
  });
  const token = b.body.credentials.api_token;
  const payment = b.body.scenarios[0].payment_id;
  const file = await env.request(
    "/api/v1/files",
    "POST",
    {
      filename: "private.pdf",
      visibility: "private",
    },
    a.body.credentials.api_token,
  );
  assert.equal(file.status, 201);
  assert.equal(
    (
      await fetch(file.body.upload_url, {
        method: "PUT",
        headers: file.body.upload_headers,
        body: "%PDF-1.4\nPrivate fixture",
      })
    ).status,
    200,
  );
  const url = `https://files.whop.mock/${file.body.id}`;
  const hook = await env.request(
    "/api/v1/webhooks",
    "POST",
    {
      resource_id: b.body.account_id,
      url,
      events: ["payment.failed"],
      api_version_date: "2026-11-04",
    },
    token,
  );
  assert.equal(hook.status, 200);
  assert.equal(hook.body.url, url);
  assert.equal(
    (
      await env.request(
        `/api/v1/webhooks/${hook.body.id}`,
        "GET",
        undefined,
        token,
      )
    ).body.url,
    url,
  );
  const metadata = {
    id: file.body.id,
    url,
    upload_url: "https://uploads.whop.mock/synthetic_token",
  };
  const refund = await env.request(
    `/api/v1/payments/${payment}/refund`,
    "POST",
    {
      partial_amount: 1,
      metadata,
    },
    token,
  );
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  const refunds = await env.request(
    `/api/v1/refunds?payment_id=${payment}`,
    "GET",
    undefined,
    token,
  );
  assert.deepEqual(refunds.body.data[0].metadata, metadata);
  assert.equal(
    (
      await env.request(
        `/api/v1/files/${file.body.id}`,
        "GET",
        undefined,
        token,
      )
    ).status,
    404,
  );

  // A receiver's JSON response is also opaque data, including nested URL fields.
  const responseBody = { nested: metadata, url };
  env.setResponseBody(responseBody);
  env.setSecret(hook.body.webhook_secret);
  assert.equal(
    (
      await env.request(
        `/api/v1/webhooks/${hook.body.id}`,
        "PATCH",
        {
          url: env.callback,
        },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await env.admin(`/_test/payments/${payment}`, "PATCH", {
        status: "open",
        substatus: "failed",
      })
    ).status,
    200,
  );
  let deliveries;
  for (let i = 0; i < 40; i++) {
    deliveries = await env.request(
      `/api/v1/webhooks/${hook.body.id}/deliveries`,
      "GET",
      undefined,
      token,
    );
    if (deliveries.body.data?.length) break;
    await delay(10);
  }
  assert.equal(deliveries.body.data.length, 1);
  assert.equal(deliveries.body.data[0].success, true);
  assert.deepEqual(deliveries.body.data[0].response_body, responseBody);
});
