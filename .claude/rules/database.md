---
paths:
  - "supabase/migrations/**"
  - "tests/pg/**"
---

# Database & Migrations

Use the `/supabase-migration` skill for new migrations.

**Location**: `supabase/migrations/`. Early migrations use sequential numbering (`20240101000001`-`20240101000038`), later ones use real timestamps.

## Migration Rules

1. Enable RLS + policies using `user_company_ids()` for company-scoped data
2. Add `updated_at` trigger via `update_updated_at_column()`
3. UUID PKs: `DEFAULT uuid_generate_v4()`
4. Company ownership: `company_id UUID REFERENCES companies NOT NULL` + `user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL`. The cascade never fires: deleted accounts keep their `auth.users` row as a tombstone, so classify every new FK to `auth.users` in `tests/pg/account-erasure.pg.test.ts` (erase it in `erase_user_personal_data`, or retain it for the company).
5. Merging to `main` is the only way a migration reaches prod; nothing goes there by hand (no `apply_migration`, no DDL through `execute_sql`). CI's `migrations-production` job (`.gitlab-ci.yml`, push to `main` only) runs `supabase db push --include-all` against prod and logs the applied versions before and after; after the merge, confirm there that your version landed. `--include-all` also applies a file older than prod's newest version, but out of repo order: if `main` landed a newer migration while yours was open, rename yours above prod's newest version before merging.
6. Always end with `NOTIFY pgrst, 'reload schema'` when altering table structure
7. GRANT every new public table, view and sequence in the migration that creates it: new relations get no privileges for `anon`/`authenticated`/`service_role` by default (migration `20260929220000_own_default_privileges`; every Supabase project from 2026-10-30). `service_role` gets DML, `authenticated` what its RLS policies allow, `anon` nothing unless public; a role that must not reach it gets `-- no-grant: <role> on public.<table> (<reason>)`. Prefer uuid or identity keys (serial needs a sequence grant). Never bulk-grant (`ON ALL TABLES`, `ALTER DEFAULT PRIVILEGES ... GRANT`). `check:guards` (table-without-grant) enforces it; template in `/supabase-migration`. A replay from an empty database runs `supabase/bootstrap.sql` first.
8. Today in SQL is `public.stockholm_today()`, never `CURRENT_DATE`: the database runs in UTC, so the session date is yesterday between midnight and 01:00/02:00 in Sweden. A function that keeps the session date on purpose is named, with its reason, in `tests/pg/stockholm-today.pg.test.ts`.
9. A data `UPDATE` or `DELETE` must skip companies archived by a migration reset: add `not exists (select 1 from public.company_migration_resets m where m.source_company_id = <row>.company_id)`. The `block_migration_reset_source_mutation` trigger refuses writes to their rows, and the pg-real replay starts from an empty database, so only `migrations-production` hits it, after the code is already live.

**pg-real tests** (Definition of Done item 3): any PR touching a trigger/RPC/RLS/DEFERRABLE must include or extend a `*.pg.test.ts` (`scripts/check-pg-test-coverage.mjs` gates it in CI). New tests go in `tests/pg/<topic>.pg.test.ts`, never under `supabase/migrations/` (that directory holds migrations only). The pg-real Vitest project collects `**/*.pg.test.ts` and runs one file at a time against `supabase/postgres:15.8.1.060`, after `tests/pg/bootstrap.sql`, `supabase/bootstrap.sql` and every migration are replayed. Local: `npm run test:pg`. Helpers: `tests/pg/setup.ts` (`getPool()`, `withUserContext()`), `tests/pg/fixtures.ts` (`seedCompany()`, `insertDraftJournalEntry()`, etc.).

## Agent skill bodies (`agent_atom_registry`)

Skill content is authored in `.claude/skills/**/SKILL.md` and inlined into the DB `body` column at runtime (not read from disk: that doesn't bundle on Vercel/Docker). After editing any atom SKILL.md, run `npm run skills:generate` to emit a new `*_seed_agent_atom_bodies.sql` migration and commit it; `npm run skills:check` (wired into CI) fails the build if you forget. Only the curated tiers become atoms: `swedish-*` (horizontal), `industry/<slug>` (vertical), `modifier/<slug>` (modifier); other Claude Code skills never become atoms. The MCP server exposes only atoms with `mcp_exposed = true`.
