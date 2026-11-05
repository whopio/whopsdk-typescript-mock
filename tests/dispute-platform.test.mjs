import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { WhopClient } from "@whop/sdk";
import { unwrapWebhook } from "@whop/sdk/helpers";
import {
  createHttpTestServer,
  LOCAL_TEST_CREDENTIALS as credentials,
} from "../dist/http-server.js";
import { API_VERSION_DATE } from "../dist/index.js";
import { exerciseDisputeApi } from "../examples/http/disputes.mjs";

let server, receiver, base, received;
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
  receiver = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      try {
        received.push(
          unwrapWebhook(Buffer.concat(chunks).toString(), {
            headers: request.headers,
            key: credentials.webhookSecret,
          }),
        );
        response.writeHead(200).end();
      } catch {
        response.writeHead(400).end();
      }
    })();
  });
  server = createHttpTestServer({
    ...credentials,
    webhookUrl: await listen(receiver),
    uploadProcessingDelayMs: 5,
  });
  base = await listen(server);
});
afterEach(async () => {
  await close(server);
  await close(receiver);
});
const client = (token) =>
  new WhopClient({
    token,
    baseUrl: `${base}/api/v1`,
    apiVersionDate: API_VERSION_DATE,
    maxRetries: 0,
  });
async function control(
  path,
  body,
  method = "POST",
  token = credentials.adminToken,
) {
  const response = await fetch(`${base}/_test/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test("seeded buyers resolve refund backfills and dispute IDs resolve payments", async () => {
  const user = {
    id: "user_partner",
    username: "buyer",
    name: "Partner Buyer",
    profile_picture: { url: "https://example.test/avatar.png" },
  };
  const seeded = await control("seed", {
    scenarios: [
      {
        payment: { id: "pay_partner1", user },
        dispute: { id: "dspt_partner1" },
        refunds: [{ amount: 1 }],
      },
      { payment: { id: "pay_partner2", user }, refunds: [{ amount: 2 }] },
    ],
  });
  assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
  const api = client(seeded.body.credentials.api_token);
  assert.deepEqual(
    (await api.payments.list({ query: "dspt_partner1" })).data.map((p) => p.id),
    ["pay_partner1"],
  );
  assert.equal((await api.refunds.list({ user_id: user.id })).data.length, 2);
  const before = (await control("status", undefined, "GET")).body.resources;
  const conflict = await control("seed", {
    account_id: seeded.body.account_id,
    scenarios: [
      {},
      { payment: { user: { ...user, name: "Conflicting Buyer" } } },
    ],
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(
    (await control("status", undefined, "GET")).body.resources,
    before,
  );
});

test("cross-currency seed refunds require explicit charge amounts and reject over-refunds atomically", async () => {
  const money = (amount, currency, decimals) => ({
    amount,
    currency,
    decimals,
    display_decimals: decimals,
  });
  const scenario = {
    payment: {
      currency: "eur",
      total: money("100.00", "eur", 2),
      presentment_total: money("16000", "jpy", 0),
    },
    refunds: [{ amount: money("10.00", "eur", 2) }],
  };
  const before = (await control("status", undefined, "GET")).body.resources;
  assert.equal((await control("seed", { scenarios: [scenario] })).status, 400);
  scenario.refunds[0].original_amount = money("16001", "jpy", 0);
  assert.equal((await control("seed", { scenarios: [scenario] })).status, 400);
  assert.deepEqual(
    (await control("status", undefined, "GET")).body.resources,
    before,
  );
  scenario.refunds[0].original_amount = money("1600", "jpy", 0);
  const seeded = await control("seed", { scenarios: [scenario] });
  assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
  const api = client(seeded.body.credentials.api_token);
  assert.deepEqual(
    (await api.payments.retrieve({ id: seeded.body.scenarios[0].payment_id }))
      .presentment_refunded_amount,
    money("1600", "jpy", 0),
  );
});

// Exercises every supported dispute operation through HTTP and the real SDK,
// starting from a user's seed file rather than the built-in fixture IDs.
test("a custom seed drives list/summary/retrieve, evidence/files, submit/reject/accept, concession and webhooks", async () => {
  const result = await exerciseDisputeApi({ base });
  assert.equal(result.dispute_api_workflow, "passed");
  assert.equal(result.webhook_delivery, "passed");
  assert.equal(result.cases_created, 6);
  assert.deepEqual(
    received.map((event) => event.type),
    ["dispute.created", "dispute.updated", "dispute.created"],
  );
  assert.equal(received[0].id, received[2].id);
  assert.equal(received[0].data.status, "needs_response");
  assert.equal(received[1].data.status, "won");
});

test("seeded merchants get scoped credentials; append preserves cases and reset revokes the tokens", async () => {
  const a = await control("seed", {
    account: { id: "biz_custom_a", title: "Merchant A" },
    scenarios: [
      {
        payment: { total: 125, customer_email: "alice@example.test" },
        dispute: { id: "dspt_custom_a" },
      },
    ],
  });
  const b = await control("seed", {
    account: { id: "biz_custom_b" },
    scenarios: [{}],
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  const api = client(a.body.credentials.api_token);
  assert.equal(
    (await api.disputes.retrieve({ id: "dspt_custom_a" })).buyer.email,
    "alice@example.test",
  );
  await assert.rejects(
    client(b.body.credentials.api_token).disputes.retrieve({
      id: "dspt_custom_a",
    }),
    (error) => error.statusCode === 403,
  );
  await assert.rejects(
    client(credentials.apiToken).disputes.retrieve({ id: "dspt_custom_a" }),
    (error) => error.statusCode === 403,
  );
  assert.equal(
    (
      await client(a.body.credentials.no_email_token).disputes.retrieve({
        id: "dspt_custom_a",
      })
    ).buyer.email,
    null,
  );
  await assert.rejects(
    client(a.body.credentials.read_only_token).disputes.submit({
      id: "dspt_custom_a",
    }),
    (error) => error.statusCode === 403,
  );
  assert.equal(
    (
      await control(
        "seed",
        { scenarios: [{}] },
        "POST",
        a.body.credentials.api_token,
      )
    ).status,
    401,
  );
  const more = await control("seed", {
    account_id: a.body.account_id,
    scenarios: [{}],
  });
  assert.equal(more.status, 201);
  assert.deepEqual(more.body.credentials, a.body.credentials);
  assert.equal((await api.disputes.list({})).data.length, 2);
  const state = (await control("status", undefined, "GET")).body;
  assert.ok(state.resources.account_ids.includes(a.body.account_id));
  assert.ok(state.resources.dispute_ids.includes("dspt_custom_a"));
  await control("reset", {});
  await assert.rejects(
    api.disputes.list({}),
    (error) => error.statusCode === 401,
  );
});

test("seed validation is atomic across a batch, rejects duplicate IDs and cannot inject unrelated records", async () => {
  const before = (await control("status", undefined, "GET")).body.resources;
  const baseSeed = {
    account: { id: "biz_atomic" },
    scenarios: [
      { payment: { id: "pay_atomic" }, dispute: { id: "dspt_atomic" } },
    ],
  };
  for (const bad of [
    { payment: { total: -1 } },
    { payment: { account_id: "biz_mock_other" } },
    { payment: { customer_email: 123 } },
    { refunds: [{}] },
    { payment: { total: 10 }, refunds: [{ amount: 11, status: "succeeded" }] },
    { dispute: { evidence_due_at: "not-a-time" } },
    {
      dispute: {
        evidence: {
          documents: [
            { id: "file_missing", document_type: "digital_fulfillment" },
          ],
        },
      },
    },
    { dispute: { _policyCopies: {} } },
  ]) {
    const result = await control("seed", {
      ...baseSeed,
      scenarios: [...baseSeed.scenarios, bad],
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.deepEqual(
      (await control("status", undefined, "GET")).body.resources,
      before,
    );
  }
  const duplicate = await control("seed", {
    ...baseSeed,
    scenarios: [...baseSeed.scenarios, { dispute: { id: "dspt_atomic" } }],
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(
    (await control("status", undefined, "GET")).body.resources,
    before,
  );
  assert.equal((await control("seed", baseSeed)).status, 201);
  const after = (await control("status", undefined, "GET")).body.resources;
  assert.equal((await control("seed", baseSeed)).status, 409);
  assert.deepEqual(
    (await control("status", undefined, "GET")).body.resources,
    after,
  );
  assert.equal(
    (await control("seed", { account_id: "biz_missing", scenarios: [{}] }))
      .status,
    404,
  );
});

test("custom Money and refund fixtures preserve precision and exclude pending/failed refunds from totals", async () => {
  const eur = (amount) => ({
    amount,
    currency: "eur",
    decimals: 2,
    display_decimals: 2,
  });
  const result = await control("seed", {
    scenarios: [
      {
        payment: { currency: "eur", total: eur("1.00") },
        refunds: [
          { amount: eur("0.10"), status: "succeeded" },
          { amount: eur("0.20"), status: "succeeded" },
          { amount: eur("0.60"), status: "pending" },
          { amount: eur("0.60"), status: "failed" },
        ],
      },
      {
        payment: {
          total: {
            amount: "1500",
            currency: "jpy",
            decimals: 0,
            display_decimals: 0,
          },
        },
        dispute: { amount: 500 },
      },
      { payment: { status: "pending" } },
    ],
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const api = client(result.body.credentials.api_token);
  const [euro, yen, pending] = result.body.scenarios;
  assert.equal(
    (await api.payments.retrieve({ id: pending.payment_id })).substatus,
    "pending",
  );
  const p = await api.payments.retrieve({ id: euro.payment_id });
  assert.deepEqual(p.refunded_amount, eur("0.30"));
  assert.equal(p.substatus, "partially_refunded");
  assert.equal(
    (await api.refunds.list({ payment_id: euro.payment_id })).data.length,
    4,
  );
  assert.equal(
    (await api.disputes.retrieve({ id: yen.dispute_id })).amount,
    500,
  );
  assert.equal(
    (await api.payments.retrieve({ id: yen.payment_id })).total.decimals,
    0,
  );
  assert.equal(
    (
      await control("seed", {
        scenarios: [{ payment: { currency: "eur", total: 1 } }],
      })
    ).status,
    400,
  );
});

test("seed and simulation controls accept the public prevented dispute status", async () => {
  const seeded = await control("seed", {
    scenarios: [{ dispute: { status: "prevented" } }, {}],
  });
  assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
  const api = client(seeded.body.credentials.api_token);
  const dispute = await api.disputes.retrieve({
    id: seeded.body.scenarios[0].dispute_id,
  });
  assert.equal(dispute.status, "prevented");
  assert.equal(dispute.evidence_editable, false);
  assert.equal(dispute.acceptable, false);
  const transitioned = await control(
    `disputes/${seeded.body.scenarios[1].dispute_id}`,
    { status: "prevented" },
    "PATCH",
  );
  assert.equal(transitioned.status, 200);
  assert.equal(transitioned.body.status, "prevented");
  assert.equal(
    (await api.disputes.list({ statuses: ["prevented"] })).data.length,
    2,
  );
  const created = await control("scenarios", { status: "prevented" });
  assert.equal(created.status, 201);
  assert.equal(created.body.event.data.status, "prevented");
});

test("seeding preserves unknown settlement amounts and validates known charge refunds atomically", async () => {
  const eur = (amount) => ({
    amount,
    currency: "eur",
    decimals: 2,
    display_decimals: 2,
  });
  const scenario = {
    payment: { total: null, presentment_total: eur("9.99") },
    refunds: [
      { amount: null, original_amount: eur("1.00"), status: "succeeded" },
    ],
  };
  const seeded = await control("seed", {
    scenarios: [
      scenario,
      { ...scenario, payment: { ...scenario.payment, currency: "eur" } },
      {
        ...scenario,
        payment: { ...scenario.payment, total: 9.99, refundable: true },
      },
    ],
  });
  assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
  const api = client(seeded.body.credentials.api_token);
  const ids = seeded.body.scenarios[0];
  const payment = await api.payments.retrieve({ id: ids.payment_id });
  assert.equal(payment.total, null);
  assert.equal(payment.refunded_amount, null);
  assert.deepEqual(payment.presentment_total, eur("9.99"));
  assert.deepEqual(payment.presentment_refunded_amount, eur("1.00"));
  assert.equal(payment.substatus, "partially_refunded");
  const refund = await api.refunds.retrieve({ id: ids.refund_ids[0] });
  assert.equal(refund.amount, null);
  assert.deepEqual(refund.original_amount, eur("1.00"));
  assert.equal(
    (await api.disputes.retrieve({ id: ids.dispute_id })).amount,
    9.99,
  );
  for (const status of ["failed", "succeeded"]) {
    const completed = await control(
      `refunds/${ids.refund_ids[0]}`,
      { status },
      "PATCH",
    );
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    const updated = await api.payments.retrieve({ id: ids.payment_id });
    assert.equal(updated.refunded_amount, null);
    assert.deepEqual(
      updated.presentment_refunded_amount,
      eur(status === "succeeded" ? "1.00" : "0.00"),
    );
  }
  await assert.rejects(
    api.payments.refund({ id: ids.payment_id }),
    (error) => error.statusCode === 501,
  );
  for (const other of seeded.body.scenarios.slice(1)) {
    const payment = await api.payments.retrieve({ id: other.payment_id });
    assert.equal(payment.refunded_amount, null);
    assert.deepEqual(payment.presentment_refunded_amount, eur("1.00"));
    await assert.rejects(
      api.payments.refund({ id: other.payment_id }),
      (error) => error.statusCode === 501,
    );
  }
  const before = (await control("status", undefined, "GET")).body.resources;
  for (const bad of [
    { ...scenario, refunds: [{ amount: null }] },
    { ...scenario, refunds: [{ amount: null, original_amount: eur("10.00") }] },
    { payment: { total: null } },
  ]) {
    assert.equal((await control("seed", { scenarios: [{}, bad] })).status, 400);
    assert.deepEqual(
      (await control("status", undefined, "GET")).body.resources,
      before,
    );
  }
});

test("18-decimal Money fixtures retain exact totals and refund arithmetic", async () => {
  const eth = (amount) => ({
    amount,
    currency: "eth",
    decimals: 18,
    display_decimals: 18,
  });
  const seeded = await control("seed", {
    scenarios: [
      {
        payment: { total: eth("0.123456789012345678") },
        refunds: [
          { amount: eth("0.000000000000000001") },
          { amount: eth("0.000000000000000002") },
        ],
      },
    ],
  });
  assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
  const api = client(seeded.body.credentials.api_token);
  const payment = await api.payments.retrieve({
    id: seeded.body.scenarios[0].payment_id,
  });
  assert.deepEqual(payment.total, eth("0.123456789012345678"));
  assert.deepEqual(payment.refunded_amount, eth("0.000000000000000003"));
  assert.deepEqual(
    payment.presentment_refunded_amount,
    payment.refunded_amount,
  );
  assert.equal(payment.substatus, "partially_refunded");
  assert.equal(
    (
      await control("seed", {
        scenarios: [{ payment: { total: eth("0.0000000000000000001") } }],
      })
    ).status,
    400,
  );
});

test("seed precision limits reject excessive allocation atomically", async () => {
  const before = (await control("status", undefined, "GET")).body.resources;
  const excessive = {
    amount: "1",
    currency: "eth",
    decimals: 1_000_000_000,
    display_decimals: 18,
  };
  for (const scenario of [
    { payment: { total: excessive } },
    { payment: { presentment_total: excessive } },
    { refunds: [{ amount: excessive }] },
    { payment: { amount_after_fees: excessive } },
  ]) {
    const result = await control("seed", { scenarios: [{}, scenario] });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.match(result.body.error.message, /<= 100/);
    assert.deepEqual(
      (await control("status", undefined, "GET")).body.resources,
      before,
    );
  }
});

test("seeded dispute alerts filter, sort, page, scope and notify over HTTP", async () => {
  const seeded = await control("seed", {
    account: { id: "biz_alerts" },
    scenarios: [
      {
        payment: {
          id: "pay_alert_efw",
          total: 40,
          created_at: "2026-10-01T00:00:00Z",
        },
        dispute: null,
        alerts: [
          {
            id: "dspa_alert_efw",
            type: "early_fraud_warning",
            source: "tc40",
            card_brand: "Visa",
            reported_at: "2026-10-02T00:00:00Z",
            created_at: "2026-10-02T01:00:00Z",
          },
          {
            id: "dspa_alert_cdrn",
            type: "dispute_alert",
            source: "cdrn",
            category: "customer_dispute",
            amount: 25,
            fee: 15,
            reported_at: "2026-10-03T00:00:00Z",
            created_at: "2026-10-03T01:00:00Z",
          },
        ],
      },
      {
        payment: {
          id: "pay_alert_rdr",
          total: 60,
          auto_refunded: true,
          created_at: "2026-10-01T00:00:00Z",
        },
        dispute: null,
        alerts: [
          {
            id: "dspa_alert_rdr",
            type: "rapid_dispute_resolution",
            reported_at: "2026-10-04T00:00:00Z",
            created_at: "2026-10-04T01:00:00Z",
          },
        ],
      },
    ],
  });
  assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
  assert.deepEqual(
    seeded.body.scenarios.map((row) => [row.dispute_id, row.alert_ids]),
    [
      [null, ["dspa_alert_efw", "dspa_alert_cdrn"]],
      [null, ["dspa_alert_rdr"]],
    ],
  );
  const api = client(seeded.body.credentials.api_token);
  assert.equal((await api.disputes.list({})).data.length, 0);
  const ids = async (query) =>
    (await api.disputeAlerts.list(query)).data.map((row) => row.id);
  assert.deepEqual(await ids({}), [
    "dspa_alert_rdr",
    "dspa_alert_cdrn",
    "dspa_alert_efw",
  ]);
  assert.deepEqual(await ids({ type: "early_fraud_warning" }), [
    "dspa_alert_efw",
  ]);
  assert.deepEqual(await ids({ payment_id: "pay_alert_rdr" }), [
    "dspa_alert_rdr",
  ]);
  assert.deepEqual(await ids({ order: "amount", direction: "asc" }), [
    "dspa_alert_cdrn",
    "dspa_alert_efw",
    "dspa_alert_rdr",
  ]);
  assert.deepEqual(
    await ids({ order: "reported_at", created_after: "2026-10-02T12:00:00Z" }),
    ["dspa_alert_rdr", "dspa_alert_cdrn"],
  );
  const paged = [];
  for await (const row of await api.disputeAlerts.list({ first: 1 }))
    paged.push(row.id);
  assert.deepEqual(paged, await ids({}));

  const fraud = await api.disputeAlerts.retrieve({ id: "dspa_alert_efw" });
  assert.deepEqual(
    [
      fraud.account_id,
      fraud.payment_id,
      fraud.category,
      fraud.card_brand,
      fraud.amount,
      fraud.fee_charged,
      fraud.fee,
      fraud.issuer,
      fraud.transaction_at,
    ],
    [
      "biz_alerts",
      "pay_alert_efw",
      "fraud",
      "visa",
      40,
      false,
      null,
      null,
      "2026-10-01T00:00:00Z",
    ],
  );
  const notice = await api.disputeAlerts.retrieve({ id: "dspa_alert_cdrn" });
  assert.equal(notice.fee_charged, true);
  assert.deepEqual(notice.fee, {
    amount: "15.00",
    currency: "usd",
    decimals: 2,
    display_decimals: 2,
  });
  const rdr = await api.disputeAlerts.retrieve({ id: "dspa_alert_rdr" });
  assert.equal(rdr.source, "rdr");
  assert.equal(rdr.auto_refunded, true);

  for (const query of [
    { type: "chargeback" },
    { order: "evidence_due_at" },
    { created_after: "yesterday" },
  ])
    await assert.rejects(
      api.disputeAlerts.list(query),
      (error) => error.statusCode === 400,
    );
  await assert.rejects(
    api.disputeAlerts.retrieve({ id: "dspa_missing" }),
    (error) => error.statusCode === 404,
  );
  for (const token of [
    seeded.body.credentials.read_only_token,
    seeded.body.credentials.no_email_token,
  ])
    assert.equal((await client(token).disputeAlerts.list({})).data.length, 3);
  await assert.rejects(
    client(credentials.apiToken).disputeAlerts.retrieve({
      id: "dspa_alert_efw",
    }),
    (error) => error.statusCode === 403,
  );
  assert.equal(
    (await client(credentials.apiToken).disputeAlerts.list({})).data.length,
    0,
  );

  const event = await control("events", {
    type: "dispute_alert.created",
    resource_id: "dspa_alert_efw",
    deliver: true,
  });
  assert.equal(event.status, 201, JSON.stringify(event.body));
  assert.equal(received.length, 1);
  assert.equal(received[0].type, "dispute_alert.created");
  assert.equal(received[0].account_id, "biz_alerts");
  assert.deepEqual(received[0].data, fraud);
  assert.deepEqual(
    (await control("status", undefined, "GET")).body.resources
      .dispute_alert_ids,
    ["dspa_alert_efw", "dspa_alert_cdrn", "dspa_alert_rdr"],
  );
});

test("the example alert seed covers each alert type, with and without a chargeback", async () => {
  const example = JSON.parse(
    await readFile(
      new URL("../examples/http/dispute-alerts.seed.json", import.meta.url),
    ),
  );
  const seeded = await control("seed", example);
  assert.equal(seeded.status, 201, JSON.stringify(seeded.body));
  const api = client(seeded.body.credentials.api_token);
  const alerts = (await api.disputeAlerts.list({ order: "reported_at" })).data;
  assert.deepEqual(
    alerts.map((row) => [row.type, row.fee_charged]),
    [
      ["dispute_alert", false],
      ["rapid_dispute_resolution", false],
      ["dispute_alert", true],
      ["early_fraud_warning", false],
    ],
  );
  assert.equal((await api.disputes.list({})).data.length, 1);
  const refunded = await api.payments.retrieve({ id: alerts[1].payment_id });
  assert.equal(refunded.substatus, "refunded");
  assert.equal(alerts[1].auto_refunded, true);
});

test("alert seeds reject fees on fraud warnings and impossible timelines atomically", async () => {
  const before = (await control("status", undefined, "GET")).body.resources;
  for (const [alert, message] of [
    [{ type: "early_fraud_warning", fee: 15 }, /never charged a fee/],
    [
      { type: "early_fraud_warning", category: "customer_dispute" },
      /always have category fraud/,
    ],
    [{ type: "dispute_alert", fee_charged: true }, /needs an explicit fee/],
    [
      { type: "dispute_alert", fee_charged: false, fee: 15 },
      /fee must be null when fee_charged is false/,
    ],
    [{ type: "dispute_alert", source: "visa" }, /source/],
    [
      { type: "dispute_alert", payment_id: "pay_elsewhere" },
      /additional properties/,
    ],
    [
      {
        reported_at: "2026-10-05T00:00:00Z",
        created_at: "2026-10-04T00:00:00Z",
      },
      /reported_at must not be later than created_at/,
    ],
    [
      {
        transaction_at: "2026-10-06T00:00:00Z",
        reported_at: "2026-10-05T00:00:00Z",
      },
      /transaction_at must not be later than reported_at/,
    ],
    [{ reported_at: "2026-01-01T00:00:00Z" }, /backdate the payment/],
    [{ id: "dspt_not_an_alert" }, /Invalid dispute_alert fixture id/],
  ]) {
    const result = await control("seed", {
      scenarios: [{ dispute: null }, { dispute: null, alerts: [alert] }],
    });
    assert.equal(result.status, 400, JSON.stringify([alert, result.body]));
    assert.match(result.body.error.message, message);
    assert.deepEqual(
      (await control("status", undefined, "GET")).body.resources,
      before,
    );
  }
});
