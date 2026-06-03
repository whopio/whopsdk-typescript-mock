/**
 * Dispute lifecycle tests for whopsdk-mock-typescript.
 * Tests disputes, early dispute alerts, and resolution cases.
 */
import WhopMock from '../src/index.js';

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
    toBeDefined() {
      if (actual === undefined) {
        throw new Error(`Expected value to be defined`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null, got ${actual}`);
      }
    },
    not: {
      toBeNull() {
        if (actual === null) {
          throw new Error(`Expected value not to be null`);
        }
      },
    },
    toBeGreaterThanOrEqual(expected: number) {
      if (typeof actual !== 'number' || actual < expected) {
        throw new Error(`Expected ${actual} >= ${expected}`);
      }
    },
  };
}

WhopMock.toggleDebug(false);

describe('Dispute Workflows', () => {
  WhopMock.start();

  it('creates a dispute with payment', () => {
    const helper = WhopMock.createTestHelper();
    const { dispute, payment, company } = helper.createDisputeWithPayment({
      dispute: { status: 'needs_response', reason: 'fraudulent' },
      payment: { total: 99.99, currency: 'usd' },
    });

    expect(dispute.id).toBeDefined();
    expect(dispute.status).toBe('needs_response');
    expect(dispute.reason).toBe('fraudulent');
    expect(dispute.amount).toBe(99.99);
    expect(dispute.currency).toBe('usd');
    expect(dispute.company).not.toBeNull();
    expect(dispute.payment).not.toBeNull();
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates dispute with all fields', () => {
    const helper = WhopMock.createTestHelper();
    const dispute = helper.createDispute({
      status: 'warning_needs_response',
      amount: 250.0,
      currency: 'eur',
      reason: 'product_not_received',
      visa_rdr: true,
      editable: false,
    });

    expect(dispute.status).toBe('warning_needs_response');
    expect(dispute.visa_rdr).toBe(true);
    expect(dispute.editable).toBe(false);
  });

  WhopMock.stop();
  WhopMock.start();

  it('updates dispute status via store', () => {
    const helper = WhopMock.createTestHelper();
    const { dispute } = helper.createDisputeWithPayment({});

    expect(dispute.status).toBe('needs_response');

    const store = WhopMock.getStore();
    const updated = store.update('dispute', dispute.id as string, {
      status: 'under_review',
    });

    expect(updated?.status).toBe('under_review');
  });

  WhopMock.stop();
});

describe('Early Dispute Alert Workflows', () => {
  WhopMock.start();

  it('creates dispute alert with payment', () => {
    const helper = WhopMock.createTestHelper();
    const payment = helper.createPayment({ total: 150.0 });
    const alert = helper.createDisputeAlert({
      payment_id: payment.id,
      alert_type: 'DISPUTE',
      amount: 150.0,
      currency: 'usd',
      charge_for_alert: true,
    });

    expect(alert.id).toBeDefined();
    expect(alert.alert_type).toBe('DISPUTE');
    expect(alert.amount).toBe(150.0);
    expect(alert.charge_for_alert).toBe(true);
    expect(alert.payment).not.toBeNull();
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates DISPUTE_RDR alert type', () => {
    const helper = WhopMock.createTestHelper();
    const alert = helper.createDisputeAlert({
      alert_type: 'DISPUTE_RDR',
      amount: 75.0,
    });

    expect(alert.alert_type).toBe('DISPUTE_RDR');
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates FRAUD alert type', () => {
    const helper = WhopMock.createTestHelper();
    const alert = helper.createDisputeAlert({
      alert_type: 'FRAUD',
      amount: 500.0,
    });

    expect(alert.alert_type).toBe('FRAUD');
  });

  WhopMock.stop();
});

describe('Resolution Case Workflows', () => {
  WhopMock.start();

  it('creates resolution case with payment', () => {
    const helper = WhopMock.createTestHelper();
    const data = helper.createResolutionCaseWithPayment({
      resolution_case: { status: 'merchant_response_needed', issue: 'product_not_delivered' },
      payment: { total: 200.0 },
    });

    const resolutionCase = data.resolution_case;
    expect(resolutionCase.id).toBeDefined();
    expect(resolutionCase.status).toBe('merchant_response_needed');
    expect(resolutionCase.issue).toBe('product_not_delivered');
    expect(resolutionCase.company).not.toBeNull();
    expect(resolutionCase.user).not.toBeNull();
    expect(resolutionCase.payment).not.toBeNull();
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates merchant_won resolution case', () => {
    const helper = WhopMock.createTestHelper();
    const resolutionCase = helper.createResolutionCase({
      status: 'merchant_won',
      issue: 'subscription_cancelled',
      merchant_appealed: false,
      customer_appealed: false,
    });

    expect(resolutionCase.status).toBe('merchant_won');
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates customer_won resolution case', () => {
    const helper = WhopMock.createTestHelper();
    const resolutionCase = helper.createResolutionCase({
      status: 'customer_won',
      issue: 'unauthorized_transaction',
    });

    expect(resolutionCase.status).toBe('customer_won');
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates resolution case with appeals', () => {
    const helper = WhopMock.createTestHelper();
    const resolutionCase = helper.createResolutionCase({
      status: 'under_platform_review',
      issue: 'duplicate_charge',
      customer_appealed: true,
      merchant_appealed: true,
    });

    expect(resolutionCase.customer_appealed).toBe(true);
    expect(resolutionCase.merchant_appealed).toBe(true);
  });

  WhopMock.stop();
});

describe('Dispute Lifecycle E2E', () => {
  WhopMock.start();

  it('full dispute lifecycle: alert -> dispute -> won', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany({ title: 'Lifecycle Test Co' });
    const payment = helper.createPayment({
      company_id: company.id,
      total: 500.0,
      status: 'paid',
    });

    // Step 1: Early warning via dispute alert
    const alert = helper.createDisputeAlert({
      company_id: company.id,
      payment_id: payment.id,
      alert_type: 'DISPUTE',
      amount: 500.0,
    });
    expect(alert.id).toBeDefined();

    // Step 2: Dispute filed
    const dispute = helper.createDispute({
      company_id: company.id,
      payment_id: payment.id,
      amount: 500.0,
      status: 'needs_response',
      reason: 'credit_not_processed',
    });
    expect(dispute.status).toBe('needs_response');

    // Step 3: Merchant responds
    const store = WhopMock.getStore();
    const underReview = store.update('dispute', dispute.id as string, {
      status: 'under_review',
      notes: 'Refund was processed on 2024-01-15',
    });
    expect(underReview?.status).toBe('under_review');

    // Step 4: Merchant wins
    const won = store.update('dispute', dispute.id as string, {
      status: 'won',
    });
    expect(won?.status).toBe('won');
  });

  WhopMock.stop();
  WhopMock.start();

  it('resolution case lifecycle: opened -> reviewed -> merchant won', () => {
    const helper = WhopMock.createTestHelper();
    const data = helper.createResolutionCaseWithPayment({
      resolution_case: { status: 'merchant_response_needed' },
    });

    expect(data.resolution_case.status).toBe('merchant_response_needed');

    // Merchant responds
    const store = WhopMock.getStore();
    const underReview = store.update('resolution_case', data.resolution_case.id as string, {
      status: 'under_platform_review',
    });
    expect(underReview?.status).toBe('under_platform_review');

    // Resolved in merchant's favor
    const won = store.update('resolution_case', data.resolution_case.id as string, {
      status: 'merchant_won',
    });
    expect(won?.status).toBe('merchant_won');
  });

  WhopMock.stop();
});

console.log('\n✅ All dispute tests completed!');
