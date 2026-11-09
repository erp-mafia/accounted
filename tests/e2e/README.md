# Browser and latency tests

The suite uses Playwright Chromium, a production build, and an isolated Podman
Supabase stack. It measures navigation until the page displays its actual data,
and interactions until the resulting UI state is visible. A separate startup
project measures the first authenticated request with a 5000 ms deadline.
Dependent desktop/mobile projects then enforce a 3000 ms navigation deadline
and a 1000 ms interaction deadline. There are no retries.
An exceeded deadline fails the test and the command exits unsuccessfully.

## Run

Install the locked dependencies and the browser once.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

Linux, Node.js 22 or later and rootless Podman must be available. CI uses Node.js 26, matching
the self-hosted development runtime. The stack uses loopback ports 54331 and 3101, and a
checkout-specific resource prefix. Other Supabase installations are independent.
Image tags are pinned in `scripts/e2e/stack.mjs`.
The production build uses an 8 GiB V8 heap limit, matching the repository's
typecheck tooling. The application server uses a 4 GiB limit.

```sh
npm run test:e2e:prepare                  # Stack, migrations, fixture, production build
npm run test:e2e:check -- --project=desktop # Rerun against that prepared build
npm run test:e2e:check -- --headed        # Explore with visible Chromium
npm run test:e2e:reset                    # Recreate only this checkout's owned stack
npm run test:e2e:down                     # Remove that stack and generated credentials
npx playwright show-report
```

`test:e2e` rebuilds the current source and refreshes the browser session each time.
`test:e2e:check` refreshes the session but deliberately tests the existing build.
The database stays available between runs. To start over, use `test:e2e:reset`.
An interrupted seed can resume by rerunning. Deterministic registry keys and
the document archive's idempotency support preserve already-created records.

## Synthetic database

The generator takes no customer export or production connection string. It
creates ten consecutive years ending in the year of the first seed, 3225 posted
vouchers, the full BAS reference chart, six customers, 50 suppliers, 50 customer
invoices, 450 supplier invoices, 100 articles, 500 bank transactions and 1400
real synthetic PDF attachments in Storage. More than 90 accounts have postings
in the latest year. A historical equity account has zero balance and no current-year
vouchers, exercising the inactive-account filter. Two current invoices are unpaid and
due the following January. Names and contact addresses are invented and use
`example.invalid`. The profile approximates a small company's data volume.

Journal entries go through the SIE worker and bookkeeping engine. Historical
invoice registers link to those posted vouchers without posting them twice.
This fixture exercises UI and volume. It does not model annual closing or tax
filing scenarios. The generator is deterministic for a given ending year.

The runner replays the existing migration history and the repository's CI
bootstrap. It preserves migration-specific grants and revocations. Auth,
PostgREST, Realtime, Storage and the database are real services. Financial APIs are not
mocked in the performance suite.

All state, generated credentials, the source snapshot, server/build logs and JSON
timings are under ignored `.e2e/`. Playwright traces and screenshots are retained
on failure under ignored `test-results/`. Reports are under `playwright-report/`.
The source snapshot excludes `.env*` and `deploy/`, and the app receives an
explicit environment containing only generated test credentials. Test tools
reject non-loopback endpoints and refuse to reset containers without this
checkout's ownership label. No script loads `.env.local`.

The Browser performance workflow runs the complete setup and both browser
projects on pull requests. It uploads only the synthetic browser report,
failure traces/screenshots and result timings. Runtime state and key files are
excluded from uploaded artifacts.

Desktop and mobile projects cover data-loaded registers, bookkeeping, reports,
full-chart search, supplier search/detail, ledger folding/filtering, client-side
navigation, transaction history, import selection and password login. Each test
starts with a fresh browser context. An uncaught browser exception, failed
database/auth request, failed Realtime socket or application API 5xx fails the
test as well.

Skatteverket is disabled in the isolated preset. Its two status/transaction
reads may return 503 only with the explicit `EXTENSION_DISABLED` code. The
report records that expected integration state. Other server errors still fail.

The GUI integration cases run when the companion navigation/ledger UI module is
present in the checkout. The performance PR can run its core navigation suite
independently; the combined branch also exercises the GUI PR's folding, mobile
headers and nested menu behavior.
