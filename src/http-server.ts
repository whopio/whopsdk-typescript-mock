import { resolveApiVersion, withApiVersion } from "./api-version.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { AddressInfo } from "node:net";
import { Session } from "./session.js";
import { Configuration } from "./configuration.js";
import { TestHelper } from "./test-helper.js";
import { signWebhook } from "./webhook-delivery.js";
import {
  API_VERSION_DATE,
  disputeResponse,
  paymentResponse,
  refundResponse,
} from "./current-responses.js";
import {
  ApiError,
  IdempotencyStore,
  carryIdempotencyDisposition,
  type FetchOptions,
} from "./current-protocol.js";
import { seedScenarios } from "./scenario-seeder.js";
import type { ResourceRecord } from "./types.js";
import type { WebhookEvent } from "./webhook-emitter.js";

export const LOCAL_TEST_CREDENTIALS = {
  apiToken: "local_mock_api_test_only",
  readOnlyToken: "local_mock_readonly_test_only",
  adminToken: "local_mock_admin_test_only",
  webhookSecret: "ws_local_mock_webhook_test_only",
  otherAccountToken: "local_mock_other_test_only",
  noEmailToken: "local_mock_no_email_test_only",
} as const;

export interface HttpTestOptions {
  apiToken: string;
  readOnlyToken?: string;
  otherAccountToken?: string;
  noEmailToken?: string;
  adminToken: string;
  /** Demo/test-control deliveries only. Registered subscriptions use their own secret. */
  webhookSecret: string;
  /** Set once by the operator. Requests cannot choose arbitrary webhook destinations. */
  webhookUrl?: string;
  /** Defaults to this server's loopback address. */
  publicBaseUrl?: string;
  /** Deterministic simulation delay; no real PDF processing takes place. */
  uploadProcessingDelayMs?: number;
  credentials?: Array<FetchOptions & { token: string }>;
  /** Multiply the real retry ladder for accelerated tests. Default 1. */
  webhookRetryScale?: number;
  automaticWebhookRetries?: boolean;
  /** Mock dispute-update delay defaults to one minute; shorten for explicit tests. */
  disputeWebhookDelayMs?: number;
}

export const WEBHOOK_RETRY_DELAYS_SECONDS = [
  30, 120, 480, 1800, 3600, 10800, 21600, 43200, 43200, 43200, 43200, 43200,
];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

async function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit)
      throw new HttpError(
        413,
        "Local test service request size limit exceeded",
      );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(bytes: Buffer): ResourceRecord {
  if (!bytes.length) return {};
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString());
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "Expected a JSON object");
  return value as ResourceRecord;
}

/** Each HTTP server owns an independent fixture session. */
export function createHttpTestServer(options: HttpTestOptions): Server {
  const tokens = [
    options.apiToken,
    options.adminToken,
    options.readOnlyToken,
    options.otherAccountToken,
    options.noEmailToken,
    ...(options.credentials?.map((credential) => credential.token) ?? []),
  ].filter(Boolean);
  if (
    tokens.length < 2 ||
    new Set(tokens).size !== tokens.length ||
    !options.webhookSecret
  ) {
    throw new Error(
      "Distinct API/admin tokens and a webhook secret are required",
    );
  }
  const webhookUrl = options.webhookUrl ? new URL(options.webhookUrl) : null;
  if (webhookUrl && !["http:", "https:"].includes(webhookUrl.protocol))
    throw new Error("Webhook URL must be HTTP(S)");
  if (webhookUrl && (webhookUrl.username || webhookUrl.password))
    throw new Error(
      "Use the signing secret, not credentials in the webhook URL",
    );
  const configuredBase = options.publicBaseUrl
    ? new URL(options.publicBaseUrl)
    : null;
  if (
    configuredBase &&
    (!["http:", "https:"].includes(configuredBase.protocol) ||
      configuredBase.pathname !== "/" ||
      configuredBase.username ||
      configuredBase.password)
  ) {
    throw new Error("publicBaseUrl must be an HTTP(S) origin");
  }
  const delay = options.uploadProcessingDelayMs ?? 100;
  if (!Number.isFinite(delay) || delay < 0)
    throw new Error("uploadProcessingDelayMs must be non-negative");
  let session = Session.build({ configuration: new Configuration() });
  let idempotency = new IdempotencyStore();
  const fullScopes = [
    "payment:dispute:read",
    "payment:dispute",
    "payment:basic:read",
    "member:email:read",
    "member:basic:read",
    "shipment:basic:read",
    "payment:manage",
    "payment:charge",
    "developer:manage_webhook",
  ];
  const credentials = [
    ...(options.credentials ?? []),
    ...(options.otherAccountToken
      ? [
          {
            token: options.otherAccountToken,
            actorId: "mock-other-app",
            actorKind: "app" as const,
            accountId: "biz_mock_other",
            grants: { biz_mock_other: fullScopes },
          },
        ]
      : []),
    ...(options.noEmailToken
      ? [
          {
            token: options.noEmailToken,
            actorId: "mock-no-email-app",
            actorKind: "app" as const,
            accountId: "biz_mock_primary",
            grants: {
              biz_mock_primary: fullScopes.filter(
                (scope) => scope !== "member:email:read",
              ),
            },
          },
        ]
      : []),
  ];
  const primary: FetchOptions = {
    actorId: "mock-primary-app",
    actorKind: "app",
    accountId: "biz_mock_primary",
    grants: { biz_mock_primary: fullScopes },
  };
  const readonly: FetchOptions = {
    ...primary,
    actorId: "mock-readonly-app",
    grants: {
      biz_mock_primary: fullScopes.filter((scope) => scope.endsWith(":read")),
    },
  };
  const seededCredentials = new Map<
    string,
    {
      tokens: {
        api_token: string;
        read_only_token: string;
        no_email_token: string;
      };
      profiles: Array<FetchOptions & { token: string }>;
    }
  >();
  function credentialsFor(account: string) {
    let result = seededCredentials.get(account);
    if (!result) {
      const tokens = {
        api_token: `local_seed_${randomUUID()}`,
        read_only_token: `local_seed_${randomUUID()}`,
        no_email_token: `local_seed_${randomUUID()}`,
      };
      result = {
        tokens,
        profiles: Object.entries(tokens).map(([kind, token]) => ({
          token,
          actorId: `seed-${account}-${kind}`,
          actorKind: "app" as const,
          accountId: account,
          grants: {
            [account]: fullScopes.filter(
              (scope) =>
                (kind !== "read_only_token" || scope.endsWith(":read")) &&
                (kind !== "no_email_token" || scope !== "member:email:read"),
            ),
          },
        })),
      };
      seededCredentials.set(account, result);
    }
    return result.tokens;
  }
  const retryScale = options.webhookRetryScale ?? 1;
  if (!Number.isFinite(retryScale) || retryScale < 0)
    throw new Error("webhookRetryScale must be non-negative");
  const disputeDelay = options.disputeWebhookDelayMs ?? 60000;
  if (!Number.isFinite(disputeDelay) || disputeDelay < 0)
    throw new Error("disputeWebhookDelayMs must be non-negative");
  const transport = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    session.currentApi.fetch(input, init, {});
  let fixtures: ResourceRecord;
  let generation = randomUUID();
  let downloadKey = randomUUID();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const events = new Map<string, WebhookEvent>();
  const deliveries: ResourceRecord[] = [];

  function reset(): ResourceRecord {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    session.currentApi.webhooks.close();
    session.webhookEmitter.clear();
    session = Session.build({ configuration: new Configuration() });
    idempotency = new IdempotencyStore();
    session.currentApi.webhooks.configure(
      async (url, init) => {
        if (!webhookUrl || url !== webhookUrl.href)
          throw new Error(
            "Webhook destination must match the operator-configured receiver",
          );
        return fetch(url, init);
      },
      retryScale,
      (event) => ({ ...event, data: rewrite(event.data) as ResourceRecord }),
    );
    generation = randomUUID();
    downloadKey = randomUUID();
    events.clear();
    seededCredentials.clear();
    deliveries.length = 0;
    const helper = new TestHelper(session);
    const primary = helper.createDisputeWithPayment({
      company: { id: "biz_mock_primary", title: "Synthetic merchant A" },
      payment: {
        id: "pay_mock_primary",
        total: 99.99,
        refunded_amount: 20,
        refundable: true,
        customer_email: "buyer@example.test",
      },
      dispute: {
        id: "dspt_mock_open",
        provider: "stripe",
        evidence_due_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
    });
    helper.createRefund({
      id: "rf_mock_partial",
      payment_id: primary.payment.id,
      amount: 20,
      status: "succeeded",
    });
    for (const [id, status, extra] of [
      [
        "dspt_mock_expired",
        "needs_response",
        { evidence_due_at: new Date(Date.now() - 3600000).toISOString() },
      ],
      [
        "dspt_mock_submitted",
        "under_review",
        { evidence_submitted_at: new Date().toISOString() },
      ],
      ["dspt_mock_won", "won", {}],
      ["dspt_mock_lost", "lost", {}],
      [
        "dspt_mock_inquiry",
        "warning_needs_response",
        { evidence_due_at: null },
      ],
    ] as const) {
      helper.createDispute({
        id,
        status,
        company_id: primary.company.id,
        payment_id: primary.payment.id,
        provider: "stripe",
        ...extra,
      });
    }
    helper.createDisputeWithPayment({
      company: { id: "biz_mock_other", title: "Synthetic merchant B" },
      payment: { id: "pay_mock_other", total: 25 },
      dispute: { id: "dspt_mock_other", provider: "stripe" },
    });
    fixtures = {
      account_id: primary.company.id,
      payment_id: primary.payment.id,
      refund_id: "rf_mock_partial",
      dispute_ids: session.store.list("dispute").map((row) => row.id),
    };
    return fixtures;
  }

  function baseUrl(): string {
    if (configuredBase) return configuredBase.origin;
    const address = server.address() as AddressInfo | null;
    if (!address) throw new Error("Server has not started");
    return `http://127.0.0.1:${address.port}`;
  }

  function signature(id: string, expires: string): string {
    return createHmac("sha256", downloadKey)
      .update(`${id}.${expires}`)
      .digest("hex");
  }

  function rewrite(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (
          ["upload_url", "url"].includes(key) &&
          typeof entry === "string" &&
          entry.startsWith("https://uploads.whop.mock/")
        ) {
          return [
            key,
            `${baseUrl()}/_uploads/${new URL(entry).pathname.slice(1)}`,
          ];
        }
        if (
          key === "url" &&
          typeof entry === "string" &&
          entry.startsWith("https://files.whop.mock/")
        ) {
          const id = new URL(entry).pathname.slice(1);
          if (session.store.find("file", id)?.visibility === "public")
            return [key, `${baseUrl()}/_files/${id}`];
          const expires = String(Math.floor(Date.now() / 1000) + 900);
          return [
            key,
            `${baseUrl()}/_files/${id}?expires=${expires}&signature=${signature(id, expires)}`,
          ];
        }
        return [key, rewrite(entry)];
      }),
    );
  }

  async function sendEvent(
    event: WebhookEvent,
    attempt = 0,
    reload = false,
  ): Promise<ResourceRecord> {
    if (!webhookUrl)
      throw new HttpError(
        400,
        "Set WHOP_MOCK_WEBHOOK_URL at startup before requesting HTTP delivery",
      );
    let payload = event;
    if (reload) {
      const resource = event.type.split(".")[0];
      const row = session.store.find(resource, String(event.data.id));
      if (!row)
        return {
          event_id: event.id,
          delivered: false,
          dropped: "resource_deleted",
        };
      const data =
        resource === "dispute"
          ? disputeResponse(row, session.store)
          : resource === "payment"
            ? paymentResponse(row)
            : refundResponse(row, session.store);
      payload = {
        ...event,
        timestamp: new Date().toISOString(),
        data: rewrite(data) as ResourceRecord,
      };
    }
    const delivery = signWebhook(payload, options.webhookSecret);
    const receipt: ResourceRecord = {
      event_id: event.id,
      attempted_at: new Date().toISOString(),
      attempt: attempt + 1,
    };
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        body: delivery.body,
        headers: delivery.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      receipt.status = response.status;
      receipt.delivered = response.ok;
      await response.body?.cancel();
    } catch {
      receipt.delivered = false;
      receipt.error = "Webhook connection failed or timed out";
    }
    deliveries.push(receipt);
    if (
      !receipt.delivered &&
      options.automaticWebhookRetries !== false &&
      attempt < WEBHOOK_RETRY_DELAYS_SECONDS.length
    ) {
      const base = WEBHOOK_RETRY_DELAYS_SECONDS[attempt];
      const milliseconds = Math.round(
        (base +
          1 +
          Math.floor(Math.random() * Math.max(1, Math.floor(base / 10)))) *
          1000 *
          retryScale,
      );
      receipt.retry_in_ms = milliseconds;
      const activeGeneration = generation;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (generation === activeGeneration)
          void sendEvent(event, attempt + 1, true).catch(() => {});
      }, milliseconds);
      timer.unref();
      timers.add(timer);
    }
    return receipt;
  }

  function processFile(id: string): void {
    if (delay <= 0) return;
    const activeSession = session;
    activeSession.store.update("file", id, { upload_status: "processing" });
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (
        session === activeSession &&
        activeSession.store.find("file", id)?.upload_status === "processing"
      )
        activeSession.store.update("file", id, { upload_status: "ready" });
    }, delay);
    timer.unref();
    timers.add(timer);
  }

  function scheduleDisputeUpdate(id: string): void {
    if (!webhookUrl) return;
    const activeGeneration = generation;
    const timer = setTimeout(() => {
      timers.delete(timer);
      const record = session.store.find("dispute", id);
      if (generation !== activeGeneration || !record || record.visa_rdr) return;
      const event = session.webhookEmitter.emit("dispute.updated", {
        data: { id },
      });
      event.data = rewrite(event.data) as ResourceRecord;
      events.set(event.id, structuredClone(event));
      void sendEvent(event).catch(() => {});
    }, disputeDelay);
    timer.unref();
    timers.add(timer);
  }

  async function handle(request: IncomingMessage): Promise<Response> {
    const url = new URL(request.url ?? "/", "http://local.invalid");
    const method = request.method ?? "GET";
    const token =
      /^Bearer\s+(.+)$/i.exec(
        String(request.headers.authorization ?? ""),
      )?.[1] ?? "";
    const admin = equalSecret(token, options.adminToken);
    const full = equalSecret(token, options.apiToken);
    const readOnly = options.readOnlyToken
      ? equalSecret(token, options.readOnlyToken)
      : false;
    const credential = [
      ...credentials,
      ...Array.from(seededCredentials.values()).flatMap(
        (entry) => entry.profiles,
      ),
    ].find((credential) => equalSecret(token, credential.token));
    if (url.pathname === "/healthz" && method === "GET") {
      return json({
        status: "ok",
        mode: "simulation",
        api_version_date: API_VERSION_DATE,
        backend_parity: "unverified",
      });
    }
    if (url.pathname.startsWith("/_files/")) {
      if (method !== "GET") throw new HttpError(405, "Use GET");
      const id = url.pathname.slice("/_files/".length);
      const expires = url.searchParams.get("expires") ?? "";
      const publicFile =
        session.store.find("file", id)?.visibility === "public";
      const valid =
        publicFile ||
        (/^\d+$/.test(expires) &&
          Number(expires) > Date.now() / 1000 &&
          equalSecret(
            url.searchParams.get("signature") ?? "",
            signature(id, expires),
          ));
      if (!valid)
        throw new HttpError(403, "Invalid or expired mock download URL");
      const bytes = session.currentApi.fileBytes(id);
      if (!bytes) throw new HttpError(404, "File not ready or not found");
      const record = session.store.find("file", id)!;
      return new Response(Buffer.from(bytes), {
        headers: {
          "content-type": String(record.content_type),
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname.startsWith("/_uploads/")) {
      if (method !== "PUT")
        throw new HttpError(405, "Use PUT for an upload URL");
      const body = await readBody(request, 32 * 1024 * 1024);
      const uploadToken = url.pathname.slice("/_uploads/".length);
      const result = await transport(
        `https://uploads.whop.mock/${uploadToken}`,
        {
          method,
          headers: {
            "content-type": String(request.headers["content-type"] ?? ""),
          },
          body,
        },
      );
      if (result.ok) {
        const file = session.store
          .list("file")
          .find((row) => row._uploadToken === uploadToken);
        if (file) processFile(String(file.id));
      }
      return result;
    }
    if (url.pathname.startsWith("/_test/")) {
      if (!admin) throw new HttpError(401, "Test-control admin token required");
      if (url.pathname === "/_test/status" && method === "GET")
        return json({
          generation,
          fixtures,
          resources: {
            account_ids: session.store.list("company").map((row) => row.id),
            payment_ids: session.store.list("payment").map((row) => row.id),
            dispute_ids: session.store.list("dispute").map((row) => row.id),
            refund_ids: session.store.list("refund").map((row) => row.id),
          },
          api_version_date: API_VERSION_DATE,
          backend_parity: "unverified",
          webhook_configured: Boolean(webhookUrl),
          deliveries,
        });
      const body = parseBody(await readBody(request, 256 * 1024));
      const paymentState = url.pathname.match(/^\/_test\/payments\/([^/]+)$/);
      if (paymentState && method === "PATCH")
        return json(
          rewrite(
            session.currentApi.payments.transition(paymentState[1], body),
          ),
        );
      const refundState = url.pathname.match(/^\/_test\/refunds\/([^/]+)$/);
      if (refundState && method === "PATCH") {
        if (Object.keys(body).some((key) => key !== "status"))
          throw new HttpError(
            400,
            "Only status can be changed on a simulated refund",
          );
        return json(
          rewrite(
            session.currentApi.payments.completeRefund(
              refundState[1],
              body.status,
            ),
          ),
        );
      }
      if (url.pathname === "/_test/reset" && method === "POST")
        return json({ fixtures: reset(), generation });
      if (url.pathname === "/_test/seed" && method === "POST") {
        const seeded = seedScenarios(session, body);
        return json(
          {
            ...seeded,
            credentials: credentialsFor(seeded.account_id),
            api_base_url: `${baseUrl()}/api/v1`,
            api_version_date: API_VERSION_DATE,
          },
          201,
        );
      }
      if (url.pathname === "/_test/scenarios" && method === "POST") {
        const accountId = String(body.account_id ?? "biz_mock_primary");
        const company = session.store.find("company", accountId);
        if (!company) throw new HttpError(404, "Fixture account not found");
        const amount = body.amount ?? 99.99;
        if (
          typeof amount !== "number" ||
          !Number.isFinite(amount) ||
          amount <= 0
        )
          throw new HttpError(
            400,
            "amount must be a positive number of USD major units",
          );
        const refunded = body.refund_amount ?? 0;
        if (
          typeof refunded !== "number" ||
          !Number.isFinite(refunded) ||
          refunded < 0 ||
          refunded > amount
        )
          throw new HttpError(
            400,
            "refund_amount must be between zero and amount",
          );
        const status = String(body.status ?? "needs_response");
        if (
          ![
            "needs_response",
            "warning_needs_response",
            "under_review",
            "warning_under_review",
            "won",
            "lost",
            "warning_closed",
            "closed",
          ].includes(status)
        )
          throw new HttpError(400, "Invalid fixture dispute status");
        const due =
          body.evidence_due_at === undefined
            ? new Date(Date.now() + 7 * 86400000).toISOString()
            : body.evidence_due_at;
        if (
          due !== null &&
          (typeof due !== "string" || !Number.isFinite(Date.parse(due)))
        )
          throw new HttpError(
            400,
            "evidence_due_at must be an ISO timestamp or null",
          );
        if (body.deliver === true && !webhookUrl)
          throw new HttpError(
            400,
            "Configure the webhook receiver before creating a delivered scenario",
          );
        const helper = new TestHelper(session);
        const created = helper.createDisputeWithPayment({
          company,
          payment: {
            total: amount,
            refunded_amount: refunded,
            customer_email: "buyer@example.test",
            status: "paid",
            substatus: refunded
              ? refunded === amount
                ? "refunded"
                : "partially_refunded"
              : "succeeded",
          },
          dispute: {
            status,
            evidence_due_at: due,
            provider: "stripe",
            reason:
              typeof body.reason === "string" ? body.reason : "fraudulent",
          },
        });
        const refund = refunded
          ? helper.createRefund({
              payment_id: created.payment.id,
              amount: refunded,
              status: "succeeded",
            })
          : null;
        const event = session.webhookEmitter.emit("dispute.created", {
          data: { id: created.dispute.id },
        });
        event.data = rewrite(event.data) as ResourceRecord;
        events.set(event.id, structuredClone(event));
        return json(
          {
            account_id: accountId,
            dispute_id: created.dispute.id,
            payment_id: created.payment.id,
            refund_id: refund?.id ?? null,
            event,
            ...(body.deliver === true
              ? { delivery: await sendEvent(event) }
              : {}),
          },
          201,
        );
      }
      if (url.pathname === "/_test/failures" && method === "POST") {
        const status = Number(body.status);
        if (
          !/^(retrieve|list|update|create|delete|submit|upload_evidence|accept|complete|capture|generate_pdf|refund|retry|void|resume|return_url|status|summary|list_fees|list_deliveries|replay|test)_(dispute|payment|refund|file|webhook)$/.test(
            String(body.action),
          ) ||
          ![400, 403, 404, 409, 429, 500, 503].includes(status)
        )
          throw new HttpError(400, "Supply a supported action and HTTP status");
        const phase =
          body.phase ??
          (status === 429
            ? "pre_execution"
            : status === 500
              ? "unknown"
              : "handled");
        if (
          !["handled", "pre_execution", "unknown"].includes(String(phase)) ||
          (phase === "pre_execution" && ![429, 503].includes(status)) ||
          (phase === "unknown" && status !== 500) ||
          (status === 429 && phase !== "pre_execution")
        )
          throw new HttpError(
            400,
            "phase must match the failure: handled, pre_execution (429/503), or unknown (500)",
          );
        session.errorInjector.prepare(Error, String(body.action), {
          attributes: {
            status,
            idempotencyDisposition:
              phase === "pre_execution"
                ? "release"
                : phase === "unknown"
                  ? "unknown"
                  : "record",
          },
          message: "Injected test failure",
        });
        return json({ prepared: true });
      }
      const submission = url.pathname.match(/^\/_test\/submissions\/([^/]+)$/);
      if (submission && method === "POST") {
        if (!["accepted", "rejected"].includes(String(body.outcome)))
          throw new HttpError(400, "outcome must be accepted or rejected");
        try {
          const previous = session.store.find("dispute", submission[1]);
          const result = session.currentApi.completeDisputeSubmission(
            submission[1],
            body.outcome as "accepted" | "rejected",
          );
          if (
            body.outcome === "accepted" &&
            previous?.status !==
              session.store.find("dispute", submission[1])?.status
          )
            scheduleDisputeUpdate(submission[1]);
          return json(rewrite(result));
        } catch {
          throw new HttpError(400, "No pending submission for this dispute");
        }
      }
      const disputeState = url.pathname.match(/^\/_test\/disputes\/([^/]+)$/);
      if (disputeState && method === "PATCH") {
        const record = session.store.find("dispute", disputeState[1]);
        if (!record) throw new HttpError(404, "Dispute not found");
        if (
          ![
            "needs_response",
            "warning_needs_response",
            "under_review",
            "warning_under_review",
            "won",
            "lost",
            "closed",
            "warning_closed",
          ].includes(String(body.status))
        )
          throw new HttpError(400, "Invalid simulated dispute state");
        const updated = session.store.update("dispute", disputeState[1], {
          status: body.status,
          updated_at: new Date().toISOString(),
        })!;
        if (record.status !== updated.status)
          scheduleDisputeUpdate(disputeState[1]);
        return json(rewrite(disputeResponse(updated, session.store)));
      }
      const fileState = url.pathname.match(/^\/_test\/files\/([^/]+)$/);
      if (fileState && method === "PATCH") {
        if (
          body.upload_status !== undefined &&
          !["processing", "ready", "failed"].includes(
            String(body.upload_status),
          )
        )
          throw new HttpError(400, "Invalid simulated upload state");
        if (!session.store.find("file", fileState[1]))
          throw new HttpError(404, "File not found");
        if (
          body.direct_upload_id !== undefined &&
          (typeof body.direct_upload_id !== "string" ||
            !body.direct_upload_id ||
            body.direct_upload_id.length > 512)
        )
          throw new HttpError(
            400,
            "direct_upload_id must be a non-empty synthetic token, at most 512 characters",
          );
        if (
          body.direct_upload_id &&
          session.store
            .list("file")
            .some(
              (row) =>
                row.id !== fileState[1] &&
                row._directUploadId === body.direct_upload_id,
            )
        )
          throw new HttpError(
            409,
            "direct_upload_id already names another fixture file",
          );
        const file = session.store.update("file", fileState[1], {
          ...(body.upload_status !== undefined
            ? { upload_status: body.upload_status }
            : {}),
          ...(body.direct_upload_id !== undefined
            ? { _directUploadId: body.direct_upload_id }
            : {}),
        });
        return json({ id: file!.id, upload_status: file!.upload_status });
      }
      if (url.pathname === "/_test/events" && method === "POST") {
        const type = String(body.type);
        if (
          ![
            "dispute.created",
            "dispute.updated",
            "payment.succeeded",
            "payment.failed",
            "payment.created",
            "payment.authorized",
            "payment.canceled",
            "payment.pending",
            "payment.requires_action",
            "refund.created",
            "refund.updated",
          ].includes(type)
        )
          throw new HttpError(400, "Unsupported scenario event type");
        if (!session.store.find(type.split(".")[0], String(body.resource_id)))
          throw new HttpError(404, "Event resource not found");
        if (
          body.previous_attributes !== undefined &&
          (!body.previous_attributes ||
            typeof body.previous_attributes !== "object" ||
            Array.isArray(body.previous_attributes))
        )
          throw new HttpError(400, "previous_attributes must be an object");
        if (
          type.startsWith("dispute.") &&
          session.store.find("dispute", String(body.resource_id))?.visa_rdr
        )
          throw new HttpError(
            400,
            "Visa RDR uses dispute-alert events on the native API",
          );
        // Snapshot the public HTTP representation so files in webhook data have usable URLs.
        const event = session.webhookEmitter.emit(type, {
          data: { id: body.resource_id },
          previous_attributes: body.previous_attributes as
            | ResourceRecord
            | undefined,
        });
        event.data = rewrite(event.data) as ResourceRecord;
        events.set(event.id, structuredClone(event));
        return json(
          {
            event,
            delivery: signWebhook(event, options.webhookSecret),
            ...(body.deliver === true
              ? { result: await sendEvent(event) }
              : {}),
          },
          201,
        );
      }
      const replay = url.pathname.match(/^\/_test\/events\/([^/]+)\/deliver$/);
      if (replay && method === "POST") {
        const event = events.get(replay[1]);
        if (!event) throw new HttpError(404, "Event not found");
        return json(await sendEvent(event));
      }
      throw new HttpError(404, "Unknown test-control endpoint");
    }
    if (url.pathname.startsWith("/api/v1/")) {
      const buyerRoute = url.pathname.match(
        /^\/api\/v1\/payments\/([^/]+)\/(status|return_url|resume)$/,
      );
      if (!full && !readOnly && !credential && !buyerRoute)
        throw new HttpError(401, "Invalid test API token");
      const version = resolveApiVersion(
        request.headers["api-version-date"] as string | undefined,
      );
      const body = await readBody(
        request,
        String(request.headers["content-type"] ?? "").startsWith(
          "multipart/form-data",
        )
          ? 26 * 1024 * 1024
          : 256 * 1024,
      );
      const secret = buyerRoute
        ? method === "GET"
          ? url.searchParams.get("client_secret")
          : parseBody(body).client_secret
        : undefined;
      const buyer =
        buyerRoute &&
        session.currentApi.payments.clientSecretGrants(buyerRoute[1], secret);
      if (!full && !readOnly && !credential && !buyer)
        throw new HttpError(401, "Invalid test API token");
      const profile =
        credential ??
        (full
          ? primary
          : readOnly
            ? readonly
            : { actorId: `buyer:${buyerRoute?.[1]}`, grants: {} });
      const headers = {
        "content-type": String(
          request.headers["content-type"] ?? "application/json",
        ),
        "api-version-date": version.requested,
      };
      const input = new Request(
        `https://api.whop.mock${url.pathname}${url.search}`,
        {
          method,
          headers: {
            ...headers,
            ...(request.headers["idempotency-key"] !== undefined
              ? {
                  "idempotency-key": String(request.headers["idempotency-key"]),
                }
              : {}),
          },
          ...(method !== "GET" && method !== "HEAD" ? { body } : {}),
        },
      );
      const run = /\/payments\/[^/]+\/generate_pdf$/.test(url.pathname)
        ? async (
            _input: Request,
            _actor: string,
            _context: unknown,
            execute: () => Promise<Response>,
          ) => execute()
        : idempotency.run.bind(idempotency);
      const result = await run(
        input,
        profile.actorId ?? token,
        [version.requested, profile.accountId, "public"],
        async () => {
          const response = await session.currentApi.fetch(
            input.url,
            {
              method,
              headers,
              ...(method !== "GET" && method !== "HEAD" ? { body } : {}),
            },
            profile,
          );
          const data = (await response.json()) as ResourceRecord;
          if (
            response.ok &&
            url.pathname.match(/^\/api\/v1\/disputes\/[^/]+\/accept$/)
          )
            scheduleDisputeUpdate(String(data.id));
          if (
            response.ok &&
            url.pathname.match(/^\/api\/v1\/files\/[^/]+\/complete$/)
          ) {
            processFile(String(data.id));
            const current = await session.currentApi.fetch(
              `https://api.whop.mock/api/v1/files/${data.id}`,
              { headers },
              profile,
            );
            return json(rewrite(await current.json()), response.status);
          }
          return carryIdempotencyDisposition(
            response,
            json(rewrite(data), response.status),
          );
        },
      );
      return withApiVersion(result, version);
    }
    throw new HttpError(404, "Unknown endpoint");
  }

  const server = createServer((request, response) => {
    void (async () => {
      let result: Response;
      try {
        result = await handle(request);
      } catch (error) {
        const known = error instanceof HttpError || error instanceof ApiError;
        const status = known ? error.status : 500;
        const types: Record<number, string> = {
          400: "bad_request",
          401: "unauthorized",
          403: "forbidden",
          404: "not_found",
          409: "conflict",
          413: "payload_too_large",
        };
        result = json(
          {
            error: {
              type: types[status] ?? "internal_server_error",
              message: known ? error.message : "Mock server error",
            },
          },
          status,
        );
      }
      response.writeHead(result.status, {
        ...Object.fromEntries(result.headers),
        "cache-control": "no-store",
      });
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => response.destroy());
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("close", () => {
    for (const timer of timers) clearTimeout(timer);
    session.currentApi.webhooks.close();
    session.webhookEmitter.clear();
  });
  reset();
  return server;
}
