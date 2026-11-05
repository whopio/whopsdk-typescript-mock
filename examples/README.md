# Integration testing with the current Whop SDK

For an API URL your application can call from any language, see the [local HTTP service](http/README.md).
HTTP users can now [seed their own linked cases from JSON](http/README.md#seed-your-own-dispute-cases).
This page describes the in-process fetch adapter.

Run `npm run test:workflow`. The executable [`dispute-workflow.test.mjs`](dispute-workflow.test.mjs) uses the
real `@whop/sdk@2.7.0` client with the mock's public `fetch` adapter and synthetic
records. All API calls and upload PUTs stay in memory.

The example receives a signed `dispute.created`, retrieves the current dispute,
reads its payment and refunds filtered by `payment_id`/`account_id`, uploads a
small valid synthetic PDF, attaches it to `evidence.uncategorized_attachment`, and
submits. It then explicitly simulates processor acceptance and sends a signed
`dispute.updated`. Concurrent duplicate delivery and an older event cannot cause
a second submission in this demonstration handler.

Replace the example's `receive()` function with your own webhook handler to
test your integration. Its in-memory deduplication Map is a teaching fixture;
production deduplication needs durable atomic storage. It re-reads the dispute
before acting so late events cannot reopen submitted cases.

## Supported scope

| Flow                   | Current adapter behavior                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK connection         | `WhopMock.createFetch()` supplies the SDK's public transport. No private SDK patching and no live network fallback. Default REST date `2026-10-28`; any well-formed date uses the closest modeled behavior (see the HTTP version guide).                                                                          |
| Disputes               | List/retrieve current nested evidence, buyer, payment and account fields; `dspt_` IDs; PATCH evidence; `uploadEvidence` replaces the complete document array; `submit` starts a pending fixture submission.                                       |
| Payment/refund context | List/retrieve; current `Money` objects with major-unit decimal strings; `rf_` IDs; refunds filter by `payment_id` and `account_id`. Seed pending, failed, partial or full refund outcomes with helpers. Payment writes use seeded outcomes; see the complete HTTP guide below. |
| Files                  | Create → synthetic upload URL/headers → PUT bytes through mock fetch → retrieve `ready`; list explicit `file_ids`; private by default and fixture-actor ownership checked.                                                                        |
| Webhooks               | Dispute/payment/refund types use `msg_`, `account_id`, `api_version_date`, current data and Standard Webhooks signatures; verify with `unwrapWebhook` from `@whop/sdk/helpers`. Events and deliveries are explicit test actions.                  |
| Backfill               | Forward and backward keyset pagination (`first`/`after`/`last`/`before`), account/status filters, date bounds and supported sorting. The SDK async iterator terminates on the last page.                                                                    |
| Failures               | Locked evidence returns HTTP 400; missing records return 404; bad documents leave the old packet unchanged. `prepareError(Error, 'retrieve_dispute', { attributes: { status: 429 } })` injects a one-shot SDK-visible HTTP error.                 |

Use one session per test with `start()` / `stop()`. The in-process API has one global
session; do not run cases sharing it concurrently. HTTP servers each own an
independent session and do not reset or stop this global session. A fetch from an ended session rejects. Synchronous event listeners must
explicitly await any asynchronous application work they start.

The old store/helpers are intentionally still available. Their fixture setup
vocabulary can include `company_id`; the current API returns `account_id`.
Helpers create synthetic disputes, not bank chargebacks or a public create-dispute
endpoint. `requester()` and `install()` retain the legacy fixture surface: legacy
dispute actions return the record without changing it, as before. Use `createFetch()`
or the HTTP service to test current evidence mutations and submission behavior.
Unrelated legacy membership webhook examples retain their old envelope unless an
API date is explicitly supplied.

## Evidence and submission details

For a consolidated PDF, the example uses the supported fixed
`uncategorized_attachment` slot. For typed documents, use:

```js
await client.disputes.update({
  id: dispute.id,
  evidence: {
    notes: "Synthetic defense",
    documents: [{ id: readyFile.id, document_type: "digital_fulfillment" }],
  },
});
```

Choose a document type that actually describes the evidence. Supplying
`documents` replaces the whole uploaded-document set; omitting it preserves the
set. Read existing evidence before replacing it if it needs to be retained.
Document uploads allow ten files, up to 10 MiB each and 25 MiB combined. Pending,
missing, attached to another dispute, duplicated, over-limit, and unsupported-type references fail.
Supported document MIME types are PDF, JSON, JPEG, PNG and WebP.

Submission has an additional **modeled processor budget**, separate from upload
limits. For example, the Stripe fixture uses 4 MiB minus a 128 KiB reserve.
Fixture-only `provider` (or `sub_provider` for `multi_psp`) chooses the budget;
unknown providers use that same default. These preflight estimates are local
fixture behavior, not a guarantee of live processor acceptance.

`submit()` leaves an eligible case awaiting a response until the test chooses:

```js
await client.disputes.submit({ id: dispute.id });
WhopMock.completeDisputeSubmission(dispute.id, "accepted"); // or 'rejected'
const event = WhopMock.emitWebhookEvent("dispute.updated", {
  data: { id: dispute.id },
});
const delivery = WhopMock.signWebhook(event, "ws_synthetic_test_secret");
// Invoke your handler with delivery.body (raw JSON) and delivery.headers.
```

Acceptance sets `under_review` (or `warning_under_review`) and
`evidence_submitted_at`. Rejection leaves the record editable and awaiting a
response. Repeating a pending submit is idempotent. After submission, a terminal
state, or the evidence deadline, edits/submission fail with 400. Set
`evidence_due_at` to the **public API deadline**, which already includes Whop's
24-hour lead time; do not subtract it again.

Numeric legacy money fixtures are converted as USD major units. For non-USD
fixtures, provide explicit `{ amount, currency, decimals, display_decimals }`
Money objects; precision and exchange rates are not invented. Other financial
fields, fees, addresses and evidence contents remain explicit synthetic fixtures,
not calculated processor or merchant data.

## Fixture behavior and limits

The adapter now includes explicit fixture scope grants, email redaction,
connected-account search/list constraints, policy fallback, processor reason
normalization, summary counts, multipart files and actor-scoped idempotency.
See `tests/api-behavior.test.mjs` for executable setups. These are in-memory
models of selected API behaviors; they do not evaluate real OAuth tokens, app
installation policies or feature flags.

`createFetch({ actorId, accountId, actorKind, grants })` accepts explicit per-account
scope arrays. The HTTP wrapper supplies primary, read-only, other-account and
no-email fixtures. Files are readable by their creating actor. Evidence attachment
checks the referenced file's readiness and dispute ownership; the mock permits
a known unattached file ID from a different creating actor. Replacing
an evidence set removes detached attachment records; one file occupies one category.

For policy tests, seed the company `_policies` map with ready PDF file IDs under
`cancellation_policy`, `terms_of_service` and `return_policy`. Open disputes refresh
account-derived copies; explicit dispute uploads take precedence. `_whopTerms`
marks a synthetic Whop-terms PDF. The mock does not parse PDF metadata to detect it.
`uploadAllowlist` explicitly selects the optional extension gate; live feature-flag
state is unknown.

The in-process upload finishes immediately. Multipart part sizes, quoted ETags
and completion ordering are checked, but storage is still memory. File URLs here
are placeholders; use the HTTP wrapper for byte downloads and delayed processing.
In-process webhook delivery remains an explicit test action. The HTTP wrapper
adds delayed updates and automatic retries without an external queue.

The five-area adapter now covers 36 operations; see the [complete HTTP guide](http/README.md#complete-current-api-scope)
for payment actions, webhook management, multipart evidence and seed controls.
Unseeded payment creation, legacy unpinned webhook payloads and event data outside
the dispute/payment/refund areas return local 501 errors. The adapter does not parse/merge PDFs, count pages, re-encode images,
moderate uploads or run generated-defense/processor workflows. Preflight estimates
cover the ordinary seller-file path; generated-response/Dispute Fighter bypasses
are not reproduced. Some error wording, storage timing and capability URL details
remain fixture choices. Unknown behavior must not be treated as a successful test.

Explicit non-USD Money objects preserve precision. Partial refunds use the seeded
charge/settlement ratio; no live FX rates or financial balances are queried.
Use `PATCH /_test/refunds/{id}` to complete a pending refund and recalculate its
payment; directly changing an independent Store record still does not. `disputes.accept()` simulates a supported processor conceding the case;
it does not call that processor. Bank outcomes remain explicit fixture inputs.

The original Node/npm/tsx setup and fixture store remain unchanged. There is no
new backend or storage infrastructure to install. Independent production-behavior
verification and your actual application run remain separate from these local
checks.

## Contract sources and verification

Reviewed on November 4, 2026 against the public docs.whop.com references and SDK
2.7.0. The default mock date is `2026-10-28`; the public schema snapshot is dated
`2026-11-04-1`. Run `npm run check:docs` to detect published shape/version drift.

- [Dispute update](https://docs.whop.com/api-reference/beta/disputes/update-dispute), [document upload](https://docs.whop.com/api-reference/beta/disputes/upload-dispute-evidence), [submission](https://docs.whop.com/api-reference/beta/disputes/submit-dispute)
- [Direct file uploads](https://docs.whop.com/developer/guides/direct-file-uploads), [webhooks](https://docs.whop.com/developer/guides/webhooks)

`npm test` retains the exact upstream build and three `tsx` scripts (43 examples).
`npm run test:all` additionally checks current SDK behavior, generated response
schemas, fixture regressions, the dispute workflow example, the optional capture comparator,
and loopback HTTP delivery. Locked evidence mutations return HTTP 400 in the mock. Generated run reports stay local. The old standalone ESLint command still has no configuration;
build and the focused test/audit commands are the maintained checks.
