import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, afterEach } from "node:test";
import Ajv from "ajv";
import { unwrapWebhook } from "@whop/sdk/helpers";
import WhopMock from "../dist/index.js";
import { seedScenarios } from "../dist/scenario-seeder.js";

const contract = JSON.parse(
  readFileSync(new URL("../vendor/current-api-schemas.json", import.meta.url)),
);
const ajv = new Ajv({
  allErrors: true,
  unknownFormats: "ignore",
  logger: false,
});
afterEach(() => WhopMock.stop());
const origin = "https://api.whop.mock/api/v1";
function setup() {
  const session = WhopMock.start();
  const helper = WhopMock.createTestHelper();
  const stack = helper.createDisputeWithPayment({
    company: { id: "biz_surface" },
    payment: {
      total: 100,
      refundable: true,
      client_secret: "local_surface_client_secret",
    },
    dispute: { provider: "stripe" },
  });
  const fetch = WhopMock.createFetch();
  const covered = new Set();
  const call = async (
    method,
    template,
    path,
    body,
    status = 200,
    headers = {},
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: { "api-version-date": contract.api_version_date, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${JSON.stringify(value)}`,
    );
    const schema =
      contract.paths[template]?.[method.toLowerCase()]?.responses[
        String(status)
      ];
    assert.ok(
      schema,
      `Missing public contract: ${method} ${template} -> ${status}`,
    );
    const valid = ajv.compile({ ...schema, components: contract.components });
    assert.ok(
      valid(value),
      `${method} ${template}: ${JSON.stringify(valid.errors)}`,
    );
    covered.add(`${method} ${template}`);
    return value;
  };
  return { session, helper, stack, fetch, call, covered };
}

test("every one of the 36 public documented operations produces its specified response", async () => {
  const { session, helper, stack, fetch, call, covered } = setup();
  const dspt = stack.dispute.id,
    pay = stack.payment.id;
  const refund = helper.createRefund({ payment_id: pay, amount: 2 });
  for (const [path, template] of [
    ["/disputes", "/disputes"],
    ["/disputes/summary", "/disputes/summary"],
    [`/disputes/${dspt}`, "/disputes/{id}"],
    ["/payments", "/payments"],
    ["/payments/summary", "/payments/summary"],
    [`/payments/${pay}`, "/payments/{id}"],
    [`/payments/${pay}/status`, "/payments/{payment_id}/status"],
    [`/payments/${pay}/fees`, "/payments/{id}/fees"],
    ["/refunds", "/refunds"],
    [`/refunds/${refund.id}`, "/refunds/{id}"],
  ])
    await call("GET", template, path);
  await call("PATCH", "/disputes/{id}", `/disputes/${dspt}`, {
    evidence: { notes: "Documented evidence fields" },
  });
  await call(
    "POST",
    "/disputes/{id}/upload_evidence",
    `/disputes/${dspt}/upload_evidence`,
    { documents: [] },
  );
  await call("POST", "/disputes/{id}/submit", `/disputes/${dspt}/submit`, {});
  const concession = helper.createDispute({
    company_id: stack.company.id,
    payment_id: pay,
    provider: "stripe",
  });
  assert.equal(
    (
      await call(
        "POST",
        "/disputes/{id}/accept",
        `/disputes/${concession.id}/accept`,
        {},
      )
    ).status,
    "lost",
  );

  const file = await call(
    "POST",
    "/files",
    "/files",
    {
      filename: "evidence.pdf",
      multipart: true,
      byte_size: 5 * 1024 * 1024 + 1,
    },
    201,
  );
  const parts = [];
  for (const [i, part] of file.multipart_upload_urls.entries()) {
    const response = await fetch(part.url, {
      method: "PUT",
      body: Buffer.alloc(i === 0 ? 5 * 1024 * 1024 : 1),
    });
    assert.equal(response.status, 200);
    parts.push({
      part_number: part.part_number,
      etag: response.headers.get("etag"),
    });
  }
  await call("POST", "/files/{id}/complete", `/files/${file.id}/complete`, {
    multipart_upload_id: file.multipart_upload_id,
    multipart_parts: parts,
  });
  await call("GET", "/files/{id}", `/files/${file.id}`);
  await call("GET", "/files", `/files?file_ids=${file.id}`);
  const shipping = await call("PATCH", "/payments/{id}", `/payments/${pay}`, {
    shipping_address: { city: "Austin" },
  });
  assert.equal(shipping.shipping_address.city, "Austin");
  await call("POST", "/payments/{id}/refund", `/payments/${pay}/refund`, {
    partial_amount: 25,
    metadata: { case: "partial" },
  });
  assert.equal(WhopMock.find("payment", pay).refunded_amount.amount, "25.00");
  const pdf = await call(
    "POST",
    "/payments/{id}/generate_pdf",
    `/payments/${pay}/generate_pdf`,
    {},
    200,
    { "idempotency-key": "pdf" },
  );
  const nextPdf = await call(
    "POST",
    "/payments/{id}/generate_pdf",
    `/payments/${pay}/generate_pdf`,
    {},
    200,
    { "idempotency-key": "pdf" },
  );
  assert.notEqual(
    pdf.url,
    nextPdf.url,
    "PDF generation opts out of idempotent replay",
  );
  assert.match(
    Buffer.from(
      session.currentApi.fileBytes(new URL(pdf.url).pathname.slice(1)),
    ).toString(),
    /^%PDF-/,
  );
  const authorized = helper.createPayment({
    company_id: stack.company.id,
    total: 50,
    status: "authorized",
    capture_expires_at: new Date(Date.now() + 86400000).toISOString(),
    _runtime: { manual_capture: true },
  });
  assert.equal(
    (
      await call(
        "POST",
        "/payments/{id}/capture",
        `/payments/${authorized.id}/capture`,
        {},
      )
    ).status,
    "processing",
  );
  await call(
    "POST",
    "/payments/{id}/void",
    `/payments/${authorized.id}/void`,
    {},
  );
  const failed = helper.createPayment({
    company_id: stack.company.id,
    status: "open",
    retryable: true,
    membership_id: "mem_seed",
    client_secret: "local_buyer",
    _runtime: { return_url_editable: true },
  });
  await call(
    "POST",
    "/payments/{id}/retry",
    `/payments/${failed.id}/retry`,
    {},
  );
  await call(
    "PATCH",
    "/payments/{payment_id}/return_url",
    `/payments/${failed.id}/return_url`,
    { return_url: "https://example.test/done" },
  );
  await call(
    "POST",
    "/payments/{payment_id}/resume",
    `/payments/${failed.id}/resume`,
    { client_secret: "local_buyer" },
  );

  const createRequest = {
    account_id: stack.company.id,
    variant_id: "plan_seed",
    member_id: "mber_seed",
    payment_method_id: "payt_seed",
  };
  seedScenarios(session, {
    account_id: stack.company.id,
    scenarios: [
      {
        payment: { status: "open", total: 100 },
        create_payment: { request: createRequest },
      },
    ],
  });
  await call("POST", "/payments", "/payments", createRequest, 201);

  const received = [];
  session.currentApi.webhooks.configure(async (url, init) => {
    received.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response("OK");
  });
  const hook = await call("POST", "/webhooks", "/webhooks", {
    resource_id: stack.company.id,
    url: "https://example.test/webhook",
    events: ["dispute.created", "payment.succeeded"],
    api_version_date: "2026-11-04",
  });
  assert.match(hook.webhook_secret, /^ws_/);
  assert.equal(
    (await call("GET", "/webhooks/{id}", `/webhooks/${hook.id}`))
      .webhook_secret,
    null,
  );
  const hooks = await call(
    "GET",
    "/webhooks",
    `/webhooks?account_id=${stack.company.id}`,
  );
  assert.ok(!("testable_events" in hooks.data[0]));
  await call("PATCH", "/webhooks/{id}", `/webhooks/${hook.id}`, {
    title: "Integration test",
  });
  await call("POST", "/webhooks/{id}/test", `/webhooks/${hook.id}/test`, {
    event: "dispute.created",
  });
  assert.equal(
    (
      await call(
        "GET",
        "/webhooks/{id}/deliveries",
        `/webhooks/${hook.id}/deliveries`,
      )
    ).data.length,
    0,
    "test probes do not create delivery-log entries",
  );
  WhopMock.emitWebhookEvent("dispute.created", { data: { id: dspt } });
  await new Promise((resolve) => setImmediate(resolve));
  const deliveries = await call(
    "GET",
    "/webhooks/{id}/deliveries",
    `/webhooks/${hook.id}/deliveries`,
  );
  assert.equal(deliveries.data.length, 1);
  assert.equal(deliveries.data[0].response_body.raw_body, "OK");
  await call(
    "POST",
    "/webhooks/{id}/deliveries/{delivery_id}/replay",
    `/webhooks/${hook.id}/deliveries/${deliveries.data[0].id}/replay`,
    {},
  );
  assert.deepEqual(received[1].body, received[2].body);
  await call("POST", "/webhooks/{id}/replay", `/webhooks/${hook.id}/replay`, {
    sent_after: new Date(Date.now() - 1000).toISOString(),
  });
  await call("DELETE", "/webhooks/{id}", `/webhooks/${hook.id}`);
  const expected = Object.entries(contract.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
  );
  assert.equal(expected.length, 36);
  assert.deepEqual([...covered].sort(), expected.sort());
});

test("payment filters, summary and total counts share the same seeded population", async () => {
  const { helper, stack, call } = setup();
  helper.createPayment({
    company_id: stack.company.id,
    status: "paid",
    total: 25,
    billing_reason: "subscription_update",
    substatus: "succeeded",
    refunded_at: "2026-11-03T12:00:00.000Z",
    user: {
      id: "user_dana",
      name: "Dana Whitfield",
      username: "dana",
      profile_picture: { url: "https://example.test/avatar.png" },
    },
  });
  const query =
    "?billing_reasons=subscription_cycle&min_amount=25&max_amount=25&refunded_after=2026-11-01&query=Dana&include_total_count=true";
  const page = await call("GET", "/payments", "/payments" + query);
  assert.equal(page.data.length, 1);
  assert.equal(page.page_info.total_count, 1);
  assert.equal(page.page_info.total_count_capped, false);
  const summary = await call(
    "GET",
    "/payments/summary",
    "/payments/summary" + query,
  );
  assert.equal(summary.total, 1);
  assert.equal(summary.groups.substatus.succeeded, 1);
});

test("seeded processor state, write scopes, idempotency and transaction rollback remain distinct", async () => {
  const { session, helper, stack, fetch } = setup();
  const denied = WhopMock.createFetch({
    grants: { [stack.company.id]: ["payment:basic:read"] },
  });
  assert.equal(
    (
      await denied(`${origin}/payments/${stack.payment.id}/refund`, {
        method: "POST",
        body: "{}",
      })
    ).status,
    403,
  );
  const headers = { "idempotency-key": "refund-once" };
  const request = () =>
    fetch(`${origin}/payments/${stack.payment.id}/refund`, {
      method: "POST",
      headers,
      body: JSON.stringify({ partial_amount: 10.01 }),
    });
  assert.equal((await request()).status, 200);
  assert.equal((await request()).headers.get("idempotent-replayed"), "true");
  assert.equal(session.store.list("refund").length, 1);
  const payment = helper.createPayment({
    company_id: stack.company.id,
    shipping_address: { city: "Old" },
    _runtime: { return_url_editable: false },
  });
  const before = session.store.find("payment", payment.id);
  const response = await fetch(`${origin}/payments/${payment.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      shipping_address: { city: "New" },
      return_url: "https://example.test/done",
    }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(session.store.find("payment", payment.id), before);
  const missing = await fetch(origin + "/payments", {
    method: "POST",
    body: JSON.stringify({
      account_id: stack.company.id,
      variant_id: "plan_not_seeded",
      member_id: "mber_seed",
      payment_method_id: "payt_seed",
    }),
  });
  assert.equal(
    missing.status,
    501,
    "unseeded pricing/processor outcomes must never silently succeed",
  );
});

test("multipart evidence and synthetic direct-upload references follow the same replacement path", async () => {
  const { session, stack, fetch } = setup();
  const data = new FormData();
  data.set("evidence[notes]", "Uploaded in one request");
  data.set("evidence[documents][0][document_type]", "digital_fulfillment");
  data.set(
    "evidence[documents][0][file]",
    new Blob(["%PDF-1.4\nSynthetic test document"], {
      type: "application/pdf",
    }),
    "evidence.pdf",
  );
  const response = await fetch(`${origin}/disputes/${stack.dispute.id}`, {
    method: "PATCH",
    body: data,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const dispute = await response.json();
  assert.equal(dispute.evidence.notes, "Uploaded in one request");
  const fileId = dispute.evidence.documents[0].id;
  assert.ok(fileId.startsWith("file_"));
  session.store.update("file", fileId, {
    _directUploadId: "local_synthetic_blob_reference",
  });
  const direct = await fetch(
    `${origin}/disputes/${stack.dispute.id}/upload_evidence`,
    {
      method: "POST",
      body: JSON.stringify({
        documents: [
          {
            document_type: "digital_fulfillment",
            direct_upload_id: "local_synthetic_blob_reference",
          },
        ],
      }),
    },
  );
  assert.equal(direct.status, 200);
  const invalid = await fetch(
    `${origin}/disputes/${stack.dispute.id}/upload_evidence`,
    {
      method: "POST",
      body: JSON.stringify({
        documents: [
          { document_type: "digital_fulfillment", direct_upload_id: "missing" },
        ],
      }),
    },
  );
  assert.equal(invalid.status, 400);
  assert.equal(
    session.store.find("dispute", stack.dispute.id).evidence.documents.length,
    1,
  );
  const conflicting = new FormData();
  conflicting.set("evidence", "a scalar");
  conflicting.set("evidence[notes]", "a nested field");
  assert.equal(
    (
      await fetch(`${origin}/disputes/${stack.dispute.id}`, {
        method: "PATCH",
        body: conflicting,
      })
    ).status,
    400,
  );
  assert.equal(
    session.store.find("dispute", stack.dispute.id).evidence.notes,
    "Uploaded in one request",
  );
});

test("cross-currency disputes and partial refunds preserve the charge and settlement currencies", async () => {
  const { session, call } = setup();
  const money = (amount, currency, decimals) => ({
    amount,
    currency,
    decimals,
    display_decimals: decimals,
  });
  const seeded = seedScenarios(session, {
    account_id: "biz_surface",
    scenarios: [
      {
        payment: {
          currency: "eur",
          total: money("100.00", "eur", 2),
          presentment_total: money("16000", "jpy", 0),
          refundable: true,
        },
      },
    ],
  });
  const { payment_id, dispute_id } = seeded.scenarios[0];
  const dispute = await call(
    "GET",
    "/disputes/{id}",
    `/disputes/${dispute_id}`,
  );
  assert.equal(dispute.currency, "jpy");
  assert.equal(dispute.amount, 16000);
  assert.equal(dispute.payment.currency, "jpy");
  const first = await call(
    "POST",
    "/payments/{id}/refund",
    `/payments/${payment_id}/refund`,
    { partial_amount: 10.01 },
  );
  assert.equal(first.refunded_amount.amount, "10.01");
  assert.equal(first.presentment_refunded_amount.amount, "1602");
  const rest = await call(
    "POST",
    "/payments/{id}/refund",
    `/payments/${payment_id}/refund`,
    { partial_amount: 999 },
  );
  assert.equal(rest.refunded_amount.amount, "100.00");
  assert.equal(rest.presentment_refunded_amount.amount, "16000");
  assert.equal(rest.refundable, false);
});

test("documented query and mutation boundary failures preserve records", async () => {
  const { session, stack, fetch } = setup();
  for (const query of [
    "min_amount=-1",
    "min_amount=20&max_amount=10",
    "min_amount=nan",
    "billing_reasons=invalid",
    "tracking_states=invalid",
    "payment_methods=invalid",
    "mode=invalid",
    "status=paid&status=open",
    "user_id=me",
    "refunded_after=not-a-date",
    "include_total_count=maybe",
    "company_id=biz_old",
    "include_free=true",
    "updated_after=2026-01-01",
  ]) {
    const result = await fetch(`${origin}/payments?${query}`);
    assert.equal(result.status, 400, query);
  }
  const before = session.store.find("payment", stack.payment.id);
  for (const body of [
    { partial_amount: -1 },
    { partial_amount: 0 },
    { partial_amount: true },
    { partial_amount: "" },
    { partial_amount: 0.001 },
    { metadata: { nested: {} } },
    {
      metadata: Object.fromEntries(
        Array.from({ length: 51 }, (_, i) => [`key${i}`, "value"]),
      ),
    },
  ]) {
    const result = await fetch(
      `${origin}/payments/${stack.payment.id}/refund`,
      { method: "POST", body: JSON.stringify(body) },
    );
    assert.equal(result.status, 400);
    assert.deepEqual(session.store.find("payment", stack.payment.id), before);
  }
});

test("webhook fixtures handle secrets, frozen replay, regenerated IDs, disabled endpoints and cursors", async () => {
  const { session, stack, call, fetch } = setup();
  const seen = [];
  session.currentApi.webhooks.configure(async (url, init) => {
    seen.push({ url, event: JSON.parse(init.body) });
    return new Response('{"ok":true}');
  });
  const hook = await call("POST", "/webhooks", "/webhooks", {
    resource_id: stack.company.id,
    url: "https://example.test/first",
    events: ["dispute_created"],
    api_version_date: "2026-11-04",
  });
  assert.deepEqual(hook.events, ["dispute.created"]);
  assert.ok(
    hook.testable_events.includes("payment.succeeded"),
    "the fixture advertises modeled v1 testable events independently of subscriptions",
  );
  for (let i = 0; i < 3; i++)
    WhopMock.emitWebhookEvent("dispute.created", {
      data: { id: stack.dispute.id },
    });
  await new Promise((resolve) => setImmediate(resolve));
  const page = await call(
    "GET",
    "/webhooks/{id}/deliveries",
    `/webhooks/${hook.id}/deliveries?first=1`,
  );
  assert.equal(page.data.length, 1);
  assert.equal(page.page_info.has_next_page, true);
  const second = await call(
    "GET",
    "/webhooks/{id}/deliveries",
    `/webhooks/${hook.id}/deliveries?first=1&after=${encodeURIComponent(page.page_info.end_cursor)}`,
  );
  assert.notEqual(second.data[0].id, page.data[0].id);
  await call("PATCH", "/webhooks/{id}", `/webhooks/${hook.id}`, {
    url: "https://example.test/second",
  });
  session.store.update("dispute", stack.dispute.id, { status: "won" });
  await call(
    "POST",
    "/webhooks/{id}/deliveries/{delivery_id}/replay",
    `/webhooks/${hook.id}/deliveries/${page.data[0].id}/replay`,
    { regenerate_id: true },
  );
  assert.equal(seen.at(-1).url, "https://example.test/second");
  assert.equal(seen.at(-1).event.data.status, "needs_response");
  assert.notEqual(seen.at(-1).event.id, page.data[0].request_body.id);
  const beforeRange = seen.length;
  await call("POST", "/webhooks/{id}/replay", `/webhooks/${hook.id}/replay`, {
    sent_after: new Date(Date.now() - 60_000).toISOString(),
    sent_before: new Date(Date.now() + 1_000).toISOString(),
  });
  for (let i = 0; seen.length < beforeRange + 2 && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    seen.length,
    beforeRange + 2,
    "successful regenerated replays suppress their original message in range replay",
  );
  await call("PATCH", "/webhooks/{id}", `/webhooks/${hook.id}`, {
    enabled: false,
  });
  assert.equal(
    (
      await fetch(
        `${origin}/webhooks/${hook.id}/deliveries/${page.data[0].id}/replay`,
        { method: "POST", body: "{}" },
      )
    ).status,
    400,
  );
  const deliveriesBefore = session.store.list("webhook_delivery").length;
  await call("POST", "/webhooks/{id}/test", `/webhooks/${hook.id}/test`, {
    event: "dispute.created",
  });
  assert.equal(session.store.list("webhook_delivery").length, deliveriesBefore);
  session.currentApi.webhooks.configure(async () => {
    throw new DOMException("timed out", "TimeoutError");
  });
  const timeout = await fetch(`${origin}/webhooks/${hook.id}/test`, {
    method: "POST",
    body: JSON.stringify({ event: "dispute.created" }),
  });
  assert.equal(timeout.status, 400);
  assert.equal(
    (await timeout.json()).error.message,
    "Webhook request timed out",
  );
  assert.equal(session.store.list("webhook_delivery").length, deliveriesBefore);
  await call("PATCH", "/webhooks/{id}", `/webhooks/${hook.id}`, {
    enabled: true,
    api_version_date: null,
  });
  assert.equal(
    (
      await fetch(`${origin}/webhooks/${hook.id}/test`, {
        method: "POST",
        body: JSON.stringify({ event: "dispute.created" }),
      })
    ).status,
    501,
    "legacy unpinned data must not be misrepresented as a native DTO",
  );
});

test("receipt searches handle short queries, permissions, membership and card fixtures", async () => {
  const { session, stack, fetch } = setup();
  session.store.insert("membership", {
    id: "mem_search",
    stripe_subscription_id: "sub_search",
    license_key: "license-search",
    discord_account: { id: "123456789012345678", username: "discord-search" },
  });
  session.store.update("payment", stack.payment.id, {
    membership_id: "mem_search",
    customer_email: "buyer@example.test",
    user: { id: "user_search", name: "Ada Example" },
    payment_instrument: {
      card: { issuer_identification_number: "424242", last4: "4242" },
    },
  });
  const ids = async (query, send = fetch) =>
    (
      await (
        await send(`${origin}/payments?query=${encodeURIComponent(query)}`)
      ).json()
    ).data.map((row) => row.id);
  for (const query of [
    "xy",
    "Ada",
    "buyer@",
    "sub_search",
    "license-search",
    "discord-search",
    "123456789012345678",
    "42424299 **** 4242",
    "4242",
  ])
    assert.deepEqual(await ids(query), [stack.payment.id], query);
  assert.deepEqual(await ids("not-found"), []);
  const noEmail = WhopMock.createFetch({
    grants: { [stack.company.id]: ["payment:basic:read"] },
  });
  assert.deepEqual(await ids("buyer@", noEmail), []);
  assert.deepEqual(await ids("Ada", noEmail), [stack.payment.id]);
});

test("all eleven local lifecycle events carry public resource shapes and SDK-verifiable signatures", () => {
  const { helper, stack } = setup();
  const refund = helper.createRefund({
    payment_id: stack.payment.id,
    amount: 10,
  });
  const subjects = {
    dispute: stack.dispute.id,
    payment: stack.payment.id,
    refund: refund.id,
  };
  assert.equal(contract.webhook_events.length, 9);
  for (const type of [
    ...contract.webhook_events,
    "refund.created",
    "refund.updated",
  ]) {
    const resource = type.split(".")[0];
    const name = resource[0].toUpperCase() + resource.slice(1);
    // Public webhook exports omit envelope schemas. Validate resource data and
    // explicitly test the mock envelope/signature without claiming full parity.
    const schema = { $ref: `#/components/schemas/${name}` };
    const event = WhopMock.emitWebhookEvent(type, {
      data: { id: subjects[type.split(".")[0]] },
      api_version_date: contract.api_version_date,
      ...(type.endsWith(".updated")
        ? { previous_attributes: { metadata: { old: "value" } } }
        : {}),
    });
    const validate = ajv.compile({
      ...schema,
      components: contract.components,
    });
    assert.ok(
      validate(event.data),
      `${type}: ${JSON.stringify(validate.errors)}`,
    );
    assert.match(event.id, /^msg_/);
    assert.equal(event.type, type);
    assert.equal(event.account_id, stack.company.id);
    assert.equal(event.api_version, "v1");
    assert.equal(event.api_version_date, contract.api_version_date);
    assert.ok(Number.isFinite(Date.parse(event.timestamp)));
    const delivery = WhopMock.signWebhook(event, "ws_synthetic_surface");
    const decoded = unwrapWebhook(delivery.body, {
      key: "ws_synthetic_surface",
      headers: delivery.headers,
    });
    assert.deepEqual(decoded, event);
    for (const name of ["webhook-id", "webhook-timestamp", "webhook-signature"])
      assert.ok(delivery.headers[name]);
  }
});
