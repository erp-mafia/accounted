# Request latency measurement (auth proxy + route wrapper)

Why this exists: a customer reported that "it takes time before all fields load when clicking around" (2026-08-26). The API handlers themselves are fast (p50 38 ms); the cost is the number of sequential calls a page makes and the fixed per-request tax in front of each one (auth proxy + route wrapper). This page is the protocol for measuring that tax before and after every change in the responsiveness plan, so no PR claims a win without a number.

## What is instrumented

| Surface | Where | Header | Log line |
|---|---|---|---|
| Auth proxy (every page, RSC, prefetch, `/api` request) | `lib/supabase/middleware.ts` via `lib/supabase/proxy-timing.ts` | `Server-Timing: mw-auth, mw-session, mw-company, mw-mfa, mw-total` on page/RSC/prefetch responses; `X-Proxy-Timing` (same value) on `/api` responses | `proxy completed` with `kind` (`page`, `rsc`, `prefetch`, `api`), `route` (ids and tokens collapsed), `status`, `authMs`, `sessionMs`, `companyMs`, `mfaMs`, `totalMs` |
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
