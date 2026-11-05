import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { WhopClient } from "@whop/sdk";
import WhopMock, { API_VERSION_DATE } from "../dist/index.js";
import {
  IdempotencyStore,
  errorResponse,
  json,
} from "../dist/current-protocol.js";

// Fixed expectations for the documented API surface and explicit fixture behavior.
let transport, helper;
beforeEach(() => {
  WhopMock.start();
  helper = WhopMock.createTestHelper();
  transport = WhopMock.createFetch();
});
afterEach(() => WhopMock.stop());
const stack = (dispute = {}, payment = {}, company = {}) =>
  helper.createDisputeWithPayment({
    company: { id: "biz_fixture", ...company },
    payment: { total: 99.99, ...payment },
    dispute: {
      provider: "stripe",
      evidence_due_at: "2099-01-01T00:00:00.000Z",
      ...dispute,
    },
  });
async function call(
  path,
  { method = "GET", body, headers = {}, fetch = transport } = {},
) {
  const response = await fetch(`https://api.whop.mock/api/v1/${path}`, {
    method,
    headers: { "api-version-date": API_VERSION_DATE, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}
async function upload(
  name = "evidence.pdf",
  bytes = Buffer.from("%PDF-1.4\nfixture\n%%EOF"),
) {
  const { body: file, status } = await call("files", {
    method: "POST",
    body: { filename: name },
  });
  assert.equal(status, 201);
  const response = await transport(file.upload_url, {
    method: "PUT",
    headers: file.upload_headers,
    body: bytes,
  });
  assert.equal(response.status, 200);
  return (await call(`files/${file.id}`)).body;
}

test("Dispute access: read/write/email grants and explicit account denials", async () => {
  const a = stack(
    {},
    {
      customer_email: "a@example.test",
      member_id: "mem_example",
      membership_id: "mship_example",
      client_secret: "synthetic",
      shipment_id: "ship_example",
    },
  );
  const b = stack({}, {}, { id: "biz_other" });
  const restricted = WhopMock.createFetch({
    actorId: "reader",
    accountId: "biz_fixture",
    actorKind: "app",
    grants: { biz_fixture: ["payment:dispute:read", "payment:basic:read"] },
  });
  const list = await call("disputes", { fetch: restricted });
  assert.deepEqual(
    list.body.data.map((d) => d.id),
    [a.dispute.id],
  );
  assert.equal(list.body.data[0].buyer.email, null);
  assert.equal(
    (await call(`disputes/${a.dispute.id}`, { fetch: restricted })).body.buyer
      .email,
    null,
  );
  assert.equal(
    (await call(`disputes/${b.dispute.id}`, { fetch: restricted })).status,
    403,
  );
  assert.equal(
    (await call("disputes?account_id=biz_other", { fetch: restricted })).status,
    403,
  );
  assert.equal(
    (await call("disputes?account_id=biz_missing", { fetch: restricted }))
      .status,
    404,
  );
  assert.equal(
    (
      await call(`disputes/${a.dispute.id}`, {
        fetch: restricted,
        method: "PATCH",
        body: { evidence: { notes: "denied" } },
      })
    ).status,
    403,
  );
  const payment = (
    await call(`payments/${a.payment.id}`, { fetch: restricted })
  ).body;
  for (const key of [
    "customer_email",
    "member_id",
    "membership_id",
    "client_secret",
    "shipment_id",
  ])
    assert.equal(payment[key], null, key);
  assert.equal(
    (await call(`disputes/${a.dispute.id}`)).body.buyer.email,
    "a@example.test",
  );
});

test("connected-account search is versioned and constrained to permitted direct children", async () => {
  stack();
  const child = stack(
    {},
    { customer_email: "child@example.test" },
    { id: "biz_child", parent_account_id: "biz_fixture" },
  );
  stack({}, {}, { id: "biz_unrelated" });
  const opts = {
    actorId: "app",
    actorKind: "app",
    accountId: "biz_fixture",
    grants: {
      biz_fixture: ["payment:dispute:read"],
      biz_child: ["payment:dispute:read"],
    },
  };
  const app = WhopMock.createFetch(opts);
  assert.equal(
    (await call("disputes?include_connected_accounts=true", { fetch: app }))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        "disputes?account_id=biz_fixture&include_connected_accounts=true",
        { fetch: app },
      )
    ).status,
    400,
  );
  const query = `account_id=biz_fixture&include_connected_accounts=true&query=${child.dispute.id}`;
  assert.deepEqual(
    (await call(`disputes?${query}`, { fetch: app })).body.data.map(
      (d) => d.id,
    ),
    [child.dispute.id],
  );
  const current = query.replace(
    "include_connected_accounts",
    "include_subaccounts",
  );
  assert.equal(
    (
      await call(`disputes?${current}`, {
        fetch: app,
        headers: { "api-version-date": "2026-11-04" },
      })
    ).body.data[0].id,
    child.dispute.id,
  );
  const platform = WhopMock.createFetch({ ...opts, actorKind: "account" });
  assert.equal(
    (
      await call(
        "disputes?account_id=biz_fixture&include_connected_accounts=true",
        { fetch: platform },
      )
    ).body.data.length,
    2,
  );
  assert.equal(
    (
      await call(
        "disputes?account_id=biz_fixture&include_connected_accounts=true&query=child@example.test",
        { fetch: app },
      )
    ).body.data.length,
    0,
  );
});

test("Keyset pagination: backward and combined windows, zero/invalid limits, stale order", async () => {
  const ids = [];
  for (let amount = 1; amount <= 7; amount++)
    ids.push(stack({ amount }).dispute.id);
  const base = "disputes?order=amount&direction=asc";
  const head = (await call(`${base}&first=3`)).body;
  assert.deepEqual(
    head.data.map((d) => d.amount),
    [1, 2, 3],
  );
  const tail = (await call(`${base}&last=2`)).body;
  assert.deepEqual(
    tail.data.map((d) => d.amount),
    [6, 7],
  );
  assert.equal(tail.page_info.has_previous_page, true);
  assert.equal(tail.page_info.has_next_page, false);
  const previous = (
    await call(`${base}&last=2&before=${tail.page_info.start_cursor}`)
  ).body;
  assert.deepEqual(
    previous.data.map((d) => d.amount),
    [4, 5],
  );
  assert.equal(previous.page_info.has_next_page, true);
  const middle = (await call(`${base}&first=4&last=2`)).body;
  assert.deepEqual(
    middle.data.map((d) => d.amount),
    [3, 4],
  );
  assert.equal(middle.page_info.has_previous_page, true);
  WhopMock.getStore().delete("dispute", ids[2]); // A deleted boundary must still seek by its values.
  assert.deepEqual(
    (await call(`${base}&after=${head.page_info.end_cursor}`)).body.data.map(
      (d) => d.amount,
    ),
    [4, 5, 6, 7],
  );
  assert.deepEqual((await call(`${base}&first=0`)).body.page_info, {
    start_cursor: null,
    end_cursor: null,
    has_next_page: false,
    has_previous_page: false,
  });
  assert.equal((await call(`${base}&first=-3`)).body.data.length, 6);
  assert.equal(
    (await call(`disputes?order=created_at&after=${head.page_info.end_cursor}`))
      .body.data.length,
    6,
  );
});

test("list validation and summaries use fixture filtering and public status vocabulary", async () => {
  stack({
    status: "needs_response",
    evidence_due_at: "2000-01-01T00:00:00.000Z",
  });
  stack({ status: "won" });
  stack({ visa_rdr: true, status: "lost" });
  const summary = (await call("disputes/summary")).body;
  assert.equal(summary.total, 2);
  assert.equal(summary.groups.status.under_review, 1);
  assert.equal(summary.groups.status.won, 1);
  assert.equal(summary.groups.status.needs_response, 0);
  assert.equal(summary.groups.currency.usd, 2);
  assert.equal(
    (await call("disputes?created_after=next%20Tuesday")).status,
    400,
  );
  assert.equal((await call("disputes?order=nope")).status, 400);
  assert.equal((await call("disputes?direction=backwards")).status, 400);
  assert.equal((await call("refunds?payment_id=pay_unknown")).status, 404);
  assert.equal((await call("payments?status=refunded")).status, 400); // Refunded payments are selected by substatus.
  assert.equal((await call("payments?statuses=paid,authorized")).status, 200);
});

test("dispute model: processor deadlines, multi-PSP Klarna inquiry and RDR retrieval", async () => {
  const { dispute } = stack(
    {
      provider: "multi_psp",
      sub_provider: "adyen",
      status: "warning_needs_response",
    },
    { payment_method_type: "klarna" },
  );
  assert.equal(
    (await call(`disputes/${dispute.id}`)).body.evidence_editable,
    true,
  );
  WhopMock.update("dispute", dispute.id, {
    reason:
      "[notification] The user reported that he/she did not receive the full/partial order",
  });
  const notice = (await call(`disputes/${dispute.id}`)).body;
  assert.equal(notice.status, "warning_under_review");
  assert.equal(notice.reason, "product_not_received");
  const rdr = stack({
    visa_rdr: true,
    status: "lost",
    evidence_due_at: null,
  }).dispute;
  assert.equal((await call(`disputes/${rdr.id}`)).body.status, "prevented");
  assert.ok(!(await call("disputes")).body.data.some((d) => d.id === rdr.id));
  const raw = {
    ...WhopMock.find("dispute", dispute.id),
    due_date: "2099-01-02T00:00:00.000Z",
    reason: "fraudulent",
    status: "needs_response",
  };
  delete raw.evidence_due_at;
  WhopMock.getStore().insert("dispute", raw);
  assert.equal(
    (await call(`disputes/${dispute.id}`)).body.evidence_due_at,
    "2099-01-01T00:00:00.000Z",
  );
});

test("Dispute reasons normalize processor prose and raw codes while preserving reason_code", async () => {
  for (const [reason, expected] of [
    ["10.4: Fraudulent Transaction", "fraudulent"],
    ["C08", "product_not_received"],
    ["Unrecognized", "unrecognized"],
    ["F29", "fraudulent"],
    ["insufficient funds", "bank_cannot_process"],
    ["Other fraud-card absent environment", "fraudulent"],
    ["mystery reason", "other"],
  ]) {
    const { dispute } = stack({ reason, reason_code: "unmapped_network_code" });
    const result = (await call(`disputes/${dispute.id}`)).body;
    assert.equal(result.reason, expected);
    assert.equal(result.reason_code, "unmapped_network_code");
  }
});

test("policy fallback refreshes open disputes, preserves explicit uploads and freezes closed packets", async () => {
  const { dispute } = stack();
  const path = `disputes/${dispute.id}`;
  const initial = (await call(path)).body;
  assert.equal(initial.evidence.cancellation_policy_attachment.platform, true);
  const terms = await upload("terms.pdf");
  const returns = await upload("returns.pdf");
  WhopMock.update("company", "biz_fixture", {
    _policies: { terms_of_service: terms.id, return_policy: returns.id },
  });
  const refreshed = (await call(path)).body;
  assert.equal(
    refreshed.evidence.cancellation_policy_attachment.filename,
    "terms.pdf",
  );
  assert.equal(
    refreshed.evidence.refund_policy_attachment.filename,
    "returns.pdf",
  );
  assert.notEqual(refreshed.evidence.refund_policy_attachment.id, returns.id); // Account policy is copied.
  const custom = await upload("custom.pdf");
  await call(path, {
    method: "PATCH",
    body: { evidence: { refund_policy_attachment: { id: custom.id } } },
  });
  assert.equal(
    (await call(path)).body.evidence.refund_policy_attachment.id,
    custom.id,
  );
  WhopMock.update("dispute", dispute.id, { status: "won" });
  const newPolicy = await upload("new.pdf");
  WhopMock.update("company", "biz_fixture", {
    _policies: { cancellation_policy: newPolicy.id },
  });
  assert.equal(
    (await call(path)).body.evidence.cancellation_policy_attachment.filename,
    "terms.pdf",
  );
});

test("file creation validates filename hygiene, integer sizes and multipart-only minimums", async () => {
  for (const filename of [
    "../bad.pdf",
    ".hidden.pdf",
    "bad\\name.pdf",
    "bad\nname.pdf",
    "bad.pdf.",
    "x".repeat(256),
  ])
    assert.equal(
      (await call("files", { method: "POST", body: { filename } })).status,
      400,
    );
  assert.equal(
    (
      await call("files", {
        method: "POST",
        body: { filename: "okay.pdf", byte_size: "nope" },
      })
    ).status,
    400,
  );
  const file = (
    await call("files", {
      method: "POST",
      body: { filename: "okay.pdf", byte_size: "12", unrelated: true },
    })
  ).body;
  for (const key of [
    "multipart_upload_id",
    "multipart_upload_urls",
    "multipart_chunk_size",
  ])
    assert.equal(file[key], null);
  assert.equal(
    (
      await call("files", {
        method: "POST",
        body: {
          filename: "okay.pdf",
          multipart: true,
          byte_size: 5 * 1024 * 1024,
        },
      })
    ).status,
    400,
  );
  const empty = await upload("empty.pdf", Buffer.alloc(0));
  assert.equal(empty.size, null);
});

test("multipart upload uses part ETags, ordered completion and an isolated file owner", async () => {
  const file = (
    await call("files", {
      method: "POST",
      body: {
        filename: "packet.pdf",
        multipart: true,
        byte_size: 5 * 1024 * 1024 + 16,
      },
    })
  ).body;
  assert.equal(file.multipart_upload_urls.length, 2);
  assert.equal(file.upload_url, null);
  const parts = [];
  for (const part of file.multipart_upload_urls) {
    const response = await transport(part.url, {
      method: "PUT",
      body: Buffer.alloc(part.part_number === 1 ? 5 * 1024 * 1024 : 16, 65),
    });
    assert.equal(response.status, 200);
    parts.push({
      part_number: part.part_number,
      etag: response.headers.get("etag"),
    });
  }
  const body = {
    multipart_upload_id: file.multipart_upload_id,
    multipart_parts: parts,
  };
  assert.equal(
    (
      await call(`files/${file.id}/complete`, {
        method: "POST",
        body: { ...body, multipart_parts: [...parts].reverse() },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`files/${file.id}/complete`, {
        method: "POST",
        body,
        fetch: WhopMock.createFetch({ actorId: "other" }),
      })
    ).status,
    404,
  );
  const result = await call(`files/${file.id}/complete`, {
    method: "POST",
    body,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.size, 5 * 1024 * 1024 + 16);
  assert.equal(
    (await call(`files/${file.id}/complete`, { method: "POST", body })).status,
    400,
  );
});

test("one evidence file occupies one category; fixed-slot MIME rules still apply", async () => {
  const { dispute } = stack();
  const file = await upload();
  const edit = (evidence) =>
    call(`disputes/${dispute.id}`, { method: "PATCH", body: { evidence } });
  await edit({ uncategorized_attachment: { id: file.id } });
  let response = await edit({
    documents: [{ id: file.id, document_type: "digital_fulfillment" }],
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.evidence.uncategorized_attachment, null);
  assert.equal(response.body.evidence.documents[0].id, file.id);
  response = await edit({ uncategorized_attachment: { id: file.id } });
  assert.equal(response.body.evidence.uncategorized_attachment.id, file.id);
  assert.deepEqual(response.body.evidence.documents, []);
  response = await edit({
    documents: [{ id: file.id, document_type: "digital_fulfillment" }],
    customer_communication_attachment: { id: file.id },
  });
  assert.equal(
    response.body.evidence.customer_communication_attachment.id,
    file.id,
  );
  assert.equal(response.body.evidence.uncategorized_attachment, null);
  assert.deepEqual(response.body.evidence.documents, []);
  const invalid = await upload("not-communication.json", Buffer.from("{}"));
  assert.equal(
    (await edit({ customer_communication_attachment: { id: invalid.id } }))
      .status,
    400,
  );
  assert.equal(
    (await call(`disputes/${dispute.id}`)).body.evidence
      .customer_communication_attachment.id,
    file.id,
  );
  assert.equal((await call("payments?substatuses=made_up")).status, 400);
});

test("document replacement removes attachment records; refused replacement is atomic", async () => {
  const { dispute } = stack();
  const a = await upload(),
    b = await upload("b.pdf");
  const path = `disputes/${dispute.id}/upload_evidence`;
  const first = await call(path, {
    method: "POST",
    body: { documents: [{ id: a.id, document_type: "digital_fulfillment" }] },
  });
  assert.equal(first.status, 200);
  assert.equal(
    (
      await call(path, {
        method: "POST",
        body: {
          documents: [
            { id: b.id, document_type: "digital_fulfillment" },
            { id: "file_missing", document_type: "customer_communication" },
          ],
        },
      })
    ).status,
    400,
  );
  assert.equal((await call(`files/${a.id}`)).status, 200);
  assert.equal(
    (
      await call(path, {
        method: "POST",
        body: {
          documents: [{ id: b.id, document_type: "digital_fulfillment" }],
        },
      })
    ).status,
    200,
  );
  assert.equal((await call(`files/${a.id}`)).status, 404);
  assert.equal((await call(`files/${b.id}`)).status, 200);
});

test("idempotent POSTs replay successful and invalid responses, detect mismatches and allow independent actors", async () => {
  const headers = { "idempotency-key": "file-once" };
  const request = { method: "POST", body: { filename: "once.pdf" }, headers };
  const first = await call("files", request);
  const replay = await call("files", request);
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal(WhopMock.list("file").length, 1);
  const mismatch = await call("files", {
    ...request,
    body: { filename: "changed.pdf" },
  });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.code, "idempotency_key_mismatch");
  assert.equal(
    (
      await call("files", {
        ...request,
        fetch: WhopMock.createFetch({ actorId: "other" }),
      })
    ).status,
    201,
  );
  const invalid = {
    method: "POST",
    body: { filename: "../bad.pdf" },
    headers: { "idempotency-key": "invalid" },
  };
  assert.equal((await call("files", invalid)).status, 400);
  assert.equal(
    (await call("files", invalid)).headers.get("idempotent-replayed"),
    "true",
  );
});

test("idempotency refuses an in-flight request, releases pre-execution failures and expires after 24 hours", async () => {
  const store = new IdempotencyStore();
  const request = new Request("https://example.test/files", {
    method: "POST",
    headers: { "idempotency-key": "once" },
    body: "{}",
  });
  let release, started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = store.run(request, "actor", [], async () => {
    started();
    await gate;
    return json({ id: "one" }, 201);
  });
  await entered;
  assert.equal(
    (
      await store.run(request, "actor", [], async () =>
        assert.fail("must not execute twice"),
      )
    ).status,
    409,
  );
  release();
  await first;
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 86400001;
    assert.equal(
      (
        await store.run(request, "actor", [], async () =>
          json({ id: "two" }, 201),
        )
      ).status,
      201,
    );
  } finally {
    Date.now = originalNow;
  }
  const transient = new Request("https://example.test/files", {
    method: "POST",
    headers: { "idempotency-key": "retry" },
    body: "{}",
  });
  await store.run(transient, "actor", [], async () =>
    errorResponse({
      status: 503,
      message: "Unavailable before execution",
      idempotencyDisposition: "release",
    }),
  );
  assert.equal(
    (await store.run(transient, "actor", [], async () => json({}, 201))).status,
    201,
  );
});

test("acceptance supports known processors and locks the conceded dispute", async () => {
  const open = stack().dispute;
  assert.equal((await call(`disputes/${open.id}`)).body.acceptable, true);
  const accepted = await call(`disputes/${open.id}/accept`, {
    method: "POST",
    body: {},
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, "lost");
  assert.equal(accepted.body.evidence_editable, false);
  assert.equal(
    (await call(`disputes/${open.id}/accept`, { method: "POST", body: {} }))
      .status,
    400,
  );
  for (const fixture of [
    { status: "warning_needs_response" },
    { provider: "dlocal" },
    { evidence_due_at: "2000-01-01T00:00:00.000Z" },
  ]) {
    const { dispute } = stack(fixture);
    assert.equal((await call(`disputes/${dispute.id}`)).body.acceptable, false);
  }
});
