// Upstream catches assertion failures without setting a failing exit code.
// Keep those files intact, but make their printed failures fail this runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
// Invoke the untouched upstream command, including its build and tsx CLI setup.
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["test"],
  {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
assert.ifError(result.error);
assert.equal(result.status, 0, "Upstream npm test failed");
assert.doesNotMatch(result.stdout, /✗/, "Upstream caught an assertion failure");
const passed = (result.stdout.match(/^\s*✓ /gm) ?? []).length;
assert.equal(passed, 43, "Expected all 43 upstream examples to pass");
console.log(`\nVerified ${passed} upstream examples with failure detection.`);
