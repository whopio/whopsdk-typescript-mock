import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WhopClient } from "@whop/sdk";
import { API_VERSION_DATE } from "../../dist/index.js";
import { LOCAL_TEST_CREDENTIALS } from "../../dist/http-server.js";
import { evidencePdf } from "../evidence-pdf.mjs";

const base = process.env.WHOP_MOCK_BASE_URL ?? "http://127.0.0.1:4100";
const apiToken =
  process.env.WHOP_MOCK_API_TOKEN ?? LOCAL_TEST_CREDENTIALS.apiToken;
const adminToken =
  process.env.WHOP_MOCK_ADMIN_TOKEN ?? LOCAL_TEST_CREDENTIALS.adminToken;
const client = new WhopClient({
  token: apiToken,
  baseUrl: `${base}/api/v1`,
  apiVersionDate: API_VERSION_DATE,
  maxRetries: 0,
});
async function control(path, body, method = "POST") {
  const response = await fetch(`${base}/_test/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(
    response.ok,
    `Test control ${path} failed: HTTP ${response.status}`,
  );
  return response.json();
}
// Reset is a simulator-only endpoint. The smoke test stops here if pointed at a real API.
await control("reset", {});
const status = await control("status", undefined, "GET");
const d = await client.disputes.retrieve({ id: "dspt_mock_open" });
const payment = await client.payments.retrieve({ id: d.payment.id });
const refunds = await client.refunds.list({
  payment_id: payment.id,
  account_id: d.account_id,
});
assert.equal(refunds.data.length, 1);
const opened = await control("events", {
  type: "dispute.created",
  resource_id: d.id,
  deliver: status.webhook_configured,
});
const bytes = evidencePdf();
const pending = await client.files.create({
  filename: "mock-synthetic-defense.pdf",
  byte_size: bytes.length,
});
assert.equal(
  (
    await fetch(pending.upload_url, {
      method: "PUT",
      headers: pending.upload_headers,
      body: bytes,
    })
  ).status,
  200,
);
let file;
const deadline = Date.now() + 5000;
do {
  file = await client.files.retrieve({ id: pending.id });
  if (file.upload_status === "ready") break;
  assert.notEqual(file.upload_status, "failed");
  await delay(50);
} while (Date.now() < deadline);
assert.equal(file.upload_status, "ready");
assert.deepEqual(
  Buffer.from(await (await fetch(file.url)).arrayBuffer()),
  bytes,
);
await client.disputes.update({
  id: d.id,
  evidence: {
    uncategorized_attachment: { id: file.id },
    notes: "Local HTTP walkthrough",
  },
});
assert.equal(
  (await client.disputes.submit({ id: d.id })).evidence_submitted_at,
  null,
);
await control(`submissions/${d.id}`, { outcome: "accepted" });
assert.equal(
  (await client.disputes.retrieve({ id: d.id })).evidence_locked_reason,
  "submitted",
);
const updated = await control("events", {
  type: "dispute.updated",
  resource_id: d.id,
  deliver: status.webhook_configured,
});
if (status.webhook_configured) {
  assert.equal(opened.result.delivered, true);
  assert.equal(updated.result.delivered, true);
  assert.equal(
    (await control(`events/${opened.event.id}/deliver`, {})).delivered,
    true,
  );
}
console.log(
  JSON.stringify(
    {
      local_http_workflow: "passed",
      upload_download_bytes: bytes.length,
      webhook_delivery: status.webhook_configured ? "passed" : "not_configured",
      backend_parity: "unverified",
    },
    null,
    2,
  ),
);
