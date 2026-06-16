# whopsdk-mock

Stateful in-process mock for the Whop TypeScript SDK. Like `stripe-mock` but for Whop.

## Install

```bash
npm install whopsdk-mock @whop/sdk
# or
pnpm add whopsdk-mock @whop/sdk
```

## Quick Start

```typescript
import WhopMock from 'whopsdk-mock';
import { Whop } from '@whop/sdk';

// In your test setup
beforeEach(() => {
  WhopMock.start();
});

afterEach(() => {
  WhopMock.stop();
});

// In your test
it('creates a withdrawal', async () => {
  const client = new Whop({ apiKey: 'test_key' });
  WhopMock.install(client);

  const helper = WhopMock.createTestHelper();
  const stack = helper.createPayoutStack();

  const withdrawal = await client.withdrawals.create({
    company_id: stack.company.id,
    amount: 100.0,
    currency: 'usd',
  });

  expect(withdrawal.status).toBe('requested');
  expect(withdrawal.amount).toBe(100.0);
});
```

## Coverage

**Payouts**:
- `transfers` - Internal transfers between ledger accounts
- `withdrawals` - Payouts to external accounts
- `topups` - Balance top-ups
- `fee_markups` - Custom fee configurations
- `account_links` - Onboarding links (transient)
- `ledger_accounts` - Balance accounts
- `payout_accounts` - External payout destinations
- `payout_methods` - Payout method configurations

**Payins & Checkout**:
- `products` - Products, linked to a company
- `plans` - Pricing plans, linked to a product
- `checkout_configurations` - Checkout configs with an embedded plan + purchase URL
- `payments` - Payment records (`list`, `retrieve`, `fees`, `refund`, `retry`, `void`) with status/substatus lifecycle
- `refunds` - Refund records (auto-created when a payment is refunded)
- `memberships` - Memberships with `cancel` / `uncancel` / `pause` / `resume` / `add_free_days`
- `invoices` - Invoices with `mark_paid` (creates a payment), `mark_uncollectible`, `void`
- `promo_codes` - Discount codes
- `payment_methods` - Stored payment methods
- `setup_intents` - Setup intents
- `members` - Members

**Disputes & Resolution**:
- `disputes` - Payment disputes with status lifecycle
- `dispute_alerts` - Early dispute alerts (DISPUTE, DISPUTE_RDR, FRAUD)
- `resolution_cases` - Resolution case management

**Core**:
- `companies` - Company/business accounts
- `users` - User accounts

**Webhook Events**:
- `webhooks` - Webhook subscriptions
- `events` - Emitted webhook events (`retrieve` via `/events/{id}`)
- Emit/deliver events in-process to test your webhook handlers (e.g. `membership.trial_ending_soon`)

## API

### Lifecycle

```typescript
import WhopMock from 'whopsdk-mock';

WhopMock.start();                    // Start session
WhopMock.stop();                     // End session
WhopMock.install(client);            // Intercept SDK client
WhopMock.uninstall(client);          // Restore SDK client
```

### Seeding Data

```typescript
WhopMock.seed('company', { id: 'biz_123', title: 'Acme' });
WhopMock.seedMany('transfer', [
  { status: 'pending' },
  { status: 'paid' },
]);
WhopMock.generateExample('withdrawal', { status: 'requested' });
```

### Test Helper

```typescript
const helper = WhopMock.createTestHelper();

// Payouts
const company = helper.createCompany({ title: 'Acme' });
const transfer = helper.createTransfer({
  origin_id: 'biz_123',
  destination_id: 'biz_456',
  amount: 50.0,
});
const withdrawal = helper.createWithdrawal({
  company_id: company.id,
  amount: 100.0,
});

// Complete payout stack
const stack = helper.createPayoutStack();
// Returns: { company, ledger_account, payout_account, payout_method }

// Payins / checkout
const checkout = helper.createCheckoutStack();
// Returns: { company, product, plan, checkout_configuration }

const purchase = helper.createPaymentStack({ amount: 49.0, currency: 'usd' });
// Returns: { company, product, plan, checkout_configuration,
//            payment_method, member, membership, payment }
// `payment` is `paid` (substatus `succeeded`) and linked across the graph.

const membership = helper.createMembership({ name: 'Gold' });
const invoice = helper.createInvoice({ company_id: company.id, plan_id: purchase.plan.id });
const promo = helper.createPromoCode({ company_id: company.id, code: 'SAVE20' });

// Disputes
const { dispute, payment, company } = helper.createDisputeWithPayment({
  dispute: { status: 'needs_response', reason: 'fraudulent' },
  payment: { total: 99.99 },
});

const alert = helper.createDisputeAlert({
  alert_type: 'DISPUTE',
  amount: 150.0,
});

// Resolution cases
const { resolution_case, payment, user, company } = helper.createResolutionCaseWithPayment({
  resolution_case: { status: 'merchant_response_needed' },
});
```

### Webhook Events

The mock can emit Whop webhook events in-process so you can exercise your
webhook handlers without standing up a real endpoint. Each emitted event is
stored (retrievable via `GET /events/{id}`) and delivered to every registered
listener.

```typescript
import WhopMock, { WebhookEvents, isKnownWebhookEvent } from 'whopsdk-mock';

const helper = WhopMock.createTestHelper();
const membership = helper.createMembership({ name: 'Gold', status: 'trialing' });

// Stand in for your application's webhook endpoint.
const unsubscribe = WhopMock.onWebhookEvent((event, { webhooks }) => {
  if (event.type === WebhookEvents.MEMBERSHIP_TRIAL_ENDING_SOON) {
    // assert your handler logic ...
  }
});

// High-level trigger for the membership trial-ending event.
const event = helper.triggerMembershipTrialEndingSoon(membership);
// event.type === 'membership.trial_ending_soon'
// event.data is the membership snapshot; event.id is an `evt_...` id

// Low-level emit for any event type.
WhopMock.emitWebhookEvent('membership.went_invalid', {
  company_id: membership.company_id,
  data: { id: membership.id, status: 'expired' },
});

// Optionally seed webhook subscriptions; matches are reported in the
// listener's delivery context.
helper.createWebhook({ events: [WebhookEvents.MEMBERSHIP_TRIAL_ENDING_SOON] });

isKnownWebhookEvent('membership.trial_ending_soon'); // true
unsubscribe();
```

Known event types live in `WebhookEvents` / `KNOWN_WEBHOOK_EVENTS`. Emitting an
unknown type still works — the registry is advisory.

### Error Injection

```typescript
WhopMock.prepareError(Error, 'retrieve_withdrawal', {
  message: 'Withdrawal not found',
});
```

### Fallback Handlers

```typescript
WhopMock.registerFallback(({ method, path, query, body }) => {
  if (path === '/custom/endpoint') {
    return [200, { ok: true }];
  }
  return null; // Fall through to default handling
});
```

### Debug Mode

```typescript
WhopMock.toggleDebug(true);
// Logs all requests and responses
```

## Configuration

```typescript
import { configure } from 'whopsdk-mock';

configure({
  debug: true,
  debugOutput: console.log,
  specPath: './path/to/openapi.yml',
  apiBasePath: '/api/v1',
  idPrefixes: {
    company: 'biz_',
    withdrawal: 'wd_',
  },
});
```

## OpenAPI Spec

The mock derives routes, schemas, and example data from the OpenAPI spec. Place your spec at:

- `vendor/openapi/whop-openapi.yml` (vendored)
- Or provide `specPath` in configuration

## Vitest Integration

```typescript
// vitest.setup.ts
import WhopMock from 'whopsdk-mock';

beforeEach(() => {
  WhopMock.start({ specPath: './vendor/openapi.yml' });
});

afterEach(() => {
  WhopMock.stop();
});
```

## Jest Integration

```typescript
// jest.setup.ts
import WhopMock from 'whopsdk-mock';

beforeEach(() => {
  WhopMock.start({ specPath: './vendor/openapi.yml' });
});

afterEach(() => {
  WhopMock.stop();
});
```

## TypeScript

Full TypeScript support with exported types:

```typescript
import type {
  WhopMockConfiguration,
  ResourceRecord,
  MockRequest,
  MockResponse,
  PaginatedResponse,
} from 'whopsdk-mock';
```
