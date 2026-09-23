# Provider invoice load and recovery test

Run from the repository root with Node 22 or newer.
No Docker or local database is used. The scripts refuse the production URL and
never load `.env.local`. They create clearly named synthetic companies in the
`erp-base` staging branch (`metjnjrhvujscngnpzdv`). Fixtures remain there for inspection.

## Worker results recorded on 2026-09-19

Both full worker runs passed against staging over HTTP. The providers returned
synthetic responses; the worker, provider clients, local throttling, mappers,
encryption and database RPCs were real. The two volume runs ran concurrently.

| Provider | Invoices | Invoice lines | Total duration | Longest returned worker run | Worker budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| Visma | 25,000 | 75,000 | 14 min 3 sec | 50.183 sec | 60 sec |
| Bokio | 25,000 | 75,000 | 14 min 14 sec | 50.178 sec | 60 sec |

Both jobs completed with zero failed or pending records, correct totals, 250
customers and exactly 25,000 row-completion events. Each recovered from a real
process kill after commit, a lost commit response and a simulated provider 429.
A competing worker could not claim the active lease. The full import duration
exceeds one invocation's budget because progress survives between invocations.

Additional runs passed for each provider: 100 invoices with every detail request
delayed 250 ms; 30 with two-second responses and a 15-second worker budget; and
30 with 1.7-second responses that interrupt a detail fetch at the invocation
boundary. These exposed and verified a fix: exhausting only the remaining
invocation time now leaves the invoice pending for automatic resumption instead
of marking it for manual retry or applying provider-error backoff. The volume
runs picked up this fix in subsequent invocations; the short-budget scenarios
and final smoke tests ran after the fix.

The full unit suite passed 24,239 tests, with 5 skipped. Changed files pass lint,
and the type check reports no new errors. Exact metrics, synthetic fixture IDs
and measurement limits are in
[`results-2026-09-19.json`](./results-2026-09-19.json).

No live provider account, hosted scheduler, deployed function runtime or large
SIE ledger was exercised. The changes are in the feature worktree and are not
deployed. Hosted cron recovery still needs verification after deployment.

PR review follow-up: after requiring explicit encryption keys and removing
name-only party adoption, another 300-invoice worker run passed for each provider
with process termination, lost acknowledgement, rate limiting and exact-count
checks. Each imported 900 lines and 250 customers without duplicates. Results
are in [`results-2026-09-19-pr-review.json`](./results-2026-09-19-pr-review.json).
The staging SQL test also verifies that same-named parties remain separate,
source-ID retries remain stable and register writes cannot target journal tables.

## Results recorded on 2026-09-18

The database-only benchmark passed for both providers:

| Provider | Invoices | Invoice lines | Failed / pending | Slowest commit plus replay |
| --- | ---: | ---: | ---: | ---: |
| Visma | 25,000 | 75,000 | 0 / 0 | 121.927 ms |
| Bokio | 25,000 | 75,000 | 0 / 0 | 185.774 ms |

Every ten-invoice batch was replayed. Both runs finished with 250 customers,
25,000 unique row-completion events, and exactly SEK 9,375,000 in invoice totals.
Synthetic fixture IDs and assertions are recorded in
[`results-2026-09-18.json`](./results-2026-09-18.json).

Separate automated pagination tests passed 25,000 invoices per provider through
the real provider HTTP clients and mappers, with simulated responses and
throttling disabled. Worker deadline regressions passed with stalled database
claims, reads, commits and releases, plus an oversized 2,001-line invoice.

These earlier database-only numbers exclude worker and HTTP timings. See the
2026-09-19 results above for the subsequent worker runs.

## Worker test over HTTP

Create an ignored `.env.provider-load.local` file with the staging values:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://metjnjrhvujscngnpzdv.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<staging service-role key>
```

A Supabase CLI `branches get staging --project-ref pwxtzglxptnnvjrpixpg -o env`
file also works via `--env /path/to/file`, using its `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`/`SERVICE_ROLE_KEY` fields. Keep this file private.

Start with a smoke run:

```bash
node --import tsx --conditions react-server scripts/provider-migration/load-staging.ts --count 30 --budget 15000
```

Then run 25,000 invoices per provider:

```bash
node --import tsx --conditions react-server scripts/provider-migration/load-staging.ts
```

Use `--provider visma` or `--provider bokio` to run one provider. Increase volume
with `--count 50000`. `--budget 60000` is the default invocation budget; use
`--budget 210000` to exercise the production worker ceiling. The harness asserts
that each invocation returns within its budget plus 1.5 seconds of scheduling
allowance. A separate process watchdog fails a stuck run.

The transport returns synthetic Visma/Bokio HTTP payloads. Provider clients,
pagination, local rate limiters, mappers, encryption, consent resolution,
worker code, PostgREST and database RPCs are real. Unexpected outbound hosts
are rejected in worker processes. No real provider account is contacted.

Each provider run tests:

- 25,000 invoices with three lines each, three fiscal years, 250 shared customers,
  and paid/unpaid states.
- Provider HTTP 429 followed by successful retry.
- An actual process kill immediately after a database commit, then a new worker.
- A lost commit acknowledgement and safe replay.
- A competing claim while a worker holds the lease.
- Invoice and line counts, exact header totals, completed receipts, and bounded
  request sizes and worker runtimes, with one row-completion event per invoice.

The 429 is injected once per provider run, including when discovery spans
several worker invocations. Repeating it on every restart could prevent a
short-budget test from ever reaching its first commit.

Only the synthetic job's lease/backoff timestamps are accelerated after injected
failures, so recovery does not wait five minutes. The same claim/fencing RPCs
still control ownership. The SIE prerequisite is a synthetic completed intake
record, with no ledger entries. This test does not validate SIE import, matching
to a large existing ledger, or real provider payload fidelity.

The default list payloads contain complete invoice lines. To include detail
requests and latency:

```bash
node --import tsx --conditions react-server scripts/provider-migration/load-staging.ts --count 25000 --detail-every 10 --delay-ms 100
```

For a Visma-style register requiring detail for every invoice, use
`--provider visma --detail-every 1`. Real client throttling stays enabled, so
25,000 details at ten requests per second require at least about 42 minutes,
before database work. Total job duration can exceed an invocation limit safely;
each invocation must checkpoint and return. The simulated delay does not model
all provider outages or distributed Redis rate-limit contention.

To interrupt detail requests at an invocation boundary and verify automatic
resumption with a small dataset:

```bash
node --import tsx --conditions react-server scripts/provider-migration/load-staging.ts --count 30 --budget 15000 --detail-every 1 --delay-ms 1700
```

An invoice that only exhausts the remaining invocation time stays pending.
It does not need manual retry and does not incur provider-error backoff.
An invoice that exhausts its full 15-second detail allowance still gets an
explicit retry outcome, so one consistently failing invoice cannot stall all
remaining invoices indefinitely.

Results are written after every invocation to `.env.provider-load-report.json`.
The report includes synthetic company/job IDs, elapsed time per invocation,
request counts, maximum database HTTP time and process memory. No credentials
are included. Use a separate `--report` path for each run you want to retain.

## Database-only benchmark through the Supabase app

When HTTP credentials are unavailable:

```bash
node --import tsx --conditions react-server scripts/provider-migration/write-sql-load.ts 25000
```

This only generates `.env.provider-sql-load-plan.json`. Execute each provider's
`seed`, then every `batches` statement in order, then `finish`, using the connected
Supabase app's SQL tool with project ID `metjnjrhvujscngnpzdv`. Do not execute it
on another project. These statements contain no schema changes.

The SQL plan uses the production Visma/Bokio and invoice mappers. It persists
25,000 source receipts, calls the real commit RPC with ten invoices per batch,
replays every batch, finishes follow-up receipts, and asserts invoices, lines,
customers, totals and exactly one row-completion event per invoice. It reports
maximum database time for a commit plus its replay. The database plan does not
execute the worker, HTTP transport, encryption or provider pagination and must
not be presented as an end-to-end timeout test.

## Targeted regressions and other data

```bash
node node_modules/vitest/vitest.mjs run extensions/general/arcim-migration/lib/__tests__ lib/providers/__tests__ lib/providers/visma/__tests__ lib/providers/bokio/__tests__
```

These cover stalled provider/database operations, oversized invoices, failed
individual details, reconnect/account changes, credit notes, invoice numbers,
VAT, payment states and fiscal-year scope. Deadline tests use a controlled clock;
they are separate from measured staging invocation times.

Before release, also run a scrubbed representative source payload from the
original incident, a full 25,000-invoice register requiring every detail, a large existing
SIE ledger with registration references, supplier invoices and settlement,
foreign currencies, mixed VAT rates, missing fields, and reconnect after token
expiry. These are additional integration datasets, not claims about the default
25,000-invoice fixture. Finally verify the deployed cron resumes a job with the
browser closed; a CLI loop cannot prove the hosted scheduler is enabled.
