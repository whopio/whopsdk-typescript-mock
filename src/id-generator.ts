import { SchemaRegistry } from './schema-registry.js';

const DEFAULT_PREFIXES: Record<string, string> = {
  event: 'evt_',
  payment_token: 'tok_',
  company: 'biz_',
  membership: 'mem_',
  payment: 'pay_',
  payment_method: 'pm_',
  plan: 'plan_',
  product: 'prod_',
  invoice: 'inv_',
  refund: 'ref_',
  transfer: 'xfer_',
  withdrawal: 'wd_',
  topup: 'topup_',
  fee_markup: 'fm_',
  account_link: 'acctlink_',
  ledger_account: 'ledger_',
  payout_account: 'poacct_',
  payout_method: 'pomethod_',
  checkout_configuration: 'chkout_',
  promo_code: 'promo_',
  webhook: 'wh_',
  verification: 'ver_',
};

/**
 * Generates unique IDs with resource-appropriate prefixes.
 */
export class IdGenerator {
  private schemaRegistry: SchemaRegistry;
  private overrides: Record<string, string>;

  constructor(schemaRegistry: SchemaRegistry, overrides: Record<string, string> = {}) {
    this.schemaRegistry = schemaRegistry;
    this.overrides = overrides;
  }

  generate(resourceName: string): string {
    const prefix = this.prefixFor(resourceName);
    const randomPart = this.randomAlphanumeric(12);
    return `${prefix}${randomPart}`;
  }

  private prefixFor(resourceName: string): string {
    // Check overrides first
    if (this.overrides[resourceName]) {
      return this.overrides[resourceName];
    }

    // Check schema registry
    const schemaPrefix = this.schemaRegistry.prefixFor(resourceName);
    if (schemaPrefix) {
      return schemaPrefix;
    }

    // Use default prefixes
    if (DEFAULT_PREFIXES[resourceName]) {
      return DEFAULT_PREFIXES[resourceName];
    }

    // Fallback: first 3 chars + underscore
    return `${resourceName.slice(0, 3)}_`;
  }

  private randomAlphanumeric(length: number): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}
