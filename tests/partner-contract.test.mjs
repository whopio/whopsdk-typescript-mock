import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";
import { WhopClient } from "@whop/sdk";
import {
  createHttpTestServer,
  LOCAL_TEST_CREDENTIALS as keys,
} from "../dist/http-server.js";
let server, base, api;
beforeEach(async () => {
  server = createHttpTestServer({ ...keys, uploadProcessingDelayMs: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});
async function admin(path, body, method = "POST") {
  const r = await fetch(`${base}/_test/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${keys.adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(r.status < 300, true, `control ${path}: ${r.status}`);
  return r.json();
}
async function seed(dispute = {}) {
  const seeded = await admin("seed", { scenarios: [{ dispute }] });
  api = new WhopClient({
    token: seeded.credentials.api_token,
    baseUrl: seeded.api_base_url,
    apiVersionDate: seeded.api_version_date,
    maxRetries: 0,
  });
  return seeded.scenarios[0].dispute_id;
}
// Explicit expected fixture error codes and response bodies.
for (const [label, input, expected] of [
  ["terminal", { status: "won" }, "dispute_not_an_open_chargeback"],
  [
    "expired",
    { evidence_due_at: "2020-01-01T00:00:00Z" },
    "dispute_response_closed",
  ],
  [
    "unsupported processor",
    { provider: "paypal" },
    "dispute_acceptance_unsupported",
  ],
])
  test(`acceptance exposes the modeled actionable code: ${label}`, async () => {
    const id = await seed(input);
    await assert.rejects(api.disputes.accept({ id }), (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.body?.error?.code, expected);
      return true;
    });
  });
async function upload(size, name) {
  const f = await api.files.create({ filename: name });
  assert.equal(
    (
      await fetch(f.upload_url, {
        method: "PUT",
        headers: f.upload_headers,
        body: Buffer.alloc(size),
      })
    ).status,
    200,
  );
  return f.id;
}
// Per-file evidence limits map to public catalog codes.
test("oversized evidence exposes the modeled per-file code", async () => {
  const id = await seed();
  const file = await upload(4 * 1024 * 1024, "large.pdf");
  await api.disputes.update({
    id,
    evidence: { uncategorized_attachment: { id: file } },
  });
  await assert.rejects(api.disputes.submit({ id }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.body?.error?.code, "dispute_evidence_file_over_limit");
    return true;
  });
});
test("aggregate evidence limit exposes the modeled filing code", async () => {
  const id = await seed();
  const ids = await Promise.all([
    upload(2 * 1024 * 1024, "one.pdf"),
    upload(2 * 1024 * 1024, "two.pdf"),
  ]);
  await api.disputes.uploadEvidence({
    id,
    documents: ids.map((id) => ({ id, document_type: "digital_fulfillment" })),
  });
  await assert.rejects(api.disputes.submit({ id }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.body?.error?.code, "dispute_evidence_bytes_over_limit");
    return true;
  });
});
// Completing a pending submission must not overwrite a terminal dispute state.
test("late simulated completion cannot reopen a terminal dispute", async () => {
  const id = await seed();
  await api.disputes.submit({ id });
  await admin(`disputes/${id}`, { status: "won" }, "PATCH");
  await admin(`submissions/${id}`, { outcome: "accepted" });
  assert.equal((await api.disputes.retrieve({ id })).status, "won");
});
