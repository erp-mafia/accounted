---
name: loop-issue-triage
description: Proactive loop that keeps GitHub Issues in erp-mafia/accounted tidy (label, dedupe, close stale/already-fixed, reconcile with merged PRs) and auto-implements small, well-scoped fixes as PRs. Use on a schedule (cloud routine) or on-demand via /loop-issue-triage. Follows dev_docs/loops.md (propose-don't-merge).
---

# loop-issue-triage

**Goal:** the open-issue list is accurately labeled and free of stale/duplicate/already-fixed items,
and a couple of small fixes ship as PRs each run. **Never merge.** Read `.claude/loops.md` first.

## Preflight
`gh auth status`, repo `erp-mafia/accounted`. If it fails, stop and report "environment not provisioned".

## 1. Triage every open issue
```bash
gh issue list --state open --limit 100 --json number,title,labels,createdAt,updatedAt,comments
```
For each issue lacking a type label:
- **Classify** → apply one of `bug` / `enhancement` / `question` / `documentation`.
- **Dedupe** → search for near-duplicates (`gh issue list --search "<keywords> in:title,body state:all"`).
  If a duplicate, label `duplicate`, comment linking the canonical issue, and close the newer one.
- **Stale** → no activity > 30 days AND not actionable: comment asking if still relevant; don't close
  unilaterally unless clearly obsolete.

## 2. Reconcile with completed work (the "are tickets up to date?" job)
- For each open issue, check whether a **merged** PR or recent commit already resolved it:
  `gh pr list --state merged --search "<#num or keywords>"`, `git log --oneline -S"<keyword>"`.
- If resolved: comment with the PR/commit link, verify the fix exists in `main`, then close.
- Conversely, if a merged PR said `Closes #N` but #N is still open, close it with a pointer.

## 3. Auto-fix small issues (propose-don't-merge): cap 2 PRs/run
Pick issues that are **small, localized, and low-risk** (a clear bug in one file, a copy/label fix, a
missing empty/loading state, a validation gap). **Never** auto-fix anything touching the bookkeeping
engine, money math, migrations/triggers, auth, or compliance logic: those get `loop:needs-human`.
- Branch `loop/issue-<n>`, minimal fix, run the **[`loop-verify`](../loop-verify/SKILL.md)** gate.
- Open PR with body `Closes #<n>` + a one-line summary. Label `loop:auto`, `loop:triage`.
- If the fix turns out larger/riskier than expected mid-way, abandon the branch and instead add a
  scoping comment on the issue + `loop:needs-human`.

## 4. Anti-thrash & report
Don't re-triage issues already labeled this run. Summarize: labeled N, deduped N, closed N (with why),
fix PRs opened, escalated N. That summary is the completion notification.
