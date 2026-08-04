-- Fix the SIE import statement timeout for real this time.
--
-- 20260629160100 (replace_sie_import / undo_sie_import) and 20260721144311
-- (import_sie_journal_entries) raised statement_timeout to 290s via
-- ALTER FUNCTION ... SET. That is a no-op for the enclosing call: Postgres
-- arms the statement_timeout timer when the top-level statement STARTS,
-- using the role-level value in effect at that moment (authenticated = 8s),
-- and a function-scoped SET applied mid-statement never re-arms the timer.
-- Proven empirically 2026-08-04: a probe function declaring
-- SET statement_timeout = '10s' around a 3s sleep was still cancelled by a
-- 1s session timeout. Large SIE imports therefore still fail at 8s with
-- "canceling statement due to statement timeout".
--
-- Working mechanism: a PostgREST pre-request hook. PostgREST invokes
-- pgrst.db_pre_request as its OWN statement inside the request transaction,
-- before the main query, so a transaction-local set_config here changes the
-- value the main statement's timer is armed with. Scoped by request path to
-- the three SIE RPCs; every other request keeps the role default (8s).
-- 290s stays just under the calling routes' maxDuration = 300 ceiling
-- (/api/import/sie/execute, /api/import/sie/[id]/replace and undo,
-- /api/extensions/ext/[...path], /api/v1/.../imports/sie).
--
-- The function runs on EVERY PostgREST request: it must be cheap and must
-- never throw (an error here fails all API requests). current_setting with
-- missing_ok handles direct connections where request.path is absent.

create or replace function public.pre_request_statement_timeout()
returns void
language plpgsql
as $$
begin
  if coalesce(current_setting('request.path', true), '')
       ~ '/rpc/(import_sie_journal_entries|replace_sie_import|undo_sie_import)$'
  then
    perform set_config('statement_timeout', '290s', true);
  end if;
end;
$$;

alter role authenticator set pgrst.db_pre_request = 'public.pre_request_statement_timeout';

notify pgrst, 'reload config';
notify pgrst, 'reload schema';
