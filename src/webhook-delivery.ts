import { createHmac } from "node:crypto";
import type { WebhookEvent } from "./webhook-emitter.js";

/** Build a delivery for your own handler. Does not make an HTTP request. */
export function signWebhook(
  event: WebhookEvent,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): {
  body: string;
  headers: Record<string, string>;
} {
  if (!secret || !Number.isInteger(timestamp))
    throw new Error("A secret and integer Unix timestamp are required");
  const body = JSON.stringify(event);
  // Whop signs with the literal secret, including its prefix (not a base64-decoded key).
  const signature = createHmac("sha256", secret)
    .update(`${event.id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    body,
    headers: {
      "content-type": "application/json",
      "webhook-id": event.id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${signature}`,
    },
  };
}
