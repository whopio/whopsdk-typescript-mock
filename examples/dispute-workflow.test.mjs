// Run: npm run test:workflow. Everything stays in this process, including upload PUTs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WhopClient } from "@whop/sdk";
import { unwrapWebhook } from "@whop/sdk/helpers";
import WhopMock, { API_VERSION_DATE } from "../dist/index.js";

import { evidencePdf } from "./evidence-pdf.mjs";

test("Dispute workflow: signed notification, case context, consolidated PDF, async result and replay", async () => {
  WhopMock.start();
  try {
    const fetch = WhopMock.createFetch();
    const client = new WhopClient({
      token: "test-only",
      fetch,
      apiVersionDate: API_VERSION_DATE,
      maxRetries: 0,
    });
    const helper = WhopMock.createTestHelper();
    const { dispute, payment, company } = helper.createDisputeWithPayment({
      company: { id: "biz_mock_demo", title: "Synthetic merchant" },
      payment: { total: 99.99 },
      dispute: { evidence_due_at: "2099-01-01T00:00:00Z", provider: "stripe" },
    });
    helper.createRefund({
      payment_id: payment.id,
      amount: 20,
      status: "succeeded",
    });
    const secret = "ws_synthetic_mock_webhook_secret";
    const workByEvent = new Map();
    const cases = new Map();
    let submitted = 0;

    // Replace this demonstration handler with your handler. Production needs
    // durable atomic deduplication; this Map only demonstrates local concurrency/replay.
    async function receive(delivery) {
      const event = unwrapWebhook(delivery.body, {
        headers: delivery.headers,
        key: secret,
      });
      if (!["dispute.created", "dispute.updated"].includes(event.type)) return;
      if (workByEvent.has(event.id)) return workByEvent.get(event.id);
      const work = (async () => {
        // Re-read current state so an old/out-of-order event cannot reopen a submitted case.
        const current = await client.disputes.retrieve({ id: event.data.id });
        assert.equal(current.account_id, event.account_id);
        const p = await client.payments.retrieve({ id: current.payment.id });
        const refunds = [];
        for await (const refund of await client.refunds.list({
          payment_id: p.id,
          account_id: current.account_id,
        }))
          refunds.push(refund);
        cases.set(current.id, {
          account_id: current.account_id,
          dispute: current,
          payment: p,
          refunds,
        });
        if (event.type !== "dispute.created" || !current.evidence_editable)
          return;

        const bytes = evidencePdf();
        const pending = await client.files.create({
          filename: "mock-defense.pdf",
          byte_size: bytes.length,
          visibility: "private",
        });
        const uploaded = await fetch(pending.upload_url, {
          method: "PUT",
          headers: pending.upload_headers,
          body: bytes,
        });
        assert.equal(uploaded.status, 200);
        const ready = await client.files.retrieve({ id: pending.id });
        assert.equal(ready.upload_status, "ready"); // Real uploads may need bounded polling.
        // The consolidated PDF uses the current uncategorized fixed slot.
        // For categorized evidence use evidence.documents; that array replaces the entire set.
        const updated = await client.disputes.update({
          id: current.id,
          evidence: {
            notes: "Synthetic consolidated dispute defense",
            uncategorized_attachment: { id: ready.id },
          },
        });
        assert.equal(updated.evidence.uncategorized_attachment.id, ready.id);
        const pendingResult = await client.disputes.submit({ id: current.id });
        assert.equal(pendingResult.evidence_submitted_at, null);
        submitted++;
      })();
      workByEvent.set(event.id, work);
      try {
        await work;
      } catch (error) {
        workByEvent.delete(event.id);
        throw error;
      }
    }

    const opened = WhopMock.emitWebhookEvent("dispute.created", {
      account_id: company.id,
      data: dispute,
    });
    const delivery = WhopMock.signWebhook(opened, secret);
    await Promise.all([receive(delivery), receive(delivery)]);
    assert.equal(submitted, 1);
    assert.equal(cases.get(dispute.id).payment.total.amount, "99.99");
    assert.equal(cases.get(dispute.id).refunds[0].amount.amount, "20.00");

    // This is an explicit mock control, not an API call or a processor prediction.
    WhopMock.completeDisputeSubmission(dispute.id, "accepted");
    const updated = WhopMock.emitWebhookEvent("dispute.updated", {
      data: { id: dispute.id },
    });
    await receive(WhopMock.signWebhook(updated, secret));
    await receive(delivery); // Same event ID is ignored.
    // A different late event is allowed through dedup but must re-read the locked state.
    const late = { ...opened, id: "msg_late_synthetic_event" };
    await receive(WhopMock.signWebhook(late, secret));
    assert.equal(submitted, 1);
    assert.equal(cases.size, 1);
    assert.equal(cases.get(dispute.id).dispute.status, "under_review");
    assert.equal(
      cases.get(dispute.id).dispute.evidence_locked_reason,
      "submitted",
    );
  } finally {
    WhopMock.stop();
  }
});
