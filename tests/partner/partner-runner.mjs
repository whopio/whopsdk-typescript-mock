import { fork, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run from the repository root after `npm run build`.
// Each worker gets a separate process, API process, ephemeral port and fixture store.
const self = fileURLToPath(import.meta.url);

if (process.argv[2] === "--server") {
  const { createHttpTestServer, LOCAL_TEST_CREDENTIALS } = await import(
    pathToFileURL(resolve("dist/http-server.js")).href
  );
  const server = createHttpTestServer(LOCAL_TEST_CREDENTIALS);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close(() => {
      if (process.connected) process.disconnect();
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("disconnect", stop);
  server.once("error", (error) => {
    console.error(error);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
  server.listen(0, "127.0.0.1", () => {
    process.send?.({
      type: "ready",
      base: `http://127.0.0.1:${server.address().port}`,
      credentials: LOCAL_TEST_CREDENTIALS,
    });
  });
} else {
  const workers = process.argv.slice(2);
  if (!workers.length) {
    throw new Error(
      "Usage: node tests/partner/runner.mjs <worker.mjs> [worker.mjs ...]",
    );
  }
  const active = new Set();
  let interrupted = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      interrupted = true;
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      for (const child of active) child.kill(signal);
    });
  }
  const track = (child) => {
    active.add(child);
    const done = new Promise((resolveDone, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        active.delete(child);
        resolveDone({ code, signal });
      });
    });
    // A startup failure may happen before callers await `done`.
    done.catch(() => {});
    return done;
  };
  const stop = async (child, done) => {
    if (!active.has(child)) return;
    child.kill("SIGTERM");
    const hardStop = setTimeout(() => child.kill("SIGKILL"), 5000);
    hardStop.unref();
    try {
      await done;
    } finally {
      clearTimeout(hardStop);
    }
  };
  if (process.env.PARTNER_RESULTS_DIR) {
    await mkdir(process.env.PARTNER_RESULTS_DIR, { recursive: true });
  }
  for (const workerPath of workers) {
    if (interrupted) break;
    const server = fork(self, ["--server"], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const serverDone = track(server);
    let worker;
    let workerDone;
    try {
      const ready = await new Promise((resolveReady, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Mock API startup timed out")),
          10000,
        );
        const fail = (code) => {
          clearTimeout(timeout);
          reject(new Error(`Mock API exited before ready (${code})`));
        };
        server.once("exit", fail);
        server.once("error", reject);
        server.once("message", (message) => {
          clearTimeout(timeout);
          server.off("exit", fail);
          if (message?.type !== "ready")
            return reject(new Error("Invalid mock API startup message"));
          resolveReady(message);
        });
      });
      const name = basename(workerPath, extname(workerPath));
      const env = {
        ...process.env,
        PARTNER_BASE_URL: ready.base,
        WHOP_MOCK_BASE_URL: ready.base,
        WHOP_MOCK_ADMIN_TOKEN: ready.credentials.adminToken,
        WHOP_MOCK_API_TOKEN: ready.credentials.apiToken,
        WHOP_MOCK_WEBHOOK_SECRET: ready.credentials.webhookSecret,
      };
      if (process.env.PARTNER_RESULTS_DIR) {
        env.PARTNER_RESULTS_PATH = resolve(
          process.env.PARTNER_RESULTS_DIR,
          `${name}.json`,
        );
      }
      console.log(
        `Running ${workerPath} against an isolated ephemeral mock API`,
      );
      worker = spawn(process.execPath, [resolve(workerPath)], {
        env,
        stdio: "inherit",
      });
      workerDone = track(worker);
      const limit = setTimeout(() => worker.kill("SIGKILL"), 180000);
      limit.unref();
      let result;
      try {
        result = await workerDone;
      } finally {
        clearTimeout(limit);
      }
      if (result.code !== 0) {
        console.error(`${workerPath} failed (${result.signal ?? result.code})`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`${workerPath}: ${error.message}`);
      process.exitCode = 1;
    } finally {
      if (worker) await stop(worker, workerDone);
      await stop(server, serverDone);
    }
  }
}
