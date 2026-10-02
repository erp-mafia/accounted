---
name: supabase-migration
description: "Generate Supabase database migrations for the Accounted project with correct RLS policies, triggers, indexes, and Swedish accounting constraints. Use when creating new tables, adding columns, modifying constraints (e.g. source_type CHECK), or any DDL operation on the Supabase database. Ensures legal compliance with BFL 7-year retention, immutability triggers, and period lock enforcement."
---

# Supabase Migration Generator

## Migration Numbering

Early migrations used the sequential series `20240101000001`-`20240101000038`; the project has long since moved to real timestamps. **New migrations use a current UTC timestamp** `YYYYMMDDHHMMSS_description.sql` (e.g. `20260603120000_add_x.sql`). Never reuse or back-date a number.

## New Table: Complete Template

Accounted is multi-tenant: company-scoped business data is owned by `company_id` and secured with the `user_company_ids()` RLS helper (NOT `auth.uid() = user_id`). Every new company-scoped table requires ALL of these. Missing any is a bug.

```sql
-- 1. Table with UUID PK + company_id + user_id FKs
CREATE TABLE public.tablename (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- domain columns --
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. RLS
ALTER TABLE public.tablename ENABLE ROW LEVEL SECURITY;

-- 3. Grants: a new public table is reachable by NO Data API role until
--    granted (see Grants below). service_role gets the DML the server needs;
--    authenticated gets what the policies in step 4 allow; anon nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tablename TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tablename TO authenticated;

-- 4. All four CRUD policies: scope to the user's companies
CREATE POLICY "view own-company tablename"
  ON public.tablename FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company tablename"
  ON public.tablename FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company tablename"
  ON public.tablename FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company tablename"
  ON public.tablename FOR DELETE USING (company_id IN (SELECT user_company_ids()));

-- 5. Indexes (minimum: company_id + any FK/filter columns)
CREATE INDEX idx_tablename_company_id ON public.tablename (company_id);

-- 6. updated_at trigger
CREATE TRIGGER set_updated_at_tablename
  BEFORE UPDATE ON public.tablename
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 7. Audit trigger
CREATE TRIGGER audit_tablename
  AFTER INSERT OR UPDATE OR DELETE ON public.tablename
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- 8. Reload PostgREST schema cache (required after structural DDL)
NOTIFY pgrst, 'reload schema';
```

## Grants

Since migration `20260929220000_own_default_privileges` (and on every Supabase project from 2026-10-30) a new table, view or sequence in `public` gets no privileges for `anon`, `authenticated` or `service_role`. Without a GRANT it answers 42501 to every supabase-js client, the service-role one included, while unit tests (mocked client) stay green. The tables created before that keep the grants the old platform default gave them, so do not copy an old migration's missing GRANT.

- Grant in the same migration that creates the relation. `service_role`: `SELECT, INSERT, UPDATE, DELETE` (crons, API-key/MCP paths, account erasure and the archive export all run as the service role). `authenticated`: the privileges its RLS policies allow, nothing more (a SELECT-only policy set gets `GRANT SELECT`). `anon`: only when the table is meant to be public.
- A view needs `GRANT SELECT` like a table, and `WITH (security_invoker = true)` so the base tables' RLS applies to the caller rather than to the view owner.
- A role that must not reach the table gets a reasoned waiver instead of a GRANT: `-- no-grant: authenticated on public.tablename (service-role only: written by the cron)`.
- Keys: `uuid DEFAULT gen_random_uuid()` or `GENERATED ALWAYS AS IDENTITY` need no sequence grant. `serial`/`bigserial` does: `GRANT USAGE, SELECT ON SEQUENCE public.tablename_col_seq TO service_role, authenticated;`.
- Never `GRANT ... ON ALL TABLES IN SCHEMA public` or `ALTER DEFAULT PRIVILEGES ... GRANT` to the API roles: the first re-opens tables earlier migrations locked down on purpose, the second undoes `20260929220000` for every table after it.
- `npm run check:guards` (table-without-grant) fails a migration that misses any of this and prints the exact lines to add.
- A fresh database that replays the whole history runs `supabase/bootstrap.sql` first (docs/SELF-HOSTING.md, section 3).

## Child Tables (No Direct user_id)

Tables owned via parent use subquery-based RLS:

```sql
CREATE POLICY "view own-company child" ON public.child_table
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.parent_table pt
      WHERE pt.id = child_table.parent_id
        AND pt.company_id IN (SELECT user_company_ids())
    )
  );
-- Repeat for INSERT (WITH CHECK), UPDATE, DELETE
```

## Expanding source_type CHECK

When adding a new journal entry source type, redefine the constraint with the current list plus the new value. Copy the list from the newest migration that redefines it (`git grep -l journal_entries_source_type_check -- supabase/migrations | sort | tail -1`); never retype it from memory, because a list missing an existing value fails validation against posted rows.

```sql
ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;
ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    -- every value from the newest redefinition, then:
    'NEW_TYPE_HERE'
  )) NOT VALID;
ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;
```

## Protected Triggers: NEVER Modify

Migration `20240101000017` defines legally-required triggers:
- `enforce_journal_entry_immutability`: blocks edits/deletes on posted/reversed entries
- `enforce_journal_entry_line_immutability`: blocks line mods on committed entries
- `enforce_period_lock`: blocks writes to closed/locked periods
- `block_document_deletion`: prevents deletion of docs linked to committed entries
- `enforce_retention_journal_entries`: 7-year retention
- `set_committed_at` / `calculate_retention_expiry`: auto-set timestamps

## Apply

Use `mcp__plugin_supabase_supabase__apply_migration` with snake_case `name`. Never modify existing migration files.

## Common Mistakes

1. Missing `ENABLE ROW LEVEL SECURITY`: table publicly accessible
2. Missing DELETE policy: users can't remove own records
3. Missing `updated_at` trigger: column never updates
4. Missing audit trigger: no audit trail
5. Hardcoded UUIDs in data migrations: use subqueries
6. Forgetting `source_type` CHECK expansion for new entry generators
7. Missing GRANT: the table answers 42501 to every supabase-js client, service role included
