-- Close the anon door on the remaining SECURITY DEFINER functions.
--
-- 20260901100000_revoke_anon_execute_on_definer_writes.sql took EXECUTE away
-- from PUBLIC and anon on every SECURITY DEFINER function in public whose body
-- WRITES. The readers were left as they shipped, and the Supabase security
-- advisor (lint 0028, anon_security_definer_function_executable) still lists
-- 66 functions the anon key can reach as POST /rest/v1/rpc/<name>.
--
-- State before this migration:
--
--   * 53 of the 66 return `trigger` (all plpgsql). They are not callable over
--     PostgREST: invoked directly, plpgsql refuses with "trigger functions can
--     only be called as triggers", and Postgres checks EXECUTE on a trigger
--     function only at CREATE TRIGGER, never when it fires. Out of scope here
--     and untouched (several are the legally required enforcement triggers of
--     migration 017).
--
--   * 13 are plain functions, all keyed on auth.uid(). The anon key's JWT has
--     no `sub`, so for anon they answer false, NULL, an empty set, or raise
--     42501. None of them leaks or changes data for an unauthenticated caller
--     today; this is defense in depth (class B), not a live hole:
--
--       RLS and authorization helpers (ACL: PUBLIC, anon, authenticated,
--       service_role):
--         user_company_ids(), user_team_ids(), current_active_company_id(),
--         current_user_can_write(), user_role_in_company(uuid),
--         user_is_company_admin(uuid), user_is_team_admin(uuid),
--         caller_can_write_company(uuid), caller_is_company_owner(uuid),
--         caller_is_team_owner(uuid)
--       Invoice delivery readers (ACL: anon, authenticated, service_role; the
--       20260723003000 family revoked PUBLIC, but the anon grant from the
--       platform default ACL survived, see below):
--         list_invoice_delivery_summaries(uuid, uuid),
--         latest_sent_invoice_delivery_document(uuid, uuid),
--         export_invoice_delivery_evidence(uuid)
--
-- Why the anon grants are there at all: pg_default_acl for postgres in public
-- grants EXECUTE on every new function to anon, authenticated and
-- service_role, and the builtin default adds PUBLIC (anon is a member of
-- PUBLIC). So a REVOKE must name PUBLIC and anon both, and a REVOKE FROM
-- PUBLIC alone (the invoice delivery readers) still leaves anon in.
--
-- Callers checked before revoking (repo at e922558b0):
--   * user_is_company_admin: src/lib/auth/require-write.ts on the route's
--     session client (authenticated).
--   * export_invoice_delivery_evidence: src/lib/reports/full-archive-export.ts,
--     session or service client.
--   * list_invoice_delivery_summaries: src/app/api/invoices/[id]/deliveries,
--     src/lib/invoices/resend-invoice.ts, session client.
--   * latest_sent_invoice_delivery_document: src/lib/invoices/
--     book-invoice-deferred.ts, session client.
--   * The rest are reached only from RLS policies, other SECURITY DEFINER
--     functions (run as the owner) and the SECURITY INVOKER writer-role
--     triggers, which fire as authenticated, service_role or postgres.
--   * Nothing calls them as anon on purpose. The public token pages (payslip,
--     attest, betala, koppla, invoice-action, invite) use the service client;
--     the sandbox signs in anonymously, which is the authenticated role; the
--     public-scope /api/v1 route (health) touches no table. pre_request_
--     statement_timeout, which PostgREST runs as anon on every request, is not
--     SECURITY DEFINER and calls none of these: untouched.
--
-- What changes for an anon caller: a table whose RLS policy calls one of the
-- helpers (142 legacy tables still carry an anon table grant) now answers
-- 42501 instead of an empty 200. No policy on those tables gives anon rows by
-- any other route (every other policy that applies to anon is auth.uid()-based
-- or `false`), so no anon read loses data. The anon reads in the edge logs
-- are expired browser sessions and two event handlers on a cookieless client;
-- the ones checked (company settings, nav badge counts, the supplier invoice
-- retro-match, the credit-note payment-link handler) treat an error exactly
-- like "no row", and the same tabs already get 401 from tables and RPCs that
-- never had an anon grant (bank_transaction_parts, collection RPCs). It also ends an
-- unauthenticated slow scan: anon reads of audit_log currently run into the
-- 3 s anon statement_timeout (500); with the helper refused at executor start
-- the request fails before scanning.
--
-- What does not change: authenticated and service_role keep EXECUTE on every
-- function touched. The loop records each role's privilege before the REVOKE
-- and re-grants it explicitly, so a function that authenticated reached only
-- through PUBLIC (any database built without the platform default ACL, e.g. a
-- preview branch) keeps it. No function body changes and every one of them
-- already pins search_path.
--
-- A loop, not a hand list, for the reason 20260901100000 gives: the predicate
-- is the advisor's own (SECURITY DEFINER, callable by anon, minus triggers),
-- so the database ends with zero offenders whatever drift exists between
-- production, pg-real and preview branches. tests/pg/anon-definer-functions.pg.test.ts
-- asserts the same predicate and fails CI on the next function that ships
-- without `REVOKE EXECUTE ... FROM PUBLIC, anon`.
--
-- pg-test: tests/pg/anon-definer-functions.pg.test.ts

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
       -- REVOKE ... ON FUNCTION rejects a procedure; public holds none.
       AND p.prokind = 'f'
       AND p.prorettype <> 'trigger'::regtype
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
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
