import type { ResourceRecord } from './types.js';
import { ResourceNames } from './types.js';
import { Session } from './session.js';
import { WebhookEvents } from './webhook-events.js';
import type {
  WebhookEvent,
  WebhookEventHandler,
  EmitOptions,
} from './webhook-emitter.js';

/**
 * Helper for creating test data with proper relationships.
 * Mirrors the Ruby TestHelper API.
 */
export class TestHelper {
  private session: Session;

  constructor(session: Session) {
    this.session = session;
  }

  createCompany(attributes: Record<string, unknown> = {}): ResourceRecord {
    return this.seed(ResourceNames.COMPANY, attributes);
  }

  createProduct(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
    };
    return this.seed(ResourceNames.PRODUCT, attrs);
  }

  createPlan(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    // A plan always belongs to a product — create one if the caller didn't provide it.
    const product =
      this.ensureProduct(attributes.product, company?.id as string, attributes.product_id as string) ??
      this.createProduct({ company_id: company?.id });

    const { company: _company, product: _product, ...rest } = attributes;
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      product_id: attributes.product_id ?? product?.id,
    };
    return this.seed(ResourceNames.PLAN, attrs);
  }

  createTransfer(attributes: Record<string, unknown> = {}): ResourceRecord {
    const originId = attributes.origin_id as string;
    const destinationId = attributes.destination_id as string;

    if (originId && this.isCompanyLikeId(originId)) {
      this.ensureCompanyExists(originId);
    }
    if (destinationId && this.isCompanyLikeId(destinationId)) {
      this.ensureCompanyExists(destinationId);
    }

    return this.createViaRequest('/transfers', attributes);
  }

  createWithdrawal(attributes: Record<string, unknown> = {}): ResourceRecord {
    const companyId = attributes.company_id as string;
    if (companyId) {
      this.ensureCompanyExists(companyId);
    }

    return this.createViaRequest('/withdrawals', attributes);
  }

  createTopup(attributes: Record<string, unknown> = {}): ResourceRecord {
    const companyId = attributes.company_id as string;
    if (companyId) {
      this.ensureCompanyExists(companyId);
    }

    return this.createViaRequest('/topups', attributes);
  }

  createFeeMarkup(attributes: Record<string, unknown> = {}): ResourceRecord {
    const companyId = attributes.company_id as string;
    if (companyId) {
      this.ensureCompanyExists(companyId);
    }

    return this.createViaRequest('/fee_markups', attributes);
  }

  createAccountLink(attributes: Record<string, unknown> = {}): ResourceRecord {
    const companyId = attributes.company_id as string;
    if (companyId) {
      this.ensureCompanyExists(companyId);
    }

    return this.createViaRequest('/account_links', attributes);
  }

  createLedgerAccount(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      resource_owner_id: attributes.resource_owner_id ?? company?.id,
      resource_owner_type: attributes.resource_owner_type ?? 'Company',
      withdrawal_status: attributes.withdrawal_status ?? 'active',
      ledger_type: attributes.ledger_type ?? 'primary',
    };
    return this.seed(ResourceNames.LEDGER_ACCOUNT, attrs);
  }

  createPayoutAccount(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      status: attributes.status ?? 'connected',
      verified_at: attributes.verified_at ?? new Date().toISOString(),
    };
    return this.seed(ResourceNames.PAYOUT_ACCOUNT, attrs);
  }

  createPayoutMethod(attributes: Record<string, unknown> = {}): ResourceRecord {
    // Ensure payout account exists
    const payoutAccountId = attributes.payout_account_id as string | undefined;
    const companyId = attributes.company_id as string | undefined;

    let payoutAccount: ResourceRecord | null = null;
    if (payoutAccountId) {
      payoutAccount = this.session.store.find(ResourceNames.PAYOUT_ACCOUNT, payoutAccountId);
      if (!payoutAccount) {
        payoutAccount = this.createPayoutAccount({ id: payoutAccountId, company_id: companyId });
      }
    }

    const attrs = {
      ...attributes,
      payout_account_id: payoutAccountId ?? payoutAccount?.id,
      status: attributes.status ?? 'active',
      token_type: attributes.token_type ?? 'regular',
      destination_currency_code: attributes.destination_currency_code ?? 'usd',
    };
    return this.seed(ResourceNames.PAYOUT_METHOD, attrs);
  }

  /**
   * Create a complete payout stack for testing withdrawal lifecycle.
   * Mimics the backend relationship: Company -> LedgerAccount -> PayoutAccount -> PayoutMethod
   */
  createPayoutStack(attributes: Record<string, unknown> = {}): {
    company: ResourceRecord;
    ledger_account: ResourceRecord;
    payout_account: ResourceRecord;
    payout_method: ResourceRecord;
  } {
    const companyAttrs = (attributes.company ?? {}) as Record<string, unknown>;
    const company = this.createCompany(companyAttrs);

    // LedgerAccount belongs to company (resource_owner)
    const ledgerAccount = this.createLedgerAccount({
      company_id: company.id,
      resource_owner_id: company.id,
      resource_owner_type: 'Company',
      withdrawal_status: 'active',
      ledger_type: 'primary',
      ...((attributes.ledger_account ?? {}) as Record<string, unknown>),
    });

    // PayoutAccount links to ledger accounts (many-to-many in backend)
    const payoutAccount = this.createPayoutAccount({
      company_id: company.id,
      ledger_account_id: ledgerAccount.id,
      status: 'connected',
      verified_at: new Date().toISOString(),
      ...((attributes.payout_account ?? {}) as Record<string, unknown>),
    });

    // PayoutMethod (PayoutToken) belongs to payout_account
    const payoutMethod = this.createPayoutMethod({
      company_id: company.id,
      payout_account_id: payoutAccount.id,
      status: 'active',
      nickname: 'Primary Bank Account',
      destination_currency_code: 'usd',
      ...((attributes.payout_method ?? {}) as Record<string, unknown>),
    });

    return {
      company,
      ledger_account: ledgerAccount,
      payout_account: payoutAccount,
      payout_method: payoutMethod,
    };
  }

  /**
   * Create a withdrawal with full payout stack.
   * Use this for testing the complete withdrawal lifecycle.
   */
  createWithdrawalWithStack(attributes: Record<string, unknown> = {}): {
    withdrawal: ResourceRecord;
    company: ResourceRecord;
    ledger_account: ResourceRecord;
    payout_account: ResourceRecord;
    payout_method: ResourceRecord;
  } {
    const stack = this.createPayoutStack(attributes);

    const withdrawal = this.createWithdrawal({
      company_id: stack.company.id,
      payout_method_id: stack.payout_method.id,
      amount: attributes.amount ?? 100.0,
      currency: attributes.currency ?? 'usd',
      ...((attributes.withdrawal ?? {}) as Record<string, unknown>),
    });

    return {
      withdrawal,
      ...stack,
    };
  }

  // ========== Disputes & Resolution Cases ==========

  createDispute(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      status: attributes.status ?? 'needs_response',
    };
    return this.createViaRequest('/disputes', attrs);
  }

  createDisputeAlert(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      alert_type: attributes.alert_type ?? 'DISPUTE',
    };
    return this.createViaRequest('/dispute_alerts', attrs);
  }

  createResolutionCase(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      status: attributes.status ?? 'merchant_response_needed',
      issue: attributes.issue ?? 'product_not_delivered',
    };
    return this.createViaRequest('/resolution_cases', attrs);
  }

  createPayment(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    const status = (attributes.status ?? 'paid') as string;
    const amount = (attributes.amount ?? attributes.total ?? 10.0) as number;
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      status,
      substatus: attributes.substatus ?? (status === 'paid' ? 'succeeded' : 'pending'),
      total: attributes.total ?? amount,
      amount,
      currency: attributes.currency ?? 'usd',
    };
    return this.seed(ResourceNames.PAYMENT, attrs);
  }

  createUser(attributes: Record<string, unknown> = {}): ResourceRecord {
    return this.seed(ResourceNames.USER, attributes);
  }

  /**
   * Create a dispute with associated payment and company.
   * Use this for testing the complete dispute lifecycle.
   */
  createDisputeWithPayment(attributes: Record<string, unknown> = {}): {
    dispute: ResourceRecord;
    payment: ResourceRecord;
    company: ResourceRecord;
  } {
    const company = this.createCompany((attributes.company ?? {}) as Record<string, unknown>);
    const payment = this.createPayment({
      company_id: company.id,
      ...((attributes.payment ?? {}) as Record<string, unknown>),
    });

    const dispute = this.createDispute({
      company_id: company.id,
      payment_id: payment.id,
      amount: payment.total,
      currency: payment.currency,
      ...((attributes.dispute ?? {}) as Record<string, unknown>),
    });

    return { dispute, payment, company };
  }

  /**
   * Create a resolution case with associated payment, user, and company.
   */
  createResolutionCaseWithPayment(attributes: Record<string, unknown> = {}): {
    resolution_case: ResourceRecord;
    payment: ResourceRecord;
    user: ResourceRecord;
    company: ResourceRecord;
  } {
    const company = this.createCompany((attributes.company ?? {}) as Record<string, unknown>);
    const user = this.createUser((attributes.user ?? {}) as Record<string, unknown>);
    const payment = this.createPayment({
      company_id: company.id,
      ...((attributes.payment ?? {}) as Record<string, unknown>),
    });

    const resolutionCase = this.createResolutionCase({
      company_id: company.id,
      user_id: user.id,
      payment_id: payment.id,
      ...((attributes.resolution_case ?? {}) as Record<string, unknown>),
    });

    return { resolution_case: resolutionCase, payment, user, company };
  }

  // ========== Payins / Checkout ==========

  createMember(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      status: attributes.status ?? 'joined',
    };
    return this.seed(ResourceNames.MEMBER, attrs);
  }

  createPaymentMethod(attributes: Record<string, unknown> = {}): ResourceRecord {
    return this.createViaRequest('/payment_methods', {
      brand: attributes.brand ?? 'visa',
      last4: attributes.last4 ?? '4242',
      ...attributes,
    });
  }

  createMembership(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    return this.createViaRequest('/memberships', {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      status: attributes.status ?? 'active',
    });
  }

  createCheckoutConfiguration(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    return this.createViaRequest('/checkout_configurations', {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      mode: attributes.mode ?? 'payment',
      allow_promo_codes: attributes.allow_promo_codes ?? true,
    });
  }

  createInvoice(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    return this.createViaRequest('/invoices', {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      status: attributes.status ?? 'open',
    });
  }

  createPromoCode(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    return this.createViaRequest('/promo_codes', {
      amount_off: attributes.amount_off ?? 10,
      base_currency: attributes.base_currency ?? 'usd',
      code: attributes.code ?? 'PROMO2024',
      new_users_only: attributes.new_users_only ?? false,
      promo_duration_months: attributes.promo_duration_months ?? 1,
      promo_type: attributes.promo_type ?? 'percentage',
      ...rest,
      company_id: attributes.company_id ?? company?.id,
    });
  }

  /**
   * Refunds are normally created through payments.refund. This seeds a standalone
   * refund linked to a payment for tests that read the refunds collection directly.
   */
  createRefund(attributes: Record<string, unknown> = {}): ResourceRecord {
    const paymentId =
      (attributes.payment_id as string | undefined) ??
      ((attributes.payment as Record<string, unknown> | undefined)?.id as string | undefined);
    const { payment_id: _paymentId, payment: _payment, ...rest } = attributes;
    return this.seed(ResourceNames.REFUND, {
      ...rest,
      status: attributes.status ?? 'succeeded',
      currency: attributes.currency ?? 'usd',
      payment: paymentId ? { id: paymentId } : undefined,
    });
  }

  /**
   * SetupIntents are normally created through checkout setup mode. This seeds one
   * for tests that read the setup_intents collection directly.
   */
  createSetupIntent(attributes: Record<string, unknown> = {}): ResourceRecord {
    const company = this.ensureCompany(attributes.company, attributes.company_id as string);
    const { company: _company, ...rest } = attributes;
    return this.seed(ResourceNames.SETUP_INTENT, {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      status: attributes.status ?? 'requires_action',
    });
  }

  /**
   * Create a checkout-ready stack: Company -> Product -> Plan -> CheckoutConfiguration.
   * Mirrors what a creator sets up before a customer can buy.
   */
  createCheckoutStack(attributes: Record<string, unknown> = {}): {
    company: ResourceRecord;
    product: ResourceRecord;
    plan: ResourceRecord;
    checkout_configuration: ResourceRecord;
  } {
    const company = this.createCompany((attributes.company ?? {}) as Record<string, unknown>);

    const product = this.createProduct({
      company_id: company.id,
      ...((attributes.product ?? {}) as Record<string, unknown>),
    });

    const plan = this.createPlan({
      company_id: company.id,
      product_id: product.id,
      ...((attributes.plan ?? {}) as Record<string, unknown>),
    });

    const checkoutConfiguration = this.createCheckoutConfiguration({
      company_id: company.id,
      plan_id: plan.id,
      ...((attributes.checkout_configuration ?? {}) as Record<string, unknown>),
    });

    return { company, product, plan, checkout_configuration: checkoutConfiguration };
  }

  /**
   * Create a full customer purchase stack: the checkout stack plus a payment method,
   * member, membership and a paid payment linked across the graph.
   * Use this for testing the complete payins lifecycle.
   */
  createPaymentStack(attributes: Record<string, unknown> = {}): {
    company: ResourceRecord;
    product: ResourceRecord;
    plan: ResourceRecord;
    checkout_configuration: ResourceRecord;
    payment_method: ResourceRecord;
    member: ResourceRecord;
    membership: ResourceRecord;
    payment: ResourceRecord;
  } {
    const stack = this.createCheckoutStack(attributes);

    const paymentMethod = this.createPaymentMethod(
      (attributes.payment_method ?? {}) as Record<string, unknown>
    );

    const member = this.createMember({
      company_id: stack.company.id,
      ...((attributes.member ?? {}) as Record<string, unknown>),
    });

    const membership = this.createMembership({
      company_id: stack.company.id,
      ...((attributes.membership ?? {}) as Record<string, unknown>),
    });

    const payment = this.createViaRequest('/payments', {
      company_id: stack.company.id,
      member_id: member.id,
      plan_id: stack.plan.id,
      product_id: stack.product.id,
      payment_method_id: paymentMethod.id,
      amount: attributes.amount ?? 10.0,
      currency: attributes.currency ?? 'usd',
      status: 'paid',
      ...((attributes.payment ?? {}) as Record<string, unknown>),
    });

    return {
      ...stack,
      payment_method: paymentMethod,
      member,
      membership,
      payment,
    };
  }

  // ========== Webhooks / Events ==========

  /**
   * Seed a webhook subscribed to one or more event types. Pass `events: ['*']`
   * to subscribe to everything. Emitted events whose type matches are reported
   * in the {@link WebhookEventContext} passed to listeners.
   */
  createWebhook(attributes: Record<string, unknown> = {}): ResourceRecord {
    const events = (attributes.events as string[] | undefined) ?? [
      WebhookEvents.MEMBERSHIP_TRIAL_ENDING_SOON,
    ];
    return this.seed(ResourceNames.WEBHOOK, {
      api_version: attributes.api_version ?? 'v1',
      enabled: attributes.enabled ?? true,
      ...attributes,
      events,
    });
  }

  /** Register a listener invoked for every emitted webhook event. */
  onWebhookEvent(handler: WebhookEventHandler): () => void {
    return this.session.webhookEmitter.on(handler);
  }

  /** Build, store, and deliver a webhook event of the given type. */
  emitWebhookEvent(type: string, options: EmitOptions = {}): WebhookEvent {
    return this.session.webhookEmitter.emit(type, options);
  }

  /**
   * Emit a `membership.trial_ending_soon` event for a membership. Accepts a
   * membership record (as returned by {@link createMembership}) or an id; if an
   * id is given the membership is looked up to populate the payload. Extra
   * `data` overrides are merged onto the membership snapshot.
   */
  triggerMembershipTrialEndingSoon(
    membership: ResourceRecord | string,
    overrides: { data?: ResourceRecord; company_id?: string } = {}
  ): WebhookEvent {
    const record =
      typeof membership === 'string'
        ? this.session.store.find(ResourceNames.MEMBERSHIP, membership) ?? { id: membership }
        : membership;

    const data: ResourceRecord = { ...record, ...(overrides.data ?? {}) };

    return this.emitWebhookEvent(WebhookEvents.MEMBERSHIP_TRIAL_ENDING_SOON, {
      company_id: overrides.company_id ?? (record.company_id as string | undefined),
      data,
    });
  }

  private seed(resourceName: string, overrides: Record<string, unknown> = {}): ResourceRecord {
    const record = this.session.exampleGenerator.generate(resourceName, overrides);
    return this.session.store.insert(resourceName, record);
  }

  private createViaRequest(path: string, body: Record<string, unknown>): ResourceRecord {
    const [status, payload] = this.session.dispatcher.dispatch({
      method: 'POST',
      path,
      body: { body },
    });

    if (status !== 201) {
      throw new Error(`Unexpected status ${status} for ${path}`);
    }

    return payload as ResourceRecord;
  }

  private ensureCompany(
    companyAttributes: unknown,
    companyId?: string
  ): ResourceRecord | null {
    if (companyAttributes && typeof companyAttributes === 'object' && (companyAttributes as Record<string, unknown>).id) {
      return companyAttributes as ResourceRecord;
    }

    if (companyId) {
      const existing = this.session.store.find(ResourceNames.COMPANY, companyId);
      if (existing) return existing;
    }

    const attrs: Record<string, unknown> = {
      ...(companyAttributes as Record<string, unknown> ?? {}),
    };
    if (companyId) {
      attrs.id = companyId;
    }

    return this.createCompany(attrs);
  }

  private ensureProduct(
    productAttributes: unknown,
    companyId: string,
    productId?: string
  ): ResourceRecord | null {
    if (productAttributes && typeof productAttributes === 'object' && (productAttributes as Record<string, unknown>).id) {
      return productAttributes as ResourceRecord;
    }

    if (productId) {
      const existing = this.session.store.find(ResourceNames.PRODUCT, productId);
      if (existing) return existing;
    }

    if (!productAttributes && !productId) return null;

    const attrs: Record<string, unknown> = {
      ...(productAttributes as Record<string, unknown> ?? {}),
      company_id: companyId,
    };
    if (productId) {
      attrs.id = productId;
    }

    return this.createProduct(attrs);
  }

  private ensureCompanyExists(companyId: string): ResourceRecord {
    const existing = this.session.store.find(ResourceNames.COMPANY, companyId);
    if (existing) return existing;

    return this.createCompany({ id: companyId });
  }

  private isCompanyLikeId(id: string): boolean {
    return id.startsWith('biz_') || id.startsWith('company_') || id.startsWith('cmp_');
  }

  private compactCompany(company: ResourceRecord | null): Record<string, unknown> | null {
    if (!company) return null;
    return {
      id: company.id,
      title: company.title,
      route: company.route,
    };
  }

  private compactProduct(product: ResourceRecord | null): Record<string, unknown> | null {
    if (!product) return null;
    return {
      id: product.id,
      title: product.title,
      company_id: product.company_id,
    };
  }
}
