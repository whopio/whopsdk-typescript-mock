import type { Whop } from "@whop/sdk";
import type { ResourceRecord } from "./types.js";
import type { Store } from "./store.js";
import { disputeReason } from "./dispute-reasons.js";

// Public SDK and documentation response shapes; fixture data stays separate.
export {
  API_VERSION_DATE,
  MODELED_API_VERSIONS as SUPPORTED_API_VERSIONS,
} from "./api-version.js";
export const PLATFORM_POLICY = {
  id: null,
  filename: "legal.pdf",
  content_type: "application/pdf",
  url: "https://content.whop.com/core/legal.pdf",
  platform: true,
};

export function effectiveProvider(record: ResourceRecord): string {
  return String(
    record.provider === "multi_psp" ? record.sub_provider : record.provider,
  );
}
export function evidenceBudget(record: ResourceRecord): number {
  const caps: Record<string, number> = {
    stripe: 4 * 1048576,
    braintree: 4 * 1048576,
    checkout_dot_com: 4 * 1048576,
    adyen: 2000000,
    dlocal: 750000 - 1024,
    splitit: 2 * 1048576,
  };
  return (caps[effectiveProvider(record)] ?? 4 * 1048576) - 128 * 1024;
}
export const EVIDENCE_TEXT_FIELDS = [
  "access_activity_log",
  "billing_address",
  "cancellation_policy_disclosure",
  "customer_email_address",
  "customer_name",
  "notes",
  "product_description",
  "refund_policy_disclosure",
  "refund_refusal_explanation",
  "service_date",
] as const;
export const EVIDENCE_SLOTS = {
  cancellation_policy_attachment: "cancellation_policy",
  customer_communication_attachment: "customer_communication",
  refund_policy_attachment: "return_policy",
  uncategorized_attachment: "uncategorized",
} as const;

export function object(value: unknown): ResourceRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ResourceRecord)
    : {};
}

function fields<T extends object>(defaults: T, record: ResourceRecord): T {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      record[key] === undefined ? fallback : record[key],
    ]),
  ) as T;
}

/** Legacy numeric fixtures are USD major units. Other currencies need explicit Money. */
export function money(value: unknown, currency = "usd"): Whop.Money {
  if (value && typeof value === "object") {
    const m = value as Whop.Money;
    if (
      typeof m.amount !== "string" ||
      !/^-?\d+(\.\d+)?$/.test(m.amount) ||
      typeof m.currency !== "string" ||
      !Number.isInteger(m.decimals) ||
      !Number.isInteger(m.display_decimals)
    ) {
      throw new Error(
        "Seed money with { amount: decimal string, currency, decimals, display_decimals }",
      );
    }
    return {
      amount: m.amount,
      currency: m.currency,
      decimals: m.decimals,
      display_decimals: m.display_decimals,
    };
  }
  if (currency !== "usd")
    throw new Error(
      "Non-USD fixtures require explicit Money objects; currency precision is not inferred",
    );
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount))
    throw new Error("Fixture amount must be finite");
  return {
    amount: amount.toFixed(2),
    currency: "usd",
    decimals: 2,
    display_decimals: 2,
  };
}

export function paymentResponse(
  record: ResourceRecord,
  listing = false,
): ResourceRecord {
  const currency = String(record.currency ?? "usd");
  const total =
    record.total === null
      ? null
      : money(record.total ?? record.amount, currency);
  const zero = total
    ? { ...total, amount: (0).toFixed(total.decimals) }
    : money(0, currency);
  const defaults = {
    account_id: (record.account_id ?? record.company_id ?? null) as
      | string
      | null,
    amount_after_fees: total ?? zero,
    auto_capture_at: null,
    auto_refunded: false,
    billing_address: null,
    billing_reason: null,
    capture_expires_at: null,
    checkout_configuration_id: null,
    client_secret: null,
    created_at: String(record.created_at),
    currency: currency as Whop.Currencies,
    customer_email: null,
    customer_phone: null,
    decline_code: null,
    dispute_alerted_at: null,
    dispute_created_at: null,
    failure_message: null,
    financing_installments_count: null,
    holds: [],
    id: String(record.id),
    ip_address: null,
    last_payment_attempt_at: null,
    line_items: [],
    member_id: null,
    membership_id: null,
    metadata: null,
    needs_tracking: null,
    next_payment_attempt_at: null,
    paid_at: null,
    payment_instrument: null,
    payment_method_id: null,
    payment_method_type: null,
    payment_rule_matches: [],
    payments_failed: 0,
    presentment_refunded_amount:
      (object(record.presentment_total).currency ?? currency) === currency &&
      record.refunded_amount != null
        ? money(record.refunded_amount, currency)
        : null,
    presentment_tax_amount: null,
    presentment_total: total,
    product_id: null,
    promo_code_id: null,
    quote_id: null,
    recovery_url: null,
    refundable: false,
    refunded_amount: null,
    refunded_at: null,
    response_due_at: null,
    retryable: false,
    risk_score: null,
    risk_signals: null,
    settlement_time_at: null,
    shipment_id: null,
    shipping_address: null,
    status: "paid",
    substatus: "succeeded",
    subtotal: total,
    tax_amount: null,
    tax_behavior: null,
    tax_refunded_amount: zero,
    three_ds_verified: false,
    total,
    updated_at: String(record.updated_at ?? record.created_at),
    usd_total: currency === "usd" ? total : null,
    user: null,
    variant_id: (record.variant_id ?? record.plan_id ?? null) as string | null,
    verification_checks: null,
    voidable: false,
  } satisfies Whop.Payment;
  const result = fields(defaults, record) as ResourceRecord;
  for (const key of [
    "amount_after_fees",
    "subtotal",
    "total",
    "usd_total",
    "tax_amount",
    "tax_refunded_amount",
    "refunded_amount",
    "presentment_total",
    "presentment_refunded_amount",
    "presentment_tax_amount",
  ]) {
    if (result[key] !== null)
      result[key] = money(result[key], key === "usd_total" ? "usd" : currency);
  }
  result.risk_signals = null;
  if (listing)
    for (const key of ["client_secret", "recovery_url", "settlement_time_at"])
      result[key] = null;
  return {
    ...result,
    user_agent: record.user_agent ?? null,
    wuid: record.wuid ?? null,
  };
}

export function refundResponse(
  record: ResourceRecord,
  store: Store,
): ResourceRecord {
  const paymentId = String(
    record.payment_id ?? object(record.payment).id ?? "",
  );
  const payment = store.find("payment", paymentId) ?? {};
  const currency = String(record.currency ?? payment.currency ?? "usd");
  const amount = record.amount === null ? null : money(record.amount, currency);
  const result = fields(
    {
      account_id: (record.account_id ??
        record.company_id ??
        payment.account_id ??
        payment.company_id ??
        null) as string | null,
      amount,
      created_at: String(record.created_at),
      failure_message: null,
      failure_reason: null,
      id: String(record.id),
      metadata: null,
      original_amount: money(record.original_amount ?? record.amount, currency),
      payment_id: paymentId,
      provider: "stripe",
      provider_created_at: null,
      reason: null,
      reference_status: null,
      reference_type: null,
      reference_value: null,
      status: "succeeded",
      updated_at: String(record.updated_at ?? record.created_at),
      visa_rdr: false,
    } satisfies Whop.Refund,
    record,
  ) as ResourceRecord;
  result.amount = amount;
  result.original_amount = money(result.original_amount, currency);
  result.account_id =
    payment.account_id ?? payment.company_id ?? result.account_id;
  if (!["failed", "canceled"].includes(String(result.status))) {
    result.failure_reason = null;
    result.failure_message = null;
  }
  return result;
}

export function evidenceResponse(record: ResourceRecord): ResourceRecord {
  const nested = object(record.evidence);
  const result: ResourceRecord = {};
  for (const key of [...EVIDENCE_TEXT_FIELDS, ...Object.keys(EVIDENCE_SLOTS)]) {
    result[key] = key in nested ? nested[key] : (record[key] ?? null);
  }
  result.documents = nested.documents ?? [];
  if (
    !result.cancellation_policy_attachment &&
    record.uses_platform_cancellation_policy
  )
    result.cancellation_policy_attachment = { ...PLATFORM_POLICY };
  if (!result.refund_policy_attachment && record.uses_platform_refund_policy)
    result.refund_policy_attachment = { ...PLATFORM_POLICY };
  return result;
}

export function disputeResponse(
  record: ResourceRecord,
  store: Store,
): ResourceRecord {
  const p =
    store.find(
      "payment",
      String(record.payment_id ?? object(record.payment).id),
    ) ?? object(record.payment);
  const due =
    (("evidence_due_at" in record
      ? record.evidence_due_at
      : record.due_date !== undefined
        ? Number.isFinite(Date.parse(String(record.due_date))) &&
          Date.parse(String(record.due_date)) > 0
          ? new Date(
              Date.parse(String(record.due_date)) - 86400000,
            ).toISOString()
          : null
        : record.needs_response_by) as string | null) ?? null;
  const submitted = (record.evidence_submitted_at as string | null) ?? null;
  let status = String(record.status ?? "needs_response");
  const inquiry = record.inquiry === true || status.startsWith("warning_");
  const responding = ["needs_response", "warning_needs_response"].includes(
    status,
  );
  const closed = due !== null && Date.parse(due) <= Date.now();
  const klarnaInquiry =
    status === "warning_needs_response" &&
    p.payment_method_type === "klarna" &&
    (effectiveProvider(record) !== "adyen" ||
      String(record.reason).startsWith("[notification]"));
  const lock = submitted
    ? "submitted"
    : !responding || klarnaInquiry
      ? "not_contestable"
      : closed
        ? "response_window_closed"
        : null;
  if (responding && closed)
    status = inquiry ? "warning_under_review" : "under_review";
  if (klarnaInquiry) status = "warning_under_review";
  if (status === "generating_response") status = "under_review";
  if (status === "closed") status = "prevented";
  if (record.visa_rdr && ["lost", "closed"].includes(String(record.status)))
    status = "prevented";
  // The embedded dispute payment uses the charged amount and currency.
  // DTO-only fixtures assume no buyer fees; in-process fixtures can specify final_amount.
  const paymentAmount =
    p.final_amount ?? p.presentment_total ?? p.total ?? p.amount;
  const result = {
    id: String(record.id),
    account_id: (record.account_id ?? record.company_id ?? null) as
      | string
      | null,
    amount: Number(record.amount ?? 0),
    currency: String(record.currency ?? "usd"),
    created_at: String(record.provider_created_at ?? record.created_at),
    updated_at: String(record.updated_at ?? record.created_at),
    status: status as Whop.Dispute.Status,
    reason: disputeReason(
      record.reason ?? object(record.stripe_data).reason,
    ) as Whop.Dispute.Reason,
    reason_code: (record.reason_code as string | null) ?? null,
    issuer_comments: (record.issuer_comments ??
      []) as Whop.DisputeIssuerComment[],
    line_items: (record.line_items ??
      p.line_items ??
      []) as Whop.ReceiptLineItem[],
    product_id: (record.product_id ??
      object(record.product).id ??
      p.product_id ??
      null) as string | null,
    variant_id: (record.variant_id ??
      object(record.plan).id ??
      p.variant_id ??
      p.plan_id ??
      null) as string | null,
    inquiry,
    acceptable:
      responding &&
      !inquiry &&
      lock === null &&
      (["stripe", "adyen", "braintree", "checkout_dot_com", "splitit"].includes(
        effectiveProvider(record),
      ) ||
        (effectiveProvider(record) === "airwallex" &&
          record._airwallexAcceptanceReady === true)),
    evidence_editable: lock === null,
    evidence_locked_reason: lock,
    evidence_due_at: due,
    evidence_submitted_at: submitted,
    fee:
      record.fee == null
        ? null
        : money(record.fee, String(record.currency ?? "usd")),
    buyer: fields(
      {
        email: null,
        name: null,
        member_id: null,
        user_id: null,
        username: null,
      },
      {
        user_id: object(p.user).id ?? null,
        member_id: p.member_id ?? null,
        name: object(p.user).name ?? null,
        username: object(p.user).username ?? null,
        email: p.customer_email ?? object(p.user).email ?? null,
        ...object(record.buyer),
      },
    ) as Whop.DisputeBuyer,
    payment: {
      id: String(p.id ?? record.payment_id ?? ""),
      amount:
        paymentAmount == null
          ? null
          : Number(object(paymentAmount).amount ?? paymentAmount),
      created_at: String(p.created_at ?? record.created_at),
      currency: (object(paymentAmount).currency ??
        object(p.presentment_total).currency ??
        p.currency ??
        null) as string | null,
      card_brand: (p.card_brand as string | null) ?? null,
      card_last4: (p.card_last4 as string | null) ?? null,
      payment_method_type: (p.payment_method_type as string | null) ?? null,
      payment_instrument:
        (p.payment_instrument as Whop.PaymentInstrument | null) ?? null,
      payment_processor: null,
    },
    evidence: evidenceResponse(record) as unknown as Whop.DisputeEvidence,
  } satisfies Whop.Dispute;
  return { ...result, fee_charged: record.fee_charged ?? result.fee !== null };
}

export function fileResponse(record: ResourceRecord): ResourceRecord {
  const result: ResourceRecord = fields(
    {
      id: String(record.id),
      object: "file",
      filename: null,
      content_type: null,
      created_at: String(record.created_at),
      size: null,
      upload_status: "pending",
      url: null,
      visibility: "private",
      blurhash: null,
      duration_seconds: null,
      height: null,
      width: null,
      removed_by_moderation: false,
      waveform_url: null,
    } satisfies Whop.File_,
    record,
  );
  if (result.upload_status !== "ready") {
    result.size = null;
    result.url = null;
  }
  if (result.size === 0) result.size = null;
  return result;
}
