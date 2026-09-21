# Observed-party timeout benchmark

The scripts are restricted to the erp-base staging branch. Use Node 22 and an
explicit private env file containing `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY` and the staging pooler's `POSTGRES_URL`. Do not use
the production `.env.local`.

```sh
node --import tsx --conditions react-server scripts/parties/seed-observed-benchmark.ts <staging-env>
node --import tsx --conditions react-server scripts/parties/benchmark-observed.ts <staging-env>
node --import tsx --conditions react-server scripts/parties/benchmark-observed.ts <staging-env> --flows
```

The seed creates a synthetic user/company and imports 100,000 vouchers through
the existing SIE worker and bookkeeping engine. Re-running resumes the recorded
jobs. It retains the posted history. Keep the ignored, private
`.env.observed-fixture.json` to reuse the fixture; it contains credentials and
must never be committed.

The fixture spans 2025 and 2026, with 1,500 supplier names, repeated descriptions,
invoice references, 350 dates per year, balance-only vouchers, revenues, mixed
expense accounts and VAT lines. Its 25,750 distinct raw descriptions make it more
favorable to deduplication than the real large-import case. The read-only
production measurement below covers a mostly-unique-description dataset.

The benchmark runs five authenticated HTTP requests for each history window,
then three concurrent all-history/12-month pairs. These retain the eight-second
PostgREST limit. It compares the full JSON result against the immutable original
SQL in one repeatable-read authenticated transaction, including the existing
1,000-key cap. Only this old-query comparison has a longer diagnostic timeout.
The ignored `.env.observed-benchmark.json` contains timings and parity hashes.
`--flows` additionally writes suggestions for the synthetic company, reads the
register and calls the document-evidence RPC.

## Investigation, 2026-09-21

The old authenticated function reproduced SQLSTATE 57014 at eight seconds.
Plans showed normalization repeated around line joins, a second line scan for
dominant accounts, and per-line RLS work. Materializing eligible vouchers alone
helped, but reusing their result-account lines and enriching only ranked keys
was faster. An account-number range uses the existing entry/account index to
exclude balance-sheet lines before RLS; exact regexes still determine which
lines contribute.

A read-only authenticated `EXPLAIN (ANALYZE, BUFFERS)` against the real
100,474-entry dataset, with 95,948 descriptions and 302,137 lines, measured the
candidate at 6.29 seconds and the final indexed-range query at 5.35 seconds.
The production function, data, RLS and timeout were unchanged. This single
query measurement does not establish a latency percentile or whole-flow
reliability under production concurrency.

The completed staging fixture has 100,000 entries, 25,750 descriptions and
360,000 lines. After restoring staging's existing parties migrations and current
normalizer, all 16 authenticated HTTP calls succeeded under the unchanged
eight-second database limit:

| Window | Serial HTTP, five runs | Concurrent HTTP, three pairs | Original SQL, one parity run |
| --- | --- | --- | --- |
| All history | 4.305 to 4.708 s | 4.793 to 5.075 s | 29.145 s |
| Since 2025-09-21 | 3.283 to 3.458 s | 3.262 to 3.852 s | 18.629 s |

Each concurrent pair requests both windows. Old and new full JSON results
matched exactly for both windows, with 1,000 keys each. The original timings
use a direct diagnostic SQL connection with the longer timeout; new timings
include HTTP overhead. These are a small sample, not latency percentiles.

A later pre-merge rerun had six SQLSTATE 57014 timeouts in 16 HTTP requests,
including five of six concurrent requests. The installed SQL still matched the
migration. Direct comparisons found no material improvement from lateral line
aggregation or narrower intermediate rows, and full versus minimal JWT claims
had comparable timings. The cause of the latency variation was not established.

With the same SQL, the next complete run passed all 16 requests: all-history
serial reads took 4.034 to 4.404 s, 12-month reads took 3.106 to 3.212 s, and the
slowest concurrent request took 4.616 s. Full old/new JSON matched again for both
windows. The parity script now sets both JWT claim formats and asserts the
fixture's `auth.uid()` before querying. Preserve the failed run as a reliability
limitation; successful samples do not establish that timeouts cannot recur.

## Complete-flow validation

The approved staging-only legacy fixture cleanup unblocked replay of the
existing parties migrations. Their SQL and original version numbers were
preserved; no prerequisite migration file was changed. Both relevant pg test
files now pass: 33 observed-party/normalizer tests and 12 suggestion tests.

The first authenticated suggestion run created 1,000 suggestions and 3,000
facts in 12.874 seconds across multiple database requests. The following
all-history register read returned 1,000 rows in 4.451 seconds. The document
evidence RPC completed in 36 ms with no documents in this import fixture;
document extraction cases are covered by the suggestion pg tests.

Browser verification used the normal Turbopack dev server, the staging fixture
account and the existing Read new action. The page rendered 1,000 rows and
statistics without a browser error. Repeat POST /api/parties/suggest calls
returned 200, attached the existing 1,000 suggestions and created no duplicates;
the final call took 7.544 seconds and its list reload took 3.530 seconds.

Aborting one refresh endpoint showed the partial-failure message; aborting both
showed the failure message. After removing interception, a successful repeat
showed the genuine zero-new-results message. The list reloaded after each
outcome, including attachment-only updates. The bank resolver was disabled
because this fixture tests imported ledger observations, without bank strings
or AI calls. The earlier webpack-only branding error did not occur with
Turbopack; no branding code was changed.

The migration is applied to staging only. Production rollout remains separate
from these tests and requires approval.
