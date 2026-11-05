import type { Session } from "./session.js";
import type { ResourceRecord } from "./types.js";
import {
  object,
  paymentResponse,
  refundResponse,
} from "./current-responses.js";
import {
  ApiError,
  bad,
  can,
  unsupported,
  type FetchOptions,
} from "./current-protocol.js";
import {
  validateCurrentBody,
  validateCurrentSchema,
} from "./current-contract.js";

export const EMPTY_PAGE = {
  start_cursor: null,
  end_cursor: null,
  has_next_page: false,
  has_previous_page: false,
};

function metadata(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value))
    bad("metadata must be an object");
  const entries = Object.entries(value);
  if (entries.length > 50) bad("metadata must have at most 50 keys");
  for (const [key, item] of entries) {
    if (key.length > 100 || typeof item !== "string" || item.length > 500)
      bad(
        "metadata keys must be at most 100 characters and values must be strings of at most 500 characters",
      );
  }
  return value;
}

function returnUrl(value: unknown): string {
  if (typeof value !== "string") bad("return_url must be a string");
  if (value.length > 2048) bad("return_url is too long");
  try {
    const url = new URL(value);
    if (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      return value;
  } catch {
    /* The same validation error below covers malformed URLs. */
  }
  bad(
    "return_url must be an absolute https URL without credentials (http is allowed for localhost)",
  );
}

// Exact minor-unit arithmetic; no binary-float subtraction of refund balances.
function units(value: ResourceRecord): bigint {
  const [whole, fraction = ""] = String(value.amount).split(".");
  const decimals = Number(value.decimals);
  const padded = fraction.padEnd(decimals, "0");
  if (padded.length > decimals && /[1-9]/.test(padded.slice(decimals)))
    bad("Amount exceeds the currency's precision");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(padded.slice(0, decimals) || "0")
  );
}
function fromUnits(value: bigint, template: ResourceRecord): ResourceRecord {
  const precision = Number(template.decimals);
  const digits = value.toString().padStart(precision + 1, "0");
  return {
    ...template,
    amount: precision
      ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}`
      : digits,
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}

/** Native actions over seeded receipts. Processor outcomes are explicit fixture inputs. */
export class PaymentOperations {
  constructor(private session: Session) {}
  private get store() {
    return this.session.store;
  }

  status(payment: ResourceRecord, options: FetchOptions): ResourceRecord {
    const fixture = object(payment._payment_status);
    const accountId = payment.account_id ?? payment.company_id;
    const account = this.store.find("company", String(accountId));
    const derived =
      (
        {
          paid: "succeeded",
          void: "canceled",
          uncollectible: "canceled",
          authorized: "requires_capture",
          draft: "requires_confirmation",
          open: "requires_confirmation",
        } as Record<string, string>
      )[String(payment.status)] ?? "processing";
    const status = String(fixture.status ?? derived);
    let action =
      status === "requires_action" ? (fixture.next_action ?? null) : null;
    if (
      object(action).type === "collect_card_present" &&
      !can(options, accountId, "payment:charge")
    )
      action = null;
    return {
      id: payment.id,
      object: "payment_status",
      account: account ? { id: account.id, title: account.title ?? "" } : null,
      status,
      next_action: action,
      processing_details:
        status === "processing" ? (fixture.processing_details ?? null) : null,
      last_payment_error: fixture.last_payment_error ?? null,
      return_url: fixture.return_url ?? null,
      capture_expires_at: payment.capture_expires_at ?? null,
      auto_capture_at: payment.auto_capture_at ?? null,
    };
  }

  clientSecretGrants(id: string, value: unknown): boolean {
    const payment = this.store.find("payment", id);
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value === payment?.client_secret
    );
  }

  /** Admin-only processor completion; never exposed as a Whop endpoint. */
  transition(id: string, input: ResourceRecord): ResourceRecord {
    const payment = this.store.find("payment", id);
    if (!payment) throw new ApiError(404, "Payment not found");
    const allowed = [
      "status",
      "substatus",
      "paid_at",
      "refundable",
      "voidable",
      "retryable",
      "capture_expires_at",
      "auto_capture_at",
      "recovery_url",
      "payment_status",
    ];
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      bad("Unknown payment simulation field");
    const { payment_status, ...fields } = input;
    const next = {
      ...payment,
      ...fields,
      updated_at: new Date().toISOString(),
      _payment_status: {
        ...object(payment._payment_status),
        ...object(payment_status),
      },
    };
    const inferred = (
      {
        paid: "succeeded",
        void: "canceled",
        authorized: "requires_capture",
        pending: "processing",
        uncollectible: "canceled",
      } as Record<string, string>
    )[String(input.status)];
    if (inferred && !object(payment_status).status)
      next._payment_status.status = inferred;
    validateCurrentSchema("Payment", paymentResponse(next));
    validateCurrentSchema("PaymentStatus", this.status(next, {}));
    this.store.update("payment", id, next);
    const eventFor = (record: ResourceRecord) => {
      if (record.status === "open") {
        if (record.substatus === "failed") return "failed";
        if (
          object(record._payment_status).status === "requires_action" &&
          record.recovery_url
        )
          return "requires_action";
      }
      return (
        {
          paid: "succeeded",
          void: "canceled",
          authorized: "authorized",
          pending: "pending",
          uncollectible: "failed",
        } as Record<string, string>
      )[String(record.status)];
    };
    const event = eventFor(next);
    if (event && event !== eventFor(payment))
      this.session.webhookEmitter.emit(`payment.${event}`, { data: { id } });
    return paymentResponse(next);
  }

  completeRefund(id: string, status: unknown): ResourceRecord {
    const refund = this.store.find("refund", id);
    if (!refund) throw new ApiError(404, "Refund not found");
    const next = { ...refund, status, updated_at: new Date().toISOString() };
    validateCurrentSchema("Refund", refundResponse(next, this.store));
    const payment = this.store.find("payment", String(refund.payment_id))!;
    const dto = paymentResponse(payment);
    const all = this.store
      .list("refund")
      .filter((row) => row.payment_id === payment.id && row.id !== id)
      .concat(next)
      .filter((row) => row.status === "succeeded");
    let refunded = 0n,
      original = 0n;
    let settlementKnown = dto.total !== null;
    for (const row of all) {
      const value = refundResponse(row, this.store);
      if (value.amount === null) settlementKnown = false;
      else refunded += units(object(value.amount));
      original += units(object(value.original_amount));
    }
    if (
      (dto.total !== null && refunded > units(object(dto.total))) ||
      (dto.presentment_total !== null &&
        original > units(object(dto.presentment_total)))
    )
      bad("Successful refunds exceed the payment's remaining balance");
    const fullyRefunded = settlementKnown
      ? refunded === units(object(dto.total))
      : dto.presentment_total !== null &&
        original === units(object(dto.presentment_total));
    this.store.update("refund", id, next);
    this.store.update("payment", String(payment.id), {
      refunded_amount: settlementKnown
        ? fromUnits(refunded, object(dto.total))
        : null,
      presentment_refunded_amount:
        dto.presentment_total === null
          ? null
          : fromUnits(original, object(dto.presentment_total)),
      refundable:
        payment.status === "paid" && settlementKnown && !fullyRefunded,
      substatus: fullyRefunded
        ? "refunded"
        : refunded > 0n || original > 0n
          ? "partially_refunded"
          : payment.substatus,
      ...(refunded > 0n || original > 0n
        ? { refunded_at: next.updated_at }
        : {}),
    });
    this.session.webhookEmitter.emit("refund.updated", { data: { id } });
    return refundResponse(next, this.store);
  }

  private authorize(
    id: string,
    options: FetchOptions,
    scope: string,
    secret?: unknown,
  ): ResourceRecord {
    const payment = this.store.find("payment", id);
    if (!payment) throw new ApiError(404, "Payment not found");
    if (
      !this.clientSecretGrants(id, secret) &&
      !can(options, payment.account_id ?? payment.company_id, scope)
    )
      throw new ApiError(403, `Missing required permission: ${scope}`);
    return payment;
  }

  create(body: ResourceRecord, options: FetchOptions): ResourceRecord {
    // Creation consumes a seeded request/result pair: pricing, tax, token vaulting and
    // purchase resources are outside this fixture engine, so never invent their outcome.
    if (typeof body.account_id !== "string" || !body.account_id)
      bad("account_id is required");
    if (!this.store.find("company", body.account_id))
      throw new ApiError(404, "Account not found");
    if (!can(options, body.account_id, "payment:charge"))
      throw new ApiError(403, "Missing required permission: payment:charge");
    const plan = this.store
      .list("payment_creation")
      .find((row) => canonical(row.request) === canonical(body));
    validateCurrentBody("/payments", "post", body);
    if (!plan)
      unsupported(
        "unseeded payment creation; seed an exact create_payment request and its synthetic result",
      );
    const result = object(plan!.payment);
    const now = new Date().toISOString();
    const payment = this.store.insert("payment", {
      ...result,
      id: this.session.idGenerator.generate("payment"),
      account_id: body.account_id,
      created_at: now,
      updated_at: now,
      metadata: metadata(body.metadata),
      _payment_status: object(plan!.payment_status),
    });
    this.session.webhookEmitter.emit("payment.created", {
      data: { id: payment.id },
    });
    return payment;
  }

  execute(
    method: string,
    id: string,
    action: string | undefined,
    body: ResourceRecord,
    params: URLSearchParams,
    options: FetchOptions,
  ): { value: ResourceRecord; status?: number } | null {
    const statusRoute = ["status", "return_url", "resume"].includes(
      action ?? "",
    );
    const allowed =
      method === "GET"
        ? ["status", "fees"]
        : method === "POST"
          ? ["capture", "generate_pdf", "refund", "retry", "void", "resume"]
          : method === "PATCH"
            ? [undefined, "return_url"]
            : [];
    if (!allowed.includes(action)) return null;
    const scope =
      method === "GET" || action === "generate_pdf" || action === "resume"
        ? "payment:basic:read"
        : action === "capture"
          ? "payment:charge"
          : "payment:manage";
    const secret = statusRoute
      ? method === "GET"
        ? params.get("client_secret")
        : body.client_secret
      : undefined;
    const payment = this.authorize(id, options, scope, secret);
    const runtime = object(payment._runtime);
    if (action === "status") return { value: this.status(payment, options) };
    if (action === "fees")
      return { value: { data: payment._fees ?? [], page_info: EMPTY_PAGE } };
    if (action === "generate_pdf") return { value: payment };
    let changes: ResourceRecord = {};
    if (method === "PATCH") {
      if (!action) {
        const unknown = Object.keys(body).filter(
          (key) => !["shipping_address", "return_url"].includes(key),
        );
        if (unknown.length) bad(`Unknown parameters: ${unknown.join(", ")}`);
      }
      if ("shipping_address" in body && !action) {
        if (payment.shipment_id)
          bad(
            "The shipping address cannot be changed after a shipment has been created for this payment",
          );
        if (body.shipping_address === null) changes.shipping_address = null;
        else {
          if (
            !body.shipping_address ||
            typeof body.shipping_address !== "object" ||
            Array.isArray(body.shipping_address)
          )
            bad("shipping_address must be an object");
          const address = Object.fromEntries(
            Object.entries(object(body.shipping_address)).filter(
              ([key, value]) =>
                [
                  "name",
                  "line1",
                  "line2",
                  "city",
                  "state",
                  "postal_code",
                  "country",
                ].includes(key) &&
                value != null &&
                value !== "",
            ),
          );
          if (!Object.keys(address).length)
            bad(
              "shipping_address must include at least one field. Pass null to remove it.",
            );
          for (const [key, value] of Object.entries(address))
            if (typeof value !== "string" || value.length > 255)
              bad(
                `shipping_address.${key} must be a string of at most 255 characters`,
              );
          changes.shipping_address = Object.fromEntries(
            [
              "name",
              "line1",
              "line2",
              "city",
              "state",
              "postal_code",
              "country",
            ].map((key) => [key, address[key] ?? null]),
          );
        }
      }
      if (action === "return_url" || "return_url" in body) {
        if (!runtime.return_url_editable)
          bad("There is no return URL to update.");
        if (runtime.buyer_returned)
          bad(
            "The return URL can no longer be changed — the buyer has already returned.",
          );
        changes._payment_status = {
          ...object(payment._payment_status),
          return_url: returnUrl(body.return_url),
        };
      }
    } else if (action === "resume") {
      if (
        !this.clientSecretGrants(id, secret) &&
        !(options.actorKind === "user" && payment.user_id === options.actorId)
      )
        throw new ApiError(403, "Only the payment's customer can resume it.");
      if (body.return_url != null) returnUrl(body.return_url);
      if (runtime.resumable && payment.status === "open")
        changes._payment_status = {
          ...object(payment._payment_status),
          status: "processing",
          next_action: null,
          return_url:
            body.return_url ??
            object(payment._payment_status).return_url ??
            null,
        };
    } else if (action === "capture") {
      if (!runtime.manual_capture)
        bad("Capturing is not supported for this payment method");
      if (payment.status !== "authorized")
        bad("Payment is not awaiting capture");
      if (
        payment.capture_expires_at &&
        Date.parse(String(payment.capture_expires_at)) < Date.now()
      )
        bad("The payment authorization has expired");
      // A request starts capture; explicit test controls supply processor confirmation.
      changes._payment_status = {
        ...object(payment._payment_status),
        status: "processing",
        next_action: null,
      };
    } else if (action === "refund") {
      this.refund(payment, body);
    } else if (action === "retry") {
      if (payment.status === "paid") bad("This receipt has already been paid");
      if (!["open", "uncollectible"].includes(String(payment.status)))
        bad("This receipt cannot be paid");
      if (Number(runtime.manual_retry_attempts ?? 0) >= 1)
        bad(
          "This receipt has already been re-tried the maximum number of times",
        );
      if (!payment.membership_id)
        bad("You can only retry payments that are attached to a membership");
      if (!payment.retryable && !runtime.retryable)
        bad(
          "You can only retry payments on an active or past due membership, or failed initial payments on a drafted membership.",
        );
      changes = {
        status: "open",
        _runtime: {
          ...runtime,
          manual_retry_attempts: Number(runtime.manual_retry_attempts ?? 0) + 1,
        },
        _payment_status: {
          ...object(payment._payment_status),
          status: "processing",
          next_action: null,
        },
      };
    } else if (action === "void") {
      if (!payment.voidable && payment.status !== "authorized")
        bad("Cannot void a payment that is not open");
      if (!runtime.void_async)
        changes = {
          status: "void",
          substatus: "canceled",
          voidable: false,
          refundable: false,
          retryable: false,
          _payment_status: {
            ...object(payment._payment_status),
            status: "canceled",
          },
        };
    }
    if (Object.keys(changes).length)
      this.store.update("payment", id, {
        ...changes,
        updated_at: new Date().toISOString(),
      });
    const updated = this.store.find("payment", id)!;
    if (action === "void" && updated.status === "void")
      this.session.webhookEmitter.emit("payment.canceled", { data: { id } });
    return {
      value:
        statusRoute || action === "capture"
          ? this.status(updated, options)
          : updated,
    };
  }

  private refund(payment: ResourceRecord, body: ResourceRecord): void {
    const dto = paymentResponse(payment);
    if (
      dto.total === null ||
      dto.presentment_total === null ||
      this.store
        .list("refund")
        .some(
          (row) =>
            row.payment_id === payment.id &&
            row.status === "succeeded" &&
            row.amount === null,
        )
    )
      unsupported(
        "refund calculations with unknown settlement or charge amounts; seed known amounts to test refund writes",
      );
    const total = object(dto.total),
      presentment = object(dto.presentment_total);
    const refunded =
      dto.refunded_amount == null ? 0n : units(object(dto.refunded_amount));
    const originalRefunded =
      dto.presentment_refunded_amount == null
        ? 0n
        : units(object(dto.presentment_refunded_amount));
    const remaining = units(total) - refunded;
    if (remaining <= 0n) bad("This payment has already been refunded");
    if (!payment.refundable || payment.status !== "paid")
      bad("This payment is not refundable");
    let requested = remaining;
    if (body.partial_amount != null) {
      if (
        !["number", "string"].includes(typeof body.partial_amount) ||
        String(body.partial_amount).trim() === ""
      )
        bad("partial_amount must be a number");
      const amount = Number(body.partial_amount);
      if (!Number.isFinite(amount)) bad("partial_amount must be a number");
      if (amount <= 0)
        bad("The partial refund amount must be greater than zero.");
      requested = units({
        ...total,
        amount: amount.toFixed(Number(total.decimals)),
      });
      if (requested <= 0n)
        bad("The partial refund amount must be greater than zero.");
      if (requested > remaining) requested = remaining;
    }
    const originalRemaining = units(presentment) - originalRefunded;
    const original =
      requested === remaining
        ? originalRemaining
        : (requested * units(presentment) + units(total) / 2n) / units(total);
    const amount = fromUnits(requested, total),
      originalAmount = fromUnits(original, presentment);
    const now = new Date().toISOString();
    const status = object(payment._runtime).refund_status ?? "succeeded";
    const refund = this.store.insert("refund", {
      id: this.session.idGenerator.generate("refund"),
      account_id: dto.account_id,
      payment_id: payment.id,
      amount,
      original_amount: originalAmount,
      status,
      provider: object(payment._runtime).refund_provider ?? "stripe",
      metadata: metadata(body.metadata),
      created_at: now,
      updated_at: now,
    });
    if (status === "succeeded")
      this.store.update("payment", String(payment.id), {
        refunded_amount: fromUnits(refunded + requested, total),
        presentment_refunded_amount: fromUnits(
          originalRefunded + original,
          presentment,
        ),
        refunded_at: now,
        refundable: requested < remaining,
        substatus: requested < remaining ? "partially_refunded" : "refunded",
        updated_at: now,
      });
    this.session.webhookEmitter.emit("refund.created", {
      data: { id: refund.id },
    });
  }
}
