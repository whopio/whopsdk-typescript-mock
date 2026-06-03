import type { ResourceRecord } from '../types.js';
import { Store } from '../store.js';
import { ExampleGenerator } from '../example-generator.js';
import { ResourceNames } from '../types.js';

/**
 * Handles payout-specific side effects and graph operations.
 */
export class PayoutGraph {
  constructor(
    private store: Store,
    private exampleGenerator: ExampleGenerator
  ) {}

  ensureTransferGraph(record: ResourceRecord, payload: Record<string, unknown>): ResourceRecord {
    const originId = (payload.origin_id ?? record.origin_id) as string | undefined;
    const destinationId = (payload.destination_id ?? record.destination_id) as string | undefined;

    const originCompany = this.companyLikeId(originId)
      ? this.ensureCompanyExists(originId!)
      : null;
    const destinationCompany = this.companyLikeId(destinationId)
      ? this.ensureCompanyExists(destinationId!)
      : null;

    const now = new Date().toISOString();
    const transferUpdates: Record<string, unknown> = {
      created_at: record.created_at ?? now,
      updated_at: record.updated_at ?? record.created_at ?? now,
      company_id: record.company_id ?? originCompany?.id,
      currency: payload.currency ?? record.currency ?? 'usd',
      amount: record.amount ?? payload.amount ?? 10.0,
      destination_id: destinationId,
      origin_id: originId,
      destination_ledger_account_id:
        record.destination_ledger_account_id ?? `ledger_${destinationId}`,
      origin_ledger_account_id: record.origin_ledger_account_id ?? `ledger_${originId}`,
      destination: this.compactTransferParty(destinationId, destinationCompany),
      origin: this.compactTransferParty(originId, originCompany),
      metadata: record.metadata ?? payload.metadata ?? {},
      notes: record.notes ?? payload.notes,
      status: record.status ?? 'paid',
    };

    // Remove undefined values
    const cleanUpdates = this.compactHash(transferUpdates);

    this.store.update(ResourceNames.TRANSFER, record.id as string, cleanUpdates);
    return this.store.find(ResourceNames.TRANSFER, record.id as string) ?? record;
  }

  ensureWithdrawalGraph(record: ResourceRecord, payload: Record<string, unknown>): ResourceRecord {
    const companyId = (payload.company_id ?? record.company_id) as string | undefined;
    const company = companyId ? this.ensureCompanyExists(companyId) : null;
    const payoutMethodId = (payload.payout_method_id ?? record.payout_method_id) as string | undefined;
    const payoutMethod = payoutMethodId
      ? this.store.find(ResourceNames.PAYOUT_METHOD, payoutMethodId)
      : null;

    const now = new Date().toISOString();
    const withdrawalUpdates: Record<string, unknown> = {
      created_at: record.created_at ?? now,
      updated_at: record.updated_at ?? record.created_at ?? now,
      amount: record.amount ?? payload.amount ?? 10.0,
      company_id: companyId,
      currency: payload.currency ?? record.currency ?? 'usd',
      payout_method_id: payoutMethodId,
      ledger_account: {
        id: (record.ledger_account as Record<string, unknown>)?.id ?? `ledger_${companyId}`,
        company_id: company?.id,
      },
      payout_token: {
        id: payoutMethodId ?? 'pomethod_example',
        created_at: payoutMethod?.created_at ?? record.created_at ?? now,
        destination_currency_code: String(payload.currency ?? record.currency ?? 'usd'),
        nickname: payoutMethod?.nickname,
        payer_name: (payoutMethod?.destination as Record<string, unknown>)?.name ?? company?.title,
      },
      status: record.status ?? 'requested',
      speed: record.speed ?? 'standard',
      fee_amount: record.fee_amount ?? 0.0,
      markup_fee: record.markup_fee ?? 0.0,
    };

    const cleanUpdates = this.compactHash(withdrawalUpdates);

    this.store.update(ResourceNames.WITHDRAWAL, record.id as string, cleanUpdates);
    return this.store.find(ResourceNames.WITHDRAWAL, record.id as string) ?? record;
  }

  ensureFeeMarkupGraph(record: ResourceRecord, payload: Record<string, unknown>): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as string | undefined;
    if (companyId) {
      this.ensureCompanyExists(companyId);
    }

    const feeType = String(record.fee_type ?? payload.fee_type ?? '');
    const now = new Date().toISOString();

    // Check for existing fee markup with same type for company
    const existing = this.store
      .list(ResourceNames.FEE_MARKUP, { company_id: companyId })
      .find((item) => String(item.fee_type) === feeType && item.id !== record.id);

    const targetId = existing ? (existing.id as string) : (record.id as string);

    if (existing) {
      this.store.delete(ResourceNames.FEE_MARKUP, record.id as string);
    }

    const timestamps = {
      created_at: existing?.created_at ?? record.created_at ?? now,
      updated_at: now,
    };

    const defaults: Record<string, unknown> = {
      company_id: companyId,
      created_at: timestamps.created_at,
      fee_type: feeType,
      fixed_fee_usd: record.fixed_fee_usd ?? payload.fixed_fee_usd,
      metadata: record.metadata ?? payload.metadata ?? {},
      notes: record.notes ?? payload.notes,
      percentage_fee: record.percentage_fee ?? payload.percentage_fee,
      updated_at: timestamps.updated_at,
    };

    const cleanDefaults = this.compactHash(defaults);

    this.store.update(ResourceNames.FEE_MARKUP, targetId, cleanDefaults);
    return this.store.find(ResourceNames.FEE_MARKUP, targetId) ?? record;
  }

  ensureTopupGraph(record: ResourceRecord, payload: Record<string, unknown>): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as string | undefined;
    if (companyId) {
      this.ensureCompanyExists(companyId);
    }

    const paymentMethodId = (record.payment_method_id ?? payload.payment_method_id) as string | undefined;
    const paymentMethod = paymentMethodId
      ? this.ensurePaymentMethodExists(paymentMethodId)
      : null;

    const now = new Date().toISOString();
    const defaults: Record<string, unknown> = {
      company_id: companyId,
      created_at: record.created_at ?? now,
      currency: record.currency ?? payload.currency ?? 'usd',
      failure_message: record.failure_message ?? payload.failure_message,
      paid_at: record.paid_at ?? now,
      payment_method_id: paymentMethodId,
      payment_method: paymentMethod ? this.compactPaymentMethod(paymentMethod) : null,
      status: record.status === 'active' ? 'paid' : (record.status ?? payload.status ?? 'paid'),
      total: payload.amount ?? record.total,
      updated_at: now,
    };

    const cleanDefaults = this.compactHash(defaults);

    this.store.update(ResourceNames.TOPUP, record.id as string, cleanDefaults);
    return this.store.find(ResourceNames.TOPUP, record.id as string) ?? record;
  }

  ensureAccountLinkGraph(record: ResourceRecord, payload: Record<string, unknown>): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as string | undefined;
    if (companyId) {
      this.ensureCompanyExists(companyId);
    }

    const useCase = String(record.use_case ?? payload.use_case ?? 'account_onboarding');
    const expiresAt =
      record.expires_at ?? payload.expires_at ?? new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const defaults: Record<string, unknown> = {
      company_id: companyId,
      expires_at: expiresAt,
      refresh_url: record.refresh_url ?? payload.refresh_url,
      return_url: record.return_url ?? payload.return_url,
      url: this.isPlaceholderValue(record.url)
        ? this.accountLinkUrl(record.id as string, companyId, useCase)
        : record.url,
      use_case: useCase,
    };

    const cleanDefaults = this.compactHash(defaults);

    this.store.update(ResourceNames.ACCOUNT_LINK, record.id as string, cleanDefaults);
    return this.store.find(ResourceNames.ACCOUNT_LINK, record.id as string) ?? record;
  }

  /**
   * Ensures ledger account has proper graph relationships.
   * LedgerAccount belongs to a resource_owner (Company/User) and has many payout_accounts.
   */
  ensureLedgerAccountGraph(record: ResourceRecord, payload: Record<string, unknown>): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as string | undefined;
    const company = companyId ? this.ensureCompanyExists(companyId) : null;

    const now = new Date().toISOString();
    const ledgerAccountUpdates: Record<string, unknown> = {
      created_at: record.created_at ?? now,
      updated_at: record.updated_at ?? now,
      company_id: companyId,
      resource_owner_type: record.resource_owner_type ?? payload.resource_owner_type ?? 'Company',
      resource_owner_id: record.resource_owner_id ?? payload.resource_owner_id ?? companyId,
      ledger_type: record.ledger_type ?? payload.ledger_type ?? 'primary',
      withdrawal_status: record.withdrawal_status ?? payload.withdrawal_status ?? 'active',
      withdrawal_frequency: record.withdrawal_frequency ?? payload.withdrawal_frequency ?? 'weekly',
      reserve_percentage: record.reserve_percentage ?? payload.reserve_percentage ?? 0,
      currency: record.currency ?? payload.currency ?? 'usd',
      balance: record.balance ?? payload.balance ?? 0,
      available_balance: record.available_balance ?? payload.available_balance ?? 0,
      pending_balance: record.pending_balance ?? payload.pending_balance ?? 0,
      // Embed company info for API response
      company: company ? this.compactCompany(company) : null,
    };

    const cleanUpdates = this.compactHash(ledgerAccountUpdates);

    this.store.update(ResourceNames.LEDGER_ACCOUNT, record.id as string, cleanUpdates);
    return this.store.find(ResourceNames.LEDGER_ACCOUNT, record.id as string) ?? record;
  }

  /**
   * Ensures payout account has proper graph relationships.
   * PayoutAccount has many ledger_accounts (through join) and many payout_tokens (methods).
   */
  ensurePayoutAccountGraph(record: ResourceRecord, payload: Record<string, unknown>): ResourceRecord {
    const companyId = (record.company_id ?? payload.company_id) as string | undefined;
    const ledgerAccountId = (record.ledger_account_id ?? payload.ledger_account_id) as string | undefined;

    // Ensure company exists
    const company = companyId ? this.ensureCompanyExists(companyId) : null;

    // Ensure ledger account exists if specified
    if (ledgerAccountId) {
      this.ensureLedgerAccountExists(ledgerAccountId, companyId);
    }

    const now = new Date().toISOString();
    // Public API status values: connected, disabled, action_required, pending_verification, verification_failed, not_started
    const status = (record.status ?? payload.status ?? 'not_started') as string;

    const payoutAccountUpdates: Record<string, unknown> = {
      created_at: record.created_at ?? now,
      updated_at: record.updated_at ?? now,
      status: status,
      verified_at: record.verified_at ?? payload.verified_at,
      country: record.country ?? payload.country ?? 'US',
      payout_country: record.payout_country ?? payload.payout_country,
      email: record.email ?? payload.email,
      first_name: record.first_name ?? payload.first_name,
      last_name: record.last_name ?? payload.last_name,
      business_name: record.business_name ?? payload.business_name ?? company?.title,
      company: company ? this.compactCompany(company) : null,
    };

    const cleanUpdates = this.compactHash(payoutAccountUpdates);

    this.store.update(ResourceNames.PAYOUT_ACCOUNT, record.id as string, cleanUpdates);
    return this.store.find(ResourceNames.PAYOUT_ACCOUNT, record.id as string) ?? record;
  }

  /**
   * Ensures payout method (PayoutToken) has proper graph relationships.
   * PayoutMethod belongs to payout_account and payout_destination.
   */
  ensurePayoutMethodGraph(record: ResourceRecord, payload: Record<string, unknown>): ResourceRecord {
    const payoutAccountId = (record.payout_account_id ?? payload.payout_account_id) as string | undefined;
    const companyId = (record.company_id ?? payload.company_id) as string | undefined;

    // Ensure payout account exists
    const payoutAccount = payoutAccountId
      ? this.ensurePayoutAccountExists(payoutAccountId, companyId)
      : null;

    // Ensure payout destination exists if specified
    const payoutDestinationId = (record.payout_destination_id ?? payload.payout_destination_id) as
      | string
      | undefined;
    const payoutDestination = payoutDestinationId
      ? this.ensurePayoutDestinationExists(payoutDestinationId)
      : null;

    const now = new Date().toISOString();
    const payoutMethodUpdates: Record<string, unknown> = {
      created_at: record.created_at ?? now,
      updated_at: record.updated_at ?? now,
      status: record.status ?? payload.status ?? 'active',
      token_type: record.token_type ?? payload.token_type ?? 'regular',
      provider: record.provider ?? payload.provider ?? 'masspay',
      payout_account_id: payoutAccountId,
      payout_destination_id: payoutDestinationId,
      destination_currency_code: record.destination_currency_code ?? payload.destination_currency_code ?? 'usd',
      destination_token: record.destination_token ?? payload.destination_token,
      nickname: record.nickname ?? payload.nickname ?? 'Primary Account',
      institution_name: record.institution_name ?? payload.institution_name,
      is_default: record.is_default ?? payload.is_default ?? false,
      // Embed destination info for API response
      destination: payoutDestination
        ? this.compactPayoutDestination(payoutDestination)
        : record.destination ?? {
            type: record.delivery_type ?? payload.delivery_type ?? 'bank_deposit',
            name: record.payer_name ?? payload.payer_name ?? payoutAccount?.business_name,
          },
      // Embed payout account info
      payout_account: payoutAccount ? this.compactPayoutAccount(payoutAccount) : null,
    };

    const cleanUpdates = this.compactHash(payoutMethodUpdates);

    this.store.update(ResourceNames.PAYOUT_METHOD, record.id as string, cleanUpdates);
    return this.store.find(ResourceNames.PAYOUT_METHOD, record.id as string) ?? record;
  }

  private ensureCompanyExists(companyId: string): ResourceRecord {
    const existing = this.store.find(ResourceNames.COMPANY, companyId);
    if (existing) return existing;

    const company = this.exampleGenerator.generate(ResourceNames.COMPANY, { id: companyId });
    return this.store.insert(ResourceNames.COMPANY, company);
  }

  private ensurePaymentMethodExists(paymentMethodId: string): ResourceRecord {
    const existing = this.store.find(ResourceNames.PAYMENT_METHOD, paymentMethodId);
    if (existing) return existing;

    const paymentMethod = this.exampleGenerator.generate(ResourceNames.PAYMENT_METHOD, {
      id: paymentMethodId,
    });
    return this.store.insert(ResourceNames.PAYMENT_METHOD, paymentMethod);
  }

  private ensureLedgerAccountExists(
    ledgerAccountId: string,
    companyId?: string
  ): ResourceRecord {
    const existing = this.store.find(ResourceNames.LEDGER_ACCOUNT, ledgerAccountId);
    if (existing) return existing;

    const ledgerAccount = this.exampleGenerator.generate(ResourceNames.LEDGER_ACCOUNT, {
      id: ledgerAccountId,
      company_id: companyId,
      withdrawal_status: 'active',
      ledger_type: 'primary',
    });
    const inserted = this.store.insert(ResourceNames.LEDGER_ACCOUNT, ledgerAccount);
    return this.ensureLedgerAccountGraph(inserted, { company_id: companyId });
  }

  private ensurePayoutAccountExists(
    payoutAccountId: string,
    companyId?: string
  ): ResourceRecord {
    const existing = this.store.find(ResourceNames.PAYOUT_ACCOUNT, payoutAccountId);
    if (existing) return existing;

    const payoutAccount = this.exampleGenerator.generate(ResourceNames.PAYOUT_ACCOUNT, {
      id: payoutAccountId,
      company_id: companyId,
      status: 'connected',
      verified_at: new Date().toISOString(),
    });
    const inserted = this.store.insert(ResourceNames.PAYOUT_ACCOUNT, payoutAccount);
    return this.ensurePayoutAccountGraph(inserted, { company_id: companyId });
  }

  private ensurePayoutDestinationExists(payoutDestinationId: string): ResourceRecord {
    const existing = this.store.find(ResourceNames.PAYOUT_DESTINATION, payoutDestinationId);
    if (existing) return existing;

    const payoutDestination = this.exampleGenerator.generate(ResourceNames.PAYOUT_DESTINATION, {
      id: payoutDestinationId,
      delivery_type: 'bank_deposit',
      fee_category: 'bank_wire',
    });
    return this.store.insert(ResourceNames.PAYOUT_DESTINATION, payoutDestination);
  }

  private companyLikeId(identifier: string | undefined): boolean {
    if (!identifier) return false;
    return (
      identifier.startsWith('biz_') ||
      identifier.startsWith('company_') ||
      identifier.startsWith('cmp_')
    );
  }

  private compactTransferParty(
    id: string | undefined,
    company: ResourceRecord | null
  ): Record<string, unknown> | null {
    if (!id) return null;

    return {
      id,
      type: this.companyLikeId(id) ? 'company' : 'ledger_account',
      company: company
        ? { id: company.id, title: company.title, route: company.route }
        : null,
    };
  }

  private compactPaymentMethod(paymentMethod: ResourceRecord): Record<string, unknown> {
    return {
      id: paymentMethod.id,
      brand: paymentMethod.brand,
      last4: paymentMethod.last4,
      exp_month: paymentMethod.exp_month,
      exp_year: paymentMethod.exp_year,
    };
  }

  private compactCompany(company: ResourceRecord): Record<string, unknown> {
    return {
      id: company.id,
      title: company.title,
      route: company.route,
    };
  }

  private compactPayoutAccount(payoutAccount: ResourceRecord): Record<string, unknown> {
    return {
      id: payoutAccount.id,
      status: payoutAccount.status,
      verified_at: payoutAccount.verified_at,
      business_name: payoutAccount.business_name,
      country: payoutAccount.country,
    };
  }

  private compactPayoutDestination(payoutDestination: ResourceRecord): Record<string, unknown> {
    return {
      id: payoutDestination.id,
      type: payoutDestination.delivery_type,
      name: payoutDestination.name,
      fee_category: payoutDestination.fee_category,
    };
  }

  private compactHash(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  private isPlaceholderValue(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    const str = String(value);
    return str.endsWith('_example') || str.startsWith('https://example.com/');
  }

  private accountLinkUrl(
    accountLinkId: string,
    companyId: string | undefined,
    useCase: string
  ): string {
    return `https://whop.test/companies/${companyId}/account_links/${useCase}?session=${accountLinkId}`;
  }
}
