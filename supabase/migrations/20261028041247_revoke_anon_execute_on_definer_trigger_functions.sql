-- Take EXECUTE away from PUBLIC and anon on the SECURITY DEFINER trigger
-- functions, the last group the Supabase security advisor still lists.
--
-- 20260901100000 (definer writers) and 20261026210000 (definer readers)
-- closed every non-trigger SECURITY DEFINER function in public to anon. The
-- advisor (lint 0028, anon_security_definer_function_executable) still
-- reports 54 functions at the time of writing, and every one of them
-- returns `trigger`:
--
--   * None is reachable over PostgREST. Called directly, plpgsql refuses with
--     "trigger functions can only be called as triggers", so this is not a live
--     hole. It is advisor hygiene: 54 warnings that hide the next real one.
--   * Postgres checks EXECUTE on a trigger function only at CREATE TRIGGER,
--     never when the trigger fires. Verified on a scratch cluster before
--     writing this (a SECURITY DEFINER trigger function with EXECUTE revoked
--     from PUBLIC and every role still fires for anon and for
--     supabase_auth_admin; only the direct SELECT is refused), and
--     tests/pg/anon-definer-trigger-functions.pg.test.ts proves it again on
--     pg-real. So handle_new_user and sync_profile_email (fired by
--     supabase_auth_admin on auth.users, which holds EXECUTE only through
--     PUBLIC) keep firing, and so does every trigger an anon, authenticated,
--     service_role or postgres write sets off.
--   * No code path calls a trigger function as an RPC: grep for .rpc('<name>'
--     over src finds none of them.
--
-- Left as they are: the functions of 20240101000017_enforcement_triggers.sql
-- (block_document_deletion and enforce_retention_journal_entries are the two
-- that show up in the advisor). CLAUDE.md says never touch the enforcement
-- triggers; an ACL change does not alter how they fire, but they stay out of
-- this sweep so the legally required set is not edited in any way. Two
-- advisor warnings remain for them by design.
--
-- What does not change: authenticated and service_role keep EXECUTE on every
-- function touched. The loop records each role's privilege before the REVOKE
-- and re-grants it explicitly (same pattern as 20261026210000), so a database
-- where a role held EXECUTE only through PUBLIC keeps it. No function body and
-- no trigger changes.
--
-- A loop, not a hand list: the predicate is the advisor's own (SECURITY
-- DEFINER, callable by anon) restricted to trigger functions, so the database
-- ends with only the enforcement functions left whatever drift exists between
-- production, pg-real and preview branches. Functions created after this
-- migration still get EXECUTE for PUBLIC and anon from the default ACL: this
-- migration leaves ALTER DEFAULT PRIVILEGES alone.
--
-- pg-test: tests/pg/anon-definer-trigger-functions.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_can
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.prokind = 'f'
       AND p.prorettype = 'trigger'::regtype
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
       -- The enforcement triggers of migration 017 stay untouched.
       AND p.proname NOT IN (
         'block_document_deletion',
         'calculate_retention_expiry',
         'enforce_journal_entry_immutability',
         'enforce_journal_entry_line_immutability',
         'enforce_period_lock',
         'enforce_period_lock_documents',
         'enforce_retention_journal_entries',
         'set_committed_at'
       )
     ORDER BY 1
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF r.auth_can THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
    IF r.service_can THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
    RAISE NOTICE 'revoked PUBLIC/anon EXECUTE on % (authenticated kept: %, service_role kept: %)',
      r.sig, r.auth_can, r.service_can;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
