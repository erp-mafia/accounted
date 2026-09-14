-- Default remains full per-header audit. Compact import audit is an explicit
-- server-only opt-in, pinned before the first journal chunk is committed.
ALTER TABLE public.sie_imports ADD COLUMN audit_mode text NOT NULL DEFAULT 'full'
  CHECK (audit_mode IN ('full','chunk'));

CREATE FUNCTION public.set_sie_import_audit_mode(p_company_id uuid,p_import_id uuid,
  p_worker_id uuid,p_attempt integer,p_mode text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  v_job := public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  IF v_job.job_phase <> 'prepare' OR v_job.transactions_count <> 0 OR p_mode NOT IN ('full','chunk') OR p_mode IS NULL THEN
    RAISE EXCEPTION 'SIE audit mode must be chosen before journal writes' USING ERRCODE = '55000';
  END IF;
  UPDATE public.sie_imports SET audit_mode=p_mode,manifest=manifest || jsonb_build_object('auditMode',p_mode)
    WHERE id=p_import_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_sie_import_audit_mode(uuid,uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_sie_import_audit_mode(uuid,uuid,uuid,integer,text) TO service_role;

-- Pure scheduling changes are not changes to accounting treatment. The
-- immutable source input and checkpoint receipts retain preparation history.
DROP TRIGGER audit_sie_imports ON public.sie_imports;
CREATE TRIGGER audit_sie_imports_insert
  AFTER INSERT OR DELETE ON public.sie_imports FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
CREATE TRIGGER audit_sie_imports_update
  AFTER UPDATE ON public.sie_imports FOR EACH ROW
  WHEN (OLD.job_state IS NULL OR NEW.job_state IS NULL OR
    OLD.job_state IS DISTINCT FROM NEW.job_state OR OLD.status IS DISTINCT FROM NEW.status OR
    OLD.error_message IS DISTINCT FROM NEW.error_message OR
    OLD.audit_mode IS DISTINCT FROM NEW.audit_mode OR
    (OLD.manifest->'input') IS DISTINCT FROM (NEW.manifest->'input'))
  EXECUTE FUNCTION public.write_audit_log();

CREATE FUNCTION public.audit_sie_completed_chunk() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  IF NEW.phase NOT IN ('vouchers','finalize') OR NEW.state <> 'completed' OR OLD.state = 'completed' THEN RETURN NEW; END IF;
  SELECT * INTO v_job FROM public.sie_imports WHERE id=NEW.import_id AND company_id=NEW.company_id;
  IF v_job.audit_mode <> 'chunk' THEN RETURN NEW; END IF;
  INSERT INTO public.audit_log(user_id,company_id,actor_id,actor_type,action,table_name,record_id,new_state,description)
    VALUES(coalesce(v_job.execution_actor_id,v_job.user_id),NEW.company_id,
      coalesce(v_job.execution_actor_id,v_job.user_id),'user','COMMIT','sie_import_chunks',NEW.id,
      jsonb_build_object('import_id',NEW.import_id,'phase',NEW.phase,'chunk_no',NEW.chunk_no,
        'payload_hash',NEW.payload_hash,'registered_at',NEW.completed_at,'entries',NEW.result->'inserted_entries'),
      'SIE import chunk committed with durable entry identities');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_sie_completed_chunk() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER audit_sie_completed_chunk AFTER UPDATE ON public.sie_import_chunks
  FOR EACH ROW EXECUTE FUNCTION public.audit_sie_completed_chunk();

-- The header audit function and trigger follow below. The ordinary generic
-- audit function and every accounting enforcement trigger remain unchanged.

CREATE OR REPLACE FUNCTION public.write_sie_header_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id    uuid;
  v_company_id uuid;
  v_action     text;
  v_old_state  jsonb;
  v_new_state  jsonb;
  v_record_id  uuid;
  v_desc       text;
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.import_batch_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.sie_imports WHERE id=NEW.import_batch_id AND company_id=NEW.company_id
      AND audit_mode='chunk' AND job_state IN ('running','finalizing') AND job_phase IN ('vouchers','finalize')
  ) THEN RETURN NEW; END IF;
  -- Sandbox teardown (cleanup_sandbox_user) deletes the company row itself;
  -- audit rows inserted mid-cascade would reference the vanishing company
  -- and violate audit_log_company_id_fkey. The flag is transaction-local and
  -- only set after the RPC's is_sandbox check.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;
  END IF;

  -- Fall back to auth.uid() when the row does not carry user_id
  v_user_id := COALESCE(v_user_id, auth.uid());

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.write_sie_header_audit() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER audit_journal_entries ON public.journal_entries;
CREATE TRIGGER audit_journal_entries AFTER INSERT OR UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.write_sie_header_audit();
NOTIFY pgrst, 'reload schema';