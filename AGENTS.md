# AGENTS.md: Accounted

Swedish accounting SaaS: double-entry bookkeeping under Swedish accounting law (Bokföringslagen) for sole traders (enskild firma) and limited companies (aktiebolag). Multi-tenant: users belong to companies via `company_members`; `teams` group companies for consultants.

This file is the entry point for Codex and other agents that do not read `CLAUDE.md` on their own. It deliberately does not duplicate the project rules: an earlier copy drifted from `CLAUDE.md` within weeks (missing the inline-rättelse correction path, a stale tenancy resolution order, an outdated MCP tool count). Read `CLAUDE.md` first and follow it as written.

## Source of truth: `CLAUDE.md`

`CLAUDE.md` at the repo root holds everything that applies to every agent, and it wins whenever this file and it disagree:

- **Hard Rules**: the seven accounting invariants (the two sanctioned correction paths, storno and inline rättelse; engine-only journal writes; balanced entries; period locks; document retention; money math; account numbers as strings) and the general prohibitions (migrations, extension imports, dependencies, the gnubok → Accounted rename, `.env.local`, diff scope, no em or en dashes).
- **Working Autonomy**: act without asking on anything reversible; ask before production writes, sending to a customer or authority, deleting data, adding a dependency, or changing how a legal rule is read. Swedish domain questions go through the `swedish-*` skills, never training data.
- **Definition of Done**: every item, including last-mile verification in-session (migration applied, routine observed firing, or the final output states exactly what is not live yet) and the three answers from **Fix From First Principles** in the MR body.
- **Commands**, **Architecture** (tenancy resolution, application-side MFA, event bus, Supabase clients, extensions, the 150+ MCP tools), **Testing**, **Merging** (read the live merge settings, queue with auto-merge) and the **Decision Log** (one file per decision that changes a rule or something users see, under `docs/decisions/`; `DECISIONS.md` explains the layout).

Do not copy sections from `CLAUDE.md` into this file; link to them instead.

## Codex-specific working constraints

These apply to Codex sessions run by Emil (Mattsson) and were added 2026-07-21; they are not in `CLAUDE.md` because they describe one operator's environment rather than the product. Keep them here.

- **Apply migrations only to the `erp-base` Supabase project's `staging` branch.** Never apply migrations to a local database or a locally hosted Supabase instance.
- **Never write to the `erp-base` Supabase production database without Emil's explicit approval for the specific write.** Production reads are allowed, including fetching data for a requested account, but no INSERT, UPDATE, DELETE, DDL, migration, mutating RPC, repair, seed, or other state-changing operation may run until Emil has clearly said okay. Do not infer approval from a request to investigate, diagnose, fix code, or fetch data.
- **Never write directly to the `main` branch without Emil's explicit approval.** Do not commit, push, merge, or otherwise update `main`; use a feature branch unless Emil clearly approves the specific main-branch write.
- **Never open, start, or run Docker locally.** Do not run Docker commands or commands that start Docker-managed services.

## Path-specific guidance (`.claude/rules/`)

The files below are the shared source of truth for path-specific guidance. Claude Code loads them through their `paths` frontmatter. Codex does not interpret that frontmatter, so before reading, editing, reviewing, or otherwise working with a matching path, read and follow the listed rule. Do not duplicate the rule bodies here.

- `.claude/rules/design.md`: design system, locked tokens (`src/app/**`, `src/components/**`)
- `.claude/rules/i18n.md`: sv/en conventions, "stays Swedish" surfaces
- `.claude/rules/api-routes.md`: `withRouteContext` route pattern, endpoint map (`src/app/api/**`)
- `.claude/rules/database.md`: migration rules, pg-real, atom skill bodies (`supabase/migrations/**`)
- `.claude/rules/mcp-server.md`: MCP tool authoring, staged-operation pattern, OAuth 2.1 connector auth
- `.claude/rules/bookkeeping.md`: VAT rate helpers, how VAT declaration rutor are derived
- `.claude/rules/legal-forms.md`: capability profiles, never `=== 'aktiebolag'` at call sites; contract in `docs/LEGAL-FORMS.md` (`src/lib/company/**`, templates, year-end, import)
