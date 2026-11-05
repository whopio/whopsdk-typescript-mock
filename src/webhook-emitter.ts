import type { ResourceRecord } from './types.js';
import { ResourceNames } from './types.js';
import { Store } from './store.js';
import { IdGenerator } from './id-generator.js';
import { isKnownWebhookEvent } from './webhook-events.js';
import { randomUUID } from 'node:crypto';
import { API_VERSION_DATE, disputeAlertResponse, disputeResponse, paymentResponse, refundResponse } from './current-responses.js';

/** The envelope Whop delivers to a webhook URL. Mirrors the `Event` schema. */
export interface WebhookEvent {
  id: string;
  api_version: string;
  type: string;
  timestamp: string;
  api_version_date?: string;
  account_id?: string;
  created_at?: string;
  company_id?: string;
  data: ResourceRecord;
  previous_attributes?: ResourceRecord;
}

/** Context passed alongside an emitted event. */
export interface WebhookEventContext {
  /** Stored webhook records whose subscription matches this event type. */
  webhooks: ResourceRecord[];
}

export type WebhookEventHandler = (
  event: WebhookEvent,
  context: WebhookEventContext
) => void;

export interface EmitOptions {
  company_id?: string;
  account_id?: string;
  /** Dispute, alert, payment and refund event types default to the tested SDK pin; older dates retain company_id. */
  api_version_date?: string;
  data?: ResourceRecord;
  /** Override the generated timestamp/created_at (ISO 8601). */
  timestamp?: string;
  api_version?: string;
  /** Explicit captured old values; omitted when no capture is supplied. */
  previous_attributes?: ResourceRecord;
}

/**
 * Emits webhook events in-process.
 *
 * Each emitted event is stored (so it is retrievable via `GET /events/{id}`),
 * delivered to every registered listener, and matched against any stored
 * {@link Webhook} records subscribed to its type. There is no real HTTP
 * delivery — listeners are the seam you assert against in tests, standing in
 * for your application's webhook endpoint.
 */
export class WebhookEmitter {
  private store: Store;
  private idGenerator: IdGenerator;
  private listeners: Set<WebhookEventHandler> = new Set();

  constructor(store: Store, idGenerator: IdGenerator) {
    this.store = store;
    this.idGenerator = idGenerator;
  }

  /**
   * Register a listener invoked for every emitted event. Returns a function
   * that unsubscribes it.
   */
  on(handler: WebhookEventHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /** Remove all registered listeners. */
  clear(): void {
    this.listeners.clear();
  }

  /**
   * Build, store, and deliver a webhook event of the given `type`.
   * Unknown event types still work (the registry is advisory), but a warning
   * surfaces in debug output via the store's normal behaviour.
   */
  emit(type: string, options: EmitOptions = {}): WebhookEvent {
    const now = options.timestamp ?? new Date().toISOString();
    let data: ResourceRecord = structuredClone(options.data ?? {});
    const currentEvent = ['dispute', 'dispute_alert', 'payment', 'refund'].includes(type.split('.')[0]);
    const version = options.api_version_date ?? (currentEvent ? API_VERSION_DATE : undefined);
    const modern = version !== undefined && version >= '2026-08-14';
    if (modern && data.id) {
      const resource = type.split('.')[0];
      const record = this.store.find(resource, String(data.id)) ?? data;
      if (resource === 'dispute') data = disputeResponse(record, this.store);
      if (resource === 'dispute_alert') data = disputeAlertResponse(record, this.store);
      if (resource === 'payment') data = paymentResponse(record);
      if (resource === 'refund') data = refundResponse(record, this.store);
    }
    const companyId = options.account_id ?? options.company_id ?? (data.account_id ?? data.company_id) as string | undefined;

    const event: WebhookEvent = {
      id: version ? `msg_${randomUUID().replaceAll('-', '').slice(0, 24)}` : this.idGenerator.generate(ResourceNames.EVENT),
      api_version: options.api_version ?? 'v1',
      api_version_date: version,
      type,
      timestamp: now,
      ...(!version ? { created_at: now } : {}),
      ...(modern ? { account_id: companyId } : { company_id: companyId }),
      data,
      ...(options.previous_attributes && Object.keys(options.previous_attributes).length
        ? { previous_attributes: structuredClone(options.previous_attributes) } : {}),
    };

    // Persist so `GET /events/{id}` can retrieve it.
    this.store.insert(ResourceNames.EVENT, event as unknown as ResourceRecord);

    const context: WebhookEventContext = {
      webhooks: this.matchingWebhooks(type, companyId),
    };

    for (const listener of this.listeners) {
      listener(event, context);
    }

    return event;
  }

  /** Whether the registry recognizes this event type. */
  isKnown(type: string): boolean {
    return isKnownWebhookEvent(type);
  }

  /** Stored webhooks whose `events`/`testable_events` include `type` (or `*`). */
  private matchingWebhooks(type: string, accountId?: string): ResourceRecord[] {
    return this.store.list(ResourceNames.WEBHOOK).filter((webhook) => {
      if (webhook.enabled === false) return false;
      const owner = webhook.account_id ?? webhook.company_id;
      if (owner && owner !== accountId) return false;
      const subscribed = [
        ...this.asStringArray(webhook.events),
        ...this.asStringArray(webhook.testable_events),
      ];
      return subscribed.includes('*') || subscribed.includes(type);
    });
  }

  private asStringArray(value: unknown): string[] {
    return Array.isArray(value) ? (value.filter((v) => typeof v === 'string') as string[]) : [];
  }
}
