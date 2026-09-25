-- start_sie_import_job: a hand-entered ingående balans is not an existing import.
--
-- The guard added in 20260911141611 refuses a new SIE import into a fiscal year
-- that already carries posted entries with source_type IN ('import',
-- 'opening_balance'). Its purpose is to stop a year being imported twice
-- without a reviewed replacement, and for SIE-created entries it is right.
--
-- But an opening balance booked through the Excel importer
-- (app/api/import/opening-balance/execute) is not an import: it is the user
-- typing in last year's closing balances. It lands as source_type
-- 'opening_balance', status 'posted', with import_batch_id NULL, and from then
-- on the year can never receive a SIE file: the replacement path needs a
-- supersedes_import_id pointing at an undone sie_imports row, and no such row
-- exists. The web wizard and the MCP tool both go through this RPC, so both
-- dead-end. Observed 2026-09-25 on a company that entered opening balances
-- first and then tried to import its vouchers.
--
-- The fix narrows the entry test to entries that actually came from an import:
--
--   source_type = 'import'
--   OR (source_type = 'opening_balance' AND import_batch_id IS NOT NULL)
--
-- 'import' keeps blocking unconditionally, because the pre-backbone writer
-- created its vouchers with no batch identity at all (see
-- tests/pg/sie-legacy-import-dead-end.pg.test.ts); testing the batch id there
-- would have quietly reopened the year to a second legacy import.
-- write_sie_job_entries writes import_batch_id on every row it creates
-- ((n.entry->>'sieImportId')::uuid), including the #IB voucher it books as
-- source_type 'opening_balance', so a durable import still blocks on both of
-- its entry kinds. A legacy import that produced an opening balance and no
-- vouchers is still caught by the second EXISTS below, which reads the
-- sie_imports row itself rather than the journal.
--
-- Nothing else in the function changes.

CREATE OR REPLACE FUNCTION public.start_sie_import_job(p_company_id uuid, p_actor uuid,
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
  -- Enqueue accepts source inputs only. Checkpoints are worker-owned state.
  p_manifest := jsonb_build_object('input',p_manifest->'input',
    'file_storage_path',p_manifest->'file_storage_path',
    'originalSource',p_manifest->'originalSource');
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text, 0));
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = p_period_id
    AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE = 'P0002'; END IF;
  IF (p_manifest #>> '{input,fiscalYear,start}') IS NULL OR
     (p_manifest #>> '{input,fiscalYear,end}') IS NULL OR
     (p_manifest #>> '{input,fiscalYear,start}')::date < v_period.period_start OR
     (p_manifest #>> '{input,fiscalYear,end}')::date > v_period.period_end OR
     (p_manifest #>> '{input,fiscalYear,start}')::date > (p_manifest #>> '{input,fiscalYear,end}')::date THEN
    RAISE EXCEPTION 'SIE source fiscal year does not fit the target period' USING ERRCODE = '22023';
  END IF;
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
      AND fiscal_period_id = p_period_id AND status = 'posted'
      AND (source_type = 'import'
           OR (source_type = 'opening_balance' AND import_batch_id IS NOT NULL))
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

NOTIFY pgrst, 'reload schema';
