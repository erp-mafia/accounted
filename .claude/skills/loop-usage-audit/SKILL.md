---
name: loop-usage-audit
description: Monthly loop that measures what nobody uses. Checks every page, API route, extension route, extension workspace and MCP tool against PostHog pageviews, MCP calls in prod event_log and Vercel route hits, joins them with scripts/usage-audit.ts, and posts to its tracking issue the removal candidates (unused for 90 days and in code for over 90 days) and the items only one company used, with what each costs to keep. Proposes only, never deletes code or data. Run LOCALLY (needs the PostHog, Supabase and Vercel MCPs). Use monthly or on demand via /loop-usage-audit. Follows .claude/loops.md.
---

# loop-usage-audit

**Goal:** every surface earns its keep or gets a keep-or-cut decision. Features ship faster than
they get used: in the two weeks to 2026-10-26, 228 API routes and 43 MCP tools were added, and 42% of
the routes added the month before still had no use. The first audit (2026-10-26) found 10 of 158
pages, 271 of 1,067 API routes and 47 of 362 MCP tools with zero use; most were new, seasonal or
dormant by decision, and the rest were removed in !946. This loop makes that a monthly habit
instead of a one-off. Read `.claude/loops.md` first.

> **Run LOCALLY.** It needs three MCPs at once: PostHog (`mcp__posthog__exec`, project 233361),
> Supabase (`execute_sql` on prod `pwxtzglxptnnvjrpixpg`, read-only SQL only) and Vercel
> (`create_observability_query`, team `team_WPj3QZgcSVRWZKcHJQB3wfv8`, project erp-base
> `prj_zOvCFaOMXS166cUY5VYEGHKke00X`). Cloud routines have no PostHog. If any source is
> unreachable, stop and say which: a missing source reads as zero use, the one error this loop must
> never make.

## 1. Due check

The run log is one issue titled `Usage audit log`, labelled `loop:auto` and `loop:usage` (create it
on the first run). Each run ends with a comment that starts `<!-- loop-usage-audit-run: YYYY-MM -->`.
If the current month's marker exists, report "not due" and stop, unless the user invoked
`/loop-usage-audit` explicitly. Save the snapshot JSON from the last two run comments (the
`snapshot.json` block) to files: the join needs them.

## 2. Export the three sources

Use a new directory in the session scratchpad, never the repo: the exports carry company ids.

**Internal users.** Identified internal people are the uuid-v4 distinct ids in PostHog cohort 192723
(`$internal_or_test_user`):

```sql
SELECT arrayStringConcat(groupUniqArray(distinct_id), ',') AS ids
FROM person_distinct_ids
WHERE person_id IN COHORT 192723
  AND match(distinct_id, '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
```

Their companies (`select distinct company_id from company_members where user_id in (...)`) are the
internal companies. Some are real customers the founders help; that only makes the company counts
cautious.

**PostHog, `posthog-pages.json`.** Run with `call --json execute-sql` so the rows come back as JSON:

```sql
SELECT
  replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(properties.$pathname,
    '[0-9a-fA-F]{7,8}-[0-9a-fA-F-]{27,}', '*'), '/[A-Za-z0-9_%.-]{32,}', '/*'), '/[0-9]+(/|$)', '/*$1'), '/+$', '') AS path,
  count() AS views,
  uniqIf($group_0, $group_0 != '' AND person_id NOT IN COHORT 192723) AS companies,
  groupUniqArrayIf(5)($group_0, $group_0 != '' AND person_id NOT IN COHORT 192723) AS company_ids
FROM events
WHERE event = '$pageview'
  AND timestamp >= now() - INTERVAL 90 DAY
  AND properties.$host NOT LIKE 'localhost%' AND properties.$host NOT LIKE '%.vercel.app'
GROUP BY path ORDER BY views DESC LIMIT 2000
```

Write `[{ "path", "views", "companies", "company_ids" }]` (an empty path is `/`). Tokens are 32
characters or more; a shorter cut would also swallow long static segments such as
`forenklat-arsbokslut`.

**event_log, `mcp-tools.json`.** `mcp.tool_called` rows keep 180 days and name the canonical
`gnubok_` tool, also for `accounted_` aliases and calls through the call/stage bridges:

```sql
with internal as (select distinct company_id from company_members where user_id in (<internal ids>))
select data->>'tool' as tool,
       count(*) as calls,
       count(distinct company_id) filter (where company_id not in (select company_id from internal)) as companies,
       (array_agg(distinct company_id) filter (where company_id not in (select company_id from internal)))[1:5] as company_ids
from event_log
where event_type = 'mcp.tool_called' and created_at >= now() - interval '90 days'
group by 1;
```

The result is large: let it land in a tool-results file and turn it into `[{ "tool", "calls",
"companies", "company_ids" }]` with a short script.

**Vercel, `vercel-routes.json`.** `vercel.request.count` grouped by `route`, start 35 days back
(the limit is 36), environment production, granularity `{ "days": 7 }`. The MCP keeps only the
first and last 50 items of every array, so cut the route space into disjoint ranges
(`route ge '/api/a' and route lt '/api/b'`) small enough that each answer's `summary` has at most
100 items, or read a range twice (`orderDirection` asc and desc, limit 100) for up to 200. Check
that the sum of all ranges plus `/_next/` equals the production total; a gap means a range was
truncated. Drop `/_next/`, fold `/api/storage/...` into one `/api/storage/*`. Then split
`/api/extensions/ext/[...path]` (every extension API call) by `request_path`, one week per query
(longer windows time out), with uuids, numbers and long tokens replaced by `*`. This step takes
about 40 queries: hand it to one subagent with these rules and have it write the file. Shape:
`{ "window": { "start", "end" }, "routes": { "<route>": hits }, "extension_paths": { "<path>": hits } }`.

## 3. Join

```bash
npx tsx --conditions react-server scripts/usage-audit.ts <dir> --run YYYY-MM \
  --previous <last-run-snapshot.json> --previous <run-before-snapshot.json>
```

It builds the inventory from the code, applies `keep.json` (next to this file), dates the unused
items with git, and writes `<dir>/report.md` and `<dir>/snapshot.json`. An item is a candidate when
every source that can see it saw nothing, it is over 90 days old, and it is not kept. API and
extension routes are seen only by Vercel's 36 days, so they need three runs in a row ("building
evidence" until then).

## 4. Verify before posting

The script cannot tell rare from dead. For each candidate and each one-company item, check:

1. **Reachable?** Is it linked from the nav, a page, an e-mail or an error message? An unlinked
   page with zero views is dead; a linked one with zero views is a product question.
2. **Seasonal or legal?** Year-end, declarations, the vacation year and ROT/RUT payouts run once a
   year or on Skatteverket's clock. Anything under BFL retention or a filing duty stays.
3. **Dormant by decision?** `grep -ri "<topic>" docs/decisions` and the open MRs and crm tickets
   (`glab mr list`): a switched-off feature or an MR in flight is not a candidate.
4. **Shared?** Deleting a route can orphan or break a component, helper or test another page
   uses. Name what else would go with it.
5. **Single company:** is that company internal, a pilot, or a paying customer who would lose
   something?

Classify each as **remove** (with what goes and what stays), **keep** (propose a `keep.json`
entry with the reason, and `until` for seasonal or dormant items, in a `loop/usage-audit-YYYY-MM`
MR) or **unclear** (for the founders).

## 5. Post the run

Comment on the tracking issue: the marker line, the summary table, the candidates with evidence,
date and cost, the one-company items, what changed since the last run (new candidates, items back
in use), and `snapshot.json` in a collapsed `<details>` block. At most 15 candidates per run; say
how many were left out. Never delete code, data or the issue history: a removal is an ordinary MR
after a founder says yes.

## Pitfalls

- Since 2026-10-22 PostHog runs only for signed-in people with analytics on; public, token and
  auth pages are invisible to it, so Vercel decides those.
- Vercel route hits include bots and Next.js link prefetches. A handful of hits is not use, but
  zero hits is no use.
- The calendar extension looked unused in the first audit, but its switch also turns on the iCal
  feed (38,000 requests in 36 days). Read what an extension id gates before proposing it.
- Files moved under `src/` on 2026-09-22; the script dates across both layouts, `git log` by hand
  on the new path alone does not.
