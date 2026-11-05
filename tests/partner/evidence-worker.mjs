import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WhopClient } from "@whop/sdk";
const base = process.env.PARTNER_BASE_URL ?? process.env.WHOP_MOCK_BASE_URL;
if (!base)
  throw new Error("Set PARTNER_BASE_URL to an isolated local mock API origin");
const adminToken =
  process.env.WHOP_MOCK_ADMIN_TOKEN ?? "local_mock_admin_test_only";
const pin = "2026-10-28";
const results = [];
const MIB = 1024 * 1024;
async function control(path, body, method = "POST") {
  const response = await fetch(`${base}/_test/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json();
  assert.ok(
    response.ok,
    `control ${path}: ${response.status} ${JSON.stringify(json)}`,
  );
  return json;
}
async function scenario(dispute = {}, payment = {}) {
  const seed = await control("seed", {
    scenarios: [{ payment: { total: 100, ...payment }, dispute }],
  });
  const sdk = new WhopClient({
    token: seed.credentials.api_token,
    apiVersionDate: pin,
    baseUrl: seed.api_base_url,
    maxRetries: 0,
  });
  return {
    sdk,
    id: seed.scenarios[0].dispute_id,
    token: seed.credentials.api_token,
  };
}
// A minimal valid PDF with a generated cross-reference table, not a copied repo fixture.
function pdf(label = "Evidence") {
  const text = `BT /F1 12 Tf 72 700 Td (${label}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((item, i) => {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${item}\nendobj\n`;
  });
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1))
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(output);
}
async function ready(sdk, id) {
  for (let i = 0; i < 80; i++) {
    const f = await sdk.files.retrieve({ id });
    if (f.upload_status === "ready") return f;
    if (f.upload_status === "failed") throw Error("Upload failed");
    await delay(20);
  }
  throw Error("Timed out awaiting ready");
}
async function upload(sdk, filename = "packet.pdf", bytes = pdf(), extra = {}) {
  const f = await sdk.files.create({
    filename,
    byte_size: bytes.length,
    ...extra,
  });
  const response = await fetch(f.upload_url, {
    method: "PUT",
    headers: f.upload_headers,
    body: bytes,
  });
  assert.equal(response.status, 200);
  const r = await ready(sdk, f.id);
  assert.equal(r.size, bytes.length);
  assert.deepEqual(
    Buffer.from(await (await fetch(r.url)).arrayBuffer()),
    bytes,
  );
  return r;
}
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, status: "passed", detail });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({
      name,
      status: "failed",
      error: e.message,
      actual: e.actual,
      expected: e.expected,
    });
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
await check(
  "Consolidated PDF: context, upload, fixed evidence, asynchronous acceptance and lock",
  async () => {
    const { sdk, id } = await scenario();
    const f = await upload(sdk);
    let d = await sdk.disputes.update({
      id,
      evidence: {
        notes: "Synthetic dispute defense",
        uncategorized_attachment: { id: f.id },
      },
    });
    assert.equal(d.evidence.uncategorized_attachment.id, f.id);
    d = await sdk.disputes.submit({ id });
    assert.equal(d.evidence_submitted_at, null);
    assert.equal(d.evidence_editable, true);
    await control(`submissions/${id}`, { outcome: "accepted" });
    d = await sdk.disputes.retrieve({ id });
    assert.equal(d.status, "under_review");
    assert.ok(d.evidence_submitted_at);
    await assert.rejects(
      sdk.disputes.update({ id, evidence: { notes: "late" } }),
      (e) => e.statusCode === 400,
    );
  },
);
await check(
  "Failed upload can be replaced; pending upload cannot be attached",
  async () => {
    const { sdk, id } = await scenario();
    const f = await sdk.files.create({ filename: "broken.pdf" });
    await assert.rejects(
      sdk.disputes.uploadEvidence({
        id,
        documents: [{ id: f.id, document_type: "digital_fulfillment" }],
      }),
      (e) => e.statusCode === 400,
    );
    await control(`files/${f.id}`, { upload_status: "failed" }, "PATCH");
    assert.equal(
      (await sdk.files.retrieve({ id: f.id })).upload_status,
      "failed",
    );
    const replacement = await upload(sdk);
    await sdk.disputes.uploadEvidence({
      id,
      documents: [{ id: replacement.id, document_type: "digital_fulfillment" }],
    });
    assert.equal(
      (await sdk.disputes.retrieve({ id })).evidence.documents[0].id,
      replacement.id,
    );
  },
);
await check(
  "Typed documents replace atomically; bad reference preserves prior packet",
  async () => {
    const { sdk, id } = await scenario();
    const a = await upload(sdk, "receipt.pdf");
    const b = await upload(sdk, "tracking.pdf");
    await sdk.disputes.uploadEvidence({
      id,
      documents: [{ id: a.id, document_type: "physical_fulfillment" }],
    });
    await assert.rejects(
      sdk.disputes.uploadEvidence({
        id,
        documents: [
          { id: b.id, document_type: "physical_fulfillment" },
          { id: "file_missing", document_type: "customer_order_history" },
        ],
      }),
      (e) => e.statusCode === 400,
    );
    assert.deepEqual(
      (await sdk.disputes.retrieve({ id })).evidence.documents.map((d) => d.id),
      [a.id],
    );
    await sdk.disputes.uploadEvidence({
      id,
      documents: [{ id: b.id, document_type: "physical_fulfillment" }],
    });
    assert.deepEqual(
      (await sdk.disputes.retrieve({ id })).evidence.documents.map((d) => d.id),
      [b.id],
    );
  },
);
await check(
  "Typed return policy stays in documents; fixed policy readback is separate from filing precedence",
  async () => {
    const { sdk, id } = await scenario();
    const custom = await upload(sdk, "return-policy.pdf");
    const d = await sdk.disputes.uploadEvidence({
      id,
      documents: [{ id: custom.id, document_type: "return_policy" }],
    });
    assert.equal(d.evidence.documents[0].id, custom.id);
    assert.equal(d.evidence.refund_policy_attachment.platform, true);
    return { attachment: d.evidence.refund_policy_attachment };
  },
);
await check(
  "Fixed customer communication rejects JSON but uncategorized accepts it",
  async () => {
    const { sdk, id } = await scenario();
    const file = await upload(
      sdk,
      "sessions.json",
      Buffer.from('{"sessions":[1,2]}'),
    );
    await assert.rejects(
      sdk.disputes.update({
        id,
        evidence: { customer_communication_attachment: { id: file.id } },
      }),
      (e) => e.statusCode === 400,
    );
    await sdk.disputes.update({
      id,
      evidence: { uncategorized_attachment: { id: file.id } },
    });
  },
);
await check("Single file cannot be reused by a different dispute", async () => {
  const one = await scenario();
  const two = await scenario();
  const f = await upload(one.sdk);
  await one.sdk.disputes.update({
    id: one.id,
    evidence: { uncategorized_attachment: { id: f.id } },
  });
  await assert.rejects(
    two.sdk.disputes.update({
      id: two.id,
      evidence: { uncategorized_attachment: { id: f.id } },
    }),
    (e) => e.statusCode === 400,
  );
});
await check(
  "Multipart: validate missing/wrong ETag, recover with ordered parts",
  async () => {
    const { sdk } = await scenario();
    const size = 5 * MIB + 123;
    const f = await sdk.files.create({
      filename: "multi.pdf",
      multipart: true,
      byte_size: size,
    });
    const chunks = [Buffer.alloc(5 * MIB, 65), Buffer.alloc(123, 66)];
    const parts = [];
    for (const part of f.multipart_upload_urls) {
      const r = await fetch(part.url, {
        method: "PUT",
        body: chunks[part.part_number - 1],
      });
      assert.equal(r.status, 200);
      parts.push({
        part_number: part.part_number,
        etag: r.headers.get("etag"),
      });
    }
    await assert.rejects(
      sdk.files.complete({
        id: f.id,
        multipart_upload_id: f.multipart_upload_id,
        multipart_parts: [{ ...parts[0], etag: '"wrong"' }, parts[1]],
      }),
      (e) => e.statusCode === 400,
    );
    await sdk.files.complete({
      id: f.id,
      multipart_upload_id: f.multipart_upload_id,
      multipart_parts: parts,
    });
    const complete = await ready(sdk, f.id);
    assert.deepEqual(
      Buffer.from(await (await fetch(complete.url)).arrayBuffer()),
      Buffer.concat(chunks),
    );
  },
);
await check(
  "Submission reserve boundary: below accepted, one byte over rejected",
  async () => {
    const budget = 4 * MIB - 128 * 1024;
    for (const [size, expected] of [
      [budget, 200],
      [budget + 1, 400],
    ]) {
      const { sdk, id } = await scenario();
      const f = await upload(sdk, "boundary.pdf", Buffer.alloc(size, 65));
      await sdk.disputes.update({
        id,
        evidence: { uncategorized_attachment: { id: f.id } },
      });
      if (expected === 200) await sdk.disputes.submit({ id });
      else
        await assert.rejects(
          sdk.disputes.submit({ id }),
          (e) => e.statusCode === 400,
        );
    }
  },
);
await check(
  "Expired and terminal cases refuse evidence; eligible inquiry remains writable",
  async () => {
    for (const dispute of [
      { evidence_due_at: "2020-01-01T00:00:00Z" },
      { status: "won" },
      { status: "lost" },
    ]) {
      const { sdk, id } = await scenario(dispute);
      await assert.rejects(
        sdk.disputes.update({ id, evidence: { notes: "late" } }),
        (e) => e.statusCode === 400,
      );
      await assert.rejects(
        sdk.disputes.submit({ id }),
        (e) => e.statusCode === 400,
      );
    }
    const { sdk, id } = await scenario({
      status: "warning_needs_response",
      evidence_due_at: null,
    });
    assert.equal(
      (await sdk.disputes.update({ id, evidence: { notes: "inquiry" } }))
        .evidence.notes,
      "inquiry",
    );
  },
);
await check(
  "Lost create response can retry exact body with Idempotency-Key",
  async () => {
    const { sdk, token } = await scenario();
    const request = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "api-version-date": pin,
        "content-type": "application/json",
        "idempotency-key": "mock-create-once",
      },
      body: JSON.stringify({ filename: "retry.pdf" }),
    };
    const first = await fetch(`${base}/api/v1/files`, request);
    const body = await first.text();
    const second = await fetch(`${base}/api/v1/files`, request);
    assert.equal(second.headers.get("idempotent-replayed"), "true");
    assert.equal(await second.text(), body);
    assert.equal(
      (await sdk.files.retrieve({ id: JSON.parse(body).id })).upload_status,
      "pending",
    );
  },
);
await check(
  "Replacing a document after same-key failed attach can succeed with a new operation key",
  async () => {
    const { sdk, id, token } = await scenario();
    const f = await sdk.files.create({ filename: "race.pdf" });
    const req = {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "api-version-date": pin,
        "content-type": "application/json",
        "idempotency-key": "attach-attempt-1",
      },
      body: JSON.stringify({
        documents: [{ id: f.id, document_type: "digital_fulfillment" }],
      }),
    };
    assert.equal(
      (await fetch(`${base}/api/v1/disputes/${id}/upload_evidence`, req))
        .status,
      400,
    );
    await fetch(f.upload_url, {
      method: "PUT",
      headers: f.upload_headers,
      body: pdf(),
    });
    await ready(sdk, f.id);
    const replay = await fetch(
      `${base}/api/v1/disputes/${id}/upload_evidence`,
      req,
    );
    assert.equal(replay.status, 400);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    await sdk.disputes.uploadEvidence({
      id,
      documents: [{ id: f.id, document_type: "digital_fulfillment" }],
    });
  },
);
await check(
  "Document ordering follows category-local position then file creation time",
  async () => {
    const { sdk, id } = await scenario();
    const first = await upload(sdk, "created-first.pdf");
    const second = await upload(sdk, "created-second.pdf");
    const third = await upload(sdk, "created-third.pdf");
    const d = await sdk.disputes.uploadEvidence({
      id,
      documents: [
        { id: third.id, document_type: "digital_fulfillment" },
        { id: first.id, document_type: "customer_communication" },
        { id: second.id, document_type: "digital_fulfillment" },
      ],
    });
    assert.deepEqual(
      d.evidence.documents.map((doc) => doc.id),
      [first.id, third.id, second.id],
    );
  },
);
await check(
  "Clearing documents before moving an old document to a fixed slot fails and rolls back",
  async () => {
    const { sdk, id } = await scenario();
    const f = await upload(sdk);
    await sdk.disputes.uploadEvidence({
      id,
      documents: [{ id: f.id, document_type: "digital_fulfillment" }],
    });
    await assert.rejects(
      sdk.disputes.update({
        id,
        evidence: { documents: [], uncategorized_attachment: { id: f.id } },
      }),
      (e) => e.statusCode === 404,
    );
    assert.equal(
      (await sdk.disputes.retrieve({ id })).evidence.documents[0].id,
      f.id,
    );
  },
);
await check(
  "Completed multipart upload refuses late part retries",
  async () => {
    const { sdk } = await scenario();
    const f = await sdk.files.create({
      filename: "completed.pdf",
      multipart: true,
      byte_size: 5 * MIB + 1,
    });
    const parts = [];
    for (const part of f.multipart_upload_urls) {
      const bytes = Buffer.alloc(part.part_number === 1 ? 5 * MIB : 1, 65);
      const r = await fetch(part.url, { method: "PUT", body: bytes });
      parts.push({
        part_number: part.part_number,
        etag: r.headers.get("etag"),
      });
    }
    await sdk.files.complete({
      id: f.id,
      multipart_upload_id: f.multipart_upload_id,
      multipart_parts: parts,
    });
    await ready(sdk, f.id);
    const late = await fetch(f.multipart_upload_urls[1].url, {
      method: "PUT",
      body: Buffer.from("B"),
    });
    assert.equal(late.status, 404);
  },
);
const summary = {
  role: "Partner evidence worker (synthetic integration client)",
  api_pin: pin,
  base,
  checks: results.length,
  passed: results.filter((r) => r.status === "passed").length,
  failed: results.filter((r) => r.status === "failed").length,
  results,
};
if (process.env.PARTNER_RESULTS_PATH)
  await writeFile(
    process.env.PARTNER_RESULTS_PATH,
    JSON.stringify(summary, null, 2) + "\n",
  );
console.log(
  JSON.stringify({
    checks: summary.checks,
    passed: summary.passed,
    failed: summary.failed,
  }),
);
process.exitCode = summary.failed ? 1 : 0;
