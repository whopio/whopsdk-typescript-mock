import { resolveApiVersion, apiVersionHeaders } from "./api-version.js";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Session } from "./session.js";
import type { ResourceRecord } from "./types.js";
import type { WebhookEvent } from "./webhook-emitter.js";
import {
  ApiError,
  bad,
  can,
  paginate,
  unsupported,
  type FetchOptions,
} from "./current-protocol.js";
import { API_VERSION_DATE, object } from "./current-responses.js";
import { currentContract } from "./current-contract.js";
import { signWebhook } from "./webhook-delivery.js";

export type WebhookTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;
const EVENT_NAMES: string[] =
  currentContract.components.schemas.Webhook.properties.events.items.enum;
const SUBSCRIBABLE_EVENTS: string[] =
  currentContract.paths["/webhooks"].post.body.properties.events.items.enum;
// Fixture testable events include all modeled subscription event names.
const TESTABLE_EVENTS = EVENT_NAMES.filter(
  (name) =>
    SUBSCRIBABLE_EVENTS.includes(name) || name.startsWith("withdrawal."),
);
const LOCAL_EVENTS = EVENT_NAMES.filter((name) =>
  /^(dispute|dispute_alert|payment|refund)\./.test(name),
);
const RETRIES = [
  30, 120, 480, 1800, 3600, 10800, 21600, 43200, 43200, 43200, 43200, 43200,
];
const RETENTION_MS = 30 * 86400000;
function boolean(value: unknown, name: string): boolean {
  if ([true, "true", "1", 1].includes(value as never)) return true;
  if ([false, "false", "0", 0].includes(value as never)) return false;
  bad(`${name} must be true or false`);
}
function events(value: unknown): string[] {
  if (!Array.isArray(value)) bad("events must be an array");
  return value.map((item) => {
    const name = EVENT_NAMES.find(
      (name) => name === item || name.replaceAll(".", "_") === item,
    );
    if (!name) bad(`'${item}' is not a valid value for events`);
    return name;
  });
}
function timestamp(value: unknown, name: string): number | undefined {
  if (value == null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(T|$)/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    bad(`'${value}' is not a valid ISO 8601 timestamp for ${name}`);
  return Date.parse(value);
}

/** The same Store holds endpoint registrations and delivery attempts. No external queue. */
export class WebhookApi {
  private transport?: WebhookTransport;
  private retryScale = 1;
  private transform = (event: WebhookEvent): WebhookEvent => event;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private cursorKey = randomBytes(32);
  private unsubscribe: () => void;
  constructor(private session: Session) {
    this.unsubscribe = session.webhookEmitter.on((event) => {
      for (const hook of this.session.store.list("webhook")) {
        if (
          !hook.enabled ||
          !Array.isArray(hook.events) ||
          !hook.events.includes(event.type)
        )
          continue;
        const account = this.session.store.find(
          "company",
          String(event.account_id),
        );
        const owner = hook.resource_id ?? hook.account_id ?? hook.company_id;
        const matches = hook.child_resource_events
          ? account?.parent_account_id === owner
          : owner === event.account_id;
        if (matches && hook.api_version === "v1")
          void this.deliver(hook, event, undefined, 0).catch(() => {});
      }
    });
  }
  configure(
    transport: WebhookTransport,
    retryScale = 1,
    transform = (event: WebhookEvent): WebhookEvent => event,
  ): void {
    this.transport = transport;
    this.retryScale = retryScale;
    this.transform = transform;
  }
  close(): void {
    this.unsubscribe();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
  private schedule(work: () => void, delay: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      work();
    }, delay);
    timer.unref();
    this.timers.add(timer);
  }
  private authorize(owner: unknown, options: FetchOptions): void {
    const account = String(owner).startsWith("app_")
      ? this.session.store.find("app", String(owner))?.account_id
      : owner;
    if (!can(options, account, "developer:manage_webhook"))
      throw new ApiError(
        403,
        "Missing required permission: developer:manage_webhook",
      );
  }
  private find(id: string, options: FetchOptions): ResourceRecord {
    const hook = this.session.store.find("webhook", id);
    if (!hook) throw new ApiError(404, "Webhook not found");
    this.authorize(hook.resource_id, options);
    return hook;
  }
  private serialize(
    hook: ResourceRecord,
    listing = false,
    created = false,
  ): ResourceRecord {
    const result: ResourceRecord = Object.fromEntries(
      Object.keys(
        currentContract.components.schemas.WebhookListItem.properties,
      ).map((key) => [key, hook[key] ?? null]),
    );
    result.webhook_secret = created ? hook.webhook_secret : null;
    if (!listing) result.testable_events = TESTABLE_EVENTS;
    return result;
  }
  private attributes(body: ResourceRecord): ResourceRecord {
    if ("api_version" in body)
      bad(
        "api_version is no longer supported. New webhooks always use the v1 events; pin payload shapes with api_version_date instead.",
      );
    const output: ResourceRecord = {};
    for (const key of [
      "url",
      "title",
      "api_version_date",
      "enabled",
      "child_resource_events",
      "events",
    ])
      if (key in body) output[key] = body[key];
    if ("events" in output) {
      const names = [...new Set(events(output.events))];
      if (names.some((name) => !SUBSCRIBABLE_EVENTS.includes(name)))
        bad("Events are not supported for v1 webhooks");
      output.events = names;
    }
    for (const key of ["enabled", "child_resource_events"])
      if (key in output) output[key] = boolean(output[key], key);
    if ("title" in output) {
      if (
        output.title != null &&
        (typeof output.title !== "string" || output.title.length > 255)
      )
        bad("Title is too long (maximum is 255 characters)");
      if (typeof output.title === "string")
        output.title = output.title.trim() || null;
    }
    if ("api_version_date" in output) {
      if (
        output.api_version_date === undefined ||
        output.api_version_date === ""
      )
        output.api_version_date = null;
      if (output.api_version_date !== null) {
        if (typeof output.api_version_date !== "string")
          bad("api_version_date must be a string or null");
        resolveApiVersion(output.api_version_date as string);
      }
    }
    if ("url" in output) {
      try {
        const url = new URL(String(output.url));
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          /(^|\.)(discord\.com|discord\.gg|discordapp\.com)$/.test(url.hostname)
        )
          bad("Invalid webhook URL");
      } catch {
        bad("Invalid webhook URL");
      }
    }
    return output;
  }
  async execute(
    method: string,
    parts: string[],
    body: ResourceRecord,
    query: URLSearchParams,
    options: FetchOptions,
  ): Promise<ResourceRecord> {
    const [id, action, deliveryId, replay] = parts;
    if (!id) {
      if (method === "POST") {
        const attributes = this.attributes(body);
        if (!attributes.url) bad("url is required");
        const owner =
          body.resource_id ||
          (options.actorKind === "account" ? options.accountId : undefined);
        if (!owner)
          bad(
            "Please provide a resource id or have a current company in context",
          );
        const resource = String(owner).startsWith("app_") ? "app" : "company";
        if (!this.session.store.find(resource, String(owner)))
          throw new ApiError(404, "Resource not found");
        this.authorize(owner, options);
        if (!Array.isArray(attributes.events) || !attributes.events.length)
          bad("You must select at least one event for the webhook");
        const hook = this.session.store.insert("webhook", {
          id: `hook_${randomUUID().replaceAll("-", "").slice(0, 14)}`,
          title: null,
          enabled: true,
          child_resource_events: false,
          api_version: "v1",
          api_version_date: null,
          created_at: new Date().toISOString(),
          webhook_secret: `ws_${randomBytes(32).toString("hex")}`,
          resource_id: owner,
          consecutive_failures: 0,
          failing_since: null,
          last_failure_at: null,
          disabled_at: null,
          disabled_reason: null,
          ...attributes,
        });
        return this.serialize(hook, false, true);
      }
      if (method === "GET") {
        const owner = query.get("account_id") || query.get("company_id");
        if (!owner) bad("account_id is required");
        if (!this.session.store.find("company", owner))
          throw new ApiError(404, "Account not found");
        this.authorize(owner, options);
        const includeApps =
          query.has("include_app_webhooks") &&
          boolean(query.get("include_app_webhooks"), "include_app_webhooks");
        const appId = query.get("app_id");
        if (appId && includeApps)
          bad("app_id cannot be combined with include_app_webhooks");
        if (
          appId &&
          this.session.store.find("app", appId)?.account_id !== owner
        )
          throw new ApiError(404, "This app does not belong to the company.");
        let rows = this.session.store
          .list("webhook")
          .filter((hook) =>
            appId
              ? hook.resource_id === appId
              : hook.resource_id === owner ||
                (includeApps &&
                  this.session.store.find("app", String(hook.resource_id))
                    ?.account_id === owner),
          );
        if (
          query.has("has_failures") &&
          boolean(query.get("has_failures"), "has_failures")
        )
          rows = rows.filter((hook) => Number(hook.consecutive_failures) > 0);
        return paginate(
          rows.map((hook, index) => ({
            value: this.serialize(hook, true),
            keys: [index + 1],
          })),
          query,
          "webhooks",
          20,
        );
      }
      unsupported(`${method} /webhooks`);
    }
    const hook = this.find(id, options);
    if (!action) {
      if (method === "GET") return this.serialize(hook);
      if (method === "DELETE") {
        this.session.store.delete("webhook", id);
        return { deleted: true, id };
      }
      if (method === "PATCH") {
        const attributes = this.attributes(body);
        if (!hook.enabled && attributes.enabled)
          Object.assign(attributes, {
            consecutive_failures: 0,
            failing_since: null,
            disabled_at: null,
            disabled_reason: null,
          });
        return this.serialize(
          this.session.store.update("webhook", id, attributes)!,
        );
      }
    }
    if (method === "GET" && action === "deliveries" && !deliveryId)
      return this.listDeliveries(hook, query);
    if (method === "POST" && action === "test") {
      if (!body.event) bad("event is required");
      const eventName = events([body.event])[0];
      if (!LOCAL_EVENTS.includes(eventName))
        unsupported(
          `test payloads for ${eventName}; this fixture engine covers dispute, dispute alert, payment and refund events`,
        );
      const resource = eventName.split(".")[0];
      const row = this.session.store
        .list(resource)
        .find(
          (row) =>
            (row.account_id ??
              row.company_id ??
              this.session.store.find("payment", String(row.payment_id))
                ?.company_id) === hook.resource_id,
        );
      if (!row) unsupported(`sample ${eventName} without a seeded ${resource}`);
      // Build a test envelope without publishing an application event to other hooks.
      const data = this.session.currentApi.serializeResource(resource, row!);
      const event = {
        id: `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        api_version: "v1",
        api_version_date: hook.api_version_date ?? API_VERSION_DATE,
        type: eventName,
        timestamp: new Date().toISOString(),
        account_id: hook.resource_id,
        data,
      } as WebhookEvent;
      return this.deliver(hook, event);
    }
    if (
      method === "POST" &&
      action === "deliveries" &&
      deliveryId &&
      replay === "replay"
    ) {
      this.replayable(hook);
      const delivery = this.session.store.find("webhook_delivery", deliveryId);
      if (
        !delivery ||
        delivery._hook !== id ||
        Date.parse(String(delivery.sent_at)) < Date.now() - RETENTION_MS
      )
        throw new ApiError(
          404,
          "No delivery found with the given id. Deliveries are retained for 30 days.",
        );
      return this.replay(
        hook,
        delivery,
        body.regenerate_id === undefined
          ? false
          : boolean(body.regenerate_id, "regenerate_id"),
      );
    }
    if (method === "POST" && action === "replay") {
      this.replayable(hook);
      const after = timestamp(body.sent_after, "sent_after");
      if (after === undefined) bad("sent_after is required");
      const before = timestamp(body.sent_before, "sent_before") ?? Date.now();
      if (after >= before) bad("sent_after must be before sent_before.");
      if (before <= Date.now() - RETENTION_MS || after > Date.now())
        bad("The requested window is entirely outside delivery retention.");
      const names = body.events == null ? null : events(body.events);
      if (names && !names.length)
        bad(
          "events must not be empty. Omit events to replay every event type.",
        );
      const failedOnly =
        body.failed_only === undefined
          ? false
          : boolean(body.failed_only, "failed_only");
      const regenerate =
        body.regenerate_ids === undefined
          ? false
          : boolean(body.regenerate_ids, "regenerate_ids");
      const seen = new Set<string>();
      const selected: ResourceRecord[] = [];
      const window = this.retained(id)
        .filter(
          (row) =>
            Date.parse(String(row.sent_at)) >= after &&
            Date.parse(String(row.sent_at)) <= before,
        )
        .reverse()
        .sort(
          (a, b) =>
            Date.parse(String(b.sent_at)) - Date.parse(String(a.sent_at)),
        );
      for (const row of window) {
        const message = String(
          row._replayed_message_id ?? object(row.request_body).id,
        );
        if (row.replayed_from) {
          if (row.success) seen.add(message);
          continue;
        }
        if (seen.has(message)) continue;
        seen.add(message);
        if (
          (!names || names.includes(String(row.event))) &&
          (!failedOnly || !row.success)
        )
          selected.push(row);
      }
      this.schedule(() => {
        const current = this.session.store.find("webhook", id);
        if (!current?.enabled) return;
        for (const row of selected.slice(0, 10000))
          void this.replay(current, row, regenerate).catch(() => {});
      }, 0);
      return { queued: true };
    }
    unsupported(`${method} /webhooks/${parts.join("/")}`);
  }
  private replayable(hook: ResourceRecord): void {
    if (hook.api_version !== "v1")
      bad("Replay is only available for webhooks on API version v1.");
    if (!hook.enabled)
      bad("Enable the webhook before replaying deliveries to it.");
  }
  private retained(id: string): ResourceRecord[] {
    return this.session.store
      .list("webhook_delivery")
      .filter(
        (row) =>
          row._hook === id &&
          Date.parse(String(row.sent_at)) >= Date.now() - RETENTION_MS,
      );
  }
  private listDeliveries(
    hook: ResourceRecord,
    query: URLSearchParams,
  ): ResourceRecord {
    const first = query.has("first") ? Number(query.get("first")) : 50;
    if (!Number.isInteger(first) || first < 1 || first > 100)
      bad("first must be an integer between 1 and 100");
    const after = timestamp(query.get("sent_after"), "sent_after"),
      before = timestamp(query.get("sent_before"), "sent_before");
    if (after !== undefined && before !== undefined && after > before)
      throw new ApiError(
        400,
        "sent_after must be before sent_before.",
        "invalid_delivery_window",
      );
    const status = query.get("status");
    if (status && !["success", "error"].includes(status))
      throw new ApiError(
        400,
        "status must be one of: success, error",
        "invalid_delivery_status",
      );
    const rawEvents = [
      ...query.getAll("events"),
      ...query.getAll("events[]"),
    ].flatMap((v) => v.split(",").filter(Boolean));
    const names = rawEvents.length ? events(rawEvents) : null;
    if ((query.has("events") || query.has("events[]")) && !names)
      throw new ApiError(
        400,
        "events must not be empty. Omit events to list every event type.",
        "empty_delivery_events",
      );
    if (names && new Set(names).size > 100)
      throw new ApiError(
        400,
        "events can include at most 100 event types.",
        "too_many_delivery_events",
      );
    const id = String(hook.id);
    let rows = this.retained(id)
      .reverse()
      .filter(
        (row) =>
          (after === undefined || Date.parse(String(row.sent_at)) >= after) &&
          (before === undefined || Date.parse(String(row.sent_at)) <= before) &&
          (!names || names.includes(String(row.event))) &&
          (!status || row.status === status) &&
          (!query.get("resource_id") ||
            row.resource_id === query.get("resource_id")),
      );
    const cursor = query.get("after");
    if (cursor) {
      try {
        const [last, signature] = JSON.parse(
          Buffer.from(cursor, "base64url").toString(),
        );
        if (signature === this.signCursor(id, last)) {
          const position = rows.findIndex((row) => row.id === last);
          if (position >= 0) rows = rows.slice(position + 1);
        }
      } catch {
        /* Invalid or foreign cursors restart at the first page. */
      }
    }
    const page = rows.slice(0, first),
      hasNext = rows.length > first;
    return {
      data: page.map((row) =>
        Object.fromEntries(
          Object.keys(
            currentContract.components.schemas.WebhookDelivery.properties,
          ).map((key) => [key, row[key]]),
        ),
      ),
      page_info: {
        start_cursor: null,
        end_cursor: hasNext
          ? Buffer.from(
              JSON.stringify([
                page.at(-1)!.id,
                this.signCursor(id, String(page.at(-1)!.id)),
              ]),
            ).toString("base64url")
          : null,
        has_next_page: hasNext,
        has_previous_page: false,
      },
    };
  }
  private signCursor(id: string, last: string): string {
    return createHmac("sha256", this.cursorKey)
      .update(`${id}:${last}`)
      .digest("hex");
  }
  private replay(
    hook: ResourceRecord,
    row: ResourceRecord,
    regenerate: boolean,
  ): Promise<ResourceRecord> {
    const event = structuredClone(row.request_body) as WebhookEvent;
    if (!event.id || !event.type)
      bad("This delivery does not have a replayable v1 payload.");
    if (regenerate)
      event.id = `msg_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    return this.deliver(
      hook,
      event,
      String(row.id),
      undefined,
      regenerate ? String(object(row.request_body).id) : undefined,
    );
  }
  private async deliver(
    hook: ResourceRecord,
    event: WebhookEvent,
    replayedFrom?: string,
    attempt?: number,
    replayedMessageId?: string,
  ): Promise<ResourceRecord> {
    if (!replayedFrom && !hook.api_version_date)
      unsupported(
        "legacy unpinned webhook payloads; set api_version_date to a well-formed date",
      );
    if (!this.transport)
      unsupported("webhook delivery without an operator-configured transport");
    if (
      attempt !== undefined &&
      !this.session.store.find("webhook", String(hook.id))?.enabled
    )
      return { status: 0, body: "", success: false };
    if (!replayedFrom)
      event = { ...event, api_version_date: String(hook.api_version_date) };
    if (!replayedFrom) event = this.transform(event);
    const delivery = signWebhook(event, String(hook.webhook_secret));
    const started = Date.now();
    let status = 0,
      body = "";
    const signal = AbortSignal.timeout(5000);
    try {
      const response = await this.transport!(String(hook.url), {
        method: "POST",
        body: delivery.body,
        headers: {
          ...delivery.headers,
          ...apiVersionHeaders(resolveApiVersion(event.api_version_date)),
        },
        signal,
        redirect: "error",
      });
      status = response.status;
      body = await response.text();
    } catch (error) {
      if (
        !replayedFrom &&
        attempt === undefined &&
        (signal.aborted ||
          (error instanceof Error &&
            ["TimeoutError", "AbortError"].includes(error.name)))
      )
        bad("Webhook request timed out");
      /* Record transport failures with status 0. */
    }
    const success = status >= 200 && status <= 299;
    const now = new Date().toISOString();
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(body);
    } catch {
      responseBody = {
        error: "Invalid JSON response",
        raw_body: Buffer.from(body).subarray(0, 100).toString("utf8"),
      };
    }
    if (replayedFrom || attempt !== undefined)
      this.session.store.insert("webhook_delivery", {
        id: `whdel_${Buffer.from(`${Date.now()}|${randomUUID()}`).toString("base64url")}`,
        _hook: hook.id,
        _replayed_message_id: replayedMessageId,
        event: event.type,
        replayed_from: replayedFrom ?? null,
        request_body: event,
        resource_id: event.data.id,
        response_body: responseBody,
        response_code: status,
        sent_at: now,
        status: success ? "success" : "error",
        success,
        total_time: (Date.now() - started) / 1000,
      });
    const current = this.session.store.find("webhook", String(hook.id));
    if (current && success && (replayedFrom || attempt !== undefined))
      this.session.store.update("webhook", String(hook.id), {
        consecutive_failures: 0,
        failing_since: null,
      });
    else if (current && attempt === 0)
      this.session.store.update("webhook", String(hook.id), {
        consecutive_failures: Number(current.consecutive_failures) + 1,
        failing_since: current.failing_since ?? now,
      });
    if (!success && attempt !== undefined && attempt < RETRIES.length)
      this.schedule(
        () => {
          const current = this.session.store.find("webhook", String(hook.id));
          if (!current?.enabled) return;
          const row = this.session.store.find(
            event.type.split(".")[0],
            String(event.data.id),
          );
          if (!row) return;
          const fresh = {
            ...event,
            timestamp: new Date().toISOString(),
            data: this.session.currentApi.serializeResource(
              event.type.split(".")[0],
              row,
            ),
          };
          void this.deliver(current, fresh, undefined, attempt + 1).catch(
            () => {},
          );
        },
        RETRIES[attempt] *
          1000 *
          this.retryScale *
          (1.01 + Math.random() * 0.09),
      );
    if (!success && attempt === RETRIES.length && current) {
      const disabled =
        Number(current.consecutive_failures) >= 10 &&
        Date.parse(String(current.failing_since ?? now)) <=
          Date.now() - 3 * 86400000;
      this.session.store.update("webhook", String(hook.id), {
        last_failure_at: now,
        ...(disabled
          ? {
              enabled: false,
              disabled_at: now,
              disabled_reason: "delivery_failures",
            }
          : {}),
      });
    }
    return { status, body, success };
  }
}
