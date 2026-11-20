-- Drop the legacy one-shot SIE import functions.
--
-- import_sie_journal_entries(uuid,uuid,uuid,jsonb), replace_sie_import(uuid,uuid,uuid)
-- and undo_sie_import(uuid,uuid,uuid) were the writer and the period-wide
-- deletes of the one-shot SIE import. The durable job backbone replaced them
-- and 20260911140532_sie_import_replacement_handoff revoked EXECUTE from
-- PUBLIC, anon, authenticated and service_role, leaving only the owner. The
-- application no longer calls them. Nothing in the database depends on them:
-- other function bodies mention the names only in comments.
--
-- The PostgREST pre-request hook named them only in its path regex. It keeps
-- the body from 20260911140523_sie_import_chunk_writer.sql minus those two
-- branches. CREATE OR REPLACE keeps its owner and grants; it still has no SET
-- clause, no SECURITY DEFINER and default volatility. It runs on EVERY
-- PostgREST request: it must stay cheap and must never throw.
--
-- The pending-operation type 'undo_sie_import' is a different thing (a
-- staged MCP action that now runs request_sie_import_undo) and stays.

CREATE OR REPLACE FUNCTION public.pre_request_statement_timeout() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_path text := coalesce(current_setting('request.path', true), '');
BEGIN
  IF v_path ~ '/rpc/(import_sie_chunk|reconcile_sie_import)$' THEN
    PERFORM set_config('statement_timeout', '30s', true);
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.import_sie_journal_entries(uuid, uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.replace_sie_import(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.undo_sie_import(uuid, uuid, uuid);

NOTIFY pgrst, 'reload schema';
