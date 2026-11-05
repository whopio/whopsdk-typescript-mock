import { resolveApiVersion, withApiVersion } from "./api-version.js";
import { createHash, randomUUID } from "node:crypto";
import type { Session } from "./session.js";
import type { ResourceRecord } from "./types.js";
import { disputeFailure, humanBytes } from "./dispute-errors.js";
import { PaymentOperations } from "./payment-operations.js";
import { queryChoices } from "./current-contract.js";
import { WebhookApi } from "./webhook-api.js";
import { receiptPdf } from "./receipt-pdf.js";
import {
  evidenceBudget,
  EVIDENCE_SLOTS,
  EVIDENCE_TEXT_FIELDS,
  object,
  disputeResponse,
  evidenceResponse,
  fileResponse,
  paymentResponse,
  refundResponse,
} from "./current-responses.js";
import {
  ApiError,
  bad,
  unsupported,
  can,
  readScope,
  paginate,
  errorResponse,
  IdempotencyStore,
  type FetchOptions,
} from "./current-protocol.js";
export type { FetchOptions } from "./current-protocol.js";
const MiB = 1024 * 1024;
const DOCUMENT_TYPES = [
  "return_policy",
  "shipping_policy",
  "cancellation_policy",
  "terms_of_service",
  "physical_fulfillment",
  "customer_order_history",
  "product_image",
  "prior_transactions",
  "customer_session",
  "digital_fulfillment",
  "subscription",
  "customer_communication",
];
const MIME_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  json: "application/json",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
};
const ALLOWED_MIME = new Set([
  "application/pdf",
  "application/json",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Scoped native-v1 adapter. The legacy fixture engine still owns records and IDs. */
export class CurrentApi {
  private uploads = new Map<
    string,
    {
      id: string;
      bytes?: Uint8Array;
      expiresAt: number;
      part?: number;
      etag?: string;
      completed?: boolean;
    }
  >();
  private multipart = new Map<
    string,
    { id: string; tokens: string[]; completed: boolean }
  >();
  private idempotency = new IdempotencyStore();
  private sequences = new Map<string, number>();
  private submissions = new Set<string>();
  readonly payments: PaymentOperations;
  readonly webhooks: WebhookApi;
  constructor(private session: Session) {
    this.payments = new PaymentOperations(session);
    this.webhooks = new WebhookApi(session);
  }

  serializeResource(resource: string, record: ResourceRecord): ResourceRecord {
    return this.serialize(resource, record);
  }

  /** Local HTTP harness only; API callers use the capability URL it issues. */
  fileBytes(id: string): Uint8Array | null {
    const file = this.store.find("file", id);
    if (!file || file.upload_status !== "ready") return null;
    const bytes = this.uploads.get(String(file._uploadToken))?.bytes;
    return bytes ? bytes.slice() : null;
  }

  private get store() {
    return this.session.store;
  }

  async fetch(
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
    options: FetchOptions,
  ): Promise<Response> {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    if (new URL(request.url).origin === "https://uploads.whop.mock")
      return this.execute(request, options);
    try {
      const version = resolveApiVersion(
        request.headers.get("api-version-date"),
      );
      const response = /\/payments\/[^/]+\/generate_pdf\/?$/.test(
        new URL(request.url).pathname,
      )
        ? await this.execute(request, options)
        : await this.idempotency.run(
            request,
            options.actorId ?? "mock-actor",
            [version.requested, options.accountId, "public"],
            () => this.execute(request, options),
          );
      return withApiVersion(response, version);
    } catch (error) {
      return errorResponse(error);
    }
  }

  private async execute(
    request: Request,
    options: FetchOptions,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin === "https://uploads.whop.mock")
        return await this.upload(request, url);
      if (!url.pathname.startsWith("/api/v1/"))
        unsupported(`${request.method} ${url.pathname}`);
      const version = resolveApiVersion(
        request.headers.get("api-version-date"),
      ).effective;
      const match = url.pathname.match(
        /^\/api\/v1\/(disputes|payments|refunds|files|webhooks)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?\/?$/,
      );
      if (!match) unsupported(`${request.method} ${url.pathname}`);
      const [, plural, id, action] = match!;
      const resource = plural.slice(0, -1);
      const actor = options.actorId ?? "mock-actor";
      const multipartBody = request.headers
        .get("content-type")
        ?.startsWith("multipart/form-data");
      let body: ResourceRecord = {};
      if (multipartBody) {
        if (
          plural !== "disputes" ||
          !id ||
          !(
            (request.method === "PATCH" && !action) ||
            (request.method === "POST" && action === "upload_evidence")
          )
        )
          unsupported("multipart input on this endpoint");
        const dispute = this.record(
          "dispute",
          id,
          actor,
          options,
          "payment:dispute",
        );
        if (!disputeResponse(dispute, this.store).evidence_editable)
          bad(
            "This dispute's evidence can no longer be edited. Read evidence_locked_reason for why.",
          );
        body = await this.multipartEvidence(request, actor, options, id);
      }
      const bodyText =
        request.method === "GET" || multipartBody ? "" : await request.text();
      if (bodyText) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          bad("Invalid JSON in request body");
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          bad("Request body must be a JSON object");
        body = parsed as ResourceRecord;
      }
      const verb =
        request.method === "GET"
          ? action === "deliveries"
            ? "list_deliveries"
            : action === "fees"
              ? "list_fees"
              : action === "status"
                ? "status"
                : id === "summary"
                  ? "summary"
                  : id
                    ? "retrieve"
                    : "list"
          : request.method === "DELETE"
            ? "delete"
            : request.method === "PATCH"
              ? (action ?? "update")
              : match![5] === "replay"
                ? "replay"
                : (action ?? "create");
      this.session.errorInjector.raiseForAction(`${verb}_${resource}`);
      if (plural === "webhooks")
        return this.json(
          await this.webhooks.execute(
            request.method,
            match!.slice(2).filter(Boolean),
            body,
            url.searchParams,
            options,
          ),
        );
      if (match![4]) unsupported(`${request.method} ${url.pathname}`);

      if (
        ["disputes", "payments"].includes(plural) &&
        id === "summary" &&
        request.method === "GET"
      )
        return this.json(
          this.list(resource, url.searchParams, actor, options, version, true),
        );
      if (plural === "payments") {
        if (request.method === "POST" && !id)
          return this.json(
            this.serialize(
              "payment",
              this.payments.create(body, options),
              false,
              options,
            ),
            201,
          );
        if (id) {
          const result = this.payments.execute(
            request.method,
            id,
            action,
            body,
            url.searchParams,
            options,
          );
          if (result && action === "generate_pdf") {
            const sourceId = object(result.value._runtime).pdf_file_id;
            const bytes = sourceId
              ? this.fileBytes(String(sourceId))
              : receiptPdf(paymentResponse(result.value));
            if (!bytes) bad("Seeded receipt PDF file is not ready");
            const file = this.createFile(
              { filename: `invoice_${id}.pdf` },
              actor,
              options,
            );
            const response = await this.upload(
              new Request(String(file.upload_url), {
                method: "PUT",
                headers: file.upload_headers as Record<string, string>,
                body: Buffer.from(bytes),
              }),
              new URL(String(file.upload_url)),
            );
            if (!response.ok) return response;
            return this.json({
              url: `https://files.whop.mock/${file.id}`,
              expires_at: new Date(Date.now() + 900000).toISOString(),
            });
          }
          if (result)
            return this.json(
              [
                "status",
                "capture",
                "resume",
                "return_url",
                "fees",
                "generate_pdf",
              ].includes(action ?? "")
                ? result.value
                : this.serialize("payment", result.value, false, options),
              result.status ?? 200,
            );
        }
      }
      if (request.method === "GET" && !action) {
        if (!id)
          return this.json(
            this.list(resource, url.searchParams, actor, options, version),
          );
        const record = this.record(resource, id, actor, options);
        if (
          resource === "dispute" &&
          disputeResponse(record, this.store).evidence_editable
        )
          this.refreshPolicies(record);
        return this.json(
          this.serialize(
            resource,
            this.store.find(resource, id)!,
            false,
            options,
          ),
        );
      }
      if (plural === "files" && request.method === "POST" && !id) {
        return this.json(this.createFile(body, actor, options), 201);
      }
      if (
        plural === "files" &&
        id &&
        action === "complete" &&
        request.method === "POST"
      )
        return this.json(
          this.completeFile(this.record("file", id, actor, options), body),
        );
      if (plural === "disputes" && id) {
        if (
          (request.method === "PATCH" && !action) ||
          (request.method === "POST" &&
            ["upload_evidence", "submit", "accept"].includes(action))
        ) {
          const dispute = this.record(
            "dispute",
            id,
            actor,
            options,
            "payment:dispute",
          );
          const current = disputeResponse(dispute, this.store);
          if (action === "accept") {
            if (dispute.status !== "needs_response")
              disputeFailure(
                "dispute_not_an_open_chargeback",
                "Only a chargeback that is still awaiting a response can be accepted.",
              );
            if (current.evidence_locked_reason)
              disputeFailure(
                "dispute_response_closed",
                "This dispute can no longer be accepted because a response was already submitted or the response window has closed.",
              );
            if (!current.acceptable)
              disputeFailure(
                "dispute_acceptance_unsupported",
                "This dispute's payment processor doesn't support accepting disputes.",
              );
            this.store.update("dispute", id, {
              status: "lost",
              updated_at: new Date().toISOString(),
            });
            return this.json(
              this.serialize(
                "dispute",
                this.store.find("dispute", id)!,
                false,
                options,
              ),
            );
          }
          if (!current.evidence_editable)
            bad(
              `This dispute's evidence can no longer be ${action === "submit" ? "submitted" : "edited"}. Read evidence_locked_reason for why.`,
            );
          if (action === "submit") {
            this.checkSubmission(dispute);
            // The production endpoint starts a workflow. Repeating a pending submission is idempotent.
            this.submissions.add(id);
            return this.json(
              this.serialize("dispute", dispute, false, options),
            );
          }
          let evidence: ResourceRecord;
          if (action === "upload_evidence") {
            evidence = { documents: body.documents };
          } else {
            // Only evidence fields below are mutable; ignore unknown fields and status.
            if (
              body.evidence != null &&
              (typeof body.evidence !== "object" ||
                Array.isArray(body.evidence))
            )
              bad("evidence must be an object");
            evidence = object(body.evidence);
          }
          this.updateEvidence(dispute, evidence, actor);
          return this.json(
            this.serialize(
              "dispute",
              this.store.find("dispute", id)!,
              false,
              options,
            ),
          );
        }
      }
      unsupported(
        `${request.method} ${url.pathname}; use fixture helpers to seed bank-created disputes and payment/refund outcomes`,
      );
    } catch (error) {
      return errorResponse(error);
    }
  }

  /** Test control, not a Whop endpoint. No acceptance is inferred from HTTP 200. */
  completeDisputeSubmission(
    id: string,
    outcome: "accepted" | "rejected",
  ): ResourceRecord {
    if (!["accepted", "rejected"].includes(outcome))
      throw new Error("Outcome must be accepted or rejected");
    if (!this.submissions.delete(id))
      throw new Error(`No pending submission for ${id}`);
    const record = this.store.find("dispute", id);
    if (!record) throw new Error(`Dispute ${id} not found`);
    // Leave disputes unchanged if they no longer await a response.
    if (
      outcome === "accepted" &&
      [
        "needs_response",
        "warning_needs_response",
        "generating_response",
      ].includes(String(record.status))
    ) {
      const inquiry = disputeResponse(record, this.store).inquiry;
      this.store.update("dispute", id, {
        status: inquiry ? "warning_under_review" : "under_review",
        evidence_submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    return disputeResponse(this.store.find("dispute", id)!, this.store);
  }

  private serialize(
    resource: string,
    record: ResourceRecord,
    listing = false,
    options: FetchOptions = {},
  ): ResourceRecord {
    if (resource === "dispute") {
      const result = disputeResponse(record, this.store);
      if (!can(options, result.account_id, "member:email:read"))
        object(result.buyer).email = null;
      return result;
    }
    if (resource === "payment") {
      const result = paymentResponse(record, listing);
      if (!can(options, result.account_id, "member:email:read"))
        result.customer_email = null;
      if (!can(options, result.account_id, "member:basic:read"))
        for (const key of [
          "member_id",
          "membership_id",
          "recovery_url",
          "user_agent",
          "wuid",
        ])
          result[key] = null;
      if (!can(options, result.account_id, "payment:charge"))
        result.client_secret = null;
      if (!can(options, result.account_id, "shipment:basic:read"))
        for (const key of ["shipment_id", "needs_tracking"]) result[key] = null;
      if (
        !can(options, result.account_id, "payment:dispute:read") &&
        !can(options, result.account_id, "payment:resolution_center_case:read")
      )
        result.response_due_at = null;
      return result;
    }
    if (resource === "refund") return refundResponse(record, this.store);
    return fileResponse(record);
  }

  private visible(
    resource: string,
    record: ResourceRecord,
    actor: string,
    options: FetchOptions,
  ): boolean {
    if (resource === "file")
      return record._actor === actor && options.actorKind !== "user_api_key";
    return can(
      options,
      this.serialize(resource, record).account_id,
      readScope(resource),
    );
  }

  private record(
    resource: string,
    id: string,
    actor: string,
    options: FetchOptions,
    scope = readScope(resource),
  ): ResourceRecord {
    const record = this.store.find(resource, id);
    if (
      !record ||
      (resource === "file" &&
        !this.visible(resource, record, actor, options)) ||
      (resource === "dispute" && record.status === "other")
    )
      throw new ApiError(404, `${resource} not found`);
    if (
      resource !== "file" &&
      !can(options, this.serialize(resource, record).account_id, scope)
    )
      throw new ApiError(403, `Missing required permission: ${scope}`);
    return record;
  }

  private list(
    resource: string,
    params: URLSearchParams,
    actor: string,
    options: FetchOptions,
    version: string,
    summary = false,
  ): ResourceRecord {
    const query = new URLSearchParams();
    const arrays = [
      "file_ids",
      "status",
      "statuses",
      "substatuses",
      "currencies",
      "product_ids",
      "variant_ids",
      "billing_reasons",
      "payment_methods",
      "tracking_states",
      "groups",
    ];
    for (const [key, value] of params) {
      const name = key.replace(/\[\]$/, "");
      for (const item of arrays.includes(name)
        ? value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
        : [value])
        query.append(name, item);
    }
    const connectedKey =
      version >= "2026-11-03-1"
        ? "include_subaccounts"
        : "include_connected_accounts";
    if (query.has("company_id") && resource === "refund")
      bad("company_id is not supported; filter by account_id");
    const filters =
      resource === "file"
        ? ["file_ids"]
        : resource === "dispute"
          ? ["account_id", "status", "currency"]
          : resource === "refund"
            ? ["account_id", "payment_id", "user_id"]
            : [
                "account_id",
                "status",
                "statuses",
                "substatuses",
                "currency",
                "currencies",
                "product_id",
                "product_ids",
                "variant_id",
                "variant_ids",
                "membership_id",
                "member_id",
                "user_id",
                "billing_reason",
                "billing_reasons",
              ];
    const allowed = [
      ...filters,
      "first",
      "after",
      "last",
      "before",
      "order",
      "direction",
      "created_after",
      "created_before",
      ...(resource === "dispute" || resource === "payment"
        ? ["query", connectedKey]
        : []),
      ...(summary ? ["groups"] : []),
      ...(resource === "payment"
        ? [
            "mode",
            "payment_methods",
            "tracking_status",
            "tracking_states",
            "include_total_count",
            "min_amount",
            "max_amount",
            "refunded_after",
            "refunded_before",
            "dispute_alerted_after",
            "dispute_alerted_before",
            "dispute_created_after",
            "dispute_created_before",
          ]
        : []),
    ];
    if (resource === "payment") {
      const legacy: Record<string, string> = {
        company_id: "filter by account_id",
        checkout_configuration_ids:
          "not supported natively yet — stay pinned before 2026-09-02-1 for it",
        updated_before:
          "not supported natively yet — stay pinned before 2026-09-02-1 for it",
        updated_after:
          "not supported natively yet — stay pinned before 2026-09-02-1 for it",
        include_free: "zero-amount payments are always included natively",
      };
      for (const [key, replacement] of Object.entries(legacy))
        if (query.get(key)) bad(`${key} is not supported; ${replacement}`);
    }
    for (const [key] of query)
      if (!allowed.includes(key)) unsupported(`list parameter ${key}`);
    const connected = query.get(connectedKey);
    if (connected !== null && !["true", "false"].includes(connected))
      bad(`${connectedKey} must be true or false`);
    if (connected === "true" && !query.get("account_id"))
      bad("account_id is required when including connected accounts");
    if (
      connected === "true" &&
      !query.get("query")?.trim() &&
      !["account", "user"].includes(options.actorKind ?? "app")
    )
      bad("query is required when including connected accounts");
    const scope = readScope(resource);
    if (resource === "payment") {
      for (const key of [
        "status",
        "currency",
        "product_id",
        "variant_id",
        "billing_reason",
      ]) {
        if (query.getAll(key).length > 1)
          bad(
            `${key} must be a single value; repeat ${key === "status" ? "statuses" : key === "currency" ? "currencies" : `${key}s`} to pass several`,
          );
      }
      for (const key of [
        "mode",
        "billing_reason",
        "billing_reasons",
        "payment_methods",
        "tracking_status",
        "tracking_states",
      ]) {
        const choices = queryChoices(
          "/payments",
          key === "billing_reason" ? "billing_reasons" : key,
        );
        for (const value of query.getAll(key))
          if (choices.length && !choices.includes(value))
            bad(`Invalid ${key} '${value}'`);
      }
      if (query.get("mode") === "user_sales" && options.actorKind !== "user")
        throw new ApiError(403, "user_sales requires a user credential");
      if (query.get("user_id") === "me")
        bad(
          "user_id 'me' is not supported: payments are listed for the accounts you manage. List your own purchases with GET /memberships?user_id=me.",
        );
      if (query.has("tracking_states") || query.has("tracking_status")) {
        const target = query.get("account_id") || options.accountId;
        if (!target && query.has("tracking_states"))
          bad("tracking_states requires account_id");
        if (!can(options, target, "shipment:basic:read"))
          throw new ApiError(
            403,
            "Missing required permission: shipment:basic:read",
          );
      }
    }
    const account =
      resource === "file"
        ? undefined
        : query.get("account_id") || options.accountId;
    if (account) {
      if (!this.store.find("company", account))
        throw new ApiError(404, "Account not found");
      if (!can(options, account, scope))
        throw new ApiError(403, `Missing required permission: ${scope}`);
    }
    if (resource === "file") {
      const ids = [...new Set(query.getAll("file_ids"))];
      if (!ids.length) bad("file_ids is required — pass at least one file ID");
      if (ids.length > 250) bad("file_ids accepts at most 250 IDs per request");
      const invalid = ids.filter(
        (id) => !id.startsWith("file_") || id.length > 18,
      );
      if (invalid.length)
        bad(`file_ids must be prefixed file_: ${invalid.join(", ")}`);
      if (options.actorKind === "user_api_key")
        throw new ApiError(404, "File not found");
    }
    if (resource === "refund") {
      if (
        query.get("payment_id") &&
        !this.store.find("payment", query.get("payment_id")!)
      )
        throw new ApiError(404, "Payment not found");
      if (
        query.get("user_id") &&
        !this.store.find("user", query.get("user_id")!)
      )
        throw new ApiError(404, "User not found");
    }
    const statuses =
      resource === "dispute"
        ? [
            "needs_response",
            "warning_needs_response",
            "under_review",
            "warning_under_review",
            "won",
            "lost",
            "prevented",
            "warning_closed",
          ]
        : [
            "open",
            "authorized",
            "paid",
            "pending",
            "uncollectible",
            "unresolved",
            "void",
          ];
    for (const value of [
      ...query.getAll("status"),
      ...query.getAll("statuses"),
    ])
      if (!statuses.includes(value))
        bad(`Invalid status '${value}'. Allowed: ${statuses.join(", ")}`);
    if (resource === "payment") {
      // Substatus filters use the public payment substatus vocabulary.
      const substatuses = [
        "succeeded",
        "requires_capture",
        "pending",
        "failed",
        "blocked",
        "past_due",
        "canceled",
        "price_too_low",
        "uncollectible",
        "refunded",
        "auto_refunded",
        "partially_refunded",
        "dispute_warning",
        "dispute_needs_response",
        "dispute_warning_needs_response",
        "resolution_needs_response",
        "dispute_under_review",
        "dispute_warning_under_review",
        "resolution_under_review",
        "dispute_won",
        "dispute_warning_closed",
        "resolution_won",
        "dispute_lost",
        "dispute_closed",
        "resolution_lost",
        "drafted",
        "incomplete",
        "unresolved",
      ];
      for (const value of query.getAll("substatuses"))
        if (!substatuses.includes(value)) bad(`Invalid substatus '${value}'`);
    }
    const raw = this.store.list(resource);
    for (const row of raw) {
      const key = `${resource}:${row.id}`;
      if (!this.sequences.has(key))
        this.sequences.set(key, this.sequences.size + 1);
    }
    let rows = raw
      .filter((row) => this.visible(resource, row, actor, options))
      .filter((row) => resource !== "payment" || row.status !== "draft")
      .filter(
        (row) =>
          resource !== "dispute" || (!row.visa_rdr && row.status !== "other"),
      )
      .map((row) => ({
        raw: row,
        value: this.serialize(resource, row, true, options),
      }));
    if (resource === "payment" && query.get("mode") === "user_sales")
      rows = rows.filter(
        ({ raw }) =>
          !raw.account_id &&
          !raw.company_id &&
          raw.seller_user_id === options.actorId,
      );
    if (account)
      rows = rows.filter(
        ({ value }) =>
          value.account_id === account ||
          (connected === "true" &&
            this.store.find("company", String(value.account_id))
              ?.parent_account_id === account),
      );
    const needle = query.get("query")?.trim();
    if (needle && needle.length >= 3)
      rows = rows.filter(({ raw, value }) => {
        const payment =
          resource === "dispute"
            ? (this.store.find("payment", String(object(value.payment).id)) ??
              {})
            : raw;
        const membership =
          this.store.find("membership", String(payment.membership_id)) ?? {};
        const user = {
          ...this.store.find("user", String(payment.user_id)),
          ...object(payment.user),
        };
        const email = String(
          payment.customer_email ?? user.email ?? "",
        ).toLowerCase();
        const emailReadable = can(
          options,
          value.account_id,
          "member:email:read",
        );
        if (needle.startsWith("dspt_")) {
          if (resource === "dispute") return value.id === needle;
          const dispute = this.store.find("dispute", needle);
          return (
            dispute?.payment_id === payment.id ||
            object(dispute?.payment).id === payment.id
          );
        }
        if (/^(pay_|user_|mem_|mship_)/.test(needle))
          return [
            payment.id,
            object(payment.user).id,
            payment.user_id,
            payment.member_id,
            payment.membership_id,
          ].includes(needle);
        if (needle.startsWith("sub_"))
          return membership.stripe_subscription_id === needle;
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(needle) && emailReadable)
          return email.startsWith(needle.toLowerCase());
        const discord = object(membership.discord_account);
        if (/\d{16,}/.test(needle))
          return String(discord.id ?? membership.discord_id ?? "") === needle;
        const instrument = object(payment.payment_instrument);
        const card = object(instrument.card);
        const cardBin = String(
          card.issuer_identification_number ??
            payment.issuer_identification_number ??
            card.bin ??
            card.first6 ??
            payment.card_bin,
        );
        const cardQuery = needle.match(/^(\d{6}|\d{8})[\s*•·.\-xX]+(\d{4})$/);
        if (cardQuery)
          return (
            (cardBin.startsWith(cardQuery[1]) ||
              cardBin === cardQuery[1].slice(0, 6)) &&
            String(card.last4 ?? payment.card_last4) === cardQuery[2]
          );
        if (/\d{4}/.test(needle))
          return String(card.last4 ?? payment.card_last4) === needle;
        return (
          membership.license_key === needle ||
          (emailReadable && email.startsWith(needle.toLowerCase())) ||
          [
            user.name,
            user.username,
            discord.username,
            object(payment.billing_address).name,
          ].some(
            (value) =>
              typeof value === "string" &&
              value.toLowerCase().includes(needle.toLowerCase()),
          )
        );
      });
    const aliases: Record<string, string> = {
      statuses: "status",
      substatuses: "substatus",
      currencies: "currency",
      product_ids: "product_id",
      variant_ids: "variant_id",
    };
    for (const key of filters) {
      if (key === "account_id") continue;
      if (
        resource === "payment" &&
        [
          "statuses",
          "currencies",
          "product_ids",
          "variant_ids",
          "billing_reasons",
        ].includes(key)
      )
        continue;
      const plural: Record<string, string> = {
        status: "statuses",
        currency: "currencies",
        product_id: "product_ids",
        variant_id: "variant_ids",
        billing_reason: "billing_reasons",
      };
      const values = [
        ...query.getAll(key),
        ...(resource === "payment" && plural[key]
          ? query.getAll(plural[key])
          : []),
      ]
        .filter(Boolean)
        .map((value) =>
          key.startsWith("currenc") ? value.toLowerCase() : value,
        );
      if (!values.length) continue;
      if (key === "billing_reason" && values.includes("subscription_cycle"))
        values.push("subscription_update");
      rows = rows.filter(({ raw, value }) => {
        if (resource === "dispute" && key === "status") {
          const status = String(raw.status);
          const open =
            value.evidence_locked_reason !== "response_window_closed";
          return values.some((wanted) =>
            wanted === "needs_response"
              ? status === "needs_response" && open
              : wanted === "under_review"
                ? ["under_review", "generating_response"].includes(status) ||
                  (status === "needs_response" && !open)
                : wanted === "prevented"
                  ? status === "closed" || status === "prevented"
                  : status === wanted,
          );
        }
        const actual =
          resource === "payment" && key === "currency"
            ? (object(raw.presentment_total).currency ?? raw.currency)
            : key === "file_ids"
              ? value.id
              : key === "user_id"
                ? (object(
                    resource === "refund"
                      ? this.store.find("payment", String(value.payment_id))
                          ?.user
                      : raw.user,
                  ).id ?? raw.user_id)
                : value[aliases[key] ?? key];
        return values.includes(String(actual));
      });
    }
    if (resource === "payment") {
      const minimum = query.has("min_amount")
        ? Number(query.get("min_amount"))
        : null;
      const maximum = query.has("max_amount")
        ? Number(query.get("max_amount"))
        : null;
      if (
        [minimum, maximum].some(
          (n) => n !== null && (!Number.isFinite(n) || n < 0),
        )
      )
        bad("min_amount and max_amount must be non-negative numbers");
      if (minimum !== null && maximum !== null && maximum < minimum)
        bad("max_amount must not be less than min_amount");
      rows = rows.filter(({ raw, value }) => {
        const charged = Math.round(
          100 *
            Number(
              raw.final_amount ?? object(value.presentment_total).amount ?? 0,
            ),
        );
        if (minimum !== null && charged < Math.round(minimum * 100))
          return false;
        if (maximum !== null && charged > Math.round(maximum * 100))
          return false;
        const methods = query.getAll("payment_methods");
        const card = object(object(value.payment_instrument).card);
        if (
          methods.length &&
          !methods.some((v) =>
            [
              value.payment_method_type,
              card.brand,
              card.wallet_type,
              raw.card_brand,
              raw.wallet_type,
            ].includes(v),
          )
        )
          return false;
        const tracking = [
          ...query.getAll("tracking_states"),
          ...query.getAll("tracking_status"),
        ];
        if (
          tracking.length &&
          !tracking.some((v) =>
            v === "needs_tracking"
              ? value.needs_tracking && !value.shipment_id
              : v === "missing_tracking"
                ? value.status === "paid" &&
                  value.shipping_address &&
                  !value.shipment_id &&
                  Number(object(value.refunded_amount).amount ?? 0) <
                    Number(object(value.total).amount)
                : raw.tracking_status === v,
          )
        )
          return false;
        return true;
      });
    }
    for (const key of [
      "created_after",
      "created_before",
      ...(resource === "payment"
        ? [
            "refunded_after",
            "refunded_before",
            "dispute_alerted_after",
            "dispute_alerted_before",
            "dispute_created_after",
            "dispute_created_before",
          ]
        : []),
    ]) {
      const value = query.get(key);
      if (!value) continue;
      const time = Date.parse(value);
      if (
        !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(
          value,
        ) ||
        !Number.isFinite(time)
      )
        bad(`'${value}' is not a valid ISO 8601 timestamp for ${key}`);
      rows = rows.filter(({ raw }) => {
        const field = key.replace(/_(after|before)$/, "_at");
        const dates = key.startsWith("dispute_created_")
          ? this.store
              .list("dispute")
              .filter(
                (d) =>
                  d.payment_id === raw.id || object(d.payment).id === raw.id,
              )
              .map((d) => d.provider_created_at ?? d.created_at)
          : [raw[field]];
        return dates.some((date) =>
          key.endsWith("_after")
            ? Date.parse(String(date)) > time
            : Date.parse(String(date)) < time,
        );
      });
    }
    if (summary) {
      const groups = query.getAll("groups");
      const requested = groups.length
        ? [...new Set(groups)]
        : [resource === "payment" ? "substatus" : "status", "currency"];
      const result: ResourceRecord = {};
      for (const field of requested) {
        if (
          ![
            resource === "payment" ? "substatus" : "status",
            "currency",
          ].includes(field)
        )
          bad(`Invalid groups '${field}'`);
        const counts: Record<string, number> =
          field === "status"
            ? Object.fromEntries(statuses.map((s) => [s, 0]))
            : field === "substatus"
              ? Object.fromEntries(
                  queryChoices("/payments", "substatuses").map((s) => [s, 0]),
                )
              : {};
        for (const row of rows) {
          const key = String(
            field === "status" && String(row.raw.status).startsWith("warning_")
              ? row.raw.status
              : field === "currency" && resource === "payment"
                ? (object(row.value.presentment_total).currency ??
                  row.value.currency)
                : (row.value[field] ??
                  (field === "substatus" ? "incomplete" : "")),
          );
          counts[key] = (counts[key] ?? 0) + 1;
        }
        result[field] = counts;
      }
      return { total: rows.length, groups: result };
    }
    const order = query.get("order") || "created_at";
    const orders =
      resource === "dispute"
        ? ["created_at", "amount", "evidence_due_at"]
        : resource === "payment"
          ? ["created_at", "paid_at", "amount"]
          : ["created_at"];
    if (!orders.includes(order))
      bad(`order must be one of: ${orders.join(", ")}`);
    const direction = query.get("direction") || "desc";
    if (!["asc", "desc"].includes(direction))
      bad("direction must be one of: asc, desc");
    // Cursor signature: public resource, sort key and direction. Payments
    // ordered by created_at page on the stable sequence alone.
    const column =
      resource === "payment" && order === "created_at" ? "id" : order;
    const signature = createHash("sha256")
      .update(
        [
          resource,
          `${column}:${direction}:column`,
          ...(column === "id" ? [] : [`id:${direction}:column`]),
        ].join(","),
      )
      .digest("hex")
      .slice(0, 12);
    const page = paginate(
      rows.map(({ raw, value }) => {
        const seq = Number(
          raw._databaseId ?? this.sequences.get(`${resource}:${raw.id}`),
        );
        const rawValue =
          order === "amount"
            ? Number(
                raw.final_amount ??
                  object(raw.presentment_total).amount ??
                  object(raw.total).amount ??
                  raw.total ??
                  raw.amount,
              )
            : order === "evidence_due_at"
              ? (raw.due_date ?? value.evidence_due_at)
              : raw[order];
        const key =
          rawValue == null
            ? null
            : typeof rawValue === "number"
              ? rawValue
              : String(rawValue);
        return { value, keys: column === "id" ? [seq] : [key, seq] };
      }),
      query,
      signature,
      resource === "file"
        ? Math.min(100, new Set(query.getAll("file_ids")).size)
        : 20,
    );
    if (resource === "payment") {
      const count = query.get("include_total_count");
      if (count !== null && !["true", "false", "1", "0"].includes(count))
        bad("include_total_count must be true or false");
      Object.assign(object(page.page_info), {
        total_count:
          count === "true" || count === "1"
            ? Math.min(rows.length, 10000)
            : null,
        total_count_capped:
          (count === "true" || count === "1") && rows.length >= 10000,
      });
    }
    return page;
  }

  private createFile(
    body: ResourceRecord,
    actor: string,
    options: FetchOptions,
  ): ResourceRecord {
    if (typeof body.filename !== "string" || !body.filename.trim())
      bad("filename is required");
    if (body.filename.length > 255) bad("Filename too long");
    if (
      /[\x00-\x1f\x7f/\\]/.test(body.filename) ||
      body.filename.startsWith(".") ||
      body.filename.endsWith(".")
    )
      bad("Invalid filename");
    const extension = body.filename.split(".").at(-1)!.toLowerCase();
    if (
      options.uploadAllowlist &&
      !"jpg jpeg png gif webp heic heif avif tiff bmp ico svg mp4 mov webm mkv m4v mp3 wav m4a aac ogg opus pdf doc docx xls xlsx ppt pptx txt md csv json jsonl zip html htm"
        .split(" ")
        .includes(extension)
    )
      bad("File type is not allowed");
    if (body.byte_size != null && !/^[+-]?\d+$/.test(String(body.byte_size)))
      bad(`'${body.byte_size}' is not a valid value for byte_size`);
    if (body.multipart != null && typeof body.multipart !== "boolean")
      bad("multipart must be a boolean");
    if (
      body.visibility != null &&
      body.visibility !== "" &&
      !["public", "private"].includes(String(body.visibility))
    )
      bad("visibility must be public or private");
    const multipart = body.multipart === true;
    const size = Number(body.byte_size);
    if (multipart && body.byte_size == null)
      bad("byte_size is required for multipart uploads");
    if (multipart && size <= 5 * MiB)
      bad("The file is too small to be uploaded in parts");
    if (multipart && Math.ceil(size / (5 * MiB)) > 10000)
      bad(
        "The file is too large: multipart uploads support at most 10000 parts of 5 MB each.",
      );
    const token = randomUUID();
    const id = this.session.idGenerator.generate("file");
    const record = this.store.insert("file", {
      id,
      filename: body.filename,
      content_type:
        MIME_TYPES[body.filename.split(".").at(-1)!.toLowerCase()] ??
        "application/octet-stream",
      created_at: new Date().toISOString(),
      visibility: body.visibility || "private",
      upload_status: "pending",
      _actor: actor,
      _uploadToken: token,
    });
    this.uploads.set(token, { id, expiresAt: Date.now() + 60 * 60 * 1000 });
    if (multipart) {
      const uploadId = randomUUID();
      const tokens = Array.from(
        { length: Math.ceil(size / (5 * MiB)) },
        (_, index) => {
          const partToken = randomUUID();
          this.uploads.set(partToken, {
            id,
            expiresAt: Date.now() + 900000,
            part: index + 1,
          });
          return partToken;
        },
      );
      this.multipart.set(uploadId, { id, tokens, completed: false });
      return {
        ...fileResponse(record),
        upload_url: null,
        upload_headers: {},
        multipart_upload_id: uploadId,
        multipart_upload_urls: tokens.map((t, index) => ({
          part_number: index + 1,
          url: `https://uploads.whop.mock/${t}`,
        })),
        multipart_chunk_size: 5 * MiB,
      };
    }
    return {
      ...fileResponse(record),
      upload_url: `https://uploads.whop.mock/${token}`,
      upload_headers: { "Content-Type": record.content_type },
      multipart_upload_id: null,
      multipart_upload_urls: null,
      multipart_chunk_size: null,
    };
  }

  private completeFile(
    file: ResourceRecord,
    body: ResourceRecord,
  ): ResourceRecord {
    if (
      typeof body.multipart_upload_id !== "string" ||
      !body.multipart_upload_id.trim()
    )
      bad("multipart_upload_id is required");
    if (!Array.isArray(body.multipart_parts))
      bad("multipart_parts must be an array");
    const upload = this.multipart.get(body.multipart_upload_id);
    if (!upload || upload.id !== file.id || upload.completed)
      bad(
        "No multipart upload found for this file with that multipart_upload_id. It may have already been completed or aborted.",
      );
    const chunks: Uint8Array[] = [];
    let previous = 0;
    for (const [index, input] of body.multipart_parts.entries()) {
      const part = object(input);
      const number = Number(part.part_number);
      const stored = this.uploads.get(upload.tokens[number - 1]);
      if (
        !Number.isInteger(number) ||
        number <= previous ||
        !stored?.bytes ||
        part.etag !== stored.etag
      )
        bad(
          "One or more parts are invalid: every part must have been uploaded, each etag must match the upload response, and part numbers must be ascending.",
        );
      if (
        index < body.multipart_parts.length - 1 &&
        stored.bytes.length < 5 * MiB
      )
        bad("Each part (other than the last) must be at least 5 MB.");
      chunks.push(stored.bytes);
      previous = number;
    }
    if (!chunks.length)
      bad(
        "One or more parts are invalid: every part must have been uploaded, each etag must match the upload response, and part numbers must be ascending.",
      );
    upload.completed = true;
    const bytes = Buffer.concat(chunks);
    for (const token of upload.tokens) {
      const part = this.uploads.get(token)!;
      part.completed = true;
      part.bytes = undefined;
    }
    this.uploads.get(String(file._uploadToken))!.bytes = bytes;
    this.store.update("file", String(file.id), {
      size: bytes.length,
      upload_status: "ready",
      url: `https://files.whop.mock/${file.id}`,
    });
    return fileResponse(this.store.find("file", String(file.id))!);
  }

  private async upload(request: Request, url: URL): Promise<Response> {
    const upload = this.uploads.get(url.pathname.slice(1));
    if (!upload) throw new ApiError(403, "Unknown mock upload URL");
    if (Date.now() >= upload.expiresAt)
      throw new ApiError(403, "Mock upload URL expired");
    if (upload.completed)
      return new Response(
        "<Error><Code>NoSuchUpload</Code><Message>The specified multipart upload does not exist.</Message></Error>",
        { status: 404, headers: { "content-type": "application/xml" } },
      );
    if (request.method !== "PUT")
      unsupported(`${request.method} on upload URL`);
    const record = this.store.find("file", upload.id)!;
    if (
      !upload.part &&
      request.headers.get("content-type") !== record.content_type
    )
      throw new ApiError(
        403,
        "Use the upload_headers returned by files.create",
      );
    upload.bytes = new Uint8Array(await request.arrayBuffer());
    upload.etag = `"${createHash("md5").update(upload.bytes).digest("hex")}"`;
    if (upload.part)
      return new Response(null, {
        status: 200,
        headers: { etag: upload.etag },
      });
    this.store.update("file", upload.id, {
      size: upload.bytes.length,
      upload_status: "ready",
      url: `https://files.whop.mock/${upload.id}`,
    });
    // Processing is immediate in the mock. Real uploads may need polling before they are ready.
    return new Response(null, { status: 200, headers: { etag: upload.etag } });
  }

  private evidenceFile(
    input: unknown,
    actor: string,
    disputeId: string,
    document = false,
  ): ResourceRecord {
    const ref = { ...object(input) };
    if (ref.file) bad("documents file must be an uploaded file");
    if (ref.direct_upload_id) {
      const file = this.store
        .list("file")
        .find((file) => file._directUploadId === ref.direct_upload_id);
      if (!file)
        bad(
          "The direct upload ID provided is invalid. If this is an existing attachment, use the 'id' input instead.",
        );
      ref.id = file!.id;
    }
    if (typeof ref.id !== "string")
      bad("Evidence attachment must have a file id");
    const file = this.store.find("file", ref.id);
    if (!file && !document) throw new ApiError(404, "File not found");
    if (!file || (file._disputeId && file._disputeId !== disputeId))
      bad("File is unavailable to this dispute");
    if (file.upload_status !== "ready")
      bad("File upload must finish before attaching evidence");
    if (document && !ALLOWED_MIME.has(String(file.content_type)))
      bad("File content type is not accepted for dispute evidence");
    if (document && Number(file.size) > 10 * MiB)
      bad("File exceeds the 10 MiB per-document limit");
    return file;
  }

  private async multipartEvidence(
    request: Request,
    actor: string,
    options: FetchOptions,
    disputeId: string,
  ): Promise<ResourceRecord> {
    let form: Awaited<ReturnType<Request["formData"]>>;
    try {
      form = await request.formData();
    } catch {
      bad("Invalid multipart request body");
    }
    const body: ResourceRecord = {};
    for (const [name, value] of form!) {
      const keys = name.match(/[^\[\]]+/g) ?? [];
      if (
        !keys.length ||
        keys.some((key) =>
          ["__proto__", "prototype", "constructor"].includes(key),
        )
      )
        bad("Invalid form field");
      let parent: any = body;
      keys.forEach((key, index) => {
        if (index === keys.length - 1) parent[key] = value;
        else {
          parent[key] ??= /^\d+$/.test(keys[index + 1]) ? [] : {};
          if (typeof parent[key] !== "object" || parent[key] instanceof Blob)
            bad("Conflicting multipart form fields");
          parent = parent[key];
        }
      });
    }
    const target = request.method === "PATCH" ? object(body.evidence) : body;
    const documents = target.documents;
    if (documents !== undefined) {
      if (!Array.isArray(documents) || documents.length > 10)
        bad("documents must be an array with at most 10 entries");
      let total = 0;
      for (const input of documents) {
        const doc = object(input),
          file = doc.file as { size?: number; name?: string } | undefined;
        if (!DOCUMENT_TYPES.includes(String(doc.document_type)))
          bad("Invalid document_type");
        if (file && typeof file.size === "number") {
          if (file.size > 10 * MiB)
            bad(`${file.name} exceeds the 10MB per-document limit`);
          total += file.size;
        } else
          total += Number(
            this.evidenceFile(input, actor, disputeId, true).size,
          );
      }
      if (total > 25 * MiB)
        bad("The evidence documents exceed the 25MB total limit");
      for (const input of documents) {
        const doc = object(input),
          part = doc.file as
            | { name?: string; arrayBuffer?: () => Promise<ArrayBuffer> }
            | undefined;
        if (!part) continue;
        if (!part.name || typeof part.arrayBuffer !== "function")
          bad("documents file must be an uploaded file");
        const upload = this.createFile({ filename: part.name }, actor, options);
        const raw = this.store.find("file", String(upload.id))!;
        if (!ALLOWED_MIME.has(String(raw.content_type))) {
          this.store.delete("file", String(upload.id));
          bad("File content type is not accepted for dispute evidence");
        }
        await this.upload(
          new Request(String(upload.upload_url), {
            method: "PUT",
            headers: upload.upload_headers as Record<string, string>,
            body: Buffer.from(await part.arrayBuffer!()),
          }),
          new URL(String(upload.upload_url)),
        );
        delete doc.file;
        delete doc.direct_upload_id;
        doc.id = upload.id;
      }
    }
    return body;
  }

  private updateEvidence(
    dispute: ResourceRecord,
    input: ResourceRecord,
    actor: string,
  ): void {
    // Apply only the fields below and ignore unknown evidence keys.
    const evidence = evidenceResponse(dispute);
    const oldEvidence = structuredClone(evidence);
    const files: ResourceRecord[] = [];
    const removedDocuments = new Set<unknown>();
    for (const key of EVIDENCE_TEXT_FIELDS) {
      if (!(key in input)) continue;
      if (input[key] !== null && typeof input[key] !== "string")
        bad(`${key} must be a string or null`);
      if (
        ["billing_address", "customer_name", "service_date"].includes(key) &&
        String(input[key] ?? "").length > 255
      )
        bad(`${key} exceeds 255 characters`);
      evidence[key] = input[key];
    }
    if ("documents" in input) {
      if (!Array.isArray(input.documents) || input.documents.length > 10)
        bad("documents must be an array with at most 10 entries");
      const seen = new Set();
      let bytes = 0;
      const positions = new Map<unknown, number>();
      const counts = new Map<string, number>();
      evidence.documents = input.documents.map((value) => {
        const ref = object(value);
        if (!DOCUMENT_TYPES.includes(String(ref.document_type)))
          bad("Invalid document_type");
        const file = this.evidenceFile(value, actor, String(dispute.id), true);
        if (seen.has(file.id))
          bad("Each document must reference a different file");
        seen.add(file.id);
        const category = String(ref.document_type);
        const position = (counts.get(category) ?? 0) + 1;
        counts.set(category, position);
        positions.set(file.id, position);
        bytes += Number(file.size);
        if (bytes > 25 * MiB) bad("Documents exceed the 25 MiB total limit");
        // Each attachment has one category; moving it into documents clears its fixed slot.
        for (const slot of Object.keys(EVIDENCE_SLOTS))
          if (object(evidence[slot]).id === file.id) evidence[slot] = null;
        files.push(file);
        return {
          ...fileResponse(file),
          visibility: "private",
          document_type: ref.document_type,
        };
      });
      // Order documents by position within category, then creation time.
      (evidence.documents as ResourceRecord[]).sort(
        (a, b) =>
          positions.get(a.id)! - positions.get(b.id)! ||
          String(a.created_at).localeCompare(String(b.created_at)),
      );
      for (const doc of oldEvidence.documents as ResourceRecord[])
        if (!seen.has(doc.id)) removedDocuments.add(doc.id);
    }
    for (const key of Object.keys(EVIDENCE_SLOTS)) {
      if (!(key in input)) continue;
      if (input[key] === null) {
        evidence[key] = null;
        continue;
      }
      const ref = object(input[key]);
      // Remove detached documents before resolving fixed-slot references;
      // a now-deleted reference fails and rolls back the entire transaction.
      if (removedDocuments.has(ref.id))
        throw new ApiError(404, "File not found");
      if (
        input[key] !== null &&
        typeof input[key] === "object" &&
        !Array.isArray(input[key]) &&
        !ref.id &&
        !ref.direct_upload_id
      )
        continue; // Hosted policy echoed back.
      const file = this.evidenceFile(input[key], actor, String(dispute.id));
      if (
        key === "customer_communication_attachment" &&
        !["image/jpeg", "image/png", "image/gif", "application/pdf"].includes(
          String(file.content_type),
        )
      )
        bad("File content type is not accepted for customer communication");
      for (const slot of Object.keys(EVIDENCE_SLOTS))
        if (slot !== key && object(evidence[slot]).id === file.id)
          evidence[slot] = null;
      evidence.documents = (evidence.documents as ResourceRecord[]).filter(
        (doc) => doc.id !== file.id,
      );
      files.push(file);
      evidence[key] = {
        id: file.id,
        filename: file.filename,
        content_type: file.content_type,
        url: file.url,
        platform: false,
      };
      dispute._policyCopies = { ...object(dispute._policyCopies) };
      delete object(dispute._policyCopies)[key];
      if (key === "cancellation_policy_attachment")
        dispute.uses_platform_cancellation_policy = false;
      if (key === "refund_policy_attachment")
        dispute.uses_platform_refund_policy = false;
    }
    // All validation finishes before any store write, matching transactional replacement.
    for (const file of files)
      this.store.update("file", String(file.id), {
        _disputeId: dispute.id,
        visibility: "private",
      });
    const refs = (value: ResourceRecord) =>
      [
        ...Object.keys(EVIDENCE_SLOTS).map((key) => object(value[key]).id),
        ...((value.documents ?? []) as ResourceRecord[]).map((doc) => doc.id),
      ].filter(Boolean);
    const retained = new Set(refs(evidence));
    for (const removed of refs(oldEvidence))
      if (
        !retained.has(removed) &&
        this.store.find("file", String(removed))?._disputeId === dispute.id
      )
        this.store.delete("file", String(removed));
    this.store.update("dispute", String(dispute.id), {
      evidence,
      _policyCopies: dispute._policyCopies,
      uses_platform_cancellation_policy:
        dispute.uses_platform_cancellation_policy,
      uses_platform_refund_policy: dispute.uses_platform_refund_policy,
      updated_at: new Date().toISOString(),
    });
  }

  private refreshPolicies(dispute: ResourceRecord): void {
    const account = this.store.find(
      "company",
      String(dispute.account_id ?? dispute.company_id),
    );
    const policies = object(account?._policies);
    const evidence = evidenceResponse(dispute);
    let changed = false;
    for (const [slot, flag, candidates] of [
      [
        "cancellation_policy_attachment",
        "uses_platform_cancellation_policy",
        ["cancellation_policy", "terms_of_service", "return_policy"],
      ],
      [
        "refund_policy_attachment",
        "uses_platform_refund_policy",
        ["return_policy", "terms_of_service"],
      ],
    ] as const) {
      const current = object(evidence[slot]);
      // Explicit per-dispute uploads win; account-derived policy copies can refresh.
      if (current.id && !object(dispute._policyCopies)[slot]) continue;
      const file = candidates
        .map((kind) => this.store.find("file", String(policies[kind])))
        .find(
          (file) =>
            file &&
            file.upload_status === "ready" &&
            file.content_type === "application/pdf" &&
            Number(file.size) <= evidenceBudget(dispute) &&
            file._whopTerms !== true,
        );
      if (!file) {
        if (current.id || dispute[flag]) continue; // Never empty a populated account copy.
        dispute[flag] = true;
        changed = true;
        continue;
      }
      if (object(dispute._policyCopies)[slot] === file.id) continue;
      if (current.id) this.store.delete("file", String(current.id));
      const copyId = this.session.idGenerator.generate("file");
      this.store.insert("file", {
        ...file,
        id: copyId,
        _actor: null,
        _disputeId: dispute.id,
        visibility: "private",
        url: `https://files.whop.mock/${copyId}`,
      });
      evidence[slot] = {
        id: copyId,
        filename: file.filename,
        content_type: file.content_type,
        url: `https://files.whop.mock/${copyId}`,
        platform: false,
      };
      dispute._policyCopies = {
        ...object(dispute._policyCopies),
        [slot]: file.id,
      };
      dispute[flag] = false;
      changed = true;
    }
    if (changed)
      this.store.update("dispute", String(dispute.id), {
        evidence,
        _policyCopies: dispute._policyCopies,
        uses_platform_cancellation_policy:
          dispute.uses_platform_cancellation_policy,
        uses_platform_refund_policy: dispute.uses_platform_refund_policy,
        updated_at: new Date().toISOString(),
      });
  }

  private checkSubmission(dispute: ResourceRecord): void {
    const budget = evidenceBudget(dispute);
    const evidence = evidenceResponse(dispute);
    const documents = evidence.documents as ResourceRecord[];
    const entries = documents.map(
      (doc) => [String(doc.document_type), doc] as const,
    );
    for (const [slot, category] of Object.entries(EVIDENCE_SLOTS)) {
      if (
        !entries.some(([type]) => type === category) &&
        object(evidence[slot]).id
      )
        entries.push([category, object(evidence[slot])]);
    }
    const seen = new Set();
    let total = 0;
    const sizes: [string, number][] = [];
    for (const [category, doc] of entries) {
      if (
        [
          "return_policy",
          "shipping_policy",
          "terms_of_service",
          "cancellation_policy",
        ].includes(category) ||
        seen.has(doc.id)
      )
        continue;
      seen.add(doc.id);
      const file = this.store.find("file", String(doc.id));
      if (!file || file.upload_status !== "ready")
        disputeFailure(
          "dispute_evidence_file_unavailable",
          "We couldn't download one of your evidence files. Please try again, or upload it again and submit.",
        );
      const isImage = String(file.content_type).startsWith("image/");
      const limit = isImage ? 10 * MiB : budget;
      if (Number(file.size) > limit)
        disputeFailure(
          "dispute_evidence_file_over_limit",
          `${file.filename} is ${humanBytes(Number(file.size))}. This dispute takes files of at most ${humanBytes(limit, true)}. Upload a smaller file, then submit again.`,
        );
      const billed = isImage
        ? Math.min(Number(file.size), MiB)
        : Number(file.size);
      total += billed;
      sizes.push([String(file.filename), billed]);
    }
    if (total > budget) {
      let remaining = total;
      const largest = sizes
        .sort((a, b) => b[1] - a[1])
        .filter(([, size]) => {
          const take = remaining > budget;
          remaining -= size;
          return take;
        });
      disputeFailure(
        "dispute_evidence_bytes_over_limit",
        `Your evidence comes to ${humanBytes(total)}. This dispute takes at most ${humanBytes(budget, true)} in one filing. Shrink or remove ${largest.map(([name, size]) => `${name} (${humanBytes(size)})`).join(", ")}, then submit again.`,
      );
    }
  }

  private json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
}
