import type {
  ResourceRecord,
  CompanyRecord,
  UserRecord,
  PaymentRecord,
  DisputeRecord,
  DisputeAlertRecord,
  ResolutionCaseRecord,
  CompactCompany,
  CompactUser,
  CompactPayment,
  CompactResolutionPayment,
  CompactDispute,
} from "../types.js";
import { Store } from "../store.js";
import { ExampleGenerator } from "../example-generator.js";
import { ResourceNames } from "../types.js";

/**
 * Handles dispute-specific side effects and graph operations.
 */
export class DisputeGraph {
  constructor(
    private store: Store,
    private exampleGenerator: ExampleGenerator,
  ) {}

  /**
   * Ensures dispute has proper graph relationships.
   * Dispute belongs to company, payment, and optionally links to dispute_alert.
   */
  ensureDisputeGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    const paymentId = (record.payment_id ?? payload.payment_id) as
      | string
      | undefined;

    const company = companyId ? this.ensureCompanyExists(companyId) : null;
    const payment = paymentId
      ? this.ensurePaymentExists(paymentId, companyId)
      : null;

    const now = new Date().toISOString();
    const userFromPayment = payment?.user as UserRecord | null;

    const disputeUpdates: Partial<DisputeRecord> = {
      created_at: (record.created_at ?? now) as string,
      status: (record.status ??
        payload.status ??
        "needs_response") as DisputeRecord["status"],
      amount: (record.amount ??
        payload.amount ??
        payment?.total ??
        10.0) as number,
      currency: (record.currency ??
        payload.currency ??
        payment?.currency ??
        "usd") as string,
      reason: (record.reason ?? payload.reason ?? "fraudulent") as string,
      visa_rdr: (record.visa_rdr ?? payload.visa_rdr ?? false) as boolean,
      editable: (record.editable ?? payload.editable ?? true) as boolean,
      needs_response_by: (record.needs_response_by ??
        payload.needs_response_by ??
        this.futureDate(7)) as string,
      company: company ? this.compactCompany(company) : null,
      payment: payment ? this.compactPayment(payment) : null,
    };

    const extraFields: ResourceRecord = {
      updated_at: record.updated_at ?? now,
      plan: record.plan ?? payload.plan ?? null,
      product: record.product ?? payload.product ?? null,
      access_activity_log:
        record.access_activity_log ?? payload.access_activity_log ?? null,
      billing_address:
        record.billing_address ?? payload.billing_address ?? null,
      cancellation_policy_disclosure:
        record.cancellation_policy_disclosure ??
        payload.cancellation_policy_disclosure ??
        null,
      customer_email_address:
        record.customer_email_address ??
        payload.customer_email_address ??
        userFromPayment?.email ??
        null,
      customer_name:
        record.customer_name ??
        payload.customer_name ??
        userFromPayment?.name ??
        null,
      notes: record.notes ?? payload.notes ?? null,
      product_description:
        record.product_description ?? payload.product_description ?? null,
      refund_policy_disclosure:
        record.refund_policy_disclosure ??
        payload.refund_policy_disclosure ??
        null,
      refund_refusal_explanation:
        record.refund_refusal_explanation ??
        payload.refund_refusal_explanation ??
        null,
      service_date: record.service_date ?? payload.service_date ?? null,
      cancellation_policy_attachment:
        record.cancellation_policy_attachment ?? null,
      customer_communication_attachment:
        record.customer_communication_attachment ?? null,
      refund_policy_attachment: record.refund_policy_attachment ?? null,
      uncategorized_attachment: record.uncategorized_attachment ?? null,
    };

    const cleanUpdates = this.compactHash({
      ...disputeUpdates,
      ...extraFields,
    });

    this.store.update(ResourceNames.DISPUTE, record.id as string, cleanUpdates);
    return (
      this.store.find(ResourceNames.DISPUTE, record.id as string) ?? record
    );
  }

  /**
   * Ensures dispute alert has proper graph relationships.
   * DisputeAlert belongs to company, payment, and optionally links to dispute.
   */
  ensureDisputeAlertGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    const paymentId = (record.payment_id ?? payload.payment_id) as
      | string
      | undefined;
    const disputeId = (record.dispute_id ?? payload.dispute_id) as
      | string
      | undefined;

    const company = companyId ? this.ensureCompanyExists(companyId) : null;
    const payment = paymentId
      ? this.ensurePaymentExists(paymentId, companyId)
      : null;
    const dispute = disputeId
      ? this.store.find(ResourceNames.DISPUTE, disputeId)
      : null;

    const now = new Date().toISOString();
    const alertUpdates: Partial<DisputeAlertRecord> & ResourceRecord = {
      created_at: (record.created_at ?? now) as string,
      updated_at: record.updated_at ?? now,
      alert_type: (record.alert_type ??
        payload.alert_type ??
        "DISPUTE") as DisputeAlertRecord["alert_type"],
      amount: (record.amount ??
        payload.amount ??
        payment?.total ??
        10.0) as number,
      currency: (record.currency ??
        payload.currency ??
        payment?.currency ??
        "usd") as string,
      charge_for_alert: (record.charge_for_alert ??
        payload.charge_for_alert ??
        true) as boolean,
      transaction_date: (record.transaction_date ??
        payload.transaction_date ??
        payment?.created_at ??
        now) as string,
      payment: payment ? this.compactPayment(payment) : null,
      dispute: dispute ? this.compactDispute(dispute) : null,
    };

    const cleanUpdates = this.compactHash(alertUpdates);

    this.store.update(
      ResourceNames.DISPUTE_ALERT,
      record.id as string,
      cleanUpdates,
    );
    return (
      this.store.find(ResourceNames.DISPUTE_ALERT, record.id as string) ??
      record
    );
  }

  /**
   * Ensures resolution case has proper graph relationships.
   * ResolutionCase belongs to company, user, payment, and has resolution_events.
   */
  ensureResolutionCaseGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    const userId = (record.user_id ?? payload.user_id) as string | undefined;
    const paymentId = (record.payment_id ?? payload.payment_id) as
      | string
      | undefined;

    const company = companyId ? this.ensureCompanyExists(companyId) : null;
    const user = userId ? this.ensureUserExists(userId) : null;
    const payment = paymentId
      ? this.ensurePaymentExists(paymentId, companyId)
      : null;

    const now = new Date().toISOString();
    const resolutionUpdates: Partial<ResolutionCaseRecord> & ResourceRecord = {
      created_at: (record.created_at ?? now) as string,
      updated_at: (record.updated_at ?? now) as string,
      status: (record.status ??
        payload.status ??
        "merchant_response_needed") as ResolutionCaseRecord["status"],
      issue: (record.issue ??
        payload.issue ??
        "product_not_delivered") as string,
      due_date: (record.due_date ??
        payload.due_date ??
        this.futureDate(3)) as string,
      customer_appealed: (record.customer_appealed ??
        payload.customer_appealed ??
        false) as boolean,
      merchant_appealed: (record.merchant_appealed ??
        payload.merchant_appealed ??
        false) as boolean,
      customer_response_actions:
        record.customer_response_actions ??
        payload.customer_response_actions ??
        [],
      merchant_response_actions: record.merchant_response_actions ??
        payload.merchant_response_actions ?? ["respond", "refund"],
      platform_response_actions:
        record.platform_response_actions ??
        payload.platform_response_actions ??
        [],
      company: company ? this.compactCompany(company) : null,
      user: user ? this.compactUser(user) : null,
      payment: payment ? this.compactResolutionPayment(payment) : null,
      member: record.member ?? payload.member ?? null,
      resolution_events:
        record.resolution_events ?? payload.resolution_events ?? [],
    };

    const cleanUpdates = this.compactHash(resolutionUpdates);

    this.store.update(
      ResourceNames.RESOLUTION_CASE,
      record.id as string,
      cleanUpdates,
    );
    return (
      this.store.find(ResourceNames.RESOLUTION_CASE, record.id as string) ??
      record
    );
  }

  private ensureCompanyExists(companyId: string): CompanyRecord {
    const existing = this.store.find(ResourceNames.COMPANY, companyId);
    if (existing) return existing as CompanyRecord;

    const company = this.exampleGenerator.generate(ResourceNames.COMPANY, {
      id: companyId,
    });
    return this.store.insert(ResourceNames.COMPANY, company) as CompanyRecord;
  }

  private ensureUserExists(userId: string): UserRecord {
    const existing = this.store.find(ResourceNames.USER, userId);
    if (existing) return existing as UserRecord;

    const user = this.exampleGenerator.generate(ResourceNames.USER, {
      id: userId,
      username: `user_${userId.slice(-6)}`,
      name: "Test User",
      email: "user@example.com",
    });
    return this.store.insert(ResourceNames.USER, user) as UserRecord;
  }

  private ensurePaymentExists(
    paymentId: string,
    companyId?: string,
  ): PaymentRecord {
    const existing = this.store.find(ResourceNames.PAYMENT, paymentId);
    if (existing) return existing as PaymentRecord;

    const now = new Date().toISOString();
    const payment = this.exampleGenerator.generate(ResourceNames.PAYMENT, {
      id: paymentId,
      company_id: companyId,
      total: 10.0,
      subtotal: 10.0,
      usd_total: 10.0,
      currency: "usd",
      created_at: now,
      paid_at: now,
      status: "paid",
    });
    return this.store.insert(ResourceNames.PAYMENT, payment) as PaymentRecord;
  }

  private compactCompany(company: CompanyRecord): CompactCompany {
    return {
      id: company.id,
      title: company.title,
    };
  }

  private compactUser(user: UserRecord): CompactUser {
    return {
      id: user.id,
      name: user.name,
      username: user.username,
    };
  }

  private compactPayment(payment: PaymentRecord): CompactPayment {
    return {
      id: payment.id,
      total: payment.total,
      subtotal: payment.subtotal,
      usd_total: (payment.usd_total ?? null) as number | null,
      currency: payment.currency,
      created_at: payment.created_at,
      paid_at: payment.paid_at,
      dispute_alerted_at: payment.dispute_alerted_at ?? null,
      payment_method_type: payment.payment_method_type ?? "card",
      billing_reason: payment.billing_reason ?? null,
      card_brand: payment.card_brand ?? "visa",
      card_last4: payment.card_last4 ?? "4242",
      user: payment.user ?? null,
      member: payment.member ?? null,
      membership: payment.membership ?? null,
    };
  }

  private compactResolutionPayment(
    payment: PaymentRecord,
  ): CompactResolutionPayment {
    return {
      id: payment.id,
      currency: payment.currency,
      created_at: payment.created_at,
      paid_at: payment.paid_at,
      total: payment.total,
      subtotal: payment.subtotal,
    };
  }

  private compactDispute(dispute: ResourceRecord): CompactDispute {
    return {
      id: dispute.id as string,
      amount: dispute.amount as number,
      currency: dispute.currency as string,
      status: dispute.status as string,
      reason: (dispute.reason ?? null) as string | null,
      created_at: dispute.created_at as string,
    };
  }

  private compactHash(obj: ResourceRecord): ResourceRecord {
    const result: ResourceRecord = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  private futureDate(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString();
  }
}
