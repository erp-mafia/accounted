-- Own the default privileges for new public tables and sequences.
--
-- Until now no migration had to say who may reach the table it creates. The
-- grants came from a platform bootstrap instead: Supabase provisions
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON TABLES TO anon, authenticated, service_role;
--   (and the same ON SEQUENCES and ON FUNCTIONS)
--
-- (verified read-only in production and in the supabase/postgres image that
-- pg-real replays on, 2026-09-29), so every CREATE TABLE came out reachable by
-- all three Data API roles and RLS did the limiting. Most create-table
-- migrations in this directory never GRANT anything.
--
-- Supabase is withdrawing that bootstrap (github.com/orgs/supabase/discussions/
-- 45329): projects created since 2026-05-30 do not have it, and existing
-- projects stop granting new public tables and sequences to the three roles on
-- 2026-10-30. A table created without an explicit GRANT then answers 42501 to
-- every supabase-js client, the service-role one included, while pg-real
-- (which replays under the old image default) stays green.
--
-- This migration adopts the new state now, on our schedule and in repo
-- history, so production, self-host (with supabase/bootstrap.sql) and pg-real
-- behave the same from here on, and a table that ships without grants fails
-- check:guards (table-without-grant) and any pg-real test that touches it as
-- an API role, rather than its first production call. Supabase preview
-- branches are the exception: they replay the history on a fresh project that
-- never had the legacy default, and branching has no step before the
-- migrations where supabase/bootstrap.sql could run, so the historical tables
-- there lack grants whether or not this migration exists.
--
-- Scope:
--   * Default ACLs apply only at CREATE time. Every existing table and
--     sequence keeps its own ACL, including the deliberate lockdowns later
--     migrations made (ai_usage_events, provider tokens, peppol_*, sie_* and
--     others). No backfill and no bulk GRANT: GRANT ... ON ALL TABLES would
--     re-open exactly those.
--   * FOR ROLE postgres only. It owns every table the migrations create, and
--     it is the only defaults owner a project may change; the supabase_admin
--     defaults cover objects that role creates, never ours.
--   * REVOKE ALL, not only the four DML privileges: the old default also
--     handed out TRUNCATE (which RLS does not govern), REFERENCES, TRIGGER and,
--     on Postgres 17, MAINTAIN. A new table gets exactly what its migration
--     grants and nothing else.
--   * Functions are out of scope. Their EXECUTE default is unchanged, and
--     PUBLIC holds EXECUTE on every new function regardless (see
--     20260901100000_revoke_anon_execute_on_definer_writes.sql).
--
-- From here on a migration that creates a public table GRANTs what its
-- callers need in the same file. check:guards (table-without-grant) enforces
-- it; the /supabase-migration skill has the template. A fresh database that
-- replays the whole history needs the legacy default back for the historical
-- files first: supabase/bootstrap.sql does that and then this migration turns
-- it off again.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
