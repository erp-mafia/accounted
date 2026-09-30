-- Run once on a new, empty database BEFORE replaying supabase/migrations/.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/bootstrap.sql
--
-- (or paste it into the Supabase SQL Editor), connected as postgres, the role
-- that applies the migrations and owns what they create.
--
-- Why it exists: the migration history was written against Supabase's legacy
-- platform bootstrap, which granted every new public table, sequence and
-- function to anon, authenticated and service_role by default. Most historical
-- create-table migrations rely on that and never GRANT; later migrations then
-- REVOKE from specific tables on purpose. Supabase projects created since
-- 2026-05-30 no longer carry that default, so replaying the history there
-- leaves every historical table without grants and the app answers 42501 to
-- every request, the service-role client included.
--
-- This restores the legacy default for the replay only. The history then
-- behaves exactly as it did in production (each CREATE TABLE grants, each
-- later REVOKE takes its grant back), and migration
-- 20260929220000_own_default_privileges switches the table and sequence
-- defaults off again for everything created after it.
--
-- Do not repair a replay that skipped this step with GRANT ... ON ALL TABLES
-- IN SCHEMA public: that re-grants what those later REVOKEs withdrew. Start
-- again from an empty database instead.
--
-- Safe to run anywhere. Once the migrations have created public.companies it
-- does nothing, so it can never re-open the defaults on a database that has
-- already applied 20260929220000. Where the legacy default is still in place
-- (the supabase/postgres image, projects created before 2026-05-30) granting
-- it again changes nothing.

DO $$
BEGIN
  IF to_regclass('public.companies') IS NOT NULL THEN
    RAISE NOTICE 'supabase/bootstrap.sql: skipped, this database already has the migrations applied (public.companies exists)';
    RETURN;
  END IF;

  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
END
$$;
