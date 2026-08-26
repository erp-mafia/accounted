# Agentic Loops: Playbook

Proactive loops that scan the codebase and our external systems (GitHub, Vercel), then
**propose** fixes and file well-formed tickets. This file is the shared contract every loop obeys.
Skills under `.claude/skills/loop-*` implement the loops; local `/loop` invocations and session-local
crons run them on a schedule. **Cloud routines are retired (2026-07-20): all loops are LOCAL.**

> These are **proactive loops**: triggered by a schedule, no human in real time, each item exits when
> its goal is met. Quality comes from the *system around the loop* (verification skills, clean
> conventions, second-agent review), not from a clever prompt.

> **This file lives at `.claude/loops.md` (committed).** `dev_docs/*` is gitignored ("internal
> reference, not published"), so the playbook cannot live there: the cloud routines clone `main` and
> need this file present.

---

## Autonomy policy: "Propose, don't merge"

This is a Swedish accounting/compliance codebase. Loops never touch `main` or production.

| Loop may… | Loop may **NOT**… |
|---|---|
| Fix trivial/low-risk issues on a `loop/*` branch | Merge any PR (`gh pr merge` is forbidden) |
| Open PRs for review, comment on PRs | Push to `main` or any human's active branch |
| File / label / dedupe / close GitHub issues | Force-push over another author's commits |
| Push to a PR branch it created, or a dependabot branch | Edit posted journal entries / violate an [Accounting Guard Rail](../CLAUDE.md#accounting-guard-rails) |
| Escalate to a human via `loop:needs-human` | Act on PRs from `contributor:flagged` / `pr:flagged` authors |

Every code change a loop makes **must pass the [`loop-verify`](skills/loop-verify/SKILL.md) gate before
the PR is opened.** No exceptions.

---

## Ticketing & dedupe conventions (all loops share these)

**Destination:** GitHub Issues + PRs in `erp-mafia/accounted` (via `gh`). Not Linear.

**Labels:** `loop:auto` (always, on anything a loop creates), `loop:vercel`, `loop:triage`,
`loop:design`, `loop:docs`, `loop:regeluppdat`, `loop:needs-human` (a loop tried and could not
safely proceed).

**Idempotency / anti-spam: MANDATORY.** Before filing anything:
1. Compute a stable **fingerprint** (error signature, file:line, rule id, never a timestamp).
2. `gh issue list --search "<fingerprint> in:body state:all"` (include closed). Match → comment instead
   of filing a duplicate; closed + recurring → reopen with a note.
3. Embed `<!-- loop-fingerprint: <hash> -->` in the body so future runs find it.

**Branch naming:** `loop/<loop>-<ref>`, e.g. `loop/ci-pr848`, `loop/issue-843`, `loop/vercel-<hash>`.

**Anti-thrash:** if the same fix (same fingerprint) already failed, **stop**, label `loop:needs-human`,
comment what was tried. Never retry the same failing action in a cycle.

**Per-run caps (cost):** each run bounds how much it acts and `log()`s what it skipped. Defaults below.

---

## The loops

| # | Loop | Skill | Where | Cadence (default) | Per-run cap |
|---|---|---|---|---|---|
| 1 | PR + CI triage | `loop-pr-ci-triage` | **Local** (session cron / `/loop`) | ~3x/day while a session is open | ≤5 PRs |
| 2 | Vercel errors → tickets | `loop-vercel-errors` | **Local** (Vercel MCP) | daily / on-demand | ≤8 issues, ≤2 PRs |
| 3 | Issue triage + easy-fix | `loop-issue-triage` | **Local** (session cron / `/loop`) | ~2x/day while a session is open | triage all; ≤2 PRs |
| 4 | UI/UX + design scan | `loop-design-scan` | **Local** (`/loop`) | on-demand | ≤1 area, ≤6 findings |
| 5 | Docs freshness (docs.accounted.se) | `loop-docs-freshness` | **Local** (`/loop` / ignite-when-due) | weekly | 1 issue, 1 website PR |
| 6 | Regeluppdat (Swedish regulatory watch) | `loop-regeluppdat` | **Local** (`/loop` / ignite-when-due) | monthly | ≤6 issues, **0 PRs** |

**All loops are local.** Cloud routines were retired 2026-07-20: the three claude.ai triggers
(`trig_01J2nG7eB9gsdAb9YSGBVwa8`, `trig_014CmE3gTJ7ErnvL2trPYymu`, `trig_017hB94ieGVwreJqHpGRDVoM`)
ran for 19 days as silent no-ops (no `GH_TOKEN` in the cloud env, issue #993) and the founder chose
to disable them rather than provision. Do not re-enable or re-create them. Loop 2 additionally needs
the Vercel MCP (local-only; Sentry is not used). Loop 4 needs `npm run dev` + Chrome.
The `loop-ignite` skill audits and (re)schedules the local cadence each session.

Loops 5 and 6 self-gate on a due check (a run marker in their tracking issues), so any invocation
is idempotent: session crons cannot outlive 7 days, which makes weekly/monthly cadences
unschedulable directly. Instead `loop-ignite` runs them **when due** at the start of a session.
Loop 6 files tickets only, never PRs: regulatory changes touch money math and compliance logic,
which the autonomy policy forbids auto-fixing.

---

## The verification gate (`loop-verify`)
Before any loop opens a PR: `check:lint` → targeted `vitest` → `test:pg` **iff** a
trigger/RPC/RLS/migration was touched → `check:guards` → the "no core imports from `@/extensions/`"
grep → build if config/types changed. Plus: never violate an
[Accounting Guard Rail](../CLAUDE.md#accounting-guard-rails); keep `sv`/`en` in sync ([i18n](rules/i18n.md)).

---

## Why not cloud (historical, kept so nobody re-litigates it)

Cloud routines were tried 2026-07-01 and retired 2026-07-20. The blockers, should anyone revisit:
the anthropic_cloud env needs a `GH_TOKEN` fine-grained PAT for private-repo access (OAuth-only
integration does not work, anthropics/claude-code#64130), cannot reach interactively-authenticated
MCPs (Vercel/Supabase plugins), and Sentry is **not** used in this codebase (the `SENTRY_*` names in
`.env.local` are leftovers). Reviving cloud means: set `GH_TOKEN` in the routine editor's cloud env,
re-enable the triggers, and verify the first fire leaves a real GitHub trace. Until someone does all
of that deliberately, treat cloud as retired: see issue #993 for the full history.

---

## Operating the loops
- **Audit / (re)ignite each session:** `/loop-ignite` (audits evidence, schedules session-local crons).
- **Run on-demand:** `/loop-pr-ci-triage`, `/loop-issue-triage`, `/loop-vercel-errors`,
  `/loop-design-scan <area>`, `/loop-docs-freshness`, `/loop-regeluppdat`. Wrap in
  `/loop <interval>` to repeat locally; `/goal` for a hard exit.
- **Cost:** route mechanical steps to cheaper models; reserve judgment for the strong model. `/usage`.
  Don't run more often than the watched thing changes.

## Extending
When a loop produces a bad result, encode the lesson back into the skill / a CLAUDE.md rule / a verifier
so every future run improves: don't just fix the one output.
