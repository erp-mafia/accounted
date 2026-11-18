-- One refusal rule for admitting an SIE import, read by the import and by
-- everything that answers before it (crm#1272).
--
-- start_sie_import_job refused an import into a fiscal year that already
-- held a posted verifikat with source_type 'opening_balance', any of them,
-- whatever the import was going to book. A company that booked its IB by
-- hand (or got it from a year-end close) and then imported the year's
-- vouchers WITHOUT the file's IB was refused with "Existing SIE import
-- requires reviewed replacement or reconciliation", while the preflight,
-- which never ran that test, answered ok. The SIE wizard was built for that
-- case: its IB toggle defaults off when the year already has an IB verifikat
-- (issue #1882), and a continuation import never books the file's IB at all
-- (crm#1099, prior_activity). A refusal caused only by such a verifikat
-- came with import_opening_balances=false, and the agent then often typed
-- the file's vouchers in by hand.
--
-- Now:
--   * sie_import_admission_refusal is the rule: NULL when the import is
--     admitted, otherwise why not. The preflight, the MCP staging check and
--     start_sie_import_job all call it (lib/import/sie-admission.ts), so an
--     ok there means the import is not refused for anything they can see.
--   * An IB verifikat that no import owns (import_batch_id NULL: booked by
--     hand, by the year-end close or carried forward) refuses only an import
--     that would book its own IB on top of it: import_opening_balances true
--     and no prior activity (the job skips the file's IB otherwise,
--     sie-job-preparation.ts). It is raised with its own prefix and a
--     Swedish sentence naming the verifikat (SIE_IMPORT_PERIOD_HAS_OPENING_
--     BALANCE), never as an existing import.
--   * An import's own vouchers or IB verifikat, and an overlapping import
--     record, refuse as before, with the same message.
--   * prior_activity is sie_import_prior_activity, the same expression, so
--     the manifest and the rule cannot drift.
--
-- start_sie_import_job is the body from 20261015235000 with only these
-- changes; signature, owner, SECURITY DEFINER and grants are unchanged
-- (CREATE OR REPLACE keeps them). No journal entry or other row is changed.
--
-- pg-test: tests/pg/sie-import-admission-refusal.pg.test.ts

-- Whether a year ending p_period_end continues earlier bookkeeping: any
-- posted verifikat that is not an IB or a storno, dated on or before the
-- year's last day (a replacement does not count the import it replaces).
-- Sealed into the job manifest as prior_activity: such an import never
-- books the file's IB (lib/import/sie-job-preparation.ts).
CREATE FUNCTION public.sie_import_prior_activity(p_company_id uuid, p_period_end date,
  p_supersedes_import_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.journal_entries WHERE company_id = p_company_id
      AND source_type NOT IN ('opening_balance','storno') AND status = 'posted'
      AND (p_supersedes_import_id IS NULL OR import_batch_id IS DISTINCT FROM p_supersedes_import_id)
      AND entry_date <= p_period_end);
$$;
REVOKE ALL ON FUNCTION public.sie_import_prior_activity(uuid, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sie_import_prior_activity(uuid, date, uuid) TO authenticated, service_role;

-- Why an import of fiscal year p_period_id would not be admitted, or NULL.
-- p_period_start/p_period_end are the year's dates when the year does not
-- exist yet (the import would create it); an existing year's own dates win.
-- p_import_opening_balances: the job's importOpeningBalances option.
-- Returns {reason, ...}:
--   unfinished_import  another import of the company is not finished, or
--                      another run holds the year (import_id)
--   existing_import    the year holds an import's verifikat, or an import
--                      record overlaps it (import_id when known)
--   opening_balance    the year has an IB verifikat no import owns and this
--                      import would book the file's IB on top of it
--                      (entry_id, voucher, entry_date, message: Swedish)
-- SECURITY INVOKER: a member reads only its own company's rows (RLS);
-- start_sie_import_job calls it with its own rights.
CREATE FUNCTION public.sie_import_admission_refusal(p_company_id uuid, p_period_id uuid,
  p_period_start date, p_period_end date, p_supersedes_import_id uuid,
  p_import_opening_balances boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_period public.fiscal_periods; v_start date := p_period_start; v_end date := p_period_end;
  v_import_id uuid; v_found boolean; v_entry record; v_voucher text;
BEGIN
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = p_period_id AND company_id = p_company_id;
  IF FOUND THEN v_start := v_period.period_start; v_end := v_period.period_end; END IF;

  SELECT id INTO v_import_id FROM public.sie_imports WHERE company_id = p_company_id
    AND job_state NOT IN ('completed','undone','failed') AND id IS DISTINCT FROM p_supersedes_import_id
    ORDER BY created_at DESC LIMIT 1;
  IF v_import_id IS NULL AND v_period.import_hold IS NOT NULL
     AND v_period.import_hold IS DISTINCT FROM p_supersedes_import_id THEN
    v_import_id := v_period.import_hold;
  END IF;
  IF v_import_id IS NOT NULL THEN
    RETURN jsonb_build_object('reason','unfinished_import','import_id',v_import_id);
  END IF;

  SELECT import_batch_id, true INTO v_import_id, v_found FROM public.journal_entries
    WHERE company_id = p_company_id AND fiscal_period_id = p_period_id AND status = 'posted'
      AND (source_type = 'import' OR (source_type = 'opening_balance' AND import_batch_id IS NOT NULL))
      AND (p_supersedes_import_id IS NULL OR import_batch_id IS DISTINCT FROM p_supersedes_import_id)
    LIMIT 1;
  IF NOT coalesce(v_found, false) THEN
    SELECT id, true INTO v_import_id, v_found FROM public.sie_imports WHERE company_id = p_company_id
      AND fiscal_year_start <= v_end AND fiscal_year_end >= v_start
      AND id IS DISTINCT FROM p_supersedes_import_id
      AND (status = 'completed' OR (job_state IS NULL AND status IN ('pending','mapped')))
      ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF coalesce(v_found, false) THEN
    RETURN jsonb_build_object('reason','existing_import','import_id',v_import_id);
  END IF;

  IF coalesce(p_import_opening_balances, false)
     AND NOT public.sie_import_prior_activity(p_company_id, v_end, p_supersedes_import_id) THEN
    SELECT id, voucher_series, voucher_number, entry_date INTO v_entry FROM public.journal_entries
      WHERE company_id = p_company_id AND fiscal_period_id = p_period_id AND status = 'posted'
        AND source_type = 'opening_balance' AND import_batch_id IS NULL
      ORDER BY entry_date, voucher_number LIMIT 1;
    IF FOUND THEN
      v_voucher := coalesce(v_entry.voucher_series, '') || coalesce(v_entry.voucher_number::text, '');
      RETURN jsonb_build_object('reason','opening_balance','entry_id',v_entry.id,'voucher',v_voucher,
        'entry_date',to_char(v_entry.entry_date, 'YYYY-MM-DD'),
        'message',format('Räkenskapsåret %s till %s har redan en bokförd ingående balans (verifikation %s, %s), '
          || 'och importen skulle bokföra filens ingående balans en gång till. Importera filen utan ingående balanser, '
          || 'så läggs verifikationerna ovanpå den bokförda. Är det filens ingående balans som stämmer, korrigera den '
          || 'bokförda först och importera sedan utan ingående balanser.',
          to_char(v_start, 'YYYY-MM-DD'), to_char(v_end, 'YYYY-MM-DD'), v_voucher,
          to_char(v_entry.entry_date, 'YYYY-MM-DD')));
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.sie_import_admission_refusal(uuid, uuid, date, date, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sie_import_admission_refusal(uuid, uuid, date, date, uuid, boolean) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.start_sie_import_job(p_company_id uuid, p_actor uuid,
  p_period_id uuid, p_filename text, p_file_hash text, p_manifest jsonb,
  p_supersedes_import_id uuid DEFAULT NULL) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods; v_refusal jsonb;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id, p_actor);
  IF p_file_hash !~ '^[0-9a-f]{64}$' OR p_file_hash IS NULL OR
     jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR
     octet_length(p_manifest::text) > 1000000 THEN
    RAISE EXCEPTION 'Invalid SIE import manifest' USING ERRCODE = '22023';
  END IF;
  -- Enqueue accepts source inputs only. Checkpoints are worker-owned state.
  -- commit_actor is who submitted the import (sie-jobs.ts
  -- sieImportCommitActor); import_sie_chunk stamps it on the verifikat.
  -- The key is present only when an actor was passed, so a manifest without
  -- one keeps exactly the shape it had before this migration.
  p_manifest := jsonb_build_object('input',p_manifest->'input',
    'file_storage_path',p_manifest->'file_storage_path',
    'originalSource',p_manifest->'originalSource')
    || CASE WHEN jsonb_typeof(p_manifest->'commit_actor') = 'object'
         THEN jsonb_build_object('commit_actor',p_manifest->'commit_actor')
         ELSE '{}'::jsonb END;
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
  -- What the year already holds (crm#1272): the rule the preflight reads.
  -- The job books the file's IB only when importOpeningBalances is true
  -- (sie-job-preparation.ts), so that is what the IB test is given.
  v_refusal := public.sie_import_admission_refusal(p_company_id, p_period_id, v_period.period_start,
    v_period.period_end, p_supersedes_import_id,
    (p_manifest #> '{input,options,importOpeningBalances}') IS NOT DISTINCT FROM 'true'::jsonb);
  IF v_refusal->>'reason' = 'unfinished_import' THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it' USING ERRCODE = '55000';
  ELSIF v_refusal->>'reason' = 'existing_import' THEN
    RAISE EXCEPTION 'Existing SIE import requires reviewed replacement or reconciliation' USING ERRCODE = '55000';
  ELSIF v_refusal->>'reason' = 'opening_balance' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE: ' || (v_refusal->>'message');
  ELSIF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION 'SIE import refused: %', v_refusal->>'reason' USING ERRCODE = '55000';
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
    p_manifest || jsonb_build_object('prior_activity',
      public.sie_import_prior_activity(p_company_id, v_period.period_end, p_supersedes_import_id)),
    p_supersedes_import_id, p_manifest->>'file_storage_path', p_actor) RETURNING * INTO v_job;
  -- During replacement the predecessor keeps the hold until its last undo
  -- checkpoint. The successor cannot be claimed before that handoff.
  UPDATE public.fiscal_periods SET import_hold = v_job.id WHERE id = p_period_id AND import_hold IS NULL;
  RETURN v_job;
END;
$$;

NOTIFY pgrst, 'reload schema';
