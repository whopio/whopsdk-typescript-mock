# whopsdk-mock

Stateful in-process mock for the Whop TypeScript SDK. Like `stripe-mock` but for Whop.

## Current API testing — updated November 4, 2026

This checkout starts from upstream `6d0057823fdd4f455fc97c734aee074205800568`
(June 22, 2026). It preserves the original Node/npm/TypeScript setup, in-memory
fixture store and three original test files. No database, Docker, remote devbox,
queue service or hosted sandbox is required. The current-API adapter and optional
local HTTP wrapper use that same store.

### Test the dispute API with your own data

```bash
npm ci
npm run serve:mock
# In another terminal, edit the example or supply your own JSON file:
npm run seed:mock -- examples/http/disputes.seed.json
npm run smoke:disputes
```

Seeding returns your merchant's test API keys and linked dispute/payment/refund
IDs. Use the returned key with `http://127.0.0.1:4100/api/v1`. You can list/read
cases, edit and upload evidence, submit or accept disputes, and drive simulated
outcomes and webhooks. [Start here](examples/http/README.md#seed-your-own-dispute-cases).
`smoke:disputes` exercises the whole flow with fresh data without resetting other
cases. The service remains local; each tester can run a copy of this repository.

### Original setup and command

```bash
npm ci
npm test
```

`npm test` is exactly the upstream command: build with `tsc`, then run
`tests/payout-test.ts`, `tests/dispute-test.ts` and `tests/payments-test.ts` with
`tsx`. It contains 43 examples. These are synthetic in-process tests; the
repository does not establish how any particular developer ran tests elsewhere.
The original scripts catch assertion failures without necessarily failing the
process, so `test:baseline` invokes that same `npm test` and checks its output.

### Additional compatibility checks

```bash
npm run test:all       # original command + compatibility/HTTP + independent Node clients
npm run test:compat    # schema coverage for every scoped operation + behavior and SDK checks
npm run test:http      # actual HTTP, multipart uploads, signed callbacks and processor controls
npm run test:partners  # 48 checks from independently written Node partner clients
npm run test:workflow  # consolidated-PDF integration example
npm run audit:sdk      # validate runtime responses against the pinned SDK types
npm run check:docs     # read current docs.whop.com and detect contract drift
npm run serve:mock    # optional local API: http://127.0.0.1:4100/api/v1
```

The audit covers the 36 public operations indexed by docs.whop.com in the dispute,
payment, refund, file and webhook areas. Tests execute every operation and check
response shapes against 57 referenced schemas extracted only from those public
pages. All eleven local lifecycle events have resource-data and signature checks.
The nine indexed webhook pages omit envelope schemas; `check:docs` reports that
verification gap rather than claiming full webhook payload parity.
The SDK is pinned to 2.7.0. The default mock API date is `2026-10-28`.
Any valid date (including release suffixes) is accepted and uses the closest
implemented behavior at or before that date, clamped to the oldest/latest model.
The effective date is returned in `x-whop-mock-api-version`. This permissive
fallback is a mock convenience, not Whop's real version-negotiation behavior.

The fixture engine now supports payment updates, refunds, capture/status/retry/void,
receipt PDFs, and webhook registration, delivery logs and replay. Payment creation
uses explicitly seeded request/result pairs; processor completion uses admin test
controls. [See the complete scope, examples and limitations](examples/http/README.md#complete-current-api-scope).

These checks establish public documentation/schema agreement and local fixture behavior.
They do not certify a 1:1 production backend or a passing run of your application.
The service reports `backend_parity: "unverified"` explicitly.

### Disputes, payment/refund context, and evidence files

This complete example uses the current SDK in memory. Run it from the repository
root after `npm ci`; it does not require the HTTP server. The PDF is synthetic.

```bash
npm run build
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { WhopClient } from '@whop/sdk';
import { unwrapWebhook } from '@whop/sdk/helpers';
import WhopMock, { API_VERSION_DATE } from './dist/index.js';
import { evidencePdf } from './examples/evidence-pdf.mjs';

WhopMock.start();
try {
  const mockFetch = WhopMock.createFetch();
  const client = new WhopClient({
    token: 'test-only', fetch: mockFetch,
    apiVersionDate: API_VERSION_DATE, maxRetries: 0,
  });
  const helper = WhopMock.createTestHelper();

  // Seed linked fixtures. Dispute creation is a test helper, not a public API.
  const { dispute, payment, company } = helper.createDisputeWithPayment({
    payment: { total: 99.99, customer_email: 'buyer@example.test' },
    dispute: { provider: 'stripe', reason: 'fraudulent' },
  });
  helper.createRefund({ payment_id: payment.id, amount: 20, status: 'succeeded' });

  const page = await client.disputes.list({ account_id: company.id, first: 10 });
  const current = await client.disputes.retrieve({ id: dispute.id });
  const paid = await client.payments.retrieve({ id: current.payment.id });
  const refunds = await client.refunds.list({ payment_id: paid.id });
  assert.equal(page.data[0].id, dispute.id);
  assert.equal(paid.total.amount, '99.99');
  assert.equal(refunds.data[0].amount.amount, '20.00');

  // Create a File, PUT bytes to its upload URL, then attach the ready file.
  const bytes = evidencePdf();
  const file = await client.files.create({ filename: 'delivery.pdf', byte_size: bytes.length });
  const upload = await mockFetch(file.upload_url, {
    method: 'PUT', headers: file.upload_headers, body: bytes,
  });
  assert.equal(upload.status, 200);
  const ready = await client.files.retrieve({ id: file.id });
  assert.equal(ready.upload_status, 'ready'); // Immediate for this in-memory adapter.
  await client.disputes.update({ id: dispute.id, evidence: { notes: 'Synthetic delivery evidence' } });
  await client.disputes.uploadEvidence({
    id: dispute.id,
    documents: [{ id: ready.id, document_type: 'digital_fulfillment' }],
  });

  // Submit starts a pending workflow; the test explicitly chooses its outcome.
  const pending = await client.disputes.submit({ id: dispute.id });
  assert.equal(pending.evidence_submitted_at, null);
  WhopMock.completeDisputeSubmission(dispute.id, 'accepted'); // Or 'rejected'.
  const submitted = await client.disputes.retrieve({ id: dispute.id });
  assert.equal(submitted.status, 'under_review');
  assert.equal(submitted.evidence_locked_reason, 'submitted');
  await assert.rejects(
    client.disputes.update({ id: dispute.id, evidence: { notes: 'Too late' } }),
    error => error.statusCode === 400,
  );

  // Conceding an open dispute is a separate action from submitting evidence.
  const other = helper.createDisputeWithPayment({ dispute: { provider: 'stripe' } });
  assert.equal((await client.disputes.accept({ id: other.dispute.id })).status, 'lost');

  // Sign an event and verify it with the SDK's actual webhook helper.
  const event = WhopMock.emitWebhookEvent('dispute.updated', { data: { id: dispute.id } });
  const secret = 'ws_readme_fixture_only';
  const delivery = WhopMock.signWebhook(event, secret);
  const verified = unwrapWebhook(delivery.body, { headers: delivery.headers, key: secret });
  assert.equal(verified.data.id, dispute.id);
  console.log('Dispute, context, file, submission, concession and webhook examples passed.');
} finally {
  WhopMock.stop();
}
JS
```

Use the same `mockFetch` for SDK calls and upload PUTs. HTTP clients must poll
the File until `upload_status` is `ready` before attaching it. `uploadEvidence`
replaces the entire document set; retain existing documents when needed. For a
consolidated packet, the supported fixed slot is
`evidence: { uncategorized_attachment: { id: ready.id } }` in `disputes.update()`.
Payment/refund APIs in this adapter support list and retrieve; create those
records with fixture helpers.

### HTTP webhooks and simulated outcomes

For a real HTTP client or webhook receiver, start these in separate terminals:

```bash
# Terminal 1: demo receiver (replace with your application's receiver when ready).
npm run receive:webhooks
# Terminal 2: API, configured to deliver signed events to that receiver.
WHOP_MOCK_WEBHOOK_URL=http://127.0.0.1:4101/webhooks/whop npm run serve:mock
```

The following requests use the built-in primary merchant on a fresh server.
Custom seeds return their own API tokens and IDs; substitute those when testing
your data. These defaults are local fixture credentials.

```bash
# Emit a dispute.created event to the configured receiver.
curl --fail-with-body http://127.0.0.1:4100/_test/events \
  -H 'Authorization: Bearer local_mock_admin_test_only' \
  -H 'Content-Type: application/json' \
  --data '{"type":"dispute.created","resource_id":"dspt_mock_open","deliver":true}'

# Submit through the API (your integration normally makes this request).
curl --fail-with-body http://127.0.0.1:4100/api/v1/disputes/dspt_mock_open/submit \
  -H 'Authorization: Bearer local_mock_api_test_only' \
  -H 'Api-Version-Date: 2026-10-28' -H 'Content-Type: application/json' \
  --data '{}'

# Simulate processor acceptance; dispute.updated is scheduled after one minute.
curl --fail-with-body http://127.0.0.1:4100/_test/submissions/dspt_mock_open \
  -H 'Authorization: Bearer local_mock_admin_test_only' \
  -H 'Content-Type: application/json' --data '{"outcome":"accepted"}'

# Inspect the resulting under_review state.
curl --fail-with-body http://127.0.0.1:4100/api/v1/disputes/dspt_mock_open \
  -H 'Authorization: Bearer local_mock_api_test_only' \
  -H 'Api-Version-Date: 2026-10-28'
```

`/_test/*` routes are simulator controls; only `/api/v1/*` routes model API calls.
For a complete HTTP flow including evidence upload, run `npm run smoke:disputes`.
The [HTTP guide](examples/http/README.md#scenarios-and-controls) includes event
replay, one-shot failures, upload failures and won/lost outcomes. The default
demo webhook signing secret is `ws_local_mock_webhook_test_only`.
**Registered webhooks use their own `webhook_secret` from the creation response.**
When using a registered webhook, omit `deliver` on test event/scenario controls:
the matching subscription delivers automatically. `deliver: true` additionally
sends a demo callback signed with the server-level secret, and so does the
delayed `dispute.updated` callback after accepted submissions and status changes.
See the [signing-secret guide](examples/http/README.md#webhook-signing-secrets).

To connect your existing service, use the [local HTTP walkthrough](examples/http/README.md).
The [in-process example](examples/README.md) documents fixture setup. Both use
synthetic records. They do not execute your code, the real permission-policy
engine, PDF processing or payment processors. Unknown operations fail explicitly;
there is no live API fallback. Health/status report backend parity as unverified.
Independent backend captures can be compared if they become available; a separate
backend environment is not part of this project's setup.

The [isolated partner simulations](tests/partner/README.md) include three independent
Node clients with 48 checks covering evidence, webhook reliability and fixture
authoring. These exercise synthetic partner
implementations; testing your application requires connecting its own client and handler.

Saved run reports, agent scratch output, build output, environment files and
user-specific data stay local and are ignored by Git. Use `.local/` for custom
datasets and `test-results/` for reports. The vendored response schema remains
versioned because both the seed validator and schema tests load it at runtime;
GitHub marks that snapshot as generated to keep reviews focused on code.

The upstream instructions below describe the legacy fixture surface. The public
registry returned 404 for `whopsdk-mock` on the review date. Its illustrated `Whop`
constructor and `install()` are not the current SDK interface; use this checkout
and `WhopClient({ fetch: WhopMock.createFetch() })` for current SDK testing.

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
