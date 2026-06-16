/**
 * Registry of known Whop webhook event types.
 *
 * Webhook events are the notifications Whop delivers to a subscribed
 * {@link Webhook}'s URL when something happens to a resource. They are distinct
 * from the REST API surface: there is no endpoint that "creates" a
 * `membership.trial_ending_soon` — Whop emits it on its own schedule. The mock
 * lets you emit them on demand so you can exercise webhook handlers in tests.
 *
 * Add new event types here as the Whop docs grow. The values must match the
 * `type` field Whop sends on the event envelope exactly.
 */
export const WebhookEvents = {
  // Membership lifecycle
  MEMBERSHIP_WENT_VALID: 'membership.went_valid',
  MEMBERSHIP_WENT_INVALID: 'membership.went_invalid',
  MEMBERSHIP_EXPERIENCE_CLAIMED: 'membership.experience_claimed',
  MEMBERSHIP_CANCEL_AT_PERIOD_END_CHANGED: 'membership.cancel_at_period_end_changed',
  MEMBERSHIP_TRIAL_ENDING_SOON: 'membership.trial_ending_soon',
} as const;

export type WebhookEventType = (typeof WebhookEvents)[keyof typeof WebhookEvents];

/** Flat list of every known webhook event type string. */
export const KNOWN_WEBHOOK_EVENTS: string[] = Object.values(WebhookEvents);

/** Whether `type` is a webhook event type the mock knows about. */
export function isKnownWebhookEvent(type: string): boolean {
  return KNOWN_WEBHOOK_EVENTS.includes(type);
}
