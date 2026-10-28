# Request latency measurement (auth proxy + route wrapper)

Why this exists: a customer reported that "it takes time before all fields load when clicking around" (2026-08-26). The API handlers themselves are fast (p50 38 ms); the cost is the number of sequential calls a page makes and the fixed per-request tax in front of each one (auth proxy + route wrapper). This page is the protocol for measuring that tax before and after every change in the responsiveness plan, so no PR claims a win without a number.

## What is instrumented

| Surface | Where | Header | Log line |
|---|---|---|---|
| Auth proxy (every page, RSC, prefetch, `/api` request) | `lib/supabase/middleware.ts` via `lib/supabase/proxy-timing.ts` | `Server-Timing: mw-auth, mw-session, mw-company, mw-mfa, mw-total` on page/RSC/prefetch responses; `X-Proxy-Timing` (same value) on `/api` responses | `proxy completed` (not for an `/api` call without a session cookie: Bearer, cron, webhook; the route's own line covers those) with `kind` (`page`, `rsc`, `prefetch`, `api`), `route` (ids and tokens collapsed), `status`, `authMs`, `sessionMs`, `companyMs`, `mfaMs`, `totalMs` |
| Route wrapper (`withRouteContext`, 367 of 529 routes) | `lib/api/with-route-context.ts` | `Server-Timing: auth, company, handler` | `op completed` with `operation`, `status`, `durationMs`, `authMs`, `companyMs`, `handlerMs` |
| Browser | `@vercel/speed-insights` mounted in `app/layout.tsx` | n/a | Vercel dashboard > Speed Insights > Routes (p75 TTFB, FCP, LCP, INP, CLS per route) |

Phase meanings for the proxy: `authMs` = `supabase.auth.getUser()` (a network call to Supabase Auth); `sessionMs` = session-timeout cookie state (`getClaims`, HMAC verify, `auto_logout` read when re-minting); `companyMs` = `resolve_active_company` RPC including the write-back on fallback; `mfaMs` = assurance-level check plus `listFactors()` (a second network call) on the enforced-MFA path.

## Reading the numbers

Percentiles per route from production logs (the `vercel` CLI is linked to the project; `--limit` defaults to 100, raise it):

```bash
# route wrapper, grouped by operation
vercel logs --environment production --since 24h --limit 1000 --json --query "op completed" \
  | npx tsx scripts/perf/log-percentiles.ts --field durationMs,authMs,companyMs,handlerMs --group operation

# auth proxy, grouped by request kind and route
vercel logs --environment production --since 24h --limit 1000 --json --query "proxy completed" \
  | npx tsx scripts/perf/log-percentiles.ts --field totalMs,authMs,sessionMs,companyMs,mfaMs --group kind,route

# auth proxy, one row per kind (the headline fixed cost)
vercel logs --environment production --since 24h --limit 1000 --json --query "proxy completed" \
  | npx tsx scripts/perf/log-percentiles.ts --field totalMs,authMs,companyMs,mfaMs --group kind
```

If `--limit` above 100 is not honoured by the installed CLI, loop `--since`/`--until` windows and concatenate before piping. The Vercel MCP `get_runtime_logs` tool (`group_by: route`) gives request counts per route, not percentiles; use it for prefetch volume (`kind=prefetch` per page load).

In the browser: DevTools > Network, pick a document or `_rsc` request, Timing tab, the `mw-*` metrics show the proxy phases; `/api` responses show `auth`/`company`/`handler` from the route wrapper and the proxy numbers in the `X-Proxy-Timing` response header.

Request count per interaction (the number that maps to "fields load late"), in the console after each action on a production build (`next build && next start`):

```js
performance.getEntriesByType('resource')
  .filter((r) => /\/api\/|\/rest\/v1\//.test(r.name))
  .map((r) => `${Math.round(r.startTime)} ${Math.round(r.duration)}ms ${r.name}`)
```

Interactions to record every time: `/transactions` soft navigation; open Bokför on a row; `/bookkeeping` then Nytt verifikat; `/invoices` then Ny faktura; `/reports`; `/supplier-invoices/new`; a list row to its detail page on customers and invoices. Note the request count and how many dependent rounds (start times that wait on an earlier response).

## Targets (p75 unless stated)

| Metric | Target | Why |
|---|---|---|
| Proxy `page`/`rsc` totalMs | p50 < 40 ms, p90 < 100 ms | Two parallel DB waves at most, no auth network call |
| Proxy `api` totalMs | p50 < 5 ms | Local JWT verification only |
| Route wrapper auth + company | p50 < 45 ms (read), same for write | One company resolution per call, never two |
| TTFB (hard load) | < 400 ms | Layout on two DB waves |
| LCP | < 1.5 s | |
| INP | < 200 ms | The metric "clicking around" maps to |
| Reference-data requests per form open | 0 blocking | Seeded and cached client-side |

## Protocol per PR

1. Before merging: record the current numbers for the interactions above on a production build, and the last 24 h of `proxy completed` / `op completed` percentiles, in the PR description.
2. 24 h after the production deploy: re-run the same three commands and the same interactions; append one row per PR to the table below.
3. A PR that claims a latency win without a before/after row is not done.

## Baseline and results

| Date | Change | Proxy page p50/p90 | Proxy api p50/p90 | Route auth+company p50 | Notes |
|---|---|---|---|---|---|
| 2026-08-26 | Route wrapper only (proxy unmeasured) | n/a | n/a | 44 ms (auth 3, company 41) | 100-call sample; handler p50 38 ms, total p50 96 ms, p90 274 ms |
| 2026-10-24 | Reports on the ledger summaries (!821, !822), opening balances on them (!845), huvudbok page boundary (!848) | ~52/75 ms (100-line sample) | 35/83 ms (n=62, /api/reports) | 30 ms (auth 3, company 27; document.counts n=94) | Prod EXPLAIN as the largest company's user (154 000 verifikat): compute_prior_opening_balances 7 310 ms before, 32 ms warm / 225 ms cold after; a huvudbok page of 2440 2 613 ms cold before, 23 ms warm after. Vercel function p50 the week before: trial-balance 167, kpi 284, balansrapport 315, resultatrapport 341 ms; Hem (/index) 47 ms, p95 904. Speed Insights p75 LCP: Hem 1.8 s, /reports/[slug] 2.5 s. Posting (commit_journal_entry, edge logs) p50 20 -> 22, p95 35 -> 44 ms. |

## Report benchmark (`scripts/perf/bench`)

Why this exists: the work that brought every report under 200 ms p95 for a company with 50 000 verifikat a year (!821, !822, !823, 2026-10-23) was measured with a harness that lived in a session scratchpad and was lost with it. This is that instrument in the repository, with budgets and a scheduled CI job, so a later change cannot make a report slow again without a red job saying which call.

It times the database side only: each report RPC the app calls, with the arguments the app passes (`cases.ts`, traced from the call sites), and the posting path (`commit_journal_entry` on a draft made the way `src/lib/bookkeeping/engine.ts` makes one). The auth proxy and the route wrapper add 50 to 90 ms per request in production (see above), and one report request can make several of these calls, so a DB budget of about 100 ms per call is what keeps a request under 200 ms.

### What it runs against

`setup-db.sh` replays every migration into an empty `supabase/postgres:17` (prod runs 17; pg-real still uses the 15 image), then `seed.sql` builds:

| Company | Shape |
|---|---|
| Prestanda AB, the measured one | 2024 and 2025 closed and locked, 2026 open up to the bench day 2026-10-22; 50 000 verifikat a year (150 000), about 455 000 lines, about 225 accounts, dimension tags on about 26 % of the lines; invoices and payments, supplier invoices with documents, bank lines (booked, and an unbooked queue in September and October), receipts, payroll, storno chains, monthly VAT settlements, year-end closings, and the audit rows those leave. Like the largest companies in production, no year has a linked IB verifikat, so every report reads its IB through `compute_prior_opening_balances`. |
| Bygget AB | The same generator at 7 000 a year: what mixed mode rebuilds onto the ledger summaries while the readers run. |
| 6 background tenants | Copies of the measured company under other ids, so the measured company is about 14 % of the shared tables (the largest in production is about 7 %) and a query that loses its company filter reads other companies' rows. Not built onto the summaries: nothing reads them. |

The seed is deterministic: ids are md5 of fixed keys and every `random()` follows `setseed()`. It writes posted rows directly with triggers off (only on a throwaway database; see the warning in `seed-company.sql`), builds the two companies onto the summaries with `build_ledger_account_days`, checks that every verifikat balances and that `ledger_account_days_drift` is empty, then runs `VACUUM (ANALYZE)`. Smaller runs: `BENCH_SEED_ARGS="-v per_year=5000 -v bg_tenants=0"`.

### Running it locally

Caps like prod's compute (Supabase Large: 2 vCPU, 8 GB, `shared_buffers` 2 GB, `work_mem` 12 MB):

```bash
docker run -d --name accounted-bench-pg17 --cpus 2 --memory 8g -p 127.0.0.1:55917:5432 \
  -e POSTGRES_PASSWORD=postgres -v "$PWD:/repo:ro" supabase/postgres:17.6.1.136 \
  postgres -D /etc/postgresql -c shared_buffers=2GB -c work_mem=12MB -c max_connections=160 \
  -c effective_cache_size=6GB -c dynamic_shared_memory_type=mmap
docker exec -w /repo accounted-bench-pg17 sh scripts/perf/bench/setup-db.sh   # migrations and seed, about 6 minutes

npx tsx scripts/perf/bench/run.ts --mode warm
npx tsx scripts/perf/bench/run.ts --mode cold --container accounted-bench-pg17
npx tsx scripts/perf/bench/run.ts --mode mixed

docker rm -f accounted-bench-pg17
```

The runner connects to `BENCH_DATABASE_URL` (default `postgresql://postgres:postgres@127.0.0.1:55917/postgres`). `dynamic_shared_memory_type=mmap` because a container's `/dev/shm` is 64 MB, which parallel queries outgrow under load. The runner posts verifikat into the measured company, so run warm before mixed, and seed again rather than compare runs from a database a mixed run has written to.

### Modes

- **warm**: one connection; each case gets 3 warm-up calls, then 30 measured ones (`--runs`, `--warmup`). Cases marked `heavy` in `cases.ts` (known to take most of a second or more: the whole-year behandlingshistorik) get 5.
- **cold**: for each sample the container is restarted (`docker restart <name>`, the exact name from `--container`), a fresh connection is opened and the case is called once (`--runs`, default 3). That empties shared buffers, the plan caches and the catalog caches. It does not empty the kernel's page cache, which survives a container restart, so cold means cold Postgres on a warm disk cache, the state right after a Postgres restart on the same machine. After a failover, or once the page cache has dropped a company's pages, reads come from disk and are slower still. Without `--container` it only opens a fresh connection per sample, and says so. CI cannot restart its service container, so CI does not run cold.
- **mixed**: `--readers` connections (default 2, as many as prod's vCPUs, so the readers interfere without queueing for a CPU) each run every case `--rounds` times (default 15, so 30 samples a case) in their own shuffled order, while one connection posts 3-line verifikat into the measured company (`--post-rate`, default 10 a second) and one rebuilds Bygget AB's summaries in a loop (`--build-pause-ms` between builds, default 2 000), as the build cron does on its daytime runs. More readers than CPUs measures queueing for a CPU rather than the interference this mode is for. The posting loop's `commit_journal_entry` times are the mixed row for the posting case. Afterwards `ledger_account_days_drift` must be empty for both companies, which checks that the triggers kept the summaries in step with every posting. Heavy cases are left out so they do not set the load.

Each call is made the way PostgREST makes it for `supabase.rpc()`: its own transaction, role `authenticated` with `request.jwt.claims` for the company's owner (so RLS applies as in production), the role's `statement_timeout` (8 s), the `pre_request_statement_timeout` hook, named arguments, the result serialised to JSON in the database and capped at 1 000 rows like Supabase's max-rows. The time is the client's wall time for that one statement, so database time plus one local round trip.

### Reading the output

```
report bench: mode warm, PostgreSQL 17.6, shared_buffers 2GB, work_mem 12MB, jit on; 30 runs after 3 warm-up
case                                             n     p50     p95     max     kB   (ms)
tb.ytd.include                                  30     7.5     9.3     9.3     18
```

One row per case: `n` samples, then p50, p95 and max in milliseconds (nearest rank, as `log-percentiles.ts`), and the size of one JSON answer in kB. The case id says what is called (`tb.ytd.include` is the trial balance from 1 January to today in the open year, closing mode `include`); `cases.ts` gives each case's RPC, arguments and the reports that make the call (`usedBy`), and `--out <file>` writes all of it as JSON. A line `over 200 ms p95` lists the cases that alone take a request past the end-to-end target. `--filter <regexp>` runs a subset.

A call that hits the statement timeout is made once more, and the repeat is shown on its row; a call that fails twice, or fails otherwise, is counted rather than timed, shown on its row, and fails the run. `--check` compares each p95 with `budgets.json` for the mode and exits 1 when one is over, or when a case has no budget. A change that makes a call legitimately more expensive updates its budget in the same merge request, with the before and after numbers in the description. A new case needs a budget for warm and mixed: `scripts/__tests__/perf-bench.test.ts` fails in the unit suite of every merge request on a case without one, or a budget without a case.

Absolute numbers depend on the machine: compare runs on the same host, and treat a busy host (other containers, a build) as noise. The CI runner is not capped at 2 CPUs and runs other jobs beside this one, so its numbers are not the local ones; the budgets leave room for both (see `budgets.json`).

### In CI

The `perf-reports` job (`.gitlab-ci.yml`) does the same on the group's runner: the 17 image as a service with the same settings, `setup-db.sh`, then warm and mixed with `--check`, about 9 minutes (replay 75 s, seed 4 minutes, warm 95 s, mixed 50 s). It runs in a scheduled pipeline when `PERF_REPORTS` is `1`, and as a manual job in a pipeline started from Build > Pipelines > Run pipeline; never in merge request or main pipelines. The project allows no pipeline variables (Settings > CI/CD > Variables, minimum role `no_one_allowed`), so a schedule cannot set `PERF_REPORTS` itself: it is a project CI/CD variable, and deleting it pauses the scheduled benchmark. Both result files are kept as job artifacts for 90 days. Schedule it when the runner is otherwise idle, daily at 03:00 Europe/Stockholm (`0 3 * * *`): beside a whole merge request pipeline (build, four unit-test shards, pg-real) one call of the whole-year behandlingshistorik has stalled past the 8 s statement timeout.

Not covered: reports with no RPC of their own (lönejournal, systemdokumentation, OSS-underlag), file exports (SIE, XLSX, PDF, the full archive), the reports of other legal forms (NE-bilaga, förenklat årsbokslut, INK3) and on-demand drill-downs other than the ones in `cases.ts`.
