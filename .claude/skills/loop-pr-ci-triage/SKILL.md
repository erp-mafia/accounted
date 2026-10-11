---
name: loop-pr-ci-triage
description: Proactive loop that watches open merge requests in arcim-technology-ab-group1/accounted, fixes failing CI, and addresses actionable review-bot / reviewer comments, on the PR branch, never merging. Use on a session-local schedule (/loop) or on-demand via /loop-pr-ci-triage. Follows .claude/loops.md (propose-don't-merge, dedupe, loop-verify gate).
---

# loop-pr-ci-triage

**Goal:** every open, non-draft PR authored by our team or dependabot is either green + review-addressed,
or explicitly escalated with `loop:needs-human`. **Never merge.** Read `.claude/loops.md` first.

## Preflight
- `glab auth status` and confirm repo `arcim-technology-ab-group1/accounted`. If either fails, stop and report "environment not provisioned".
- Respect [foreign WIP](../../../CLAUDE.md): never touch a branch with another human's uncommitted/active work; never force-push over someone's commits.

## 1. Enumerate & prioritize
```bash
glab mr list -R arcim-technology-ab-group1/accounted -F json --jq '.[] | {iid,title,draft,source_branch,author:.author.username,detailed_merge_status,updated_at}'
glab ci get --merge-request <n> -R arcim-technology-ab-group1/accounted -F json --jq .status   # pipeline status, per MR
```
Skip: drafts; PRs by `contributor:flagged`/`pr:flagged` authors; PRs already labeled `loop:needs-human`.
Prioritize (cap **5 PRs/run**, log the rest):
1. Failing CI that's a mechanical fix (lint, type error, snapshot, a flaky/needs-rerun check).
2. Dependency bumps failing `checks` / `build` / `unit-tests` / `pg-real`.
3. Unresolved actionable review comments (from "The PR Agent", Superagent, or a human).

## 2. Diagnose each PR
- Failing checks: read the failing job. `glab ci get --merge-request <n> -R arcim-technology-ab-group1/accounted -s failed -d`; open the failing job's log
  (`glab ci trace <job-id> -R arcim-technology-ab-group1/accounted`). Identify the *specific* failing command in that job's `.gitlab-ci.yml` script: `checks` (skills/taxonomy/apiskill checks, `check:lint`, `check:types`, `check:guards`, pack and registry validation, the core-imports-`@/extensions/` grep), `build` (`npm run build`), `unit-tests` (`npm test`, 4 shards), `pg-coverage-gate`, `pg-real` (migration replay + `test:pg`), `pg-upgrade`, `tool-pg`.
- Review comments: `glab mr view <n> -R arcim-technology-ab-group1/accounted --comments`. Separate *actionable* (a concrete bug/change) from
  informational. Follow the [bot-triage rule](../../../CLAUDE.md): honest triage beats chasing every finding.

## 3. Fix (propose-don't-merge)
- `glab mr checkout <n> -R arcim-technology-ab-group1/accounted` (or for dependabot, check out its branch). Reproduce the failure locally by
  running the exact failing command. Make the **minimal** fix.
- Run the **[`loop-verify`](../loop-verify/SKILL.md)** gate. If it can't pass safely → step 5.
- `git push` to the PR's own branch. Leave a concise comment on the PR: what was failing, what you
  changed, verify output. Do **not** `glab mr merge`.

## 4. Dependabot specifics
If a bump breaks the build/tests, the fix is usually a small code adaptation to the new API or a
peer-dep pin. If the bump is a **major** version with wide breakage, don't force it: comment with the
breaking changes found and label `loop:needs-human` instead of a risky rewrite.

## 5. Escalate / anti-thrash
If you already attempted the same fix on this PR (same failure signature) and it failed again, or the
fix is unsafe/large: **stop**, add label `loop:needs-human`, comment what you tried and why you stopped.
Never retry the same failing push in a cycle.

## 6. Report
Summarize per PR: fixed & pushed / commented / escalated / skipped (with reason). This summary is the
routine's completion notification.

## Batch mode (optional)
For many PRs at once, drive this with a dynamic **workflow**: one agent per PR in its own worktree
(`isolation: 'worktree'`) so parallel fixes don't collide, then an adversarial reviewer per fix before
it's pushed. Keep the 5-PR cap unless told otherwise.
