# Agentic Loops — Playbook

Proactive loops that scan the codebase and our external systems (GitHub, Vercel), then
**propose** fixes and file well-formed tickets. This file is the shared contract every loop obeys.
Skills under `.claude/skills/loop-*` implement the loops; cloud routines and local `/loop` invocations
run them on a schedule.

> These are **proactive loops** — triggered by a schedule, no human in real time, each item exits when
> its goal is met. Quality comes from the *system around the loop* (verification skills, clean
> conventions, second-agent review), not from a clever prompt.

> **This file lives at `.claude/loops.md` (committed).** `dev_docs/*` is gitignored ("internal
> reference, not published"), so the playbook cannot live there — the cloud routines clone `main` and
> need this file present.

---

## Autonomy policy — "Propose, don't merge"

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
`loop:design`, `loop:needs-human` (a loop tried and could not safely proceed).

**Idempotency / anti-spam — MANDATORY.** Before filing anything:
1. Compute a stable **fingerprint** (error signature, file:line, rule id — never a timestamp).
2. `gh issue list --search "<fingerprint> in:body state:all"` (include closed). Match → comment instead
   of filing a duplicate; closed + recurring → reopen with a note.
3. Embed `<!-- loop-fingerprint: <hash> -->` in the body so future runs find it.

**Branch naming:** `loop/<loop>-<ref>` — e.g. `loop/ci-pr848`, `loop/issue-843`, `loop/vercel-<hash>`.

**Anti-thrash:** if the same fix (same fingerprint) already failed, **stop**, label `loop:needs-human`,
comment what was tried. Never retry the same failing action in a cycle.

**Per-run caps (cost):** each run bounds how much it acts and `log()`s what it skipped. Defaults below.

---

## The loops

| # | Loop | Skill | Where | Cadence (default) | Per-run cap |
|---|---|---|---|---|---|
| 1 | PR + CI triage | `loop-pr-ci-triage` | **Cloud** `trig_01J2nG7eB9gsdAb9YSGBVwa8` | `0 7,11,15 * * *` UTC | ≤5 PRs |
| 2 | Vercel errors → tickets | `loop-vercel-errors` | **Local** (Vercel MCP); cloud needs `VERCEL_TOKEN`. Trigger `trig_014CmE3gTJ7ErnvL2trPYymu` **disabled** | on-demand / `/loop` | ≤8 issues, ≤2 PRs |
| 3 | Issue triage + easy-fix | `loop-issue-triage` | **Cloud** `trig_017hB94ieGVwreJqHpGRDVoM` | `0 7,15 * * *` UTC | triage all; ≤2 PRs |
| 4 | UI/UX + design scan | `loop-design-scan` | **Local** (`/loop`) | on-demand | ≤1 area, ≤6 findings |

Loops 1 & 3 are cloud routines (only need `gh`). Loop 2 (Vercel errors) is **local** — the Vercel MCP is
only available locally, and there's no error-aggregation service (Sentry is not used). Loop 4 is
**local** — it needs `npm run dev` + Chrome to render/screenshot the UI.

---

## The verification gate (`loop-verify`)
Before any loop opens a PR: `check:lint` → targeted `vitest` → `test:pg` **iff** a
trigger/RPC/RLS/migration was touched → `check:guards` → the "no core imports from `@/extensions/`"
grep → build if config/types changed. Plus: never violate an
[Accounting Guard Rail](../CLAUDE.md#accounting-guard-rails); keep `sv`/`en` in sync ([i18n](rules/i18n.md)).

---

## Cloud-environment requirements (verify these — they are the usual failure points)

Cloud routines run in a **fresh session** in the anthropic_cloud env (`env_01R1K99XTZCEptnQ7k955qfN`),
cloning `main`. For them to work:

1. **`gh` must be authenticated in the cloud env.** Each routine's preflight stops and reports
   *"environment not provisioned"* if not. Verify via the completion notification of the first fire.
2. **Cloud routines cannot reach interactively-authenticated MCPs** (Vercel/Supabase plugins are not in
   the routine tool allowlist). Loops rely on `gh` (via Bash) + HTTP APIs.
3. **The Vercel-errors loop runs locally** (Vercel MCP). Sentry is **not** used in this codebase — the
   `SENTRY_*` names in `.env.local`/CLAUDE.md are leftovers. To run this loop in the cloud instead, set a
   `VERCEL_TOKEN` secret on the env and accept that Vercel runtime-log retention is short (recent window
   only). `GH_TOKEN` is the one secret loops 1 & 3 actually require (private-repo access;
   OAuth-only integration does not work for private repos — anthropics/claude-code#64130).

---

## Operating the loops
- **List / pause / retune:** `/schedule` (or the trigger MCP tools; `update_trigger` for a new cron).
- **Run on-demand:** `/loop-pr-ci-triage`, `/loop-issue-triage`, `/loop-vercel-errors`,
  `/loop-design-scan <area>`. Wrap in `/loop <interval>` to repeat locally; `/goal` for a hard exit.
- **Cost:** route mechanical steps to cheaper models; reserve judgment for the strong model. `/usage`.
  Don't run more often than the watched thing changes.

## Extending
When a loop produces a bad result, encode the lesson back into the skill / a CLAUDE.md rule / a verifier
so every future run improves — don't just fix the one output.
