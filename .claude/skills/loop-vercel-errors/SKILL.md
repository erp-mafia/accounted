---
name: loop-vercel-errors
description: Proactive loop that pulls recent production runtime errors from Vercel (and Sentry if configured), groups + dedupes them, files well-formed GitHub issues, and opens a fix PR only for clearly trivial/safe cases. Use on a schedule (cloud routine) or on-demand via /loop-vercel-errors. Follows dev_docs/loops.md.
---

# loop-vercel-errors

**Goal:** every distinct, real production runtime error is tracked as a GitHub issue (deduped), and the
obviously-trivial ones have a proposed fix PR. **Never merge.** Read `dev_docs/loops.md` first.

Project: Vercel `erp-base` (`prj_zOvCFaOMXS166cUY5VYEGHKke00X`, team `team_WPj3QZgcSVRWZKcHJQB3wfv8`).

## 1. Fetch errors (try sources in order; report which worked)
1. **Vercel MCP** (`mcp__plugin_vercel_vercel__*`) — authenticate if needed, then pull recent runtime
   logs / observability for the production deployment. Prefer this.
2. **Vercel CLI** fallback: `vercel logs <prod-deployment-url> --json` (tails a window) or
   `vercel inspect`. The CLI here is old (v48) — if it errors, note it and move on.
3. **Sentry** (the app ships `@sentry/*`; `SENTRY_DSN` may be set) — if a Sentry token is available,
   its issue stream is richer than Vercel logs. Use it if present.

If **no** source is reachable in this environment, stop and report that clearly (do not invent errors).

## 2. Group into distinct errors
Cluster raw log lines by **signature**: normalized message + top of stack + route. Drop noise
(expected 4xx, aborted requests, health checks). For each cluster capture: signature, first/last seen,
count, sample stack, affected route/file.

## 3. Dedupe (mandatory — see loops.md)
Fingerprint = hash of the normalized signature.
```bash
gh issue list --search "<fingerprint> in:body state:all" --json number,state
```
- Match open → add a comment ("still occurring, N times since <date>"). Do not file a duplicate.
- Match closed but recurring → reopen with a note.
- No match → file new (below). **Cap 8 new issues/run**; log the rest.

## 4. File the issue
```
Title: [prod error] <short normalized message> (<route>)
Labels: loop:auto, loop:vercel, bug
Body:
  **Signature:** …    **Count / window:** …    **First/last seen:** …
  **Route/file:** app/…:line   **Sample stack:** (fenced)
  **Likely cause:** <1–2 lines of hypothesis from the code>
  <!-- loop-fingerprint: <hash> -->
```
Point at the suspected `file:line` by reading the code the stack references.

## 5. Trivial fix only (propose-don't-merge) — cap 2 PRs/run
Open a `loop/vercel-<hash>` fix PR **only** when the cause is unambiguous and low-risk (e.g. a missing
null guard, an unhandled `undefined`, a bad `.env` read with an obvious default, a narrow type fix).
Anything touching bookkeeping/money/migrations/auth → issue only, label `loop:needs-human`.
Every fix must pass the **[`loop-verify`](../loop-verify/SKILL.md)** gate. PR body: `Closes #<issue>`.

## 6. Report
List: new issues filed, existing issues updated, fix PRs opened, sources used, anything skipped.
