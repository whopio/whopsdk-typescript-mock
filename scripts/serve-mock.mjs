import {
  createHttpTestServer,
  LOCAL_TEST_CREDENTIALS,
} from "../dist/http-server.js";

const port = Number(process.env.WHOP_MOCK_PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid WHOP_MOCK_PORT");
const server = createHttpTestServer({
  apiToken: process.env.WHOP_MOCK_API_TOKEN ?? LOCAL_TEST_CREDENTIALS.apiToken,
  readOnlyToken:
    process.env.WHOP_MOCK_READONLY_TOKEN ??
    LOCAL_TEST_CREDENTIALS.readOnlyToken,
  otherAccountToken:
    process.env.WHOP_MOCK_OTHER_ACCOUNT_TOKEN ??
    LOCAL_TEST_CREDENTIALS.otherAccountToken,
  noEmailToken:
    process.env.WHOP_MOCK_NO_EMAIL_TOKEN ?? LOCAL_TEST_CREDENTIALS.noEmailToken,
  adminToken:
    process.env.WHOP_MOCK_ADMIN_TOKEN ?? LOCAL_TEST_CREDENTIALS.adminToken,
  webhookSecret:
    process.env.WHOP_MOCK_WEBHOOK_SECRET ??
    LOCAL_TEST_CREDENTIALS.webhookSecret,
  webhookUrl: process.env.WHOP_MOCK_WEBHOOK_URL,
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Whop mock test API: http://127.0.0.1:${port}/api/v1`);
  console.log(
    "Use Api-Version-Date: 2026-10-28. Local test credentials and scenario controls: examples/http/README.md",
  );
  console.log(
    "Simulation only; parity against the actual Whop backend is unverified.",
  );
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close());
