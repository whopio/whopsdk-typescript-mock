import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import WhopMock from "../dist/index.js";
import {
  createHttpTestServer,
  LOCAL_TEST_CREDENTIALS as credentials,
} from "../dist/http-server.js";

async function environment(t) {
  const server = createHttpTestServer({
    ...credentials,
    uploadProcessingDelayMs: 0,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  t.after(close);
  const request = (path, { method = "GET", body, headers = {} } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${path.startsWith("/_test/") ? credentials.adminToken : credentials.apiToken}`,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const data = async (path, options) => {
    const response = await request(path, options);
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  return { close, request, data };
}

test("HTTP server startup, reset and close preserve other servers and in-process clients", async (t) => {
  WhopMock.start();
  t.after(() => WhopMock.stop());
  const globalDispute = WhopMock.createTestHelper().createDisputeWithPayment({
    company: { id: "biz_in_process" },
    dispute: { id: "dspt_in_process", evidence: { notes: "global fixture" } },
  }).dispute;
  const inProcess = WhopMock.createFetch();
  const readGlobal = async () => {
    const response = await inProcess(
      `https://api.whop.mock/api/v1/disputes/${globalDispute.id}`,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).evidence.notes, "global fixture");
  };
  const a = await environment(t);
  await a.data("/api/v1/disputes/dspt_mock_open", {
    method: "PATCH",
    body: { evidence: { notes: "server A" } },
  });
  const b = await environment(t);
  await readGlobal();
  assert.equal(
    (await a.data("/api/v1/disputes/dspt_mock_open")).evidence.notes,
    "server A",
  );
  await b.data("/api/v1/disputes/dspt_mock_open", {
    method: "PATCH",
    body: { evidence: { notes: "server B" } },
  });
  const generation = (await b.data("/_test/status")).generation;
  const file = await b.data("/api/v1/files", {
    method: "POST",
    body: { filename: "isolated.pdf" },
    headers: { "idempotency-key": "isolated-create" },
  });
  const bytes = Buffer.from("%PDF-1.4\nserver B owns these bytes\n%%EOF");
  assert.equal(
    (
      await fetch(file.upload_url, {
        method: "PUT",
        body: bytes,
        headers: file.upload_headers,
      })
    ).status,
    200,
  );
  let ready;
  for (let i = 0; i < 50; i++) {
    ready = await b.data(`/api/v1/files/${file.id}`);
    if (ready.upload_status === "ready") break;
    await delay(10);
  }
  assert.equal(ready.upload_status, "ready");
  const assertB = async () => {
    assert.equal((await b.data("/_test/status")).generation, generation);
    assert.equal(
      (await b.data("/api/v1/disputes/dspt_mock_open")).evidence.notes,
      "server B",
    );
    const download = await fetch(ready.url);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  };
  await a.data("/_test/reset", { method: "POST", body: {} });
  assert.notEqual(
    (await a.data("/api/v1/disputes/dspt_mock_open")).evidence.notes,
    "server A",
  );
  await assertB();
  await readGlobal();
  const replay = await b.request("/api/v1/files", {
    method: "POST",
    body: { filename: "isolated.pdf" },
    headers: { "idempotency-key": "isolated-create" },
  });
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal((await replay.json()).id, file.id);
  await a.close();
  await assertB();
  await readGlobal();
  WhopMock.stop();
  await assertB();
  WhopMock.start();
  WhopMock.seed("company", { id: "biz_new_global" });
  await assertB();
  await b.data("/_test/reset", { method: "POST", body: {} });
  assert.ok(WhopMock.find("company", "biz_new_global"));
});

test("HTTP accepts old, future and numbered dates, exposes fallback, and rejects malformed pins", async (t) => {
  const env = await environment(t);
  for (const [pin, effective] of [
    [undefined, "2026-10-28"],
    ["2020-02-29", "2026-10-28"],
    ["2026-11-01", "2026-10-28"],
    ["2026-11-03", "2026-10-28"],
    ["2026-11-03-10", "2026-11-03-1"],
    ["2026-11-04", "2026-11-03-1"],
    ["2026-11-04-1", "2026-11-04-1"],
    ["2099-01-01-12", "2026-11-04-1"],
  ]) {
    const response = await env.request("/api/v1/disputes/dspt_mock_open", {
      headers: pin === undefined ? {} : { "api-version-date": pin },
    });
    assert.equal(response.status, 200, pin);
    assert.equal((await response.json()).id, "dspt_mock_open");
    assert.equal(response.headers.get("x-whop-mock-api-version"), effective);
    assert.equal(
      response.headers.get("x-whop-mock-requested-api-version"),
      pin ?? "2026-10-28",
    );
  }
  for (const pin of [
    "",
    "2026-02-29",
    "2026-13-01",
    "2026-11-31",
    "2026-1-01",
    "2026-11-04-0",
    "2026-11-04-01",
    "2026-11-04-x",
    "latest",
  ]) {
    const response = await env.request("/api/v1/disputes", {
      headers: { "api-version-date": pin },
    });
    assert.equal(response.status, 400, pin);
    assert.equal((await response.json()).error.type, "bad_request");
  }
});
