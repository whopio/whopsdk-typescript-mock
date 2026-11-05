import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fork } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdtempSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WhopClient } from "@whop/sdk";
import { unwrapWebhook } from "@whop/sdk/helpers";
const projectRoot = process.env.WHOP_MOCK_PROJECT_ROOT
  ? resolve(process.env.WHOP_MOCK_PROJECT_ROOT)
  : fileURLToPath(new URL("../../", import.meta.url));
const { evidencePdf } = await import(
  pathToFileURL(join(projectRoot, "examples/evidence-pdf.mjs"))
);

const secret = "ws_local_mock_webhook_test_only",
  admin = "local_mock_admin_test_only",
  version = "2026-10-28";
const output = process.env.OUTPUT_DIR
  ? resolve(process.env.OUTPUT_DIR)
  : mkdtempSync(join(tmpdir(), "whop-mock-webhooks-"));
mkdirSync(output, { recursive: true });
const dir = `${output}/`;
const stateFile = `${dir}partner-state.json`;
const receipts = [],
  checks = [],
  findings = [],
  jobs = new Map(),
  credentials = new Map(),
  running = new Map();
let base,
  child,
  receiver,
  receiverBase,
  receivePort,
  policy = { status: 200, count: 0, accept: true },
  invalidSignatures = 0;
let state = {
  events: {},
  cases: {},
  submit_attempts: {},
  uploads: {},
  worker_errors: [],
};
const save = () => {
  writeFileSync(`${stateFile}.new`, JSON.stringify(state, null, 2));
  renameSync(`${stateFile}.new`, stateFile);
};
save();
const sdk = (token) =>
  new WhopClient({
    token,
    baseUrl: `${base}/api/v1`,
    apiVersionDate: version,
    maxRetries: 2,
  });
async function api(
  path,
  { token, method = "GET", body, key, headers = {} } = {},
) {
  const r = await fetch(`${base}/api/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "api-version-date": version,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
      ...headers,
    },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  return {
    status: r.status,
    body: await r.text(),
    headers: Object.fromEntries(r.headers),
  };
}
async function control(path, body, method = "POST") {
  const r = await fetch(`${base}/_test/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await delay(10);
  assert.ok(fn(), "condition did not complete before deadline");
}
async function seed(title, scenarios = [{}]) {
  const result = await control("seed", { account: { title }, scenarios });
  credentials.set(result.account_id, result.credentials.api_token);
  return result;
}
async function worker(event) {
  const caseId = event.data.id,
    key = `${event.account_id}:${caseId}`;
  if (running.has(key)) return running.get(key);
  const promise = (async () => {
    const client = sdk(credentials.get(event.account_id));
    const dispute = await client.disputes.retrieve({ id: caseId });
    if (!dispute.evidence_editable) {
      state.cases[key] = { status: dispute.status, action: "skip_locked" };
      save();
      return;
    }
    if (state.cases[key]?.action === "submitted") return;
    const payment = await client.payments.retrieve({ id: dispute.payment.id });
    const refunds = await client.refunds.list({ payment_id: payment.id });
    const bytes = evidencePdf();
    const file = await client.files.create(
      { filename: `mock-defense.pdf`, byte_size: bytes.length },
      { idempotencyKey: `file:${key}` },
    );
    state.uploads[key] = (state.uploads[key] ?? 0) + 1;
    save();
    assert.equal(
      (
        await fetch(file.upload_url, {
          method: "PUT",
          headers: file.upload_headers,
          body: bytes,
        })
      ).status,
      200,
    );
    let ready;
    for (let n = 0; n < 100; n++) {
      ready = await client.files.retrieve({ id: file.id });
      if (ready.upload_status === "ready") break;
      await delay(10);
    }
    assert.equal(ready.upload_status, "ready");
    await client.disputes.update({
      id: caseId,
      evidence: {
        notes: `Synthetic partner case; ${refunds.data.length} refund(s)`,
        uncategorized_attachment: { id: file.id },
      },
    });
    state.submit_attempts[key] = (state.submit_attempts[key] ?? 0) + 1;
    save();
    await client.disputes.submit(
      { id: caseId },
      { idempotencyKey: `submit:${key}` },
    );
    state.cases[key] = {
      status: "awaiting_processor",
      action: "submitted",
      payment_id: payment.id,
      file_id: file.id,
    };
    save();
  })()
    .catch((error) => {
      state.worker_errors.push({ case: key, message: error.message });
      save();
      throw error;
    })
    .finally(() => running.delete(key));
  running.set(key, promise);
  return promise;
}
async function startReceiver(port = 0) {
  receiver = createServer((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const b of req) chunks.push(b);
      const body = Buffer.concat(chunks).toString();
      let event;
      try {
        event = unwrapWebhook(body, { headers: req.headers, key: secret });
      } catch {
        invalidSignatures++;
        res.writeHead(400).end();
        return;
      }
      receipts.push({
        event_id: event.id,
        type: event.type,
        account_id: event.account_id,
        resource_id: event.data.id,
        status: event.data.status,
        body,
        headers: { ...req.headers },
      });
      const forced = policy.count > 0 ? policy.status : 200;
      if (policy.count > 0) policy.count--;
      if (
        policy.accept &&
        credentials.has(event.account_id) &&
        !state.events[event.id]
      ) {
        state.events[event.id] = {
          account_id: event.account_id,
          resource_id: event.data.id,
          type: event.type,
        };
        save();
        if (event.type === "dispute.created") jobs.set(event.id, event);
        else if (event.type === "dispute.updated") {
          const current = await sdk(
            credentials.get(event.account_id),
          ).disputes.retrieve({ id: event.data.id });
          state.cases[`${event.account_id}:${event.data.id}`] = {
            ...(state.cases[`${event.account_id}:${event.data.id}`] ?? {}),
            status: current.status,
          };
          save();
        }
      }
      res
        .writeHead(
          forced,
          forced === 302 ? { location: `${receiverBase}/redirect-target` } : {},
        )
        .end();
    })().catch((error) => {
      res.writeHead(500).end();
      state.worker_errors.push({ receiver: error.message });
      save();
    });
  });
  await new Promise((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(port, "127.0.0.1", resolve);
  });
  receivePort = receiver.address().port;
  receiverBase = `http://127.0.0.1:${receivePort}`;
}
async function runCheck(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, status: "passed", ...detail });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, status: "failed", error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
try {
  await startReceiver();
  child = fork(new URL("./reliability-server.mjs", import.meta.url), [], {
    env: {
      ...process.env,
      RECEIVER_URL: receiverBase,
      WHOP_MOCK_PROJECT_ROOT: projectRoot,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stderr.on("data", (b) => process.stderr.write(b));
  base = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("message", (m) => resolve(m.base));
    child.once("exit", (c) => reject(new Error(`server exit ${c}`)));
  });
  const a = await seed("Synthetic merchant A", [
    {
      payment: { total: 80, customer_email: "a@example.test" },
      refunds: [{ amount: 10, status: "succeeded" }],
    },
    {},
  ]);
  const b = await seed("Synthetic merchant B", [
    { payment: { total: 25, customer_email: "b@example.test" } },
  ]);
  const first = a.scenarios[0].dispute_id,
    key = `${a.account_id}:${first}`;
  await runCheck(
    "signature verification rejects modified payload and stale correctly-signed delivery",
    async () => {
      const e = await control("events", {
        type: "dispute.created",
        resource_id: first,
        deliver: false,
      });
      const modified = JSON.stringify({ ...e.event, type: "dispute.updated" });
      assert.equal(
        (
          await fetch(receiverBase, {
            method: "POST",
            headers: e.delivery.headers,
            body: modified,
          })
        ).status,
        400,
      );
      const timestamp = String(Math.floor(Date.now() / 1000) - 601);
      const signature = createHmac("sha256", secret)
        .update(`${e.event.id}.${timestamp}.${e.delivery.body}`)
        .digest("base64");
      assert.equal(
        (
          await fetch(receiverBase, {
            method: "POST",
            headers: {
              ...e.delivery.headers,
              "webhook-timestamp": timestamp,
              "webhook-signature": `v1,${signature}`,
            },
            body: e.delivery.body,
          })
        ).status,
        400,
      );
      assert.equal(invalidSignatures, 2);
      assert.equal(Object.keys(state.events).length, 0);
    },
  );
  await runCheck(
    "lost acknowledgement and ten concurrent duplicates enqueue one durable case",
    async () => {
      policy = { status: 503, count: 1, accept: true };
      const opened = await control("events", {
        type: "dispute.created",
        resource_id: first,
        deliver: true,
      });
      assert.equal(opened.result.delivered, false);
      await Promise.all(
        Array.from({ length: 10 }, () =>
          control(`events/${opened.event.id}/deliver`, {}),
        ),
      );
      await waitFor(
        () =>
          receipts.filter((r) => r.event_id === opened.event.id).length >= 12,
      );
      assert.equal(jobs.size, 1);
      assert.equal(Object.keys(state.events).length, 1);
      await worker(jobs.get(opened.event.id));
      assert.equal(state.submit_attempts[key], 1);
      assert.equal(state.uploads[key], 1);
      await control(`submissions/${first}`, { outcome: "accepted" });
      await waitFor(() => state.cases[key]?.status === "under_review");
      return {
        same_event_deliveries: receipts.filter(
          (r) => r.event_id === opened.event.id,
        ).length,
        submissions: 1,
      };
    },
  );
  await runCheck("receiver restart retains duplicate protection", async () => {
    const old = receipts.find(
      (r) => r.resource_id === first && r.type === "dispute.created",
    );
    await new Promise((resolve) => receiver.close(resolve));
    state = JSON.parse(readFileSync(stateFile));
    await startReceiver(receivePort);
    const prior = Object.keys(state.events).length;
    await control(`events/${old.event_id}/deliver`, {});
    assert.equal(Object.keys(state.events).length, prior);
    assert.equal(state.submit_attempts[key], 1);
  });
  await runCheck(
    "acknowledged queued case recovers from the persisted journal after receiver restart",
    async () => {
      const s = await seed("Webhook journal recovery");
      const id = s.scenarios[0].dispute_id;
      const e = await control("events", {
        type: "dispute.created",
        resource_id: id,
        deliver: true,
      });
      assert.equal(e.result.delivered, true);
      assert.ok(jobs.has(e.event.id));
      await new Promise((resolve) => receiver.close(resolve));
      jobs.clear();
      state = JSON.parse(readFileSync(stateFile));
      for (const [eventId, saved] of Object.entries(state.events)) {
        const caseState =
          state.cases[`${saved.account_id}:${saved.resource_id}`];
        if (
          saved.type === "dispute.created" &&
          !["submitted", "skip_locked"].includes(caseState?.action)
        )
          jobs.set(eventId, {
            id: eventId,
            type: saved.type,
            account_id: saved.account_id,
            data: { id: saved.resource_id },
          });
      }
      await startReceiver(receivePort);
      assert.ok(jobs.has(e.event.id));
      await worker(jobs.get(e.event.id));
      assert.equal(state.submit_attempts[`${s.account_id}:${id}`], 1);
    },
  );
  await runCheck(
    "two different events for one case share a concurrent worker lease",
    async () => {
      const s = await seed("Dispute case lease");
      const id = s.scenarios[0].dispute_id;
      const events = await Promise.all(
        Array.from({ length: 2 }, () =>
          control("events", {
            type: "dispute.created",
            resource_id: id,
            deliver: true,
          }),
        ),
      );
      assert.notEqual(events[0].event.id, events[1].event.id);
      await Promise.all(events.map((e) => worker(jobs.get(e.event.id))));
      assert.equal(state.submit_attempts[`${s.account_id}:${id}`], 1);
      assert.equal(state.uploads[`${s.account_id}:${id}`], 1);
    },
  );
  await runCheck("old create event cannot reopen a terminal case", async () => {
    const id = a.scenarios[1].dispute_id;
    const old = await control("events", {
      type: "dispute.created",
      resource_id: id,
      deliver: false,
    });
    await control(`disputes/${id}`, { status: "won" }, "PATCH");
    await waitFor(() => state.cases[`${a.account_id}:${id}`]?.status === "won");
    await control(`events/${old.event.id}/deliver`, {});
    await worker(jobs.get(old.event.id));
    assert.equal(state.cases[`${a.account_id}:${id}`].action, "skip_locked");
    assert.equal(state.submit_attempts[`${a.account_id}:${id}`], undefined);
  });
  await runCheck(
    "merchant-specific clients reject cross-account resource access",
    async () => {
      await assert.rejects(
        sdk(b.credentials.api_token).disputes.retrieve({ id: first }),
        (e) => e.statusCode === 403,
      );
      assert.equal(
        (
          await sdk(b.credentials.api_token).disputes.retrieve({
            id: b.scenarios[0].dispute_id,
          })
        ).account_id,
        b.account_id,
      );
    },
  );
  await runCheck(
    "real SDK retries one-shot 429, 500 and 503 reads",
    async () => {
      for (const status of [429, 500, 503]) {
        await control("failures", { action: "retrieve_dispute", status });
        assert.equal(
          (await sdk(a.credentials.api_token).disputes.retrieve({ id: first }))
            .id,
          first,
        );
      }
    },
  );
  await runCheck(
    "automatic webhook retry retains identity and reloads current resource",
    async () => {
      const s = await seed("retry refresh");
      const id = s.scenarios[0].dispute_id;
      policy = { status: 500, count: 1, accept: false };
      const e = await control("events", {
        type: "dispute.created",
        resource_id: id,
        deliver: true,
      });
      await control(`disputes/${id}`, { status: "won" }, "PATCH");
      await waitFor(
        () => receipts.filter((r) => r.event_id === e.event.id).length >= 2,
      );
      const attempts = receipts.filter((r) => r.event_id === e.event.id);
      assert.equal(attempts[0].status, "needs_response");
      assert.equal(attempts[1].status, "won");
      assert.equal(attempts[0].event_id, attempts[1].event_id);
      policy = { status: 200, count: 0, accept: true };
    },
  );
  await runCheck(
    "concurrent idempotent file creation converges without duplicate files",
    async () => {
      const requests = await Promise.all(
        Array.from({ length: 12 }, () =>
          api("files", {
            token: a.credentials.api_token,
            method: "POST",
            body: { filename: "concurrent.pdf" },
            key: "same-file-key",
          }),
        ),
      );
      assert.ok(requests.every((r) => [201, 409].includes(r.status)));
      const success = requests.filter((r) => r.status === 201);
      assert.ok(success.length);
      assert.equal(new Set(success.map((r) => JSON.parse(r.body).id)).size, 1);
      const final = await api("files", {
        token: a.credentials.api_token,
        method: "POST",
        body: { filename: "concurrent.pdf" },
        key: "same-file-key",
      });
      assert.equal(final.status, 201);
      assert.equal(final.headers["idempotent-replayed"], "true");
      assert.equal(final.body, success[0].body);
      const mismatch = await api("files", {
        token: a.credentials.api_token,
        method: "POST",
        body: { filename: "different.pdf" },
        key: "same-file-key",
      });
      assert.equal(mismatch.status, 400);
    },
  );
  await runCheck(
    "POST 429/503 before execution releases the idempotency key",
    async () => {
      for (const status of [429, 503]) {
        await control("failures", {
          action: "create_file",
          status,
          phase: "pre_execution",
        });
        const args = {
          token: a.credentials.api_token,
          method: "POST",
          body: { filename: `retry-${status}.pdf` },
          key: `before-${status}`,
        };
        assert.equal((await api("files", args)).status, status);
        assert.equal((await api("files", args)).status, 201);
      }
    },
  );
  await runCheck(
    "same idempotency key is isolated by merchant actor",
    async () => {
      const body = { filename: "same-business-key.pdf" };
      const aRes = await api("files", {
        token: a.credentials.api_token,
        method: "POST",
        body,
        key: "external-order-123",
      });
      const bRes = await api("files", {
        token: b.credentials.api_token,
        method: "POST",
        body,
        key: "external-order-123",
      });
      assert.equal(aRes.status, 201);
      assert.equal(bRes.status, 201);
      assert.notEqual(JSON.parse(aRes.body).id, JSON.parse(bRes.body).id);
    },
  );
  await runCheck(
    "generic handled 503 records the refusal rather than treating all outages as safe retries",
    async () => {
      await control("failures", {
        action: "create_file",
        status: 503,
        phase: "handled",
      });
      const args = {
        token: a.credentials.api_token,
        method: "POST",
        body: { filename: "generic-outage.pdf" },
        key: "generic-outage-key",
      };
      const first = await api("files", args),
        second = await api("files", args);
      assert.equal(first.status, 503);
      assert.equal(second.status, 503);
      assert.equal(second.headers["idempotent-replayed"], "true");
      assert.equal(first.body, second.body);
      const fresh = await api("files", {
        ...args,
        key: "generic-outage-new-key",
      });
      assert.equal(fresh.status, 201);
    },
  );
  await runCheck(
    "unknown 500 POST outcome preserves an open claim and a retry reports in-progress",
    async () => {
      await control("failures", {
        action: "create_file",
        status: 500,
        phase: "unknown",
      });
      const args = {
        token: a.credentials.api_token,
        method: "POST",
        body: { filename: "unknown-outcome.pdf" },
        key: "server-error-key",
      };
      const first = await api("files", args),
        second = await api("files", args);
      assert.equal(first.status, 500);
      assert.equal(second.status, 409);
      assert.equal(
        JSON.parse(second.body).error.code,
        "idempotency_request_in_progress",
      );
      assert.equal(second.headers["idempotent-replayed"], undefined);
    },
  );
  await runCheck(
    "unrelated request headers do not change idempotency request meaning",
    async () => {
      const args = {
        token: a.credentials.api_token,
        method: "POST",
        body: { filename: "public-context.pdf" },
        key: "same-public-context",
      };
      assert.equal((await api("files", args)).status, 201);
      for (const value of ["false", "true", "anything"]) {
        const retry = await api("files", {
          ...args,
          headers: { "x-unrelated-header": value },
        });
        assert.equal(retry.status, 201);
        assert.equal(retry.headers["idempotent-replayed"], "true");
      }
    },
  );
  const summary = {
    output_dir: output,
    checked_at: new Date().toISOString(),
    isolation:
      "separate Node API child process and receiver, independent fixture state and ephemeral ports",
    api_base: base,
    timing_overrides: { webhookRetryScale: 0.002, disputeWebhookDelayMs: 70 },
    client:
      "synthetic partner Node SDK/HTTP receiver with file-journal deduplication; no external application code",
    passed: checks.filter((c) => c.status === "passed").length,
    failed: checks.filter((c) => c.status === "failed").length,
    checks,
    findings,
    receipts: receipts.map(({ body, headers, ...r }) => r),
    worker_errors: state.worker_errors,
  };
  writeFileSync(
    `${dir}${process.env.RELIABILITY_RUN_LABEL ?? "verification"}-results.json`,
    JSON.stringify(summary, null, 2) + "\n",
  );
  process.exitCode = summary.failed ? 1 : 0;
  console.log(
    JSON.stringify(
      {
        passed: summary.passed,
        failed: summary.failed,
        findings: summary.findings,
      },
      null,
      2,
    ),
  );
} finally {
  if (child && child.connected) {
    child.send("close");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 3000).unref();
    });
  }
  if (receiver) await new Promise((resolve) => receiver.close(resolve));
}
