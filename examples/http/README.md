# Whop mock HTTP test service

Your application can use its existing HTTP client with a different base URL and fixture
credentials. This optional Node HTTP wrapper uses the original in-memory fixture
engine. It requires no database, Docker, devbox, queue or storage service. The CLI
binds to `127.0.0.1`; nothing has been deployed for remote access.

## Seed your own dispute cases

Start with `npm ci` and `npm run serve:mock`. Copy/edit
[`disputes.seed.json`](disputes.seed.json), then run:

```bash
npm run seed:mock -- examples/http/disputes.seed.json
```

You can also submit the same JSON directly from curl, Postman or any HTTP client:

```bash
curl http://127.0.0.1:4100/_test/seed \
  -H 'Authorization: Bearer local_mock_admin_test_only' \
  -H 'Content-Type: application/json' \
  --data-binary @examples/http/disputes.seed.json
```

The response contains `api_base_url`, `api_version_date`, `account_id`,
`credentials.api_token`, `credentials.read_only_token`,
`credentials.no_email_token`, and the created dispute/payment/refund IDs in
`scenarios`. Use the returned API token for this merchant's normal API calls;
the built-in primary-merchant token cannot read the newly created merchant.
The seed command intentionally prints these generated local test keys.

For example, a complete custom seed request is:

```json
{
  "account": { "title": "My test merchant" },
  "scenarios": [{
    "payment": { "total": 89.99, "customer_email": "buyer@example.test", "metadata": { "order_id": "my-order" } },
    "dispute": { "reason": "fraudulent", "buyer": { "name": "Test Buyer" } },
    "refunds": [{ "amount": 15, "status": "succeeded" }]
  }]
}
```

Each scenario automatically links one payment, one dispute and zero or more
refunds. Supply custom IDs if useful, or let the fixture engine generate them.
Amounts, customer/context fields, dates, statuses, reason codes, evidence text,
payment instruments and other accepted response fields can be overridden. The
seed endpoint uses the vendored current response schemas to validate fields;
unknown fields, malformed nested data and mismatched relationships fail visibly.
Upload evidence files through the real File/evidence API sequence after seeding.

Omit `account` to create a fresh merchant. To add cases to one already seeded,
use `account_id` instead of `account`; its test keys remain the same. Imports
accept 1–100 scenarios, up to 100 refunds per case, within a 256 KiB JSON body.
Existing IDs return 409 and are never overwritten. A refused batch adds nothing.
Use synthetic data. Everything is memory-backed; reset/restart removes custom
records, uploads, events and generated credentials. Separate simultaneous test
suites should use their own process/port.

This service is for trusted local/CI testing. The startup script binds to loopback,
and demo credentials are public. The admin token controls every fixture in an
instance; keep it with the test operator. The server has per-request size limits
but no rate limits or total-memory quotas. Sharing it remotely requires separate
access controls and resource limits; do not expose the default setup publicly.

Numeric money values are USD major units. For other currencies provide explicit
Money objects, for example
`{"amount":"89.99","currency":"eur","decimals":2,"display_decimals":2}`.
Seeded refund `amount` uses the payment's settlement currency/precision. If
`presentment_total` has a different currency, each refund needs an explicit
`original_amount` in that charge currency. Successful refunds update both
refunded totals; pending/failed refunds do not. Payment currency filters use the
charge currency, although the returned payment `currency` is the settlement currency,
in the fixture. The dispute's embedded payment uses the charged amount.
DTO-only seeds assume no buyer fees: `presentment_total` is also the charged total.
Buyer-fee calculation is outside this fixture importer. Supply an explicit
`substatus` to test dispute/refund status combinations. Legacy card snapshots may be
null even when `payment_instrument.card` is populated.

Seeds accept `prevented` disputes and explicit Money precision, including 18 decimals.
The importer caps `Money.decimals` at 100 to bound allocations; this is a local
fixture limit, not a restriction in Whop's public schema.
For `payment.total: null`, supply `presentment_total`; for `refund.amount: null`,
supply `original_amount`. Unknown settlement totals stay null. Refund API writes
require known settlement and charge balances and return a local 501 otherwise.

No live FX lookup or money movement occurs. Partial refund writes use the seeded
settlement/charge ratio and integer minor-unit arithmetic. Account/payment links, refund totals
and computed dispute lock/acceptance fields are managed by the harness. An
`evidence_due_at` value is the public deadline, after Whop's lead-time adjustment.

## Exercise dispute API functionality

Run `npm run smoke:disputes` against the running service. It imports fresh custom
cases, then checks the following sequence through HTTP and the real SDK:

| Operation | Production-shaped route |
| --- | --- |
| List/filter/paginate cases | `GET /api/v1/disputes` |
| Summary counts | `GET /api/v1/disputes/summary` |
| Read a case | `GET /api/v1/disputes/{id}` |
| Edit evidence text/fixed attachments | `PATCH /api/v1/disputes/{id}` |
| Replace evidence documents | `POST /api/v1/disputes/{id}/upload_evidence` |
| Submit evidence | `POST /api/v1/disputes/{id}/submit` |
| Concede a case | `POST /api/v1/disputes/{id}/accept` |
| Read related context | `GET /api/v1/payments/{id}` and `GET /api/v1/refunds?payment_id=…` |
| Upload a document | `POST /api/v1/files`, PUT returned upload URL, then `GET /api/v1/files/{id}` |

Every API call uses `Authorization: Bearer <returned api_token>` and
`Api-Version-Date: 2026-10-28`. With a receiver configured below, the walkthrough
also verifies signed delivery/replay. It tests expired/submitted/terminal locks,
read-only permissions, email redaction and a transient 429. The example remains
adaptable to your own client/handler; it does not run your application.

Use the admin controls below to emit events and simulate processor acceptance,
rejection or won/lost outcomes. Case creation and outcome simulation are test
controls; normal API calls use the same route/method/body shapes as Whop.

## Original setup and verification

```bash
npm ci
npm test
npm run test:all
```

`npm test` retains the exact original command: `tsc`, followed by the payout,
dispute and payment test scripts through `tsx`. Those three files are unchanged.
`test:all` runs that command with failure detection, then the additional SDK,
behavior/schema and loopback HTTP tests. Everything uses synthetic fixtures in the
same Node setup. HTTP tests need permission to bind local sockets.

The references are SDK 2.7.0 and the public docs.whop.com pages. The November 4
schema audit reads 50 official reference pages and covers 36 operations with 57
referenced schemas. Local regressions also exercise grants and email visibility,
pagination, deadlines, evidence replacement, multipart uploads, idempotency and
retry behavior. They do not prove deployed backend or processor parity.

```bash
npm run check:docs
```

This read-only check detects published schema and version drift. To regenerate
only from public docs after reviewing a change:

```bash
mkdir -p .local/docs-audit
npm run check:docs -- .local/docs-audit/public-scope.json
node scripts/sync-current-contract.mjs .local/docs-audit/public-scope.json
```

A drift finding exits nonzero but still writes the export; a network failure is
an incomplete check. Review the diff and run `test:all` after regeneration.
`/healthz` and `/_test/status` report `backend_parity: "unverified"`.

## Complete current API scope

The operation inventory is stored in `vendor/current-api-schemas.json`, with
request fields, query fields, documented response codes and referenced schemas.
`tests/current-surface.test.mjs` calls all 36 operations and validates real response
bodies against that independently generated contract. `check:docs` downloads the
current official references again and fails on new routes or changed shapes;
network failures are reported as an incomplete check. It does not update the mock.

| Area | Operations covered |
| --- | --- |
| Disputes (7) | List, retrieve, summary, update, upload evidence, submit, accept |
| Payments (14) | List, retrieve, summary, fees, status, create, update, capture, refund, retry, void, generate PDF, resume, update return URL |
| Refunds (2) | List and retrieve; create refunds through `POST /payments/{id}/refund` |
| Files (4) | Create, list, retrieve, complete multipart upload |
| Webhooks (9) | Create, list, retrieve, update, delete, test, list deliveries, replay one delivery, replay a time range |

### Seed payment actions and processor outcomes

```bash
npm run seed:mock -- examples/http/payments.seed.json
```

Use the returned merchant API token for normal routes. For example, capture
`pay_capture_demo` with `POST /api/v1/payments/pay_capture_demo/capture`, then poll
`GET /api/v1/payments/pay_capture_demo/status`. The capture response is a
`PaymentStatus`, not a `Payment`. It enters `processing`. Complete the simulated
processor result with the admin token:

```bash
curl http://127.0.0.1:4100/_test/payments/pay_capture_demo \
  -X PATCH -H 'Authorization: Bearer local_mock_admin_test_only' \
  -H 'Content-Type: application/json' \
  -d '{"status":"paid","substatus":"succeeded","refundable":true}'
```

`POST /payments/{id}/refund` accepts `partial_amount` in settlement currency and
returns the updated **Payment**. List the actual Refund with
`GET /refunds?payment_id=...`. The sample's `runtime.refund_status` is `pending`,
so refunded totals change only after the admin completes the refund with
`PATCH /_test/refunds/{id}` and `{"status":"succeeded"}`. Successful partial
refunds retain decimal precision and update both settlement and charge totals.

Each scenario can include `payment_status` (the status/next-action fields),
`fees` (complete PaymentFee objects), and these explicit runtime controls:
`manual_capture`, `return_url_editable`, `buyer_returned`, `resumable`,
`void_async`, `retryable`, `manual_retry_attempts`, `refund_status`,
`refund_provider`, and `pdf_file_id`. The generated PDF is a valid synthetic
receipt; `pdf_file_id` uses an already uploaded fixture PDF instead. Every PDF
request gets a fresh expiring URL, even with the same idempotency key.

Creation is deliberately driven by a fixture: `create_payment.request` stores
the exact JSON your client will send. The scenario's `payment` and
`payment_status` define its synthetic result. On an exact match,
`POST /payments` returns 201 with a newly generated payment ID. JSON key order
does not matter. An unseeded request returns a clear local 501. This validates
your request shape and subsequent workflow without pretending to calculate
pricing, tax, eligibility, saved-method ownership or a processor decision.

The buyer status/return-URL/resume routes also accept the seeded payment's own
`client_secret`. It grants only that payment. Seller credentials cannot resume
a buyer's pending charge. Read-only tokens cannot mutate payments or manage hooks.

### Register and replay webhooks

Use `POST /api/v1/webhooks` with a JSON body like this and the merchant API token:

```json
{
  "resource_id": "biz_payment_cases",
  "url": "http://127.0.0.1:4101/webhooks/whop",
  "events": ["dispute.created", "dispute.updated", "refund.created", "refund.updated"],
  "api_version_date": "2026-11-04"
}
```

### Webhook signing secrets

**Registered subscriptions and demo callbacks use different secrets.**

| Delivery path | Receiver verification key |
| --- | --- |
| Hook created through `POST /api/v1/webhooks`, including automatic test-control events, `/test` and API replay | That hook's `webhook_secret`, returned only at creation |
| Demo delivery via `deliver: true`, admin event replay, and the signed `delivery` preview in `/_test/events` | Server-level `WHOP_MOCK_WEBHOOK_SECRET` (`ws_local_mock_webhook_test_only` by default) |
| Delayed `dispute.updated` demo callback after an accepted `/_test/submissions/{id}`, `PATCH /_test/disputes/{id}` or `POST /api/v1/disputes/{id}/accept`; sent to `WHOP_MOCK_WEBHOOK_URL` whenever it is set, regardless of `deliver` | Server-level `WHOP_MOCK_WEBHOOK_SECRET`; a receiver holding a registered hook's secret must expect and reject this extra callback (the matching subscription still delivers separately with its own secret) |

For a registered hook, save its secret in your receiver and **omit `deliver` (or
set it to false)** when calling `/_test/events` or `/_test/scenarios`. Matching
subscriptions deliver automatically with their own secrets. `deliver: true`
adds a separate demo delivery; a receiver using the registered secret will reject
that extra callback. The demo preview is not the registered subscription's signed
payload (the subscription's version pin can also differ).

The supplied demo receiver defaults to the server-level secret. Restart it with
`WHOP_MOCK_WEBHOOK_SECRET` set to the registered secret when testing that hook.
The registration URL must match the server's `WHOP_MOCK_WEBHOOK_URL` for HTTP delivery.

Subscribed seeded events and simulated payment/refund changes deliver automatically.
For `payment.failed`, transition to `status: "open", substatus: "failed"`.
For [`payment.requires_action`](https://docs.whop.com/api-reference/beta/payments/payment-requires-action),
use `status: "open", substatus: "incomplete"`, `payment_status.status: "requires_action"`
and a non-null `recovery_url`. Repeating the same state does not emit another event.
`GET /webhooks/{id}/deliveries` exposes attempts and cursor pagination.
`POST /webhooks/{id}/deliveries/{delivery_id}/replay` sends the stored payload to
the hook's current URL; `{"regenerate_id":true}` gives it a new signed event ID.
`POST /webhooks/{id}/replay` accepts `sent_after`, optional `sent_before`,
`events`, `failed_only` and `regenerate_ids`, and returns `{"queued":true}`.
Range replays run asynchronously, selecting the latest normal attempt per message
and skipping messages with a more recent successful replay, including regenerated
IDs. Original attempts and replays have a simulated
30-day retention window. Disabled hooks cannot replay; `/test` can still probe
them. Test probes do not create delivery-log entries or change endpoint health.

Set a well-formed payload date. The same version fallback described below applies
to registered deliveries, with the requested date in the payload and effective
modeled date in `x-whop-mock-api-version`. Unpinned webhook metadata is preserved
as null, but delivery returns a local 501 because historical unpinned payloads are
not implemented. Events outside dispute/payment/refund are outside this mock's
payload scope. `testable_events` currently lists all modeled v1 event names rather
than just subscriptions; treat that as a fixture choice.

The nine indexed dispute/payment webhook pages omit envelope schemas.
`check:docs` reports that gap; tests validate public resource-data schemas and
SDK signatures but cannot certify complete envelope parity. Local delivery logs
preserve any valid JSON response, including arrays/scalars, although
`WebhookDelivery.response_body` is documented as object-or-null. This discrepancy
is a known mock limitation.
`POST /_test/events` accepts optional `previous_attributes` for an explicitly
captured update; it is omitted when no capture is supplied.

### Evidence inputs

Both `PATCH /disputes/{id}` and `POST /disputes/{id}/upload_evidence` accept
multipart file parts with indexed field names, such as
`evidence[documents][0][document_type]` and `evidence[documents][0][file]` for
PATCH, or `documents[0][document_type]` and `documents[0][file]` for upload.
They use the same evidence replacement and size checks as file-ID references.
The local HTTP multipart body cap is 26 MiB; evidence totals are capped at 25 MiB.

For integrations that already use `direct_upload_id`, bind an opaque synthetic
token to a ready fixture file with `PATCH /_test/files/{id}` and
`{"direct_upload_id":"local_test_blob"}`. That token can then be referenced as
`direct_upload_id`. Real upload tokens are not interchangeable with local
fixture tokens. The five scoped APIs ordinarily use the returned `file_...` ID.

## Start and exercise it

```bash
# Terminal 1: optional demo receiver, or configure your development receiver.
npm run receive:webhooks

# Terminal 2: local API using that receiver.
WHOP_MOCK_WEBHOOK_URL=http://127.0.0.1:4101/webhooks/whop npm run serve:mock

# Terminal 3: resets fixtures and exercises the complete workflow.
npm run smoke:http
```

| Setting | Local value |
| --- | --- |
| API base URL | `http://127.0.0.1:4100/api/v1` |
| Version header | `Api-Version-Date: 2026-10-28` |
| Primary API token | `local_mock_api_test_only` |
| Dispute read-only token | `local_mock_readonly_test_only` |
| Other-merchant token | `local_mock_other_test_only` |
| Primary token without email scope | `local_mock_no_email_test_only` |
| Test-control admin token | `local_mock_admin_test_only` |
| Webhook signing secret | `ws_local_mock_webhook_test_only` |

Send tokens as `Authorization: Bearer <token>`. These are public local fixture
credentials. Use no production credentials here. The read-only profile lacks
dispute/payment write and webhook-management permissions; ordinary authenticated file creation remains allowed,
in this fixture. The two merchant profiles cannot read each other's
payments/disputes. The no-email profile gets null email fields. These grants are
explicit fixtures, not an OAuth or app-installation permission-policy engine.

```bash
curl http://127.0.0.1:4100/api/v1/disputes/dspt_mock_open \
  -H 'Authorization: Bearer local_mock_api_test_only' \
  -H 'Api-Version-Date: 2026-10-28'
```

### API version fallback

The mock accepts any valid calendar date in `YYYY-MM-DD` or `YYYY-MM-DD-N` form
(with a positive release number). Missing headers use `2026-10-28`; malformed or
impossible dates return 400. The closest implemented behavior at or before the
requested date is used, clamped to the oldest/latest model. Current checkpoints
are `2026-10-28`, `2026-11-03-1` and `2026-11-04-1`.

Responses expose `x-whop-mock-requested-api-version` and
`x-whop-mock-api-version` (the effective checkpoint). The connected-account
parameter is `include_connected_accounts` before `2026-11-03-1` and
`include_subaccounts` from that checkpoint. Future dates use the latest model;
older dates use the earliest model, not reconstructed historical payloads.

This fallback is a **mock convenience**. The [public versioning guide](https://docs.whop.com/developer/api/versioning)
says real Whop rejects unknown dates with 400 and resolves missing headers from
the credential's pin or legacy default. A successful mock request does not prove
Whop supports that date. Test-control events default to `2026-10-28`.

The CLI accepts `WHOP_MOCK_PORT`, `WHOP_MOCK_API_TOKEN`,
`WHOP_MOCK_READONLY_TOKEN`, `WHOP_MOCK_OTHER_ACCOUNT_TOKEN`,
`WHOP_MOCK_NO_EMAIL_TOKEN`, `WHOP_MOCK_ADMIN_TOKEN`, `WHOP_MOCK_WEBHOOK_SECRET`
and `WHOP_MOCK_WEBHOOK_URL`. The smoke client accepts `WHOP_MOCK_BASE_URL`
(origin without `/api/v1`) and matching API/admin tokens. Tokens are not logged.
The callback target is configured at startup; requests cannot choose arbitrary
targets. Redirects are not followed.

The smoke walkthrough uploads/downloads a valid synthetic PDF, edits evidence,
submits, simulates acceptance and verifies signed delivery and replay. Its receiver
is a demo. Without a receiver it reports delivery as
`not_configured`, not passed. To test your integration, point your application at this
API and configure its development webhook endpoint as the callback.

After pulling changes to the default fixture names or credentials, restart the
local server and update your client configuration to the values above. Existing
`WHOP_MOCK_*` environment overrides remain available.

## Scenarios and controls

The primary merchant is `biz_mock_primary`, with `pay_mock_primary` for USD 99.99
and a USD 20 refund `rf_mock_partial`. Merchant B is `biz_mock_other`.

| Dispute | Scenario |
| --- | --- |
| `dspt_mock_open` | Editable, awaiting response |
| `dspt_mock_expired` | Past the public evidence deadline |
| `dspt_mock_submitted` | Accepted submission, under review and locked |
| `dspt_mock_won` / `dspt_mock_lost` | Terminal outcomes |
| `dspt_mock_inquiry` | Inquiry awaiting response |
| `dspt_mock_other` | Merchant B's dispute |

The following are test-control endpoints, not Whop API endpoints. Use the admin
Bearer token and JSON bodies. Reset only when the suite has no requests in flight.
Use a separate Node process/port for independent concurrent suites.

| Method/path | Body or result |
| --- | --- |
| `GET /_test/status` | Built-in fixture IDs, all current resource IDs, generation, delivery receipts, parity status |
| `POST /_test/seed` | Import custom account/case JSON and return merchant-scoped test keys |
| `POST /_test/reset` | `{}` clears files, timers, events, idempotency and pending submissions |
| `POST /_test/scenarios` | `{"amount":80,"refund_amount":15,"deliver":true}` creates linked payment/dispute/refund fixtures and a signed created event; `deliver` defaults false |
| `POST /_test/events` | `{"type":"dispute.created","resource_id":"dspt_mock_open","deliver":true}` |
| `POST /_test/events/{id}/deliver` | `{}` manually replays the saved ID and data snapshot |
| `POST /_test/submissions/{id}` | `{"outcome":"accepted"}` or `{"outcome":"rejected"}` after submission |
| `PATCH /_test/disputes/{id}` | `{"status":"won"}` changes a synthetic outcome and schedules an updated event |
| `PATCH /_test/files/{id}` | `{"upload_status":"failed"}`, `processing`, or `ready` |
| `PATCH /_test/payments/{id}` | Simulate status completion and public payment/status fields |
| `PATCH /_test/refunds/{id}` | `{"status":"succeeded"}` completes a pending refund and updates totals |
| `POST /_test/failures` | `{"action":"retrieve_dispute","status":429}` injects one API failure |

For idempotent POST retry tests, the mock handles failures as follows:
429 releases the key; a generic handled 503 is recorded and replayed with the same
key. To model a 503 before execution, add `"phase":"pre_execution"`; its key is
released so the retry can execute. A 500 defaults to `"phase":"unknown"`, leaving
the key in progress and returning 409 on retry. `"phase":"handled"` records a
handled failure. These phases are fixture controls, never production API headers.

Accepted submissions and changed dispute statuses schedule `dispute.updated`
after a one-minute mock delay. That delayed callback is a demo delivery signed
with the server-level secret (see [Webhook signing secrets](#webhook-signing-secrets)). Rejection leaves the dispute
awaiting response. `disputes.accept()` simulates concession for supported
processors and schedules an update. Reset/close clears pending timers. The tests
explicitly accelerate these timers; the service retains its default timing.

Failed webhook requests automatically retry using the mock's delay ladder
(30 seconds, 2 minutes, 8 minutes, 30 minutes, 1 hour, 3 hours, 6 hours, then five
12-hour delays), with 1–10% jitter and a five-second request timeout. This allows
13 attempts. Automatic retries retain the event ID and reload current resource
data. Explicit admin replay retains the old
snapshot to exercise duplicates and out-of-order delivery. Events are signed with
the literal secret bytes and can be checked by `unwrapWebhook` from the real SDK.
Timers and receipts are in memory; restarting loses them.

File creation returns upload URLs and required headers. PUT the bytes without API
authorization. Single-part URLs expire after one hour; multipart part URLs after
15 minutes. Multipart parts use five-MiB chunks and quoted ETags; call
`files.complete()` with ordered part numbers/ETags. Poll GET until `ready`:
the HTTP wrapper simulates `pending → processing → ready` with a 100 ms delay.
Private downloads use signed capability URLs and return exact uploaded bytes;
public files are unsigned until attached as evidence. Reset invalidates old
capabilities. Local download expiry (15 minutes) and the 32 MiB per-PUT cap are
fixture choices, not native storage guarantees.

## Limits and independent evidence

Every `createHttpTestServer()` owns an independent fixture session. Starting,
resetting or closing one server does not affect another server or the in-process
`WhopMock.start()` / `createFetch()` session. Each server is still in memory:
reset it only while its own clients are idle, and restart loses that server's data.

The local tests do not run the real OAuth/permission-policy
engine, S3 processing, PDF parsing/merging/page checks, moderation, generated
responses, processor filing or bank outcomes. File MIME type is inferred from the
fixture filename rather than inspected from bytes. Policy fallback uses explicit
fixture metadata. Seller-file preflight estimates do not cover the generated
response/Dispute Fighter bypasses. Some error messages and URL/timing details are
approximations. New payment creation consumes a seeded request/result pair;
unseeded creation and legacy unpinned webhook delivery return local 501 errors.
Payment search covers seeded names, emails, IDs and card fields. Subscription,
license-key and Discord branches need membership fixtures in the in-process Store
(`stripe_subscription_id`, `license_key`, `discord_account`); the HTTP DTO importer
does not construct external-account relationships or run an external lookup.
The public metadata fields are schema-checked, but full permission-policy
evaluation, processor error catalogs, taxes/fees, foreign-exchange reconciliation,
bank outcomes, production PDF layout and storage scanning costs are
not reproduced. Tests cover representative success/error cases, not every
combination of every field or every production side effect.

The original infrastructure remains the required setup. A separate backend
environment is not needed to run these tests. This local simulator does not
establish availability of a native sandbox dispute-creation API.

If independently captured, synthetic Whop reference responses become available,
the existing comparator can assess the 20 sequences in
[`tests/parity-cases.json`](../../tests/parity-cases.json):

```bash
npm run check:parity -- /path/to/reference.json /path/to/candidate.json
```

The capture structure and validation are in `scripts/check-parity.mjs` and
`tests/parity-check.test.mjs`. It compares complete request/response sequences,
including statuses, selected headers, bodies, nulls and order. Normalize only
explicit environment-specific IDs/timestamps/capability URLs while retaining
relationships and temporal assertions. Never include credentials or customer data.
It rejects mock-vs-mock references and absent scenarios, but trusts declared
provenance. Exit 0 means the declared scope matched, 1 differences, 2 invalid or
missing evidence. No reference run or capture/export runner has been supplied;
this does not block the original local setup or certify an absolute mirror.

Official references: [file lifecycle](https://docs.whop.com/developer/guides/direct-file-uploads),
[asynchronous submission](https://docs.whop.com/api-reference/beta/disputes/submit-dispute),
[webhook signing](https://docs.whop.com/developer/guides/webhooks).
