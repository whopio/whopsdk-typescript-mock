import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { WhopClient } from "@whop/sdk";
import { API_VERSION_DATE } from "../../dist/index.js";
import { LOCAL_TEST_CREDENTIALS } from "../../dist/http-server.js";
import { evidencePdf } from "../evidence-pdf.mjs";

// This same HTTP-only walkthrough is used by the integration tests. It creates a
// fresh merchant each time, without resetting anyone else's local fixtures.
export async function exerciseDisputeApi({
  base = "http://127.0.0.1:4100",
  adminToken = LOCAL_TEST_CREDENTIALS.adminToken,
} = {}) {
  const control = async (path, body, method = "POST") => {
    const response = await fetch(`${base}/_test/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.ok(
      response.ok,
      `Test control ${path}: ${response.status} ${JSON.stringify(data)}`,
    );
    return data;
  };
  const status = await control("status", undefined, "GET");
  const fixture = JSON.parse(
    await readFile(new URL("./disputes.seed.json", import.meta.url)),
  );
  const seeded = await control("seed", fixture);
  const sdk = (token) =>
    new WhopClient({
      token,
      baseUrl: seeded.api_base_url,
      apiVersionDate: API_VERSION_DATE,
      maxRetries: 0,
    });
  const client = sdk(seeded.credentials.api_token);
  const [open, concede, expired, won, inquiry, submitted] = seeded.scenarios;
  const dispute = await client.disputes.retrieve({ id: open.dispute_id });
  assert.equal(dispute.payment.id, open.payment_id);
  assert.equal(dispute.buyer.name, "Test Buyer");
  const payment = await client.payments.retrieve({ id: dispute.payment.id });
  assert.equal(payment.metadata.order_id, "my-test-order-001");
  assert.equal(payment.refunded_amount.amount, "20.00");
  assert.equal(
    (await client.refunds.list({ payment_id: payment.id })).data[0].id,
    open.refund_ids[0],
  );
  const ids = [];
  for await (const row of await client.disputes.list({ first: 2 }))
    ids.push(row.id);
  assert.equal(ids.length, 6);
  const summaryResponse = await fetch(
    `${seeded.api_base_url}/disputes/summary`,
    {
      headers: {
        authorization: `Bearer ${seeded.credentials.api_token}`,
        "api-version-date": API_VERSION_DATE,
      },
    },
  );
  assert.equal(summaryResponse.status, 200);
  assert.equal((await summaryResponse.json()).total, 6);
  const event = await control("events", {
    type: "dispute.created",
    resource_id: dispute.id,
    deliver: status.webhook_configured,
  });
  await client.disputes.update({
    id: dispute.id,
    evidence: { notes: "My API test evidence" },
  });
  assert.equal(
    (await client.disputes.retrieve({ id: dispute.id })).evidence.notes,
    "My API test evidence",
  );
  const bytes = evidencePdf();
  const pending = await client.files.create({
    filename: "test-defense.pdf",
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
    await delay(20);
  } while (Date.now() < deadline);
  assert.equal(file.upload_status, "ready");
  assert.deepEqual(
    Buffer.from(await (await fetch(file.url)).arrayBuffer()),
    bytes,
  );
  await client.disputes.uploadEvidence({
    id: dispute.id,
    documents: [{ id: file.id, document_type: "digital_fulfillment" }],
  });
  assert.equal(
    (await client.disputes.retrieve({ id: dispute.id })).evidence.documents[0]
      .id,
    file.id,
  );
  await client.disputes.submit({ id: dispute.id });
  await control(`submissions/${dispute.id}`, { outcome: "rejected" });
  assert.equal(
    (await client.disputes.retrieve({ id: dispute.id })).evidence_editable,
    true,
  );
  await client.disputes.submit({ id: dispute.id });
  await control(`submissions/${dispute.id}`, { outcome: "accepted" });
  assert.equal(
    (await client.disputes.retrieve({ id: dispute.id })).status,
    "under_review",
  );
  await control(`disputes/${dispute.id}`, { status: "won" }, "PATCH");
  assert.equal(
    (await client.disputes.retrieve({ id: dispute.id })).status,
    "won",
  );
  assert.equal(
    (await client.disputes.accept({ id: concede.dispute_id })).status,
    "lost",
  );
  for (const row of [open, concede, expired, won, submitted]) {
    await assert.rejects(
      client.disputes.update({
        id: row.dispute_id,
        evidence: { notes: "locked" },
      }),
      (error) => error.statusCode === 400,
    );
  }
  assert.equal(
    (await client.disputes.retrieve({ id: inquiry.dispute_id })).inquiry,
    true,
  );
  await assert.rejects(
    sdk(seeded.credentials.read_only_token).disputes.update({
      id: inquiry.dispute_id,
      evidence: { notes: "denied" },
    }),
    (error) => error.statusCode === 403,
  );
  assert.equal(
    (
      await sdk(seeded.credentials.no_email_token).disputes.retrieve({
        id: dispute.id,
      })
    ).buyer.email,
    null,
  );
  await control("failures", { action: "retrieve_dispute", status: 429 });
  await assert.rejects(
    client.disputes.retrieve({ id: dispute.id }),
    (error) => error.statusCode === 429,
  );
  assert.equal(
    (await client.disputes.retrieve({ id: dispute.id })).id,
    dispute.id,
  );
  if (status.webhook_configured) {
    assert.equal(event.result.delivered, true);
    assert.equal(
      (
        await control("events", {
          type: "dispute.updated",
          resource_id: dispute.id,
          deliver: true,
        })
      ).result.delivered,
      true,
    );
    assert.equal(
      (await control(`events/${event.event.id}/deliver`, {})).delivered,
      true,
    );
  }
  return {
    dispute_api_workflow: "passed",
    account_id: seeded.account_id,
    cases_created: seeded.scenarios.length,
    upload_download_bytes: bytes.length,
    webhook_delivery: status.webhook_configured ? "passed" : "not_configured",
    backend_parity: "unverified",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(
    JSON.stringify(
      await exerciseDisputeApi({
        base: process.env.WHOP_MOCK_BASE_URL,
        adminToken: process.env.WHOP_MOCK_ADMIN_TOKEN,
      }),
      null,
      2,
    ),
  );
}
