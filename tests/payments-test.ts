/**
 * Payins / checkout workflow tests for whopsdk-mock.
 *
 * Covers the customer side of payments: products, plans, checkout configurations,
 * payments (list / retrieve / fees / refund / retry / void), memberships lifecycle,
 * invoices and promo codes.
 */

import WhopMock, { ResourceNames } from '../src/index.js';
import type { Session } from '../src/session.js';

let failures = 0;

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`);
  fn();
}

function it(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(error as Error).message}`);
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeDefined() {
      if (actual === undefined || actual === null) {
        throw new Error(`Expected value to be defined`);
      }
    },
    toBeTruthy() {
      if (!actual) {
        throw new Error(`Expected truthy value, got ${JSON.stringify(actual)}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (typeof actual !== 'number' || actual <= expected) {
        throw new Error(`Expected ${JSON.stringify(actual)} to be greater than ${expected}`);
      }
    },
  };
}

/** Helper: dispatch a request the way the SDK requester would (synchronously). */
function call(
  session: Session,
  method: string,
  path: string,
  body?: unknown
): [number, Record<string, unknown>] {
  const [status, payload] = session.dispatcher.dispatch({ method, path, body });
  return [status, payload as Record<string, unknown>];
}

WhopMock.toggleDebug(false);

describe('Checkout Setup', () => {
  WhopMock.start();

  it('creates a product linked to a company', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany({ title: 'Acme Co' });
    const product = helper.createProduct({ company_id: company.id, title: 'Pro Plan' });

    expect(product.id).toBeDefined();
    expect(product.title).toBe('Pro Plan');
    expect(product.company_id).toBe(company.id);
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates a plan linked to product and company', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany();
    const plan = helper.createPlan({
      company_id: company.id,
      title: 'Monthly',
      initial_price: 25.0,
      currency: 'usd',
    });

    expect(plan.id).toBeDefined();
    expect(plan.title).toBe('Monthly');
    expect(plan.initial_price).toBe(25.0);
    expect(plan.product_id).toBeDefined();
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates a checkout configuration with an embedded plan and purchase url', () => {
    const helper = WhopMock.createTestHelper();
    const stack = helper.createCheckoutStack({ plan: { initial_price: 30.0 } });
    const checkout = stack.checkout_configuration;

    expect(checkout.id).toBeDefined();
    expect(checkout.mode).toBe('payment');
    expect(checkout.allow_promo_codes).toBe(true);
    expect(checkout.plan_id).toBe(stack.plan.id);
    expect((checkout.plan as Record<string, unknown>).id).toBe(stack.plan.id);
    expect(checkout.purchase_url).toBeDefined();
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates a payment method', () => {
    const helper = WhopMock.createTestHelper();
    const pm = helper.createPaymentMethod({ last4: '1881', brand: 'amex' });

    expect(pm.id).toBeDefined();
    expect(pm.brand).toBe('amex');
    expect(pm.last4).toBe('1881');
  });

  WhopMock.stop();
});

describe('Payment Lifecycle E2E', () => {
  WhopMock.start();

  it('creates a full payment stack with linked graph', () => {
    const helper = WhopMock.createTestHelper();
    const stack = helper.createPaymentStack({ amount: 49.0, currency: 'usd' });

    expect(stack.company.id).toBeDefined();
    expect(stack.product.id).toBeDefined();
    expect(stack.plan.id).toBeDefined();
    expect(stack.checkout_configuration.id).toBeDefined();
    expect(stack.payment_method.id).toBeDefined();
    expect(stack.member.id).toBeDefined();
    expect(stack.membership.id).toBeDefined();

    const payment = stack.payment;
    expect(payment.id).toBeDefined();
    expect(payment.status).toBe('paid');
    expect(payment.substatus).toBe('succeeded');
    expect(payment.amount).toBe(49.0);
    expect(payment.member_id).toBe(stack.member.id);
    expect(payment.plan_id).toBe(stack.plan.id);
    expect(payment.product_id).toBe(stack.product.id);
    expect(payment.payment_method_id).toBe(stack.payment_method.id);
  });

  WhopMock.stop();
  const listSession = WhopMock.start();

  it('lists and retrieves payments like the SDK', () => {
    const helper = WhopMock.createTestHelper();
    const stack = helper.createPaymentStack();

    const [listStatus, list] = call(listSession, 'GET', '/payments');
    expect(listStatus).toBe(200);
    expect((list.data as unknown[]).length).toBeGreaterThan(0);
    expect(list.page_info).toBeDefined();

    const [retrieveStatus, retrieved] = call(
      listSession,
      'GET',
      `/payments/${stack.payment.id}`
    );
    expect(retrieveStatus).toBe(200);
    expect(retrieved.id).toBe(stack.payment.id);
  });

  WhopMock.stop();
  const feesSession = WhopMock.start();

  it('returns a fee breakdown for a payment', () => {
    const helper = WhopMock.createTestHelper();
    const stack = helper.createPaymentStack({ amount: 100.0 });

    const [status, fees] = call(feesSession, 'GET', `/payments/${stack.payment.id}/fees`);
    expect(status).toBe(200);
    expect((fees.data as unknown[]).length).toBe(2);
    const first = (fees.data as Record<string, unknown>[])[0];
    expect(first.type).toBe('processing');
    expect(first.amount).toBeGreaterThan(0);
  });

  WhopMock.stop();
  const refundSession = WhopMock.start();

  it('fully refunds a payment and records a refund', () => {
    const helper = WhopMock.createTestHelper();
    const stack = helper.createPaymentStack({ amount: 49.0 });

    const [status, refunded] = call(
      refundSession,
      'POST',
      `/payments/${stack.payment.id}/refund`,
      {}
    );
    expect(status).toBe(200);
    expect(refunded.substatus).toBe('refunded');
    expect(refunded.refunded_at).toBeDefined();

    const refunds = WhopMock.list(ResourceNames.REFUND);
    expect(refunds.length).toBe(1);
    expect(refunds[0].amount).toBe(49.0);
    expect((refunds[0].payment as Record<string, unknown>).id).toBe(stack.payment.id);
  });

  WhopMock.stop();
  const partialSession = WhopMock.start();

  it('partially refunds a payment', () => {
    const helper = WhopMock.createTestHelper();
    const stack = helper.createPaymentStack({ amount: 100.0 });

    const [, refunded] = call(
      partialSession,
      'POST',
      `/payments/${stack.payment.id}/refund`,
      { amount: 40.0 }
    );
    expect(refunded.substatus).toBe('partially_refunded');

    const refunds = WhopMock.list(ResourceNames.REFUND);
    expect(refunds[0].amount).toBe(40.0);
  });

  WhopMock.stop();
  const retrySession = WhopMock.start();

  it('retries a failed/open payment to paid', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany();
    const payment = helper.createPayment({
      company_id: company.id,
      status: 'open',
      amount: 15.0,
    });
    expect(payment.status).toBe('open');

    const [status, retried] = call(retrySession, 'POST', `/payments/${payment.id}/retry`, {});
    expect(status).toBe(200);
    expect(retried.status).toBe('paid');
    expect(retried.substatus).toBe('succeeded');
  });

  WhopMock.stop();
  const voidSession = WhopMock.start();

  it('voids a payment', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany();
    const payment = helper.createPayment({ company_id: company.id, status: 'open' });

    const [, voided] = call(voidSession, 'POST', `/payments/${payment.id}/void`, {});
    expect(voided.status).toBe('void');
  });

  WhopMock.stop();
});

describe('Membership Lifecycle', () => {
  const session = WhopMock.start();

  it('cancels, pauses, resumes and uncancels a membership', () => {
    const helper = WhopMock.createTestHelper();
    const membership = helper.createMembership({ name: 'Gold' });
    expect(membership.status).toBe('active');

    const [, canceled] = call(session, 'POST', `/memberships/${membership.id}/cancel`, {});
    expect(canceled.status).toBe('canceled');

    const [, uncanceled] = call(session, 'POST', `/memberships/${membership.id}/uncancel`, {});
    expect(uncanceled.status).toBe('active');

    const [, paused] = call(session, 'POST', `/memberships/${membership.id}/pause`, {});
    expect(paused.status).toBe('paused');

    const [, resumed] = call(session, 'POST', `/memberships/${membership.id}/resume`, {});
    expect(resumed.status).toBe('active');
  });

  WhopMock.stop();
});

describe('Invoices & Promo Codes', () => {
  const session = WhopMock.start();

  it('creates an invoice and marks it paid (creating a payment)', () => {
    const helper = WhopMock.createTestHelper();
    const stack = helper.createCheckoutStack();
    const invoice = helper.createInvoice({
      company_id: stack.company.id,
      plan_id: stack.plan.id,
    });
    expect(invoice.id).toBeDefined();
    expect(invoice.status).toBe('open');

    const paymentsBefore = WhopMock.list(ResourceNames.PAYMENT).length;

    const [status, result] = call(session, 'POST', `/invoices/${invoice.id}/mark_paid`, {});
    expect(status).toBe(200);
    expect(result as unknown).toBe(true);

    const storedInvoice = WhopMock.find(ResourceNames.INVOICE, invoice.id as string);
    expect(storedInvoice?.status).toBe('paid');

    const paymentsAfter = WhopMock.list(ResourceNames.PAYMENT).length;
    expect(paymentsAfter).toBe(paymentsBefore + 1);
  });

  WhopMock.stop();
  WhopMock.start();

  it('creates a promo code', () => {
    const helper = WhopMock.createTestHelper();
    const company = helper.createCompany();
    const promo = helper.createPromoCode({
      company_id: company.id,
      code: 'SAVE20',
      amount_off: 20,
      promo_type: 'percentage',
    });

    expect(promo.id).toBeDefined();
    expect(promo.code).toBe('SAVE20');
    expect(promo.amount_off).toBe(20);
    expect(promo.status).toBe('active');
  });

  WhopMock.stop();
});

if (failures > 0) {
  console.log(`\n❌ ${failures} payments test(s) failed.`);
  process.exit(1);
} else {
  console.log('\n✅ All payments tests completed!');
}
