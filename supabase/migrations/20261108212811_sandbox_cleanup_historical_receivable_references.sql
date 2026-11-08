-- Historical receivable references must release their voucher/job/user foreign
-- keys before the sandbox-only teardown deletes those parent rows.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.cleanup_sandbox_user(uuid)'::regprocedure);
  v_old text := '  DELETE FROM public.journal_entry_lines';
  v_new text := $replacement$  DELETE FROM public.historical_receivable_references
  WHERE company_id = ANY(v_companies);

  DELETE FROM public.journal_entry_lines$replacement$;
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Unexpected sandbox cleanup definition';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
