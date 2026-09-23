-- Preserve the legacy hash guard while giving each deliberate execution a
-- separate identity. A replacement is reserved before any reversal starts.
DROP INDEX public.sie_imports_company_id_file_hash_active_idx;
CREATE UNIQUE INDEX sie_imports_company_id_file_hash_active_idx
  ON public.sie_imports(company_id,file_hash)
  WHERE job_state IS NULL AND status NOT IN ('replaced','failed','undone');
CREATE UNIQUE INDEX sie_job_active_hash_idx ON public.sie_imports(company_id,fiscal_period_id,file_hash)
  WHERE job_state IS NOT NULL AND job_phase <> 'undo' AND job_state NOT IN ('undone','failed');
CREATE UNIQUE INDEX sie_job_successor_idx ON public.sie_imports(supersedes_import_id)
  WHERE supersedes_import_id IS NOT NULL AND job_state NOT IN ('undone','failed');

CREATE FUNCTION public.replace_sie_import_job(p_company_id uuid,p_actor uuid,p_period_id uuid,
  p_filename text,p_file_hash text,p_manifest jsonb,p_supersedes_import_id uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_previous public.sie_imports;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_previous FROM public.sie_imports WHERE id = p_supersedes_import_id
    AND company_id = p_company_id AND fiscal_period_id = p_period_id FOR UPDATE;
  IF NOT FOUND OR v_previous.job_state IS NULL THEN
    RAISE EXCEPTION 'Legacy SIE import requires reviewed reconciliation before replacement' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_job FROM public.sie_imports WHERE supersedes_import_id = p_supersedes_import_id
    AND company_id = p_company_id AND job_state NOT IN ('undone','failed') ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_job.file_hash IS DISTINCT FROM p_file_hash OR v_job.manifest->'input' IS DISTINCT FROM p_manifest->'input' THEN
      RAISE EXCEPTION 'SIE replacement already reserved with different input' USING ERRCODE = '23505';
    END IF;
    RETURN v_job;
  END IF;
  IF v_previous.job_state NOT IN ('completed','undoing','undone') THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it first' USING ERRCODE = '55000';
  END IF;
  IF v_previous.job_state = 'completed' THEN
    PERFORM public.request_sie_import_undo(p_company_id,p_supersedes_import_id,p_actor);
  END IF;
  RETURN public.start_sie_import_job(p_company_id,p_actor,p_period_id,p_filename,p_file_hash,p_manifest,p_supersedes_import_id);
END;
$$;
REVOKE ALL ON FUNCTION public.replace_sie_import_job(uuid,uuid,uuid,text,text,jsonb,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.replace_sie_import_job(uuid,uuid,uuid,text,text,jsonb,uuid) TO authenticated,service_role;

CREATE FUNCTION public.handoff_sie_replacement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_successor uuid;
BEGIN
  IF NEW.job_state = 'undone' AND OLD.job_state IS DISTINCT FROM 'undone' THEN
    SELECT id INTO v_successor FROM public.sie_imports WHERE supersedes_import_id = NEW.id
      AND company_id = NEW.company_id AND job_state = 'queued' FOR UPDATE;
    IF v_successor IS NOT NULL THEN
      UPDATE public.fiscal_periods SET import_hold = v_successor
        WHERE id = NEW.fiscal_period_id AND company_id = NEW.company_id AND import_hold = NEW.id;
      IF NOT FOUND THEN RAISE EXCEPTION 'SIE replacement lost its period hold'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.handoff_sie_replacement() FROM PUBLIC;
CREATE TRIGGER handoff_sie_replacement AFTER UPDATE OF job_state ON public.sie_imports
  FOR EACH ROW EXECUTE FUNCTION public.handoff_sie_replacement();

-- Inline correction writes lines without updating the header. They must wait
-- too, and corrections of a completed batch must not race batch undo.
CREATE FUNCTION public.guard_sie_held_lines() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_entry public.journal_entries; v_hold uuid;
BEGIN
  SELECT * INTO v_entry FROM public.journal_entries
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  IF v_entry.import_batch_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT import_hold INTO v_hold FROM public.fiscal_periods WHERE id = v_entry.fiscal_period_id FOR UPDATE NOWAIT;
  IF v_hold IS NOT NULL AND v_entry.import_batch_id = v_hold AND v_entry.status <> 'draft' THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: vänta med rättelser tills importen är slutförd' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_held_lines() FROM PUBLIC;
CREATE TRIGGER guard_sie_held_lines BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_held_lines();

CREATE FUNCTION public.retain_sie_batch_entry() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.import_batch_id IS NOT NULL THEN
    RAISE EXCEPTION 'SIE batch entries cannot be deleted; use batch storno' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.retain_sie_batch_entry() FROM PUBLIC;
CREATE TRIGGER retain_sie_batch_entry BEFORE DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.retain_sie_batch_entry();

-- The one-shot writer and period-scoped deletes are retired at cutover.
-- No flag can reinstate a second ledger writer or its deletion bypass.
DO $$ DECLARE v_signature regprocedure;
BEGIN
  FOR v_signature IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('import_sie_journal_entries','undo_sie_import','replace_sie_import')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_signature);
  END LOOP;
END; $$;

NOTIFY pgrst,'reload schema';

