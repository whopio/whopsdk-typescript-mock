import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { WhopClient } from "@whop/sdk";
import { unwrapWebhook } from "@whop/sdk/helpers";
import WhopMock, {
  API_VERSION_DATE,
  isKnownWebhookEvent,
} from "../dist/index.js";

let transport;
let client;
beforeEach(() => {
  WhopMock.start();
  transport = WhopMock.createFetch();
  client = sdk(transport);
});
afterEach(() => WhopMock.stop());
const sdk = (fetch) =>
  new WhopClient({
    token: "test-only",
    baseUrl: "https://api.whop.mock/api/v1",
    apiVersionDate: API_VERSION_DATE,
    maxRetries: 0,
    fetch,
  });
const stack = (dispute = {}, payment = {}) =>
  WhopMock.createTestHelper().createDisputeWithPayment({
    company: { id: "biz_mock" },
    payment: { total: 99.99, ...payment },
    dispute: { evidence_due_at: "2099-01-01T00:00:00.000Z", ...dispute },
  });
const httpError = (status) => (error) => {
  assert.equal(error.statusCode, status);
  assert.equal(typeof error.body.error.message, "string");
  return true;
};
async function upload(
  filename = "mock-evidence.pdf",
  bytes = Buffer.from("%PDF-1.4\nfixture bytes\n%%EOF"),
) {
  const pending = await client.files.create({
    filename,
    byte_size: bytes.length,
  });
  assert.equal(pending.upload_status, "pending");
  assert.equal(pending.size, null);
  const result = await transport(pending.upload_url, {
    method: "PUT",
    headers: pending.upload_headers,
    body: bytes,
  });
  assert.equal(result.status, 200);
  return client.files.retrieve({ id: pending.id });
}

test("current SDK reads linked context, Money amounts and refund filters", async () => {
  const { dispute, payment, company } = stack();
  const helper = WhopMock.createTestHelper();
  const refund = helper.createRefund({
    payment_id: payment.id,
    amount: 20,
    status: "pending",
  });
  helper.createRefund({ payment_id: "pay_unrelated", amount: 5 });
  const d = await client.disputes.retrieve({ id: dispute.id });
  assert.match(d.id, /^dspt_/);
  assert.equal(d.account_id, company.id);
  assert.equal(d.evidence_editable, true);
  assert.equal(d.evidence_locked_reason, null);
  assert.equal(d.payment.id, payment.id);
  assert.equal(d.payment.payment_processor, null);
  assert.equal(d.amount, 99.99);
  const p = await client.payments.retrieve({ id: d.payment.id });
  assert.deepEqual(p.total, {
    amount: "99.99",
    currency: "usd",
    decimals: 2,
    display_decimals: 2,
  });
  const refunds = await client.refunds.list({
    payment_id: p.id,
    account_id: company.id,
  });
  assert.equal(refunds.data.length, 1);
  assert.match(refunds.data[0].id, /^rf_/);
  assert.equal(refunds.data[0].id, refund.id);
  assert.equal(refunds.data[0].amount.amount, "20.00");
  assert.equal(refunds.data[0].status, "pending");
  assert.equal(refunds.data[0].payment_id, p.id);
  assert.equal(
    (await client.refunds.retrieve({ id: refund.id })).id,
    refund.id,
  );
});

test("preserves explicit non-USD precision and nullable payment/refund amounts", async () => {
  const total = {
    amount: "1234",
    currency: "jpy",
    decimals: 0,
    display_decimals: 0,
  };
  const { payment } = stack(
    {},
    { currency: "jpy", total, tax_refunded_amount: { ...total, amount: "0" } },
  );
  const p = await client.payments.retrieve({ id: payment.id });
  assert.deepEqual(p.total, total);
  assert.equal(p.tax_refunded_amount.currency, "jpy");
  const refund = WhopMock.createTestHelper().createRefund({
    payment_id: payment.id,
    currency: "jpy",
    amount: null,
    original_amount: total,
  });
  const r = await client.refunds.retrieve({ id: refund.id });
  assert.equal(r.amount, null);
  assert.deepEqual(r.original_amount, total);
});

test("SDK async iteration finishes, filters accounts and status arrays, and sorts pages", async () => {
  const { company, payment } = stack({ status: "won" });
  const helper = WhopMock.createTestHelper();
  for (let i = 0; i < 25; i++)
    helper.createDispute({
      company_id: company.id,
      payment_id: payment.id,
      amount: i + 1,
      status: i % 2 ? "needs_response" : "warning_needs_response",
      evidence_due_at: null,
    });
  helper.createDispute({ company_id: "biz_other" });
  const page = await client.disputes.list({
    account_id: company.id,
    first: 7,
    status: ["needs_response", "warning_needs_response"],
    order: "amount",
    direction: "asc",
  });
  const records = [];
  for await (const record of page) {
    records.push(record);
    assert.ok(records.length <= 25, "pagination must terminate");
  }
  assert.deepEqual(
    records.map((row) => row.amount),
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
  assert.equal(new Set(records.map((row) => row.id)).size, 25);
  await assert.rejects(
    client.disputes.list({ account_id: "biz_absent" }),
    httpError(404),
  );
});

test("file upload, PATCH and uploadEvidence persist a replacement document set", async () => {
  const { dispute } = stack();
  const a = await upload();
  const b = await upload("second.pdf");
  assert.equal(a.upload_status, "ready");
  assert.equal(a.content_type, "application/pdf");
  assert.ok(a.size > 0);
  const listed = await client.files.list({ file_ids: [a.id, b.id] });
  assert.equal(listed.data.length, 2);
  const first = await client.disputes.update({
    id: dispute.id,
    evidence: {
      notes: "Consolidated test defense",
      documents: [{ id: a.id, document_type: "digital_fulfillment" }],
    },
  });
  assert.equal(first.evidence.notes, "Consolidated test defense");
  assert.equal(first.evidence.documents[0].id, a.id);
  const replaced = await client.disputes.uploadEvidence({
    id: dispute.id,
    documents: [{ id: b.id, document_type: "customer_communication" }],
  });
  assert.deepEqual(
    replaced.evidence.documents.map((doc) => doc.id),
    [b.id],
  );
  assert.equal(replaced.evidence.notes, first.evidence.notes);
  const read = await client.disputes.retrieve({ id: dispute.id });
  assert.deepEqual(read.evidence, replaced.evidence);
  const cleared = await client.disputes.update({
    id: dispute.id,
    evidence: { documents: [], notes: null },
  });
  assert.deepEqual(cleared.evidence.documents, []);
  assert.equal(cleared.evidence.notes, null);
});

test("submission is pending until an explicit accepted/rejected processor outcome", async () => {
  const { dispute } = stack();
  const file = await upload();
  await client.disputes.update({
    id: dispute.id,
    evidence: {
      documents: [{ id: file.id, document_type: "digital_fulfillment" }],
    },
  });
  const pending = await client.disputes.submit({ id: dispute.id });
  assert.equal(pending.status, "needs_response");
  assert.equal(pending.evidence_submitted_at, null);
  await client.disputes.submit({ id: dispute.id }); // Duplicate workflow start is idempotent.
  const rejected = WhopMock.completeDisputeSubmission(dispute.id, "rejected");
  assert.equal(rejected.status, "needs_response");
  assert.equal(rejected.evidence_submitted_at, null);
  await client.disputes.submit({ id: dispute.id });
  WhopMock.completeDisputeSubmission(dispute.id, "accepted");
  const accepted = await client.disputes.retrieve({ id: dispute.id });
  assert.equal(accepted.status, "under_review");
  assert.ok(accepted.evidence_submitted_at);
  assert.equal(accepted.evidence_editable, false);
  assert.equal(accepted.evidence_locked_reason, "submitted");
  await assert.rejects(
    client.disputes.update({ id: dispute.id, evidence: { notes: "late" } }),
    httpError(400),
  );
  await assert.rejects(
    client.disputes.submit({ id: dispute.id }),
    httpError(400),
  );
  assert.throws(
    () => WhopMock.completeDisputeSubmission(dispute.id, "accepted"),
    /No pending submission/,
  );
});

test("deadlines, terminal cases, inquiries and missing resources follow current read/write behavior", async () => {
  const expired = stack({ evidence_due_at: "2020-01-01T00:00:00Z" }).dispute;
  const d = await client.disputes.retrieve({ id: expired.id });
  assert.equal(d.status, "under_review");
  assert.equal(d.evidence_locked_reason, "response_window_closed");
  await assert.rejects(
    client.disputes.submit({ id: expired.id }),
    httpError(400),
  );
  for (const status of ["won", "lost", "prevented", "warning_closed"]) {
    const terminal = stack({ status }).dispute;
    assert.equal(
      (await client.disputes.retrieve({ id: terminal.id }))
        .evidence_locked_reason,
      "not_contestable",
    );
    await assert.rejects(
      client.disputes.update({ id: terminal.id, evidence: { notes: "no" } }),
      httpError(400),
    );
  }
  const inquiry = stack({
    status: "warning_needs_response",
    evidence_due_at: null,
  }).dispute;
  await client.disputes.submit({ id: inquiry.id });
  assert.equal(
    WhopMock.completeDisputeSubmission(inquiry.id, "accepted").status,
    "warning_under_review",
  );
  await assert.rejects(
    client.payments.retrieve({ id: "pay_missing" }),
    httpError(404),
  );
  await assert.rejects(
    client.disputes.retrieve({ id: "dspt_missing" }),
    httpError(404),
  );
});

test("invalid evidence is rejected atomically: pending, missing, duplicate and unsupported files", async () => {
  const { dispute } = stack();
  const valid = await upload();
  await client.disputes.update({
    id: dispute.id,
    evidence: {
      notes: "preserve",
      documents: [{ id: valid.id, document_type: "digital_fulfillment" }],
    },
  });
  const pending = await client.files.create({ filename: "pending.pdf" });
  const unsupportedFile = await upload("not-evidence.txt", Buffer.from("text"));
  for (const documents of [
    [{ id: pending.id, document_type: "digital_fulfillment" }],
    [{ id: "file_missing", document_type: "digital_fulfillment" }],
    [{ id: valid.id, document_type: "made_up_category" }],
    [{ id: unsupportedFile.id, document_type: "digital_fulfillment" }],
    Array.from({ length: 2 }, () => ({
      id: valid.id,
      document_type: "digital_fulfillment",
    })),
    Array.from({ length: 11 }, () => ({
      id: valid.id,
      document_type: "digital_fulfillment",
    })),
  ]) {
    await assert.rejects(
      client.disputes.update({
        id: dispute.id,
        evidence: { notes: "must roll back", documents },
      }),
      httpError(400),
    );
    const unchanged = await client.disputes.retrieve({ id: dispute.id });
    assert.equal(unchanged.evidence.notes, "preserve");
    assert.equal(unchanged.evidence.documents[0].id, valid.id);
  }
});

test("upload caps and smaller processor submission budgets are separate checks", async () => {
  const { dispute } = stack({ provider: "stripe" });
  const large = await upload("large.pdf", Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(
    client.disputes.uploadEvidence({
      id: dispute.id,
      documents: [{ id: large.id, document_type: "digital_fulfillment" }],
    }),
    httpError(400),
  );
  const files = [];
  for (let i = 0; i < 3; i++)
    files.push(await upload(`packet-${i}.pdf`, Buffer.alloc(9 * 1024 * 1024)));
  await assert.rejects(
    client.disputes.uploadEvidence({
      id: dispute.id,
      documents: files.map((f) => ({
        id: f.id,
        document_type: "digital_fulfillment",
      })),
    }),
    httpError(400),
  );
  // A 4 MiB PDF fits the upload cap, but Stripe's current seller budget is 4 MiB minus 128 KiB.
  const packet = await upload("packet.pdf", Buffer.alloc(4 * 1024 * 1024));
  await client.disputes.uploadEvidence({
    id: dispute.id,
    documents: [{ id: packet.id, document_type: "digital_fulfillment" }],
  });
  await assert.rejects(
    client.disputes.submit({ id: dispute.id }),
    httpError(400),
  );
  assert.equal(
    (await client.disputes.retrieve({ id: dispute.id })).evidence_submitted_at,
    null,
  );
});

test("file ownership and optional account visibility keep fixture clients separate", async () => {
  const { dispute, company } = stack();
  const file = await upload();
  const other = sdk(WhopMock.createFetch({ actorId: "other" }));
  await assert.rejects(other.files.retrieve({ id: file.id }), httpError(404));
  assert.equal(
    (await other.files.list({ file_ids: [file.id] })).data.length,
    0,
  );
  // A known unattached file ID resolves independently of its creator.
  await other.disputes.uploadEvidence({
    id: dispute.id,
    documents: [{ id: file.id, document_type: "digital_fulfillment" }],
  });
  await client.disputes.uploadEvidence({
    id: dispute.id,
    documents: [{ id: file.id, document_type: "digital_fulfillment" }],
  });
  const otherDispute = stack().dispute;
  await assert.rejects(
    client.disputes.uploadEvidence({
      id: otherDispute.id,
      documents: [{ id: file.id, document_type: "digital_fulfillment" }],
    }),
    httpError(400),
  );
  const scoped = sdk(WhopMock.createFetch({ accountIds: ["biz_other"] }));
  await assert.rejects(
    scoped.disputes.list({ account_id: company.id }),
    httpError(403),
  );
  await assert.rejects(
    scoped.disputes.retrieve({ id: dispute.id }),
    httpError(403),
  );
});

test("current webhook envelope verifies with SDK helper and rejects tampering and stale delivery", async () => {
  const { dispute, company } = stack();
  const secret = "ws_fixture_secret_not_a_real_credential";
  const event = WhopMock.emitWebhookEvent("dispute.created", {
    account_id: company.id,
    data: dispute,
  });
  assert.match(event.id, /^msg_/);
  assert.equal(event.account_id, company.id);
  assert.equal(event.api_version_date, API_VERSION_DATE);
  assert.ok(!("company_id" in event));
  assert.equal(event.data.evidence_editable, true);
  const delivery = WhopMock.signWebhook(event, secret);
  const decoded = unwrapWebhook(delivery.body, {
    headers: delivery.headers,
    key: secret,
  });
  assert.deepEqual(decoded, event);
  assert.throws(() =>
    unwrapWebhook(`${delivery.body} `, {
      headers: delivery.headers,
      key: secret,
    }),
  );
  assert.throws(() =>
    unwrapWebhook(delivery.body, { headers: delivery.headers, key: "wrong" }),
  );
  const stale = WhopMock.signWebhook(event, secret, 1);
  assert.throws(() =>
    unwrapWebhook(stale.body, { headers: stale.headers, key: secret }),
  );
  const replay = WhopMock.signWebhook(event, secret);
  assert.equal(
    unwrapWebhook(replay.body, { headers: replay.headers, key: secret }).id,
    event.id,
  );
  assert.equal(isKnownWebhookEvent("dispute.updated"), true);
});

test("webhook subscriptions match account and type and preserve event snapshots", () => {
  const { dispute, company } = stack();
  WhopMock.seed("webhook", {
    company_id: company.id,
    events: ["dispute.created"],
    enabled: true,
  });
  WhopMock.seed("webhook", {
    company_id: "biz_other",
    events: ["dispute.created"],
    enabled: true,
  });
  WhopMock.seed("webhook", {
    company_id: company.id,
    events: ["refund.created"],
    enabled: true,
  });
  let matched;
  const off = WhopMock.onWebhookEvent((_event, context) => {
    matched = context.webhooks;
  });
  const event = WhopMock.emitWebhookEvent("dispute.created", { data: dispute });
  off();
  assert.equal(matched.length, 1);
  WhopMock.update("dispute", dispute.id, { status: "won" });
  assert.equal(event.data.status, "needs_response");
  const old = WhopMock.emitWebhookEvent("dispute.created", {
    company_id: company.id,
    data: dispute,
    api_version_date: "2026-08-13",
  });
  assert.equal(old.company_id, company.id);
  assert.ok(!("account_id" in old));
});

test("prepared HTTP errors reach the SDK once; unknown writes never silently succeed", async () => {
  const { dispute } = stack();
  WhopMock.prepareError(Error, "retrieve_dispute", {
    message: "retry later",
    attributes: { status: 429 },
  });
  await assert.rejects(
    client.disputes.retrieve({ id: dispute.id }),
    httpError(429),
  );
  assert.equal(
    (await client.disputes.retrieve({ id: dispute.id })).id,
    dispute.id,
  );
  for (const path of [
    "/disputes",
    `/disputes/${dispute.id}/submit_evidence`,
    "/refunds",
  ]) {
    const response = await transport(`https://api.whop.mock/api/v1${path}`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 501);
  }
  assert.equal(
    (
      await transport("https://api.whop.mock/api/v1/payments", {
        method: "POST",
        body: "{}",
      })
    ).status,
    400,
  );
  WhopMock.stop();
  await assert.rejects(
    transport("https://api.whop.mock/api/v1/disputes"),
    /ended session/,
  );
});

test("fixed evidence slots preserve other fields, accept hosted-policy echoes and enforce field length", async () => {
  const { dispute } = stack();
  const pdf = await upload();
  const updated = await client.disputes.update({
    id: dispute.id,
    evidence: {
      notes: "Keep this",
      customer_name: "Synthetic buyer",
      uncategorized_attachment: { id: pdf.id },
      refund_policy_attachment: {
        id: null,
        platform: true,
        filename: "legal.pdf",
        url: "https://example.invalid/policy.pdf",
      },
    },
  });
  assert.equal(updated.evidence.uncategorized_attachment.id, pdf.id);
  assert.equal(updated.evidence.uncategorized_attachment.platform, false);
  await assert.rejects(
    client.disputes.update({
      id: dispute.id,
      evidence: { customer_name: "x".repeat(256) },
    }),
    httpError(400),
  );
  const cleared = await client.disputes.update({
    id: dispute.id,
    evidence: { uncategorized_attachment: null },
  });
  assert.equal(cleared.evidence.uncategorized_attachment, null);
  assert.equal(cleared.evidence.notes, "Keep this");
  assert.equal(cleared.evidence.customer_name, "Synthetic buyer");
});

test("public status vocabulary excludes RDR/internal cases, validates filters and handles zero pages", async () => {
  const normal = stack();
  const rdr = stack({ visa_rdr: true }).dispute;
  const internal = stack({ status: "other" }).dispute;
  assert.equal((await client.disputes.retrieve({ id: rdr.id })).id, rdr.id);
  await assert.rejects(
    client.disputes.retrieve({ id: internal.id }),
    httpError(404),
  );
  const list = await client.disputes.list({ account_id: normal.company.id });
  assert.deepEqual(
    list.data.map((row) => row.id),
    [normal.dispute.id],
  );
  assert.equal((await client.disputes.list({ first: 0 })).data.length, 0);
  const reset = await client.disputes.list({ after: "stale-cursor" });
  assert.equal(reset.data.length, 1);
  await assert.rejects(
    client.disputes.list({ status: "made_up_status" }),
    httpError(400),
  );
  const response = await transport(
    "https://api.whop.mock/api/v1/refunds?company_id=biz_mock",
  );
  assert.equal(response.status, 400);
});

test("legacy install preserves record-returning dispute actions and uninstall restores its requester", async () => {
  const { dispute } = stack();
  const originalRequester = {
    execute: () => {
      throw new Error("Unexpected real request");
    },
  };
  const legacyClient = { _requester: originalRequester };
  WhopMock.install(legacyClient);
  try {
    for (const action of ["submit_evidence", "update_evidence"]) {
      const [status, response] = await legacyClient._requester.execute({
        method: "POST",
        path: `/disputes/${dispute.id}/${action}`,
        body: { evidence: { notes: "Legacy action input" } },
      });
      assert.equal(status, 200);
      const result = JSON.parse(response.body);
      assert.equal(result.id, dispute.id);
      assert.equal(result.status, dispute.status);
      assert.deepEqual(WhopMock.find("dispute", dispute.id), dispute);
      const missing = await legacyClient._requester.execute({
        method: "POST",
        path: `/disputes/dspt_missing/${action}`,
      });
      assert.equal(missing[0], 404);
    }
  } finally {
    WhopMock.uninstall(legacyClient);
  }
  assert.equal(legacyClient._requester, originalRequester);
});

test("in-process version fallback handles date gaps and preserves the query rename boundary", async () => {
  const { dispute } = stack();
  for (const [pin, effective, name] of [
    ["2024-02-29", "2026-10-28", "include_connected_accounts"],
    ["2026-11-03", "2026-10-28", "include_connected_accounts"],
    ["2026-11-03-10", "2026-11-03-1", "include_subaccounts"],
    ["2099-01-01", "2026-11-04-1", "include_subaccounts"],
  ]) {
    const response = await transport(
      `https://api.whop.mock/api/v1/disputes?account_id=biz_mock&query=${dispute.id}&${name}=true`,
      {
        headers: { "api-version-date": pin },
      },
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("x-whop-mock-api-version"), effective);
    assert.equal((await response.json()).data.length, 1);
    const wrongName =
      name === "include_subaccounts"
        ? "include_connected_accounts"
        : "include_subaccounts";
    const unsupportedQuery = await transport(
      `https://api.whop.mock/api/v1/disputes?${wrongName}=false`,
      {
        headers: { "api-version-date": pin },
      },
    );
    assert.equal(unsupportedQuery.status, 501);
  }
  const malformed = await transport("https://api.whop.mock/api/v1/disputes", {
    headers: { "api-version-date": "2025-02-29" },
  });
  assert.equal(malformed.status, 400);
});
