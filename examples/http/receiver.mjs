// Optional local receiver for the walkthrough. Use your own receiver for acceptance tests.
import { createServer } from "node:http";
import { unwrapWebhook } from "@whop/sdk/helpers";
import { LOCAL_TEST_CREDENTIALS } from "../../dist/http-server.js";

const key =
  process.env.WHOP_MOCK_WEBHOOK_SECRET ?? LOCAL_TEST_CREDENTIALS.webhookSecret;
const seen = new Set();
createServer((request, response) => {
  void (async () => {
    if (request.method !== "POST" || request.url !== "/webhooks/whop")
      return response.writeHead(404).end();
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024 * 1024) return response.writeHead(413).end();
      chunks.push(chunk);
    }
    try {
      const event = unwrapWebhook(Buffer.concat(chunks).toString(), {
        headers: request.headers,
        key,
      });
      console.log(
        JSON.stringify({
          type: event.type,
          id: event.id,
          duplicate: seen.has(event.id),
        }),
      );
      seen.add(event.id);
      response.writeHead(200).end();
    } catch {
      response.writeHead(400).end();
    }
  })().catch(() => response.destroy());
}).listen(4101, "127.0.0.1", () =>
  console.log("Local receiver: http://127.0.0.1:4101/webhooks/whop"),
);
