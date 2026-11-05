import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// Independent partner fixture importer and raw HTTP validator. No SDK mocking,
// live credentials, external services, database, or processor is used.
// Run from the project root, or supply PROJECT_ROOT / WHOP_MOCK_MODULE.
// All receipts are written outside the checkout unless OUTPUT_DIR is explicit.
const projectRoot = resolve(process.env.PROJECT_ROOT ?? process.cwd());
const moduleUrl = pathToFileURL(
  resolve(
    process.env.WHOP_MOCK_MODULE ?? join(projectRoot, "dist/http-server.js"),
  ),
).href;
const { createHttpTestServer, LOCAL_TEST_CREDENTIALS } = await import(
  moduleUrl
);
const outputDir = process.env.OUTPUT_DIR
  ? resolve(process.env.OUTPUT_DIR)
  : await mkdtemp(join(tmpdir(), "whop-mock-fixtures-"));
await mkdir(outputDir, { recursive: true });
const out = pathToFileURL(outputDir + sep);
const label = process.env.RUN_LABEL ?? "scenario-author";
if (!/^[a-zA-Z0-9_-]+$/.test(label))
  throw new Error(
    "RUN_LABEL must contain only letters, numbers, underscores, or hyphens",
  );
const receipts = [];
const checks = [];
const money = (amount, currency, decimals, display_decimals = decimals) => ({
  amount,
  currency,
  decimals,
  display_decimals,
});
const M = (amount) => money(amount, "usd", 2);
const icon = {
  svg: "https://example.test/card.svg",
  png_1x: "https://example.test/card.png",
  png_2x: "https://example.test/card-2.png",
  png_4x: "https://example.test/card-4.png",
};
const instrument = {
  payment_method_type: "card",
  display_name: "Visa •••• 4242",
  icons: {
    square: { light: icon, dark: icon },
    card: { light: icon, dark: icon },
  },
  card: {
    brand: "visa",
    last4: "4242",
    issuer_identification_number: "424242",
    exp_month: 12,
    exp_year: 2030,
    network_transaction_id: "synthetic_mock_network_transaction",
  },
  installment_count: null,
};
const due = new Date(Date.now() + 86400000 * 14).toISOString();
const basic = (tag, currency, total, decimals, display = decimals) => ({
  payment: {
    id: `pay_qa_${tag}`,
    currency,
    total: money(total, currency, decimals, display),
    created_at: "2026-10-02T12:00:00.000Z",
    paid_at: "2026-10-02T12:00:01.000Z",
    metadata: { mock_case: tag },
  },
  dispute: {
    id: `dspt_qa_${tag}`,
    evidence_due_at: due,
    created_at: "2026-10-10T12:00:00.000Z",
    reason: "fraudulent",
  },
  refunds: [],
});
const usd = basic("usd", "usd", "100.01", 2);
Object.assign(usd.payment, {
  customer_email: "qa.buyer@example.test",
  member_id: "mem_qa_buyer",
  user: {
    id: "user_qa_buyer",
    username: "mock_qa",
    name: "Test buyer",
    profile_picture: { url: "https://example.test/avatar.png" },
  },
  payment_method_type: "card",
  payment_instrument: instrument,
});
usd.refunds = [
  {
    id: "rf_qa_usd_ok",
    amount: M("25.20"),
    status: "succeeded",
    failure_reason: "unknown",
    failure_message: "must be masked",
  },
  { id: "rf_qa_usd_wait", amount: M("10.00"), status: "pending" },
  {
    id: "rf_qa_usd_fail",
    amount: M("20.00"),
    status: "failed",
    failure_reason: "charge_disputed",
    failure_message: "The charge was disputed.",
  },
  {
    id: "rf_qa_usd_cancel",
    amount: M("5.00"),
    status: "canceled",
    failure_reason: "merchant_request",
    failure_message: "Canceled on request.",
  },
  { id: "rf_qa_usd_action", amount: M("2.00"), status: "requires_action" },
];
const jpy = basic("jpy", "jpy", "7500", 0);
jpy.refunds = [
  { id: "rf_qa_jpy_a", amount: money("3000", "jpy", 0) },
  { id: "rf_qa_jpy_b", amount: money("4500", "jpy", 0) },
  {
    id: "rf_qa_jpy_fail",
    amount: money("900", "jpy", 0),
    status: "failed",
    failure_reason: "bank_declined",
  },
];
Object.assign(jpy.dispute, { status: "lost", fee: money("500", "jpy", 0) });
const cop = basic("cop", "cop", "1234.56", 2, 0);
cop.refunds = [
  { id: "rf_qa_cop_a", amount: money("0.01", "cop", 2, 0) },
  { id: "rf_qa_cop_b", amount: money("4.55", "cop", 2, 0) },
];
Object.assign(cop.dispute, {
  status: "warning_needs_response",
  reason: "subscription_canceled",
  inquiry: true,
});
const kwd = basic("kwd", "kwd", "1.005", 3);
kwd.refunds = [
  { id: "rf_qa_kwd_a", amount: money("0.001", "kwd", 3) },
  { id: "rf_qa_kwd_b", amount: money("0.004", "kwd", 3) },
];
kwd.payment.amount_after_fees = money("0.991", "kwd", 3);
const fx = basic("fx", "eur", "100.00", 2);
// This fixture assumes no buyer fees, so presentment_total is the charged amount.
// Fees and exchange rates are explicit inputs rather than calculated values.
Object.assign(fx.payment, {
  presentment_total: money("16000", "jpy", 0),
  usd_total: M("107.50"),
  payment_method_type: "card",
  payment_instrument: instrument,
});
fx.refunds = [
  {
    id: "rf_qa_fx",
    amount: money("10.00", "eur", 2),
    original_amount: money("1600", "jpy", 0),
  },
];
const guest = basic("guest", "usd", "29.95", 2);
Object.assign(guest.payment, {
  user: null,
  member_id: null,
  customer_email: null,
  payment_method_type: "paypal",
  payment_instrument: null,
  tax_amount: null,
  refunded_at: null,
});
Object.assign(guest.dispute, {
  status: "warning_closed",
  reason: "product_not_received",
  buyer: {
    email: null,
    name: null,
    username: null,
    user_id: null,
    member_id: null,
  },
});
const rdr = basic("rdr", "usd", "60.00", 2);
Object.assign(rdr.dispute, {
  status: "lost",
  visa_rdr: true,
  reason: "fraudulent",
});
const input = process.argv[2]
  ? JSON.parse(await readFile(process.argv[2], "utf8"))
  : {
      account: {
        id: "biz_qa_dataset",
        title: "Synthetic fixture merchant",
      },
      scenarios: [usd, jpy, cop, kwd, fx, guest, rdr],
    };
await writeFile(
  new URL(`dataset-${label}.json`, out),
  JSON.stringify(input, null, 2) + "\n",
);
const server = createHttpTestServer({
  ...LOCAL_TEST_CREDENTIALS,
  automaticWebhookRetries: false,
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let token = LOCAL_TEST_CREDENTIALS.apiToken;
const redact = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(redact)
      : Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            /token|secret/i.test(k)
              ? "<synthetic credential omitted>"
              : redact(v),
          ]),
        )
    : value;
async function req(
  path,
  {
    body,
    admin = false,
    auth = token,
    method = body === undefined ? "GET" : "POST",
  } = {},
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      authorization: `Bearer ${admin ? LOCAL_TEST_CREDENTIALS.adminToken : auth}`,
      "content-type": "application/json",
      "api-version-date": "2026-10-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  receipts.push({
    method,
    path,
    request: body,
    status: response.status,
    response: redact(payload),
  });
  return { status: response.status, data: payload };
}
async function check(name, source, test) {
  try {
    const details = await test();
    checks.push({ name, source, outcome: "pass", details });
  } catch (error) {
    checks.push({
      name,
      source,
      outcome: "fail",
      message: error.message,
      actual: error.actual,
      expected: error.expected,
    });
  }
}
const sourceRefund = "Public Refund schema and explicit seeded expectations";
const sourceMoney = "Public Money fields and explicit seeded currency precision";

try {
  const imported = await req("/_test/seed", { admin: true, body: input });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  token = imported.data.credentials.api_token;
  const noEmail = imported.data.credentials.no_email_token;
  const account = imported.data.account_id;
  const readPayment = async (id) => (await req(`/api/v1/payments/${id}`)).data;
  const readDispute = async (id, auth) =>
    (await req(`/api/v1/disputes/${id}`, { auth: auth ?? token })).data;
  const readRefund = async (id) => (await req(`/api/v1/refunds/${id}`)).data;
  const payments = Object.fromEntries(
    await Promise.all(
      input.scenarios.map(async (s) => [
        s.payment.id,
        await readPayment(s.payment.id),
      ]),
    ),
  );
  const disputes = Object.fromEntries(
    await Promise.all(
      input.scenarios.map(async (s) => [
        s.dispute.id,
        await readDispute(s.dispute.id),
      ]),
    ),
  );
  if (!process.argv[2]) {
    await check(
      "Exact non-USD money precision survives HTTP",
      sourceMoney,
      async () => {
        for (const s of [jpy, cop, kwd, fx])
          assert.deepEqual(payments[s.payment.id].total, s.payment.total);
        return [
          "JPY zero decimal",
          "COP two carried / zero displayed",
          "KWD three decimals",
          "EUR two decimals",
        ];
      },
    );
    await check(
      "Only succeeded refunds count toward settlement totals",
      sourceRefund,
      async () => {
        assert.deepEqual(payments[usd.payment.id].refunded_amount, M("25.20"));
        assert.deepEqual(
          payments[jpy.payment.id].refunded_amount,
          money("7500", "jpy", 0),
        );
        assert.deepEqual(
          payments[cop.payment.id].refunded_amount,
          money("4.56", "cop", 2, 0),
        );
        assert.deepEqual(
          payments[kwd.payment.id].refunded_amount,
          money("0.005", "kwd", 3),
        );
      },
    );
    await check(
      "Succeeded refund failure details are hidden; failed/canceled details survive",
      sourceRefund,
      async () => {
        const succeeded = await readRefund("rf_qa_usd_ok");
        const failed = await readRefund("rf_qa_usd_fail");
        const canceled = await readRefund("rf_qa_usd_cancel");
        assert.equal(succeeded.failure_reason, null);
        assert.equal(succeeded.failure_message, null);
        assert.equal(failed.failure_reason, "charge_disputed");
        assert.equal(canceled.failure_reason, "merchant_request");
      },
    );
    await check(
      "Requires-action refund remains accessible",
      sourceRefund,
      async () =>
        assert.equal(
          (await readRefund("rf_qa_usd_action")).status,
          "requires_action",
        ),
    );
    await check(
      "Explicit settlement and presentment refund money stay separate",
      sourceRefund,
      async () => {
        const refund = await readRefund("rf_qa_fx");
        assert.deepEqual(refund.amount, money("10.00", "eur", 2));
        assert.deepEqual(refund.original_amount, money("1600", "jpy", 0));
      },
    );
    await check(
      "Dispute embedded payment uses charged amount/currency",
      "Explicit local fixture expectation",
      async () => {
        assert.deepEqual(
          {
            amount: disputes[fx.dispute.id].payment.amount,
            currency: disputes[fx.dispute.id].payment.currency,
          },
          { amount: 16000, currency: "jpy" },
        );
      },
    );
    await check(
      "Payment currency filtering uses receipt/presentment currency",
      "Explicit local fixture expectation",
      async () => {
        const found = await req("/api/v1/payments?currency=jpy&first=100");
        assert.equal(found.status, 200);
        assert.deepEqual(
          found.data.data.map((x) => x.id).sort(),
          [jpy.payment.id, fx.payment.id].sort(),
        );
      },
    );
    await check(
      "Same-currency presentment refunded amount matches successful total",
      "Explicit local fixture expectation",
      async () => {
        assert.deepEqual(
          payments[usd.payment.id].presentment_refunded_amount,
          M("25.20"),
        );
      },
    );
    await check(
      "Legacy card snapshots can be null while instrument details are populated",
      "Explicit local fixture expectation",
      async () => {
        // Snapshot fields and instrument details are independent fixture inputs.
        // This fixture supplies instrument details without legacy card snapshots.
        assert.deepEqual(
          {
            brand: disputes[usd.dispute.id].payment.card_brand,
            last4: disputes[usd.dispute.id].payment.card_last4,
          },
          { brand: null, last4: null },
        );
        assert.equal(
          disputes[usd.dispute.id].payment.payment_instrument.card.brand,
          "visa",
        );
        assert.equal(
          disputes[usd.dispute.id].payment.payment_instrument.card.last4,
          "4242",
        );
      },
    );
    await check(
      "Guest null buyer context survives",
      "Explicit local fixture expectation",
      async () =>
        assert.deepEqual(disputes[guest.dispute.id].buyer, guest.dispute.buyer),
    );
    await check(
      "Buyer context/email permission is independent from dispute read",
      "Explicit local fixture expectation",
      async () => {
        const full = disputes[usd.dispute.id].buyer;
        assert.equal(full.user_id, usd.payment.user.id);
        assert.equal(full.member_id, usd.payment.member_id);
        assert.equal(full.email, usd.payment.customer_email);
        const redacted = (await readDispute(usd.dispute.id, noEmail)).buyer;
        assert.equal(redacted.email, null);
        assert.equal(redacted.user_id, usd.payment.user.id);
      },
    );
    await check(
      "Inquiry and RDR fixture semantics remain distinguishable",
      "Explicit local fixture expectation",
      async () => {
        assert.equal(disputes[cop.dispute.id].inquiry, true);
        assert.equal(disputes[cop.dispute.id].acceptable, false);
        assert.equal(disputes[rdr.dispute.id].status, "prevented");
        const list = await req("/api/v1/disputes?first=100");
        assert(!list.data.data.some((x) => x.id === rdr.dispute.id));
      },
    );
    await check(
      "Refund pagination contains the full seeded status mixture",
      "Explicit local fixture expectation",
      async () => {
        let after;
        const ids = [];
        const statuses = new Set();
        do {
          const result = await req(
            "/api/v1/refunds?first=2" +
              (after ? `&after=${encodeURIComponent(after)}` : ""),
          );
          assert.equal(result.status, 200);
          ids.push(...result.data.data.map((x) => x.id));
          result.data.data.forEach((x) => statuses.add(x.status));
          after = result.data.page_info.has_next_page
            ? result.data.page_info.end_cursor
            : null;
        } while (after);
        assert.equal(new Set(ids).size, 13);
        assert.equal(ids.length, 13);
        assert.deepEqual([...statuses].sort(), [
          "canceled",
          "failed",
          "pending",
          "requires_action",
          "succeeded",
        ]);
      },
    );
    await check(
      "Invalid mixed batch does not retain the earlier valid case",
      "Test-control atomicity (not a native endpoint)",
      async () => {
        const before = (await req("/_test/status", { admin: true })).data
          .resources;
        const bad = basic("bad", "usd", "10.00", 2);
        bad.refunds = [{ amount: M("10.01") }];
        const r = await req("/_test/seed", {
          admin: true,
          body: {
            account_id: account,
            scenarios: [basic("atomic", "usd", "10.00", 2), bad],
          },
        });
        assert.equal(r.status, 400);
        const after = (await req("/_test/status", { admin: true })).data
          .resources;
        assert.deepEqual(after, before);
      },
    );
    const invalids = [
      [
        "currency mismatch",
        () => {
          const s = basic("badcurr", "eur", "10.00", 2);
          s.refunds = [{ amount: M("1.00") }];
          return s;
        },
      ],
      ["precision overflow", () => basic("badprec", "jpy", "10.5", 0)],
      ["negative payment", () => basic("badneg", "usd", "-10.00", 2)],
      [
        "over-refund",
        () => {
          const s = basic("badrefund", "usd", "10.00", 2);
          s.refunds = [{ amount: M("11.00") }];
          return s;
        },
      ],
    ];
    await check(
      "Invalid money fixture imports fail before storage",
      "Test-control validation (not a native endpoint)",
      async () => {
        for (const [name, make] of invalids) {
          const result = await req("/_test/seed", {
            admin: true,
            body: { account_id: account, scenarios: [make()] },
          });
          assert.equal(result.status, 400, name);
        }
      },
    );
    await check(
      "Duplicate imported IDs are refused without replacing data",
      "Test-control identity safety (not a native endpoint)",
      async () => {
        const duplicate = await req("/_test/seed", {
          admin: true,
          body: { account_id: account, scenarios: [usd] },
        });
        assert.equal(duplicate.status, 409);
        assert.deepEqual(
          await readPayment(usd.payment.id),
          payments[usd.payment.id],
        );
      },
    );
    await check(
      "Append reuses the merchant and returns usable existing credentials",
      "Test-control append (not a native endpoint)",
      async () => {
        const append = await req("/_test/seed", {
          admin: true,
          body: {
            account_id: account,
            scenarios: [basic("append", "usd", "11.00", 2)],
          },
        });
        assert.equal(append.status, 201);
        assert.equal(append.data.account_id, account);
        assert.equal(append.data.credentials.api_token, token);
        assert.equal(
          (await readPayment("pay_qa_append")).total.amount,
          "11.00",
        );
      },
    );
    await check(
      "Draft receipts are excluded from ordinary payment lists",
      "Explicit local fixture expectation",
      async () => {
        const draft = basic("draft", "usd", "10.00", 2);
        Object.assign(draft.payment, {
          status: "draft",
          substatus: "drafted",
          paid_at: null,
        });
        const seeded = await req("/_test/seed", {
          admin: true,
          body: { account_id: account, scenarios: [draft] },
        });
        assert.equal(seeded.status, 201);
        assert.equal((await req("/api/v1/payments/pay_qa_draft")).status, 200);
        const list = await req("/api/v1/payments?first=100");
        assert(
          !list.data.data.some((x) => x.id === "pay_qa_draft"),
          "draft fixture leaked into payment list",
        );
      },
    );
    await check(
      "Reset removes imported records and invalidates their generated credential",
      "Test-control reset (not a native endpoint)",
      async () => {
        const reset = await req("/_test/reset", { admin: true, body: {} });
        assert.equal(reset.status, 200);
        const after = (await req("/_test/status", { admin: true })).data
          .resources;
        assert(!after.payment_ids.includes("pay_qa_usd"));
        assert.equal((await req("/api/v1/payments/pay_qa_usd")).status, 401);
      },
    );
  }
} catch (error) {
  checks.push({
    name: "Import/setup",
    outcome: "fail",
    message: error.message,
  });
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const report = {
    label,
    generated_at: new Date().toISOString(),
    expected_from:
      "Public API shapes and explicit local fixture expectations; production backend not executed",
    actual_target: moduleUrl,
    infrastructure:
      "Existing Node HTTP server and fixture engine; fresh in-memory session; ephemeral loopback TCP port; synthetic data only",
    totals: {
      checks: checks.length,
      pass: checks.filter((x) => x.outcome === "pass").length,
      fail: checks.filter((x) => x.outcome === "fail").length,
      http_exchanges: receipts.length,
    },
    checks,
  };
  await writeFile(
    new URL(`report-${label}.json`, out),
    JSON.stringify(report, null, 2) + "\n",
  );
  await writeFile(
    new URL(`receipts-${label}.json`, out),
    JSON.stringify(receipts, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        suite: "Partner fixture author",
        ...report.totals,
        output_dir: outputDir,
      },
      null,
      2,
    ),
  );
  if (report.totals.fail > 0) process.exitCode = 1;
}
