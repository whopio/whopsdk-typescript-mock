/**
 * Payout workflow tests for whopsdk-mock.
 */

import WhopMock, { ResourceNames } from '../src/index.js';

// Simulated test runner
function describe(name: string, fn: () => void) {
  console.log(`\n${name}`);
  fn();
}

function it(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${(error as Error).message}`);
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toEqual(expected: unknown) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error(`Expected value to be defined`);
      }
    },
  };
}

// Enable debug mode to see what's happening
WhopMock.toggleDebug(false);

describe('Payout Workflows', () => {
  // Start fresh session for each test
  WhopMock.start();

  it('creates a company', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany({ title: 'Test Company' });

    expect(company.id).toBeDefined();
    expect(company.title).toBe('Test Company');
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates a transfer between companies', () => {
    const helper = WhopMock.createTestHelper();

    // Create origin and destination companies
    const origin = helper.createCompany({ title: 'Origin Co' });
    const destination = helper.createCompany({ title: 'Destination Co' });

    // Create transfer
    const transfer = helper.createTransfer({
      origin_id: origin.id,
      destination_id: destination.id,
      amount: 50.0,
      currency: 'usd',
    });

    expect(transfer.id).toBeDefined();
    expect(transfer.amount).toBe(50.0);
    expect(transfer.status).toBe('paid');
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates a withdrawal', () => {
    const helper = WhopMock.createTestHelper();

    // Create a payout stack (company + related resources)
    const stack = helper.createPayoutStack();

    // Create withdrawal
    const withdrawal = helper.createWithdrawal({
      company_id: stack.company.id,
      amount: 100.0,
      currency: 'usd',
    });

    expect(withdrawal.id).toBeDefined();
    expect(withdrawal.status).toBe('requested');
    expect(withdrawal.amount).toBe(100.0);
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates a fee markup', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany();

    const feeMarkup = helper.createFeeMarkup({
      company_id: company.id,
      fee_type: 'withdrawal',
      percentage_fee: 2.5,
      fixed_fee_usd: 0.3,
    });

    expect(feeMarkup.id).toBeDefined();
    expect(feeMarkup.fee_type).toBe('withdrawal');
    expect(feeMarkup.percentage_fee).toBe(2.5);
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates an account link', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany();

    const accountLink = helper.createAccountLink({
      company_id: company.id,
      use_case: 'account_onboarding',
      return_url: 'https://example.com/return',
      refresh_url: 'https://example.com/refresh',
    });

    expect(accountLink.id).toBeDefined();
    expect(accountLink.url).toBeDefined();
    expect(accountLink.expires_at).toBeDefined();
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates a complete payout stack', () => {
    const helper = WhopMock.createTestHelper();

    const stack = helper.createPayoutStack({
      company: { title: 'Payout Test Co' },
    });

    expect(stack.company.id).toBeDefined();
    expect(stack.company.title).toBe('Payout Test Co');
    expect(stack.ledger_account.id).toBeDefined();
    expect(stack.payout_account.id).toBeDefined();
    expect(stack.payout_method.id).toBeDefined();
  });

  WhopMock.stop();
  WhopMock.start();

  it('seeds data directly', () => {
    WhopMock.seed(ResourceNames.COMPANY, {
      id: 'biz_test123',
      title: 'Seeded Company',
    });

    const results = WhopMock.search(ResourceNames.COMPANY, { query: 'Seeded' });

    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Seeded Company');
  });

  WhopMock.stop();
});

describe('Payout Lifecycle E2E', () => {
  WhopMock.start();

  it('creates ledger account with proper graph', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany({ title: 'LedgerAccount Test Co' });

    const ledgerAccount = helper.createLedgerAccount({
      company_id: company.id,
      withdrawal_status: 'active',
      ledger_type: 'primary',
    });

    expect(ledgerAccount.id).toBeDefined();
    expect(ledgerAccount.company_id).toBe(company.id);
    expect(ledgerAccount.withdrawal_status).toBe('active');
    expect(ledgerAccount.ledger_type).toBe('primary');
    expect(ledgerAccount.resource_owner_type).toBe('Company');
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates payout account with verification status', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany({ title: 'PayoutAccount Test Co' });

    const payoutAccount = helper.createPayoutAccount({
      company_id: company.id,
      status: 'connected',
      country: 'US',
    });

    expect(payoutAccount.id).toBeDefined();
    expect(payoutAccount.status).toBe('connected');
    expect(payoutAccount.verified_at).toBeDefined();
    expect(payoutAccount.country).toBe('US');
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates payout method with proper destination', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany({ title: 'PayoutMethod Test Co' });
    const payoutAccount = helper.createPayoutAccount({
      company_id: company.id,
    });

    const payoutMethod = helper.createPayoutMethod({
      payout_account_id: payoutAccount.id,
      company_id: company.id,
      nickname: 'My Bank Account',
      destination_currency_code: 'usd',
    });

    expect(payoutMethod.id).toBeDefined();
    expect(payoutMethod.status).toBe('active');
    expect(payoutMethod.nickname).toBe('My Bank Account');
    expect(payoutMethod.destination_currency_code).toBe('usd');
    expect(payoutMethod.payout_account_id).toBe(payoutAccount.id);
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates full withdrawal with stack helper', () => {
    const helper = WhopMock.createTestHelper();

    const result = helper.createWithdrawalWithStack({
      amount: 250.0,
      currency: 'usd',
    });

    // Check withdrawal
    expect(result.withdrawal.id).toBeDefined();
    expect(result.withdrawal.status).toBe('requested');
    expect(result.withdrawal.amount).toBe(250.0);

    // Check full stack was created
    expect(result.company.id).toBeDefined();
    expect(result.ledger_account.id).toBeDefined();
    expect(result.ledger_account.withdrawal_status).toBe('active');
    expect(result.payout_account.id).toBeDefined();
    expect(result.payout_account.status).toBe('connected');
    expect(result.payout_method.id).toBeDefined();
    expect(result.payout_method.status).toBe('active');
  });

  WhopMock.stop();
  WhopMock.start();

  it('simulates withdrawal lifecycle: requested -> awaiting_payment -> completed', () => {
    const helper = WhopMock.createTestHelper();
    const stack = helper.createPayoutStack();

    // Create withdrawal in requested state
    const withdrawal = helper.createWithdrawal({
      company_id: stack.company.id,
      payout_method_id: stack.payout_method.id,
      amount: 500.0,
    });
    expect(withdrawal.status).toBe('requested');

    // Update to awaiting_payment (simulating approval)
    const store = WhopMock.getStore();
    const approved = store.update(ResourceNames.WITHDRAWAL, withdrawal.id as string, {
      status: 'awaiting_payment',
    });
    expect(approved?.status).toBe('awaiting_payment');

    // Update to completed (simulating payment)
    const completed = store.update(ResourceNames.WITHDRAWAL, withdrawal.id as string, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.completed_at).toBeDefined();
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates disabled payout account', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany();

    const payoutAccount = helper.createPayoutAccount({
      company_id: company.id,
      status: 'disabled',
    });

    expect(payoutAccount.status).toBe('disabled');
  });

  WhopMock.stop();
});

console.log('\n✅ All payout tests completed!');
