-- Durable SIE executions. Existing imports retain job_state NULL until their
-- provenance is explicitly reconciled. No historical ledger rows are changed.
ALTER TABLE public.sie_imports
  ADD COLUMN job_state text CHECK (job_state IN ('queued','preparing','running','reconciling','paused','finalizing','completed','undoing','undone','failed')),
  ADD COLUMN job_phase text CHECK (job_phase IN ('prepare','vouchers','finalize','undo')),
  ADD COLUMN job_attempt integer NOT NULL DEFAULT 0 CHECK (job_attempt >= 0),
  ADD COLUMN worker_id uuid,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN chunks_total integer NOT NULL DEFAULT 0,
  ADD COLUMN chunks_done integer NOT NULL DEFAULT 0,
  ADD COLUMN prepared_through integer NOT NULL DEFAULT 0,
  ADD COLUMN manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN job_result jsonb,
  ADD COLUMN supersedes_import_id uuid REFERENCES public.sie_imports(id),
  ADD COLUMN execution_actor_id uuid REFERENCES auth.users(id),
  ADD CONSTRAINT sie_job_counters CHECK (chunks_done >= 0 AND chunks_done <= chunks_total),
  ADD CONSTRAINT sie_job_phase_required CHECK (job_state IS NULL OR job_phase IS NOT NULL),
  ADD CONSTRAINT sie_imports_id_company_key UNIQUE (id, company_id);

ALTER TABLE public.fiscal_periods
  ADD COLUMN import_hold uuid,
  ADD CONSTRAINT fiscal_period_import_hold_fk FOREIGN KEY (import_hold, company_id)
    REFERENCES public.sie_imports(id, company_id);

ALTER TABLE public.journal_entries
  ADD COLUMN import_batch_id uuid,
  ADD COLUMN source_ordinal integer,
  ADD COLUMN source_content_hash text,
  ADD CONSTRAINT journal_import_batch_company_fk FOREIGN KEY (import_batch_id, company_id)
    REFERENCES public.sie_imports(id, company_id),
  ADD CONSTRAINT journal_import_identity_complete CHECK (
    (import_batch_id IS NULL AND source_ordinal IS NULL AND source_content_hash IS NULL)
    OR (import_batch_id IS NOT NULL AND source_ordinal IS NOT NULL
      AND source_ordinal >= 0 AND source_content_hash IS NOT NULL
      AND source_content_hash ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX journal_import_batch_ordinal_idx
  ON public.journal_entries(import_batch_id, source_ordinal)
  WHERE import_batch_id IS NOT NULL;

-- Legacy duplicates must be repaired before broadening this to all posted
-- imports. The start guard refuses periods containing unowned posted imports.
CREATE UNIQUE INDEX journal_import_source_owned_idx
  ON public.journal_entries(company_id, fiscal_period_id, source_voucher_series, source_voucher_number)
  WHERE source_type = 'import' AND status = 'posted' AND import_batch_id IS NOT NULL;

CREATE INDEX sie_job_due_idx ON public.sie_imports(next_attempt_at, created_at)
  WHERE job_state IS NOT NULL AND job_state NOT IN ('completed','undone','failed');
CREATE INDEX sie_job_period_idx ON public.sie_imports(company_id, fiscal_period_id)
  WHERE job_state IS NOT NULL;

CREATE FUNCTION public.guard_sie_entry_provenance() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.source_type = 'import' AND NEW.import_batch_id IS NULL AND
    (TG_OP = 'INSERT' OR OLD.source_type IS DISTINCT FROM 'import') THEN
    RAISE EXCEPTION 'SIE imports require a durable batch identity' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id OR
      NEW.source_ordinal IS DISTINCT FROM OLD.source_ordinal OR
      NEW.source_content_hash IS DISTINCT FROM OLD.source_content_hash) THEN
    RAISE EXCEPTION 'SIE entry provenance is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.import_batch_id IS NOT NULL AND
     current_user IN ('anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'SIE entry provenance requires the import engine' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_entry_provenance() FROM PUBLIC;
CREATE TRIGGER guard_sie_entry_provenance BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_entry_provenance();

CREATE TABLE public.sie_import_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  phase text NOT NULL CHECK (phase IN ('prepare','vouchers','finalize','undo')),
  chunk_no integer NOT NULL CHECK (chunk_no >= 0),
  payload jsonb,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed')),
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (import_id, company_id) REFERENCES public.sie_imports(id, company_id),
  UNIQUE (import_id, phase, chunk_no),
  CHECK (state <> 'completed' OR (result IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (octet_length(payload::text) <= 1200000)
);
ALTER TABLE public.sie_import_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY sie_chunks_read ON public.sie_import_chunks FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));
-- Clients cannot forge receipts, delete checkpoints or replace approved input.
REVOKE ALL ON public.sie_import_chunks FROM anon, authenticated, service_role;
GRANT SELECT ON public.sie_import_chunks TO authenticated, service_role;
CREATE INDEX sie_chunks_company_idx ON public.sie_import_chunks(company_id);
CREATE TRIGGER sie_chunks_updated_at BEFORE UPDATE ON public.sie_import_chunks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Trusted RPCs run as the owner; direct REST writes cannot forge job state.
CREATE FUNCTION public.guard_sie_execution_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SIE execution history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF current_user IN ('anon','authenticated','service_role')
     AND (NEW.job_state IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.job_state IS NOT NULL)) THEN
    RAISE EXCEPTION 'SIE execution metadata requires an authorized RPC' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.job_state IN ('completed','undone')
     AND NEW.manifest IS DISTINCT FROM OLD.manifest THEN
    RAISE EXCEPTION 'SIE execution manifest is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_execution_metadata() FROM PUBLIC;
CREATE TRIGGER guard_sie_execution_metadata BEFORE INSERT OR UPDATE OR DELETE ON public.sie_imports
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_execution_metadata();

CREATE FUNCTION public.authorize_sie_execution(p_company_id uuid, p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '');
BEGIN
  IF p_actor IS NULL OR p_company_id IS NULL OR
     (v_role <> 'service_role' AND auth.uid() IS DISTINCT FROM p_actor) OR
     NOT EXISTS (SELECT 1 FROM public.company_members WHERE company_id = p_company_id
       AND user_id = p_actor AND role <> 'viewer') THEN
    RAISE EXCEPTION 'SIE import requires company write access' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.authorize_sie_execution(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Every job RPC uses this order: company advisory lock, job row, period row.
-- A lease takeover and a chunk commit cannot pass each other in that order.
CREATE FUNCTION public.lock_sie_execution(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text, 0));
  SELECT * INTO v_job FROM public.sie_imports
    WHERE id = p_import_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_state IS NULL THEN
    RAISE EXCEPTION 'SIE execution not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.authorize_sie_execution(p_company_id, coalesce(v_job.execution_actor_id, v_job.user_id));
  IF p_worker_id IS NULL OR p_attempt IS NULL OR
     v_job.worker_id IS DISTINCT FROM p_worker_id OR v_job.job_attempt <> p_attempt OR
     v_job.lease_until IS NULL OR v_job.lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'SIE worker lease or attempt is stale' USING ERRCODE = '40001';
  END IF;
  PERFORM 1 FROM public.fiscal_periods WHERE id = v_job.fiscal_period_id
    AND company_id = p_company_id AND import_hold = p_import_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SIE import hold missing' USING ERRCODE = '55000'; END IF;
  UPDATE public.sie_imports SET lease_until = clock_timestamp() + interval '2 minutes'
    WHERE id = p_import_id;
  RETURN v_job;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_sie_execution(uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.start_sie_import_job(p_company_id uuid, p_actor uuid,
  p_period_id uuid, p_filename text, p_file_hash text, p_manifest jsonb,
  p_supersedes_import_id uuid DEFAULT NULL) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id, p_actor);
  IF p_file_hash !~ '^[0-9a-f]{64}$' OR p_file_hash IS NULL OR
     jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR
     octet_length(p_manifest::text) > 1000000 THEN
    RAISE EXCEPTION 'Invalid SIE import manifest' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text, 0));
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = p_period_id
    AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE = 'P0002'; END IF;
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Fiscal period is locked or closed' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_job FROM public.sie_imports WHERE company_id = p_company_id
    AND fiscal_period_id = p_period_id AND file_hash = p_file_hash
    AND job_state IS NOT NULL AND job_state NOT IN ('undone','failed')
    AND id IS DISTINCT FROM p_supersedes_import_id
    ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_job.manifest->'input' IS DISTINCT FROM p_manifest->'input' THEN
      RAISE EXCEPTION 'SIE retry has different mapping or options' USING ERRCODE = '23505';
    END IF;
    RETURN v_job;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sie_imports WHERE company_id = p_company_id
      AND job_state NOT IN ('completed','undone','failed') AND id IS DISTINCT FROM p_supersedes_import_id)
      OR (v_period.import_hold IS NOT NULL AND v_period.import_hold IS DISTINCT FROM p_supersedes_import_id) THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE company_id = p_company_id
      AND fiscal_period_id = p_period_id AND source_type IN ('import','opening_balance') AND status = 'posted'
      AND (p_supersedes_import_id IS NULL OR import_batch_id IS DISTINCT FROM p_supersedes_import_id)) OR
     EXISTS (SELECT 1 FROM public.sie_imports WHERE company_id = p_company_id
      AND fiscal_year_start <= v_period.period_end AND fiscal_year_end >= v_period.period_start
      AND id IS DISTINCT FROM p_supersedes_import_id
      AND (status = 'completed' OR (job_state IS NULL AND status IN ('pending','mapped')))) THEN
    RAISE EXCEPTION 'Existing SIE import requires reviewed replacement or reconciliation' USING ERRCODE = '55000';
  END IF;
  IF p_supersedes_import_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sie_imports
      WHERE id = p_supersedes_import_id AND company_id = p_company_id
      AND fiscal_period_id = p_period_id AND job_state IN ('undone','undoing')) THEN
    RAISE EXCEPTION 'SIE predecessor has not been completely undone' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.sie_imports(company_id, user_id, filename, file_hash, sie_type,
    fiscal_period_id, fiscal_year_start, fiscal_year_end, status, job_state, job_phase,
    manifest, supersedes_import_id, file_storage_path, execution_actor_id)
  VALUES (p_company_id, p_actor, p_filename, p_file_hash, 4, p_period_id,
    v_period.period_start, v_period.period_end, 'pending', 'queued', 'prepare',
    p_manifest || jsonb_build_object('prior_activity', EXISTS (
      SELECT 1 FROM public.journal_entries WHERE company_id = p_company_id
        AND source_type NOT IN ('opening_balance','storno') AND status = 'posted'
        AND (p_supersedes_import_id IS NULL OR import_batch_id IS DISTINCT FROM p_supersedes_import_id)
        AND entry_date <= v_period.period_end)),
    p_supersedes_import_id, p_manifest->>'file_storage_path', p_actor) RETURNING * INTO v_job;
  -- During replacement the predecessor keeps the hold until its last undo
  -- checkpoint. The successor cannot be claimed before that handoff.
  UPDATE public.fiscal_periods SET import_hold = v_job.id WHERE id = p_period_id AND import_hold IS NULL;
  RETURN v_job;
END;
$$;
REVOKE ALL ON FUNCTION public.start_sie_import_job(uuid, uuid, uuid, text, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_sie_import_job(uuid, uuid, uuid, text, text, jsonb, uuid) TO authenticated, service_role;

-- Claim at most two unexpired leases globally. Claim serialization is short;
-- it is never held while writing ledger rows. Only the server cron can claim.
CREATE FUNCTION public.claim_sie_import_job(p_worker_id uuid, p_import_id uuid DEFAULT NULL)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  IF p_worker_id IS NULL THEN RAISE EXCEPTION 'Worker identity required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-platform-claim', 0));
  IF (SELECT count(*) FROM public.sie_imports WHERE lease_until > clock_timestamp()
      AND job_state NOT IN ('completed','undone','failed')) >= 2 THEN RETURN NULL; END IF;
  SELECT * INTO v_job FROM public.sie_imports
    WHERE job_state NOT IN ('completed','undone','failed')
      AND (p_import_id IS NULL OR id = p_import_id)
      AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
      AND EXISTS (SELECT 1 FROM public.company_members m WHERE m.company_id = sie_imports.company_id
        AND m.user_id = coalesce(sie_imports.execution_actor_id,sie_imports.user_id) AND m.role <> 'viewer')
      AND EXISTS (SELECT 1 FROM public.fiscal_periods p WHERE p.id = sie_imports.fiscal_period_id
        AND p.company_id = sie_imports.company_id AND p.import_hold = sie_imports.id)
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Nonblocking company acquisition avoids deadlocks with a committing worker.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-company:' || v_job.company_id::text, 0)) THEN RETURN NULL; END IF;
  UPDATE public.sie_imports SET worker_id = p_worker_id,
    lease_until = clock_timestamp() + interval '2 minutes', job_attempt = job_attempt + 1,
    job_state = CASE job_phase WHEN 'prepare' THEN 'preparing' WHEN 'undo' THEN 'undoing'
      WHEN 'finalize' THEN 'finalizing' ELSE 'running' END
    WHERE id = v_job.id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_sie_import_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sie_import_job(uuid, uuid) TO service_role;

CREATE FUNCTION public.reconcile_sie_import(p_company_id uuid, p_import_id uuid, p_actor uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id, p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text, 0));
  SELECT * INTO v_job FROM public.sie_imports WHERE id = p_import_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_state IS NULL THEN RAISE EXCEPTION 'SIE execution not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.job_state IN ('completed','undone','failed') THEN RETURN v_job; END IF;
  IF v_job.job_state = 'queued' AND v_job.supersedes_import_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.fiscal_periods WHERE id = v_job.fiscal_period_id AND import_hold = v_job.supersedes_import_id
  ) THEN RETURN v_job; END IF;
  -- Receipt and progress are in the voucher transaction, so this observes the
  -- committed step, even if its HTTP response never reached the worker.
  UPDATE public.sie_imports SET job_attempt = job_attempt + 1, worker_id = NULL,
    lease_until = NULL, next_attempt_at = NULL,
    job_state = CASE job_phase WHEN 'prepare' THEN 'preparing' WHEN 'undo' THEN 'undoing'
      WHEN 'finalize' THEN 'finalizing' ELSE CASE WHEN chunks_done = chunks_total
        THEN 'finalizing' ELSE 'running' END END,
    job_phase = CASE WHEN job_phase = 'vouchers' AND chunks_done = chunks_total THEN 'finalize' ELSE job_phase END
    WHERE id = p_import_id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;
REVOKE ALL ON FUNCTION public.reconcile_sie_import(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_sie_import(uuid, uuid, uuid) TO authenticated, service_role;

CREATE FUNCTION public.record_sie_job_failure(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  v_job := public.lock_sie_execution(p_company_id, p_import_id, p_worker_id, p_attempt);
  UPDATE public.sie_imports SET consecutive_failures = consecutive_failures + 1,
    job_state = CASE WHEN consecutive_failures >= 2 THEN 'paused' ELSE 'reconciling' END,
    error_message = left(p_error, 2000), worker_id = NULL, lease_until = NULL,
    job_attempt = job_attempt + 1,
    next_attempt_at = clock_timestamp() + make_interval(secs => least(3600, 15 * power(2, least(consecutive_failures, 8)))::integer)
    WHERE id = p_import_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_sie_job_failure(uuid, uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sie_job_failure(uuid, uuid, uuid, integer, text) TO service_role;

-- A separate trigger adds hold enforcement without editing migration 017's
-- legal period guards. The hold itself can only change in trusted RPCs.
CREATE FUNCTION public.guard_sie_period_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.import_hold IS DISTINCT FROM OLD.import_hold AND current_user IN ('anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'SIE import hold requires an authorized RPC' USING ERRCODE = '42501';
  END IF;
  IF OLD.import_hold IS NOT NULL AND (
      (NEW.is_closed AND NOT coalesce(OLD.is_closed, false)) OR
      (NEW.locked_at IS NOT NULL AND OLD.locked_at IS NULL) OR
      NEW.closing_entry_id IS DISTINCT FROM OLD.closing_entry_id) THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it before closing' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_period_hold() FROM PUBLIC;
CREATE TRIGGER guard_sie_period_hold BEFORE UPDATE ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_period_hold();

NOTIFY pgrst, 'reload schema';

