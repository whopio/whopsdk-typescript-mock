import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
const projectRoot = process.env.WHOP_MOCK_PROJECT_ROOT
  ? resolve(process.env.WHOP_MOCK_PROJECT_ROOT)
  : fileURLToPath(new URL("../../", import.meta.url));
const { createHttpTestServer, LOCAL_TEST_CREDENTIALS } = await import(
  pathToFileURL(join(projectRoot, "dist/http-server.js"))
);
const server = createHttpTestServer({
  ...LOCAL_TEST_CREDENTIALS,
  webhookUrl: process.env.RECEIVER_URL,
  webhookRetryScale: 0.002,
  disputeWebhookDelayMs: 70,
  uploadProcessingDelayMs: 8,
});
server.listen(0, "127.0.0.1", () =>
  process.send?.({ base: `http://127.0.0.1:${server.address().port}` }),
);
process.on("message", (message) => {
  if (message === "close") server.close(() => process.exit(0));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
