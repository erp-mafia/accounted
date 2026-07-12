-- Raise statement_timeout inside the SIE bulk-delete RPCs so replacing /
-- undoing a large import does not get cancelled mid-delete.
--
-- Background: replace_sie_import / undo_sie_import hard-delete every
-- source_type='import' (and 'opening_balance') journal entry for a period.
-- Each DELETE fires write_audit_log (a JSONB old_state snapshot insert) and
-- cascades to journal_entry_lines, so a real-world migration import (e.g.
-- ~2,700 vouchers / ~12,000 lines) takes well over 8 seconds.
--
-- The original migration (20260526120000) routed these RPCs onto the
-- service-role REST client on the assumption that "the service role has no
-- statement_timeout". That assumption is wrong: pg_roles shows
-- service_role.rolconfig IS NULL, so a PostgREST request keeps the 8s
-- statement_timeout that the `authenticator` login role sets. The role
-- switch (SET ROLE service_role) does not reset the session GUC because
-- service_role carries no statement_timeout of its own. Result: the delete
-- is cancelled with "canceling statement due to statement timeout", the RPC
-- rolls back, and the route returns SIE_REPLACE_FAILED / SIE_UNDO_FAILED.
--
-- Fix: attach a function-local statement_timeout to each SECURITY DEFINER
-- RPC. A function-scoped SET re-arms the timer for the duration of the call
-- (PostgreSQL re-evaluates statement_timeout when the GUC changes) and is
-- restored on function exit. 290s sits just under the route's
-- maxDuration=300 ceiling, so the HTTP/serverless layer remains the
-- effective bound while the DB no longer cancels a legitimate cleanup.
--
-- Bodies are unchanged; only the function configuration is altered.

ALTER FUNCTION public.replace_sie_import(uuid, uuid)
  SET statement_timeout = '290s';

ALTER FUNCTION public.undo_sie_import(uuid, uuid, uuid)
  SET statement_timeout = '290s';

NOTIFY pgrst, 'reload schema';
