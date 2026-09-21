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
favorable to deduplication than the real large-import case. That limitation needs
an additional mostly-unique-description measurement.

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
360,000 lines. All 16 authenticated HTTP calls succeeded under the unchanged
eight-second database limit:

| Window | Serial HTTP, five runs | Concurrent HTTP, three pairs | Original SQL, one parity run |
| --- | --- | --- | --- |
| All history | 4.177 to 5.828 s | 4.174 to 5.704 s | 24.965 s |
| Since 2025-09-21 | 3.172 to 3.470 s | 3.150 to 5.305 s | 15.534 s |

Each concurrent pair requests both windows. Old and new full JSON results
matched exactly for both windows, with 1,000 keys each. The original timings
use a direct diagnostic SQL connection with the longer timeout; new timings
include HTTP overhead. These are a small sample, not latency percentiles.

## Validation limits

Staging has the older SQL `ledger_key` definition and is missing the parties
tables and evidence RPC. Restoring the existing parties migration fails on an
invalid legacy fixture value. The observed-party tests pass; the complete test
file retains one pre-existing SQL/TypeScript ledger-key parity failure on this
staging schema. Full register/refresh verification needs those prerequisites.

Browser verification also encountered an existing `process is not defined`
error in `lib/branding/service.ts` under the local webpack dev server. The
refresh success, partial failure and total failure outcomes have unit coverage;
the browser flow is not yet verified.
