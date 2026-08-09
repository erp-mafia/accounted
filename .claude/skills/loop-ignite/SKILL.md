---
name: loop-ignite
description: Verify the agentic loops are actually running and ignite any that are not. Use at the start of any session, or whenever the user manually asks to "check the pr comments" / check logs / triage issues, which signals a loop is not firing. The loops are LOCAL-only since 2026-07-20 (cloud routines retired); the historical failure mode is that nobody initiates them.
---

# loop-ignite

**Goal:** the user never has to type "check the pr comments" again. That prompt was typed 323 times
between 2026-04 and 2026-07; the loops that replace it were built 2026-07-01.
This skill closes the initiation gap.

**Cloud routines are RETIRED (founder decision 2026-07-20).** The three claude.ai triggers
(trig_01J2nG7eB9gsdAb9YSGBVwa8, trig_014CmE3gTJ7ErnvL2trPYymu, trig_017hB94ieGVwreJqHpGRDVoM)
fired daily for 19 days as silent no-ops (no GH_TOKEN in the cloud env, issue #993) and were
deliberately disabled instead of provisioned. Do NOT re-enable or re-create them; ignore them in
audits. All loops run locally now.

## When invoked

1. **Audit what is live.**
   - Local schedule: `CronList` for session-local jobs invoking `/loop-*` skills.
   - Evidence of firing: recent `loop/*` branches, PR comments by the loop, `loop:needs-human` labels
     (`gh pr list`, `gh issue list --label loop:needs-human`).
   - Slow loops: last `<!-- loop-docs-freshness-run: ... -->` marker on `loop:docs` issues (due
     weekly) and last `<!-- loop-regeluppdat-run: YYYY-MM -->` marker on the `Regeluppdat scan log`
     issue (due monthly).
2. **Report a one-screen status table**: loop, expected cadence, last observed run, verdict (LIVE / DEAD / NEVER RAN / NOT DUE).
3. **Ignite what is dead.** For each non-live loop:
   - Run the loop skill once NOW (`/loop-pr-ci-triage`, `/loop-issue-triage`, `/loop-vercel-errors`)
     so the backlog is cleared this session.
   - Then schedule a session-local cadence (`CronCreate` invoking the matching `/loop-*` skill) and
     say clearly that it only runs while this session is alive (7-day auto-expiry).
   - **Slow loops run when due, not on a cron**: session crons cannot outlive 7 days, so weekly and
     monthly cadences cannot be scheduled directly. If the docs-freshness marker is older than 6
     days (or absent), run `/loop-docs-freshness` once now; if the regeluppdat marker is not from
     the current calendar month, run `/loop-regeluppdat` once now. Both self-gate, so running them
     again is a cheap no-op.
   - If a loop cannot run at all, file the blocker as a GitHub issue so the gap is visible instead of silent.
4. **Switch-on check (mandatory):** after igniting, verify via `CronList` that the jobs exist.
   End with either "ALL LOOPS LIVE (session-local)" or "NOT SWITCHED ON YET: <loop> - <what remains, who flips it>".

## If the user manually types a loop-shaped request

("check the pr comments", "check the vercel/supabase logs for errors", "triage the issues")
Do the requested work, then ALSO run the audit above and tell the user which loop should have made
the request unnecessary, and whether it is now live.
