import type { ResourceRecord } from './types.js';
import { ResourceNames } from './types.js';
import { Session } from './session.js';

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
    const product = this.ensureProduct(
      attributes.product,
      company?.id as string,
      attributes.product_id as string
    );

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
    const attrs = {
      ...rest,
      company_id: attributes.company_id ?? company?.id,
      status: attributes.status ?? 'paid',
      total: attributes.total ?? 10.0,
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
