# AGENTS.md: Accounted

Swedish accounting SaaS: double-entry bookkeeping under Swedish accounting law (Bokföringslagen) for sole traders (enskild firma) and limited companies (aktiebolag). Multi-tenant: users belong to companies via `company_members`; `teams` group companies for consultants.

This file is the entry point for Codex and other agents that do not read `CLAUDE.md` on their own. It deliberately does not duplicate the project rules: an earlier copy drifted from `CLAUDE.md` within weeks. Read `CLAUDE.md` first and follow it as written.

## Source of truth: `CLAUDE.md`

`CLAUDE.md` at the repo root holds everything that applies to every agent, and it wins whenever this file and it disagree:

- **Hard Rules**: the seven accounting invariants (the two sanctioned correction paths, storno and inline rättelse; engine-only journal writes; balanced entries; period locks; document retention; money math; account numbers as strings) and the general prohibitions (migrations, extension imports, dependencies, the gnubok → Accounted rename, diff scope, no em or en dashes).
- **When Uncertain**: ask instead of guessing; Swedish domain questions go through the `swedish-*` skills in `.claude/skills/`, never training data.
- **Definition of Done**: lint, tests, pg-real tests for database behaviour, both locales, `skills:generate`, `check:guards`, conventional commits, and a pull request that follows `.github/CONTRIBUTING.md`.
- **Commands**, **Architecture** (tenancy resolution, application-side MFA and `withRouteContext`, event bus, Supabase clients, legal forms, extensions, the 150+ MCP tools), **Repository Map** and **Testing**.

Do not copy sections from `CLAUDE.md` into this file; link to them instead.

## Contributions made with an agent

`.github/CONTRIBUTING.md` has the policy for AI-assisted pull requests: disclose the assistance, a human author reads every line and answers for it, small focused PRs with tests, and no bulk or autonomous agent PRs from outside contributors.
