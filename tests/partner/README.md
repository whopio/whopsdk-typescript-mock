# Partner integration simulations

Three independent Node clients simulate a dispute-handling integration.
Each runs in a separate Node process with its own fixture store and loopback
port. No partner application code, real merchant data or production Whop
endpoints are used.

After fixture review and fixes, all **48 distinct partner checks** passed:

| Role | Client | Checks | Coverage |
| --- | --- | ---: | --- |
| Evidence worker | Current Whop SDK and HTTP | 14 | PDF bytes, processing, replacement/rollback, document order, multipart, filing and recovery |
| Webhook/reliability | SDK receiver, separate API child, local file journal | 15 | Signatures, duplicates, lost acknowledgements, stale events, recovery, case concurrency and idempotency |
| Fixture author | Raw HTTP | 19 | User-authored cases, USD/JPY/EUR/COP/KWD precision, refunds, nullable fields, atomic imports and reset |

An additional six root-authored HTTP checks in `tests/partner-contract.test.mjs`
verify modeled acceptance/filing error codes and terminal-state protection. Their
fixed expectations describe local fixture behavior; they do not establish live parity.
Generated reports remain local and are not committed.
Repeated runs are not additional checks.

## Run with the existing setup

```bash
npm ci
npm test                  # exact original command and three original files
npm run test:all          # all Node regressions, including the 48 Node partner checks
npm run test:partners     # just the 48 Node partner checks
```

The partner command starts and closes its own isolated servers on ephemeral
ports. It does not touch the shared service on 4100/4101. No extra service,
database, Docker environment, dependency installation or real API key is needed.
The reliability client's file journal is synthetic partner-side test state in
an OS temporary directory; server persistence is still the original in-memory store.

To retain all Node client receipts in one ignored local directory:

```bash
PARTNER_RESULTS_DIR=test-results/mock OUTPUT_DIR=test-results/mock npm run test:partners
```

Buyer/refund backfills and dispute-to-payment lookups also have Node regression
coverage in `tests/dispute-platform.test.mjs`.

## Interpretation and boundaries

These clients exercise the local HTTP service and installed SDK against public
API shapes and explicit seeded expectations. The public references are linked in
the [HTTP guide](../../examples/http/README.md). The S3 rule rejecting parts after multipart completion comes from
[AWS UploadPart documentation](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UploadPart.html).
None of these results is a trace captured from an executing Whop backend.

The regression expectations preserve several fixture choices:
email search does not necessarily fail without email scope; expired inquiry status
filters use raw stored statuses; typed policy evidence does not remove the fixed
policy from readback; and instrument card facts may coexist with null legacy
card snapshot fields. Generated reports remain local.

DTO-only imports assume no buyer fees, require explicit cross-currency refund
amounts, and let authors specify cached payment substatuses. The real permission
engine, storage/PDF processing, processor filing, bank decisions and your
application still need their own integration verification. The local platform
continues to report `backend_parity: "unverified"`.
