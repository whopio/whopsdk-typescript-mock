import type { ResourceRecord } from "../types.js";
import { Store } from "../store.js";
import { ExampleGenerator } from "../example-generator.js";
import { ResourceNames } from "../types.js";

/**
 * Handles payins/checkout-specific side effects and graph operations.
 *
 * Mirrors the relationships on the customer side of payments:
 * Company -> Product -> Plan -> CheckoutConfiguration -> Payment -> Membership,
 * plus Invoice, Refund, PromoCode, PaymentMethod and SetupIntent.
 */
export class PaymentsGraph {
  constructor(
    private store: Store,
    private exampleGenerator: ExampleGenerator,
  ) {}

  ensureProductGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    const company = companyId ? this.ensureCompanyExists(companyId) : null;

    const now = new Date().toISOString();
    const updates: ResourceRecord = {
      company_id: companyId,
      created_at: record.created_at ?? now,
      updated_at: record.updated_at ?? now,
      title: record.title ?? payload.title ?? "Example Product",
      route:
        record.route ??
        payload.route ??
        this.routeFromId(record.id as string, "product"),
      visibility: record.visibility ?? payload.visibility ?? "visible",
      member_count: record.member_count ?? payload.member_count ?? 0,
      company: company ? this.compactCompany(company) : null,
    };

    return this.commit(
      ResourceNames.PRODUCT,
      record.id as string,
      updates,
      record,
    );
  }

  ensurePlanGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    const company = companyId ? this.ensureCompanyExists(companyId) : null;

    const productId = (record.product_id ?? payload.product_id) as
      | string
      | undefined;
    const product = productId
      ? this.ensureProductExists(productId, companyId)
      : null;

    const now = new Date().toISOString();
    const planType = (record.plan_type ??
      payload.plan_type ??
      "renewal") as string;
    const updates: ResourceRecord = {
      company_id: companyId,
      product_id: productId,
      created_at: record.created_at ?? now,
      updated_at: record.updated_at ?? now,
      title: record.title ?? payload.title ?? "Example Plan",
      currency: record.currency ?? payload.currency ?? "usd",
      initial_price: record.initial_price ?? payload.initial_price ?? 10.0,
      renewal_price:
        record.renewal_price ??
        payload.renewal_price ??
        (planType === "one_time" ? 0 : 10.0),
      plan_type: planType,
      release_method:
        record.release_method ?? payload.release_method ?? "buy_now",
      visibility: record.visibility ?? payload.visibility ?? "visible",
      billing_period: record.billing_period ?? payload.billing_period ?? 30,
      member_count: record.member_count ?? payload.member_count ?? 0,
      purchase_url: this.isPlaceholder(record.purchase_url)
        ? this.checkoutUrl(record.id as string)
        : record.purchase_url,
      company: company ? this.compactCompanyTitle(company) : null,
      product: product ? this.compactProductTitle(product) : null,
    };

    return this.commit(
      ResourceNames.PLAN,
      record.id as string,
      updates,
      record,
    );
  }

  ensureCheckoutConfigurationGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    const company = companyId ? this.ensureCompanyExists(companyId) : null;

    // A checkout config either references an existing plan or describes an inline one.
    const planId = (record.plan_id ?? payload.plan_id) as string | undefined;
    const inlinePlan = (payload.plan ?? record.plan) as
      | ResourceRecord
      | undefined;
    const plan = planId
      ? this.ensurePlanExists(planId, companyId)
      : inlinePlan
        ? this.createPlanFromInline(inlinePlan, companyId)
        : null;

    const now = new Date().toISOString();
    const updates: ResourceRecord = {
      company_id: companyId,
      created_at: record.created_at ?? now,
      allow_promo_codes:
        record.allow_promo_codes ?? payload.allow_promo_codes ?? true,
      mode: record.mode ?? payload.mode ?? "payment",
      currency: record.currency ?? payload.currency ?? plan?.currency ?? "usd",
      plan_id: plan?.id ?? planId,
      plan: plan ? this.compactPlan(plan) : null,
      purchase_url: this.isPlaceholder(record.purchase_url)
        ? this.checkoutUrl((plan?.id as string) ?? (record.id as string))
        : record.purchase_url,
      redirect_url: record.redirect_url ?? payload.redirect_url,
    };

    return this.commit(
      ResourceNames.CHECKOUT_CONFIGURATION,
      record.id as string,
      updates,
      record,
    );
  }

  ensurePaymentGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    if (companyId) this.ensureCompanyExists(companyId);

    const memberId = (record.member_id ?? payload.member_id) as
      | string
      | undefined;
    const member = memberId
      ? this.ensureMemberExists(memberId, companyId)
      : null;

    const planId = (record.plan_id ?? payload.plan_id) as string | undefined;
    const plan = planId ? this.ensurePlanExists(planId, companyId) : null;

    const productId = (record.product_id ??
      payload.product_id ??
      plan?.product_id) as string | undefined;
    const product = productId
      ? this.ensureProductExists(productId, companyId)
      : null;

    const paymentMethodId = (record.payment_method_id ??
      payload.payment_method_id) as string | undefined;
    const paymentMethod = paymentMethodId
      ? this.ensurePaymentMethodExists(paymentMethodId)
      : null;

    const status = (record.status ?? payload.status ?? "paid") as string;
    // substatus must stay consistent with status; the example generator fills it with
    // an arbitrary enum default, so prefer the caller's value, then derive from status.
    const substatus =
      (payload.substatus as string | undefined) ??
      this.substatusForStatus(status);
    const updates: ResourceRecord = {
      company_id: companyId,
      member_id: member?.id ?? memberId,
      currency: record.currency ?? payload.currency ?? plan?.currency ?? "usd",
      amount: record.amount ?? payload.amount ?? plan?.initial_price ?? 10.0,
      status,
      substatus,
      plan_id: plan?.id ?? planId,
      plan: plan ? this.compactPlan(plan) : null,
      product_id: product?.id ?? productId,
      product: product ? this.compactProductTitle(product) : null,
      payment_method_id: paymentMethod?.id ?? paymentMethodId,
      payment_method: paymentMethod
        ? this.compactPaymentMethod(paymentMethod)
        : null,
      metadata: record.metadata ?? payload.metadata ?? {},
      refunded_at: record.refunded_at ?? payload.refunded_at,
    };

    return this.commit(
      ResourceNames.PAYMENT,
      record.id as string,
      updates,
      record,
    );
  }

  ensureMembershipGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    const company = companyId ? this.ensureCompanyExists(companyId) : null;

    const now = new Date().toISOString();
    const updates: ResourceRecord = {
      company_id: companyId,
      created_at: record.created_at ?? now,
      name: record.name ?? payload.name ?? "Example Membership",
      status: record.status ?? payload.status ?? "active",
      metadata: record.metadata ?? payload.metadata ?? {},
      company: company ? this.compactCompanyTitle(company) : null,
    };

    return this.commit(
      ResourceNames.MEMBERSHIP,
      record.id as string,
      updates,
      record,
    );
  }

  ensureInvoiceGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    if (companyId) this.ensureCompanyExists(companyId);

    const planId = (record.plan_id ?? payload.plan_id) as string | undefined;
    const plan = planId ? this.ensurePlanExists(planId, companyId) : null;

    const productId = (record.product_id ??
      payload.product_id ??
      plan?.product_id) as string | undefined;
    const product = productId
      ? this.ensureProductExists(productId, companyId)
      : null;

    const now = new Date().toISOString();
    const updates: ResourceRecord = {
      company_id: companyId,
      created_at: record.created_at ?? now,
      collection_method:
        record.collection_method ?? payload.collection_method ?? "send_invoice",
      status: record.status ?? payload.status ?? "open",
      number:
        record.number ??
        payload.number ??
        this.invoiceNumber(record.id as string),
      due_date: record.due_date ?? payload.due_date ?? this.futureDate(14),
      email_address:
        record.email_address ?? payload.email_address ?? "customer@example.com",
      customer_name:
        record.customer_name ?? payload.customer_name ?? "Example Customer",
      member_id: record.member_id ?? payload.member_id,
      plan_id: plan?.id ?? planId,
      plan: plan ? this.compactPlan(plan) : undefined,
      current_plan: plan ? this.currentPlan(plan) : undefined,
      product_id: product?.id ?? productId,
      product: product ? this.compactProductTitle(product) : undefined,
    };

    return this.commit(
      ResourceNames.INVOICE,
      record.id as string,
      updates,
      record,
    );
  }

  ensureRefundGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const paymentId = (record.payment_id ?? payload.payment_id) as
      | string
      | undefined;
    const payment = paymentId ? this.ensurePaymentExists(paymentId) : null;

    const now = new Date().toISOString();
    const updates: ResourceRecord = {
      created_at: record.created_at ?? now,
      amount: record.amount ?? payload.amount ?? payment?.amount ?? 10.0,
      currency:
        record.currency ?? payload.currency ?? payment?.currency ?? "usd",
      status: record.status ?? payload.status ?? "succeeded",
      provider: record.provider ?? payload.provider ?? "stripe",
      payment: payment ? { id: payment.id } : (record.payment ?? null),
    };

    return this.commit(
      ResourceNames.REFUND,
      record.id as string,
      updates,
      record,
    );
  }

  ensurePromoCodeGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    const company = companyId ? this.ensureCompanyExists(companyId) : null;

    const productId = (record.product_id ?? payload.product_id) as
      | string
      | undefined;
    const product = productId
      ? this.ensureProductExists(productId, companyId)
      : null;

    const now = new Date().toISOString();
    const promoType = (record.promo_type ??
      payload.promo_type ??
      "percentage") as string;
    const updates: ResourceRecord = {
      created_at: record.created_at ?? now,
      amount_off: record.amount_off ?? payload.amount_off ?? 10,
      code: record.code ?? payload.code ?? "PROMO2024",
      currency:
        record.currency ?? payload.base_currency ?? payload.currency ?? "usd",
      promo_type: promoType,
      duration: record.duration ?? payload.duration ?? "once",
      status: record.status ?? payload.status ?? "active",
      stock: record.stock ?? payload.stock ?? 100,
      uses: record.uses ?? payload.uses ?? 0,
      unlimited_stock:
        record.unlimited_stock ?? payload.unlimited_stock ?? false,
      new_users_only: record.new_users_only ?? payload.new_users_only ?? false,
      churned_users_only:
        record.churned_users_only ?? payload.churned_users_only ?? false,
      existing_memberships_only:
        record.existing_memberships_only ??
        payload.existing_memberships_only ??
        false,
      one_per_customer:
        record.one_per_customer ?? payload.one_per_customer ?? false,
      promo_duration_months:
        record.promo_duration_months ?? payload.promo_duration_months ?? 1,
      expires_at: record.expires_at ?? payload.expires_at,
      company: company ? this.compactCompanyTitle(company) : null,
      product: product ? this.compactProductTitle(product) : undefined,
    };

    return this.commit(
      ResourceNames.PROMO_CODE,
      record.id as string,
      updates,
      record,
    );
  }

  ensurePaymentMethodGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const updates: ResourceRecord = {
      brand: record.brand ?? payload.brand ?? "visa",
      last4: record.last4 ?? payload.last4 ?? "4242",
      exp_month: record.exp_month ?? payload.exp_month ?? 12,
      exp_year: record.exp_year ?? payload.exp_year ?? 2035,
      country: record.country ?? payload.country ?? "US",
    };

    return this.commit(
      ResourceNames.PAYMENT_METHOD,
      record.id as string,
      updates,
      record,
    );
  }

  ensureSetupIntentGraph(
    record: ResourceRecord,
    payload: ResourceRecord,
  ): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as
      | string
      | undefined;
    const company = companyId ? this.ensureCompanyExists(companyId) : null;

    const paymentMethodId = (record.payment_method_id ??
      payload.payment_method_id) as string | undefined;
    const paymentMethod = paymentMethodId
      ? this.ensurePaymentMethodExists(paymentMethodId)
      : null;

    const now = new Date().toISOString();
    const updates: ResourceRecord = {
      company_id: companyId,
      created_at: record.created_at ?? now,
      status: record.status ?? payload.status ?? "requires_action",
      company: company ? { id: company.id } : null,
      payment_method: paymentMethod
        ? {
            id: paymentMethod.id,
            card: {
              brand: paymentMethod.brand ?? "visa",
              exp_month: paymentMethod.exp_month ?? 12,
              exp_year: paymentMethod.exp_year ?? 2035,
              last4: paymentMethod.last4 ?? "4242",
            },
            created_at: paymentMethod.created_at ?? now,
            payment_method_type: "card",
          }
        : undefined,
    };

    return this.commit(
      ResourceNames.SETUP_INTENT,
      record.id as string,
      updates,
      record,
    );
  }

  /**
   * Creates a Refund record for a payment (used by the payments.refund action).
   * Returns the stored, graph-enriched refund.
   */
  createRefundForPayment(
    payment: ResourceRecord,
    amount?: number,
  ): ResourceRecord {
    const refund = this.exampleGenerator.generate(ResourceNames.REFUND, {
      payment_id: payment.id,
      amount: amount ?? payment.amount ?? 10.0,
      currency: payment.currency ?? "usd",
      status: "succeeded",
    });
    const stored = this.store.insert(ResourceNames.REFUND, refund);
    return this.ensureRefundGraph(stored, { payment_id: payment.id as string });
  }

  /**
   * Builds the fee breakdown for a payment (used by the payments.listFees action).
   */
  feesForPayment(payment: ResourceRecord): ResourceRecord[] {
    const amount = (payment.amount as number) ?? 10.0;
    const currency = (payment.currency as string) ?? "usd";
    const processing = Math.round((amount * 0.029 + 0.3) * 100) / 100;
    const platform = Math.round(amount * 0.03 * 100) / 100;

    return [
      {
        amount: processing,
        currency,
        name: "Processing fee",
        type: "processing",
      },
      { amount: platform, currency, name: "Platform fee", type: "platform" },
    ];
  }

  // ========== Existence helpers ==========

  private ensureCompanyExists(companyId: string): ResourceRecord {
    const existing = this.store.find(ResourceNames.COMPANY, companyId);
    if (existing) return existing;

    const company = this.exampleGenerator.generate(ResourceNames.COMPANY, {
      id: companyId,
    });
    return this.store.insert(ResourceNames.COMPANY, company);
  }

  private ensureProductExists(
    productId: string,
    companyId?: string,
  ): ResourceRecord {
    const existing = this.store.find(ResourceNames.PRODUCT, productId);
    if (existing) return existing;

    const product = this.exampleGenerator.generate(ResourceNames.PRODUCT, {
      id: productId,
      company_id: companyId,
    });
    const inserted = this.store.insert(ResourceNames.PRODUCT, product);
    return this.ensureProductGraph(inserted, { company_id: companyId });
  }

  private ensurePlanExists(planId: string, companyId?: string): ResourceRecord {
    const existing = this.store.find(ResourceNames.PLAN, planId);
    if (existing) return existing;

    const plan = this.exampleGenerator.generate(ResourceNames.PLAN, {
      id: planId,
      company_id: companyId,
    });
    const inserted = this.store.insert(ResourceNames.PLAN, plan);
    return this.ensurePlanGraph(inserted, { company_id: companyId });
  }

  private createPlanFromInline(
    inline: ResourceRecord,
    companyId?: string,
  ): ResourceRecord {
    const plan = this.exampleGenerator.generate(ResourceNames.PLAN, {
      ...inline,
      company_id: companyId ?? inline.company_id,
    });
    const inserted = this.store.insert(ResourceNames.PLAN, plan);
    return this.ensurePlanGraph(inserted, { company_id: companyId, ...inline });
  }

  private ensureMemberExists(
    memberId: string,
    companyId?: string,
  ): ResourceRecord {
    const existing = this.store.find(ResourceNames.MEMBER, memberId);
    if (existing) return existing;

    const member = this.exampleGenerator.generate(ResourceNames.MEMBER, {
      id: memberId,
      company_id: companyId,
      status: "joined",
    });
    return this.store.insert(ResourceNames.MEMBER, member);
  }

  private ensurePaymentExists(paymentId: string): ResourceRecord {
    const existing = this.store.find(ResourceNames.PAYMENT, paymentId);
    if (existing) return existing;

    const payment = this.exampleGenerator.generate(ResourceNames.PAYMENT, {
      id: paymentId,
      amount: 10.0,
      currency: "usd",
      status: "paid",
    });
    return this.store.insert(ResourceNames.PAYMENT, payment);
  }

  private ensurePaymentMethodExists(paymentMethodId: string): ResourceRecord {
    const existing = this.store.find(
      ResourceNames.PAYMENT_METHOD,
      paymentMethodId,
    );
    if (existing) return existing;

    const paymentMethod = this.exampleGenerator.generate(
      ResourceNames.PAYMENT_METHOD,
      {
        id: paymentMethodId,
      },
    );
    const inserted = this.store.insert(
      ResourceNames.PAYMENT_METHOD,
      paymentMethod,
    );
    return this.ensurePaymentMethodGraph(inserted, {});
  }

  // ========== Compact embeds ==========

  private compactCompany(company: ResourceRecord): ResourceRecord {
    return { id: company.id, route: company.route, title: company.title };
  }

  private compactCompanyTitle(company: ResourceRecord): ResourceRecord {
    return { id: company.id, title: company.title };
  }

  private compactProductTitle(product: ResourceRecord): ResourceRecord {
    return { id: product.id, title: product.title };
  }

  private compactPlan(plan: ResourceRecord): ResourceRecord {
    return {
      id: plan.id,
      company_id: plan.company_id,
      product_id: plan.product_id,
      currency: plan.currency,
      initial_price: plan.initial_price,
      renewal_price: plan.renewal_price,
      plan_type: plan.plan_type,
      title: plan.title,
      visibility: plan.visibility,
    };
  }

  private currentPlan(plan: ResourceRecord): ResourceRecord {
    const price = (plan.initial_price as number) ?? 10.0;
    const currency = (plan.currency as string) ?? "usd";
    return {
      id: plan.id,
      currency,
      formatted_price: this.formatPrice(price, currency),
    };
  }

  private compactPaymentMethod(paymentMethod: ResourceRecord): ResourceRecord {
    return {
      id: paymentMethod.id,
      brand: paymentMethod.brand,
      last4: paymentMethod.last4,
      exp_month: paymentMethod.exp_month,
      exp_year: paymentMethod.exp_year,
    };
  }

  // ========== Misc ==========

  private substatusForStatus(status: string): string {
    switch (status) {
      case "paid":
        return "succeeded";
      case "void":
        return "failed";
      default:
        return "pending";
    }
  }

  private commit(
    resourceName: string,
    id: string,
    updates: ResourceRecord,
    fallback: ResourceRecord,
  ): ResourceRecord {
    this.store.update(resourceName, id, this.compactHash(updates));
    return this.store.find(resourceName, id) ?? fallback;
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

  private isPlaceholder(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    const str = String(value);
    return str.endsWith("_example") || str.startsWith("https://example.com/");
  }

  private checkoutUrl(id: string): string {
    return `https://whop.test/checkout/${id}`;
  }

  private routeFromId(id: string, fallback: string): string {
    return id ? id.replace(/^[a-z]+_/, "") : fallback;
  }

  private invoiceNumber(id: string): string {
    return `INV-${(id ?? "")
      .replace(/^[a-z]+_/, "")
      .slice(0, 8)
      .toUpperCase()}`;
  }

  private formatPrice(amount: number, currency: string): string {
    const symbol = currency === "usd" ? "$" : "";
    return `${symbol}${amount.toFixed(2)}`;
  }

  private futureDate(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString();
  }
}
