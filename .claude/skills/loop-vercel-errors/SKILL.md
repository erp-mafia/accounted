---
name: loop-vercel-errors
description: Proactive loop that pulls recent production runtime errors from Sentry (the wired source) or Vercel, groups + dedupes them, files well-formed GitHub issues, and opens a fix PR only for clearly trivial/safe cases. Use on a schedule (cloud routine) or on-demand via /loop-vercel-errors. Follows .claude/loops.md.
---

# loop-vercel-errors

**Goal:** every distinct, real production runtime error is tracked as a GitHub issue (deduped), and the
obviously-trivial ones have a proposed fix PR. **Never merge.** Read `.claude/loops.md` first.

Vercel project `erp-base` (`prj_zOvCFaOMXS166cUY5VYEGHKke00X`, team `team_WPj3QZgcSVRWZKcHJQB3wfv8`).

## 1. Fetch errors (Sentry is the configured source)
The app ships `@sentry/*` and is wired to Sentry (`SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`,
`SENTRY_VERCEL_LOG_DRAIN_URL`). Sentry's issue stream is the richest, already-grouped source.

1. **Sentry API (primary):**
   ```bash
   curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
     "https://sentry.io/api/0/projects/$SENTRY_ORG/$SENTRY_PROJECT/issues/?statsPeriod=14d&query=is:unresolved&limit=25"
   ```
   The token needs **`event:read` + `project:read`**. As of 2026-07-01 the token in `.env.local` returns
   **HTTP 403** — a scoped Internal Integration token is required. In the **cloud** routine these vars
   must exist as **secrets in the cloud env** (see `.claude/loops.md` → cloud requirements).
2. **Vercel MCP** (`mcp__plugin_vercel_vercel__*`) — only in a LOCAL run (not in the cloud routine's
   tool allowlist). If present, pull prod runtime logs / observability.
3. **Vercel CLI** last resort: `vercel logs <prod-deployment-url> --json` (v48 here, may fail).

If **no** source is reachable, STOP and report exactly which sources you tried and why each failed.
**Never invent errors.**

## 2. Group into distinct errors
If using raw logs, cluster by **signature** (normalized message + top of stack + route); drop noise
(expected 4xx, aborted requests, health checks). Sentry issues are already grouped — use `issue.id` /
`culprit` / `title` / `count`. Capture: signature, first/last seen, count, sample stack, route/file.

## 3. Dedupe (mandatory — see loops.md)
Fingerprint = the Sentry issue short-id, or a hash of the normalized signature.
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
  **Route/file:** app/…:line   **Sample stack:** (fenced)   **Sentry:** <permalink if available>
  **Likely cause:** <1–2 lines from reading the referenced code>
  <!-- loop-fingerprint: <hash-or-shortid> -->
```

## 5. Trivial fix only (propose-don't-merge) — cap 2 PRs/run
Open a `loop/vercel-<hash>` fix PR **only** when the cause is unambiguous and low-risk (missing null
guard, unhandled `undefined`, bad env read with an obvious default, a narrow type fix). Anything
touching bookkeeping/money/migrations/auth → issue only, label `loop:needs-human`. Every fix passes the
**[`loop-verify`](../loop-verify/SKILL.md)** gate. PR body: `Closes #<issue>`.

## 6. Report
List: new issues filed, existing issues updated, fix PRs opened, which source worked, anything skipped.
