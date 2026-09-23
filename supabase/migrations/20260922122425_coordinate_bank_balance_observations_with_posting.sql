-- Balance observations also take cash row locks. Acquire the company lock
-- before the connection/cash locks so bank posting can wait in that order.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.persist_bank_sync_result(uuid,uuid,text,timestamptz,timestamptz,jsonb,jsonb)'::regprocedure);
  v_old text := '  -- RLS and invoker privileges also apply to the row lock and balance writes.';
  v_new text := $replacement$
  -- Preserve the invoker's not-found/tenant contract before privileged locking.
  IF NOT EXISTS (
    SELECT 1 FROM public.bank_connections
    WHERE id = p_connection_id AND company_id = p_company_id
  ) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_found');
  END IF;
  PERFORM public.lock_cash_account_company(p_company_id);

  -- Re-read connection/session state after waiting, under the invoker's RLS.
$replacement$;
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Unexpected bank sync result definition';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
