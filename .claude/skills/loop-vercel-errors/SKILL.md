---
name: loop-vercel-errors
description: Loop that pulls recent production runtime errors from Vercel (via the Vercel MCP locally, or the Vercel API with a token), groups + dedupes them, files well-formed GitHub issues, and opens a fix PR only for clearly trivial/safe cases. Best run LOCALLY (the Vercel MCP is available there). Follows .claude/loops.md.
---

# loop-vercel-errors

**Goal:** every distinct, real production runtime error is tracked as a GitHub issue (deduped), and the
obviously-trivial ones have a proposed fix PR. **Never merge.** Read `.claude/loops.md` first.

Vercel project `erp-base` (`prj_zOvCFaOMXS166cUY5VYEGHKke00X`, team `team_WPj3QZgcSVRWZKcHJQB3wfv8`).

> **No error-aggregation service is wired up** (Sentry is NOT used: no `@sentry/*`, no config, despite
> leftover `SENTRY_*` names in `.env.local`/CLAUDE.md). The only source is **Vercel's own runtime logs /
> observability**, which have short retention: this loop sees a *recent window*, not full history.
> **Run it LOCALLY** so the Vercel MCP is available; the cloud routine is disabled (see step 1).

## 1. Fetch errors from Vercel
1. **Vercel MCP (primary, local runs):** `mcp__plugin_vercel_vercel__*`: authenticate if needed, then
   list recent **production** deployments and pull runtime logs / observability / error events. This is
   the clean path and is only present in a LOCAL session.
2. **Vercel API (if a token exists):** with a `VERCEL_TOKEN` (from vercel.com/account/tokens),
   ```bash
   curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
     "https://api.vercel.com/v6/deployments?projectId=prj_zOvCFaOMXS166cUY5VYEGHKke00X&teamId=team_WPj3QZgcSVRWZKcHJQB3wfv8&limit=5&target=production"
   # then pull runtime logs for the latest prod deployment id
   ```
   This is the only path that works in a **cloud** routine, and only if `VERCEL_TOKEN` is set as a
   secret on the cloud env. `VERCEL_OIDC_TOKEN` in `.env.local` is short-lived and NOT a usable API token.
3. **Vercel CLI last resort:** `vercel logs <prod-deployment-url> --json` (v48 here; only a live tail).

If **no** source is reachable, STOP and report exactly which sources you tried and why each failed.
**Never invent errors.**

## 2. Group into distinct errors
Cluster raw log lines by **signature**: normalized message + top of stack + route. Drop noise (expected
4xx, aborted requests, health checks). For each cluster capture: signature, first/last seen, count,
sample stack, affected route/file.

## 3. Dedupe (mandatory, see loops.md)
Fingerprint = a stable hash of the normalized signature.
```bash
gh issue list --search "<fingerprint> in:body state:all" --json number,state
```
Open match → comment ("still occurring, N since <date>"). Closed + recurring → reopen. No match → file
new. **Cap 8 new issues/run**; log the rest.

## 4. File the issue
```
Title: [prod error] <short normalized message> (<route>)
Labels: loop:auto, loop:vercel, bug
Body:
  **Signature:** …    **Count / window:** …    **First/last seen:** …
  **Route/file:** app/…:line   **Sample stack:** (fenced)   **Vercel:** <deployment/log link if available>
  **Likely cause:** <1-2 lines from reading the referenced code>
  <!-- loop-fingerprint: <hash> -->
```
Point at the suspected `file:line` by reading the code the stack references.

## 5. Trivial fix only (propose-don't-merge), cap 2 PRs/run
Open a `loop/vercel-<hash>` fix PR **only** when the cause is unambiguous and low-risk (missing null
guard, unhandled `undefined`, bad env read with an obvious default, a narrow type fix). Anything
touching bookkeeping/money/migrations/auth → issue only, label `loop:needs-human`. Every fix passes the
**[`loop-verify`](../loop-verify/SKILL.md)** gate. PR body: `Closes #<issue>`.

## 6. Report
List: new issues filed, existing issues updated, fix PRs opened, which source worked, anything skipped.
```

> **Want proper error tracking?** Vercel runtime-log retention is short. For a real errors→tickets loop,
> wire an error sink (Sentry, Vercel Log Drains to a store, etc.) and update step 1 to read from it.
