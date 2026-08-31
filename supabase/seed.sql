-- Align the local Supabase stack's table privileges with a hosted project.
--
-- Why this file exists: on hosted Supabase, `anon`, `authenticated` and
-- `service_role` hold SELECT/INSERT/UPDATE/DELETE on everything in `public`,
-- and Row Level Security is what actually decides who sees what. The local
-- CLI image does not grant that DML by default, so straight out of
-- `supabase start` every PostgREST query fails with "permission denied for
-- table X" even though the schema and the policies are correct.
--
-- Without this, an E2E run tests a database that is locked down in a way
-- production is not, and every failure is an artefact of the harness.
--
-- This grants privileges only. It does not touch RLS: all 168 public tables
-- have `relrowsecurity` on, and the policies from supabase/migrations/ remain
-- the sole access control. Granting `anon` the same set production grants it
-- is deliberate: an E2E suite has to be able to catch a missing RLS policy,
-- and it cannot do that if the role is blocked one layer earlier by a
-- privilege model production does not have.
--
-- Applied automatically wherever the Supabase CLI layout is honoured: by
-- `supabase db reset` locally, and by spectest's supabase() component, which
-- runs seed.sql after the migrations. tests/e2e/setup-env.sh applies it too,
-- for a stack that is already up.
--
-- Never a migration: this describes the local harness, not the product schema,
-- and production already grants these privileges.

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  TO anon, authenticated, service_role;

GRANT USAGE, SELECT, UPDATE
  ON ALL SEQUENCES IN SCHEMA public
  TO anon, authenticated, service_role;

GRANT EXECUTE
  ON ALL FUNCTIONS IN SCHEMA public
  TO anon, authenticated, service_role;

-- Tables created after this point (a migration applied mid-session, a test
-- fixture) inherit the same shape rather than silently reintroducing the gap.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE
  ON SEQUENCES TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE
  ON FUNCTIONS TO anon, authenticated, service_role;

-- Migrations that deliberately lock a table down must stay locked down. This
-- one is a one-off backfill snapshot holding invoice PII; migration
-- 20260825170000 revokes everything from PUBLIC, anon, authenticated and all
-- write privileges from service_role, and the blanket GRANT above would have
-- handed them straight back.
DO $$
BEGIN
  IF to_regclass('public._backfill_remaining_20260817') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public._backfill_remaining_20260817 FROM PUBLIC, anon, authenticated';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public._backfill_remaining_20260817 FROM service_role';
  END IF;
END $$;
