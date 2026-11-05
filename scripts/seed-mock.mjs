import { readFile } from "node:fs/promises";
import { LOCAL_TEST_CREDENTIALS } from "../dist/http-server.js";

const path = process.argv[2];
if (!path)
  throw new Error("Usage: npm run seed:mock -- /path/to/disputes.seed.json");
const input = JSON.parse(await readFile(path, "utf8"));
const base = process.env.WHOP_MOCK_BASE_URL ?? "http://127.0.0.1:4100";
const health = await (await fetch(`${base}/healthz`)).json();
if (health.mode !== "simulation")
  throw new Error("The target is not a Whop fixture test service");
const response = await fetch(`${base}/_test/seed`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.WHOP_MOCK_ADMIN_TOKEN ?? LOCAL_TEST_CREDENTIALS.adminToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(input),
});
const result = await response.json();
if (!response.ok)
  throw new Error(
    `Seed failed (${response.status}): ${result.error?.message ?? "unknown error"}`,
  );
// These are freshly generated, local fixture credentials, needed by the tester.
console.log(JSON.stringify(result, null, 2));
