-- Top up an imported fiscal year with only its new vouchers (issue #108,
-- crm#1338, crm#1297, crm#1049).
--
-- A company that switches system mid-year keeps booking the last weeks in
-- the old system, then needs those vouchers in Accounted. A card provider,
-- payroll or POS system exports its own verifikat as a SIE 4I file for a
-- year that is already imported. Until now the only way in was to replace the
-- whole year: every verifikat of the earlier import reversed and booked again
-- under new numbers.
--
-- An append is its own import batch, linked to the year's import (its base),
-- written by the same job and the same writer (write_sie_job_entries) as any
-- import. No posted entry is touched; its numbers continue in each series.
-- The application plans it first (lib/import/sie-append.ts): each file
-- voucher is already booked (skipped), changed (the whole append refused),
-- a possible duplicate (skipped unless the user includes it) or new.
--
--   1. sie_imports.base_import_id: the import an append adds to. NULL for
--      every import and replacement. Same company (composite FK).
--   2. sie_append_plan(company, year, source program, prepared entries): the
--      verdict for each prepared entry, read from the books. A voucher's
--      source ref (series, number) is matched only against import batches of
--      the same source program (#PROGRAM): a card provider's A1 is not
--      Fortnox's A1. The content compare is the stored source_content_hash,
--      with the target series taken from the booked entry (a series mapped in
--      an append does not make it another voucher). Without a ref match: a
--      posted entry of the year on the same date with the same lines
--      (account, debit, credit) is a possible duplicate.
--   3. start_sie_append_job: admits a second batch in a year only as an
--      append of the year's completed import. A running job, another run's
--      hold, or a closed or locked year still refuses. An identical retry
--      returns the same job.
--   4. request_sie_import_undo refuses a base import with a live append
--      ('SIE undo requires review: an append batch is live'). A replacement
--      undoes the previous import through it, so it is refused as well. An
--      append undoes alone, like any batch. Body from 20261016005200 with only
--      that check added.
--   5. import_sie_chunk: for an append job, the cross-batch source-ref
--      conflict check reads only batches of the job's source program (the
--      same rule as the plan). Body from 20261016120100 with only that
--      change; every other job is checked exactly as before.
--
-- Signatures, owners and grants of the replaced functions are unchanged
-- (CREATE OR REPLACE keeps them). No journal entry is changed.
--
-- pg-test: tests/pg/sie-append-import.pg.test.ts

ALTER TABLE public.sie_imports
  ADD COLUMN IF NOT EXISTS base_import_id uuid,
  ADD CONSTRAINT sie_imports_base_import_fk FOREIGN KEY (base_import_id, company_id)
    REFERENCES public.sie_imports(id, company_id),
  ADD CONSTRAINT sie_imports_base_import_not_self CHECK (base_import_id IS DISTINCT FROM id);

CREATE INDEX IF NOT EXISTS sie_imports_base_import_idx ON public.sie_imports(base_import_id)
  WHERE base_import_id IS NOT NULL;

COMMENT ON COLUMN public.sie_imports.base_import_id IS
  'The import this batch appends to (issue #108): its own vouchers only, undone alone. NULL for every import and replacement.';

-- The verdict for each prepared SIE entry against the books of one fiscal
-- year. p_entries: the job payload entries (lib/import/sie-append.ts), each
-- with sourceOrdinal, date, sourceSeries, sourceNumber and lines. Returns
-- [{sourceOrdinal, verdict, entryId, voucher}] in payload order, verdict one
-- of present, conflict, possible_duplicate, new. Read-only. SECURITY DEFINER
-- for extensions.digest; a member reads only its own companies.
CREATE FUNCTION public.sie_append_plan(p_company_id uuid, p_period_id uuid, p_source_program text,
  p_entries jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_result jsonb;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id USING ERRCODE = '42501';
  END IF;
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'p_entries must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fiscal_periods WHERE id = p_period_id AND company_id = p_company_id) THEN
    RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE = 'P0002';
  END IF;
  WITH src AS (
    SELECT x.ord, x.e, (x.e->>'sourceOrdinal')::integer AS ordinal,
      nullif(x.e->>'sourceSeries', '') AS source_series,
      CASE WHEN x.e->>'sourceNumber' ~ '^-?[0-9]{1,9}$' THEN (x.e->>'sourceNumber')::integer END AS source_number,
      (x.e->>'date')::date AS entry_date,
      (SELECT string_agg(f, ',' ORDER BY f) FROM (
        SELECT (l->>'account_number') || ':' || round(coalesce((l->>'debit_amount')::numeric, 0), 2)::text || ':'
          || round(coalesce((l->>'credit_amount')::numeric, 0), 2)::text AS f
        FROM jsonb_array_elements(x.e->'lines') l
        WHERE round(coalesce((l->>'debit_amount')::numeric, 0), 2) <> 0
           OR round(coalesce((l->>'credit_amount')::numeric, 0), 2) <> 0) lf) AS fingerprint
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY x(e, ord)
  ), ref AS (
    SELECT s.ord, j.id, coalesce(j.voucher_series, '') || coalesce(j.voucher_number::text, '') AS voucher,
      j.voucher_number,
      j.source_content_hash = encode(extensions.digest(((s.e - 'sieImportId' - 'sourceOrdinal')
        || jsonb_build_object('series', j.voucher_series))::text, 'sha256'), 'hex') AS same
    FROM src s
    JOIN public.journal_entries j ON j.company_id = p_company_id AND j.fiscal_period_id = p_period_id
      AND j.status = 'posted' AND j.source_voucher_number = s.source_number
      AND j.source_voucher_series IS NOT DISTINCT FROM s.source_series
    JOIN public.sie_imports b ON b.id = j.import_batch_id AND b.company_id = p_company_id
      AND (b.migration_documentation->>'sourceSystem') IS NOT DISTINCT FROM p_source_program
    WHERE s.source_number IS NOT NULL
  ), ref_verdict AS (
    SELECT ord, bool_or(same) AS any_same,
      (array_agg(id ORDER BY same DESC, voucher_number))[1] AS entry_id,
      (array_agg(voucher ORDER BY same DESC, voucher_number))[1] AS voucher
    FROM ref GROUP BY ord
  ), unmatched AS (
    SELECT s.* FROM src s
    WHERE s.fingerprint IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ref_verdict r WHERE r.ord = s.ord)
  ), booked AS (
    -- Each posted entry on a date an unmatched voucher carries, fingerprinted once.
    SELECT j.id, j.entry_date, j.voucher_series, j.voucher_number,
      (SELECT string_agg(f, ',' ORDER BY f) FROM (
        SELECT l.account_number || ':' || round(l.debit_amount, 2)::text || ':' || round(l.credit_amount, 2)::text AS f
        FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = j.id AND (round(l.debit_amount, 2) <> 0 OR round(l.credit_amount, 2) <> 0)) jf) AS fingerprint
    FROM public.journal_entries j
    WHERE j.company_id = p_company_id AND j.fiscal_period_id = p_period_id AND j.status = 'posted'
      AND j.source_type <> 'storno' AND j.entry_date IN (SELECT DISTINCT entry_date FROM unmatched)
  ), dup AS (
    SELECT DISTINCT ON (u.ord) u.ord, b.id AS entry_id,
      coalesce(b.voucher_series, '') || coalesce(b.voucher_number::text, '') AS voucher
    FROM unmatched u JOIN booked b ON b.entry_date = u.entry_date AND b.fingerprint = u.fingerprint
    ORDER BY u.ord, b.voucher_series, b.voucher_number
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'sourceOrdinal', s.ordinal,
      'verdict', CASE WHEN r.ord IS NOT NULL THEN CASE WHEN r.any_same THEN 'present' ELSE 'conflict' END
                      WHEN d.ord IS NOT NULL THEN 'possible_duplicate' ELSE 'new' END,
      'entryId', coalesce(r.entry_id, d.entry_id),
      'voucher', coalesce(r.voucher, d.voucher)) ORDER BY s.ord), '[]'::jsonb)
    INTO v_result
    FROM src s LEFT JOIN ref_verdict r ON r.ord = s.ord LEFT JOIN dup d ON d.ord = s.ord;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.sie_append_plan(uuid, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sie_append_plan(uuid, uuid, text, jsonb) TO authenticated, service_role;

-- Admit an append of p_base_import_id: the year's completed import. The
-- shape of start_sie_import_job, with the year's earlier import as its base
-- instead of a refusal. source_program (the file's #PROGRAM) is kept beside
-- input for import_sie_chunk's conflict check. prior_activity is true: an
-- append never books an IB.
CREATE FUNCTION public.start_sie_append_job(p_company_id uuid, p_actor uuid, p_period_id uuid,
  p_filename text, p_file_hash text, p_manifest jsonb, p_base_import_id uuid) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods; v_base public.sie_imports;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id, p_actor);
  IF p_file_hash !~ '^[0-9a-f]{64}$' OR p_file_hash IS NULL OR p_base_import_id IS NULL OR
     jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR
     octet_length(p_manifest::text) > 1000000 OR
     (p_manifest #>> '{input,options,onExistingPeriod}') IS DISTINCT FROM 'append' THEN
    RAISE EXCEPTION 'Invalid SIE import manifest' USING ERRCODE = '22023';
  END IF;
  p_manifest := jsonb_build_object('input',p_manifest->'input',
    'file_storage_path',p_manifest->'file_storage_path',
    'originalSource',p_manifest->'originalSource',
    'source_program',CASE WHEN jsonb_typeof(p_manifest->'source_program') = 'string'
      THEN p_manifest->'source_program' ELSE 'null'::jsonb END)
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
  -- An identical retry (the same file, mapping and options on the same base)
  -- gets the job it started.
  SELECT * INTO v_job FROM public.sie_imports WHERE company_id = p_company_id
    AND fiscal_period_id = p_period_id AND file_hash = p_file_hash
    AND job_state IS NOT NULL AND job_state NOT IN ('undone','failed')
    ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_job.base_import_id IS DISTINCT FROM p_base_import_id OR v_job.manifest->'input' IS DISTINCT FROM p_manifest->'input' THEN
      RAISE EXCEPTION 'SIE retry has different mapping or options' USING ERRCODE = '23505';
    END IF;
    RETURN v_job;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sie_imports WHERE company_id = p_company_id
      AND job_state NOT IN ('completed','undone','failed')) OR v_period.import_hold IS NOT NULL THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_base FROM public.sie_imports WHERE id = p_base_import_id AND company_id = p_company_id;
  IF NOT FOUND OR v_base.fiscal_period_id IS DISTINCT FROM p_period_id OR v_base.job_kind <> 'import'
     OR v_base.job_state IS DISTINCT FROM 'completed' OR v_base.base_import_id IS NOT NULL THEN
    RAISE EXCEPTION 'SIE append requires a completed base import of the year' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.sie_imports(company_id, user_id, filename, file_hash, sie_type,
    fiscal_period_id, fiscal_year_start, fiscal_year_end, status, job_state, job_phase,
    manifest, base_import_id, file_storage_path, execution_actor_id)
  VALUES (p_company_id, p_actor, p_filename, p_file_hash, 4, p_period_id,
    v_period.period_start, v_period.period_end, 'pending', 'queued', 'prepare',
    p_manifest || jsonb_build_object('prior_activity', true),
    p_base_import_id, p_manifest->>'file_storage_path', p_actor) RETURNING * INTO v_job;
  UPDATE public.fiscal_periods SET import_hold = v_job.id WHERE id = p_period_id AND import_hold IS NULL;
  RETURN v_job;
END;
$$;
REVOKE ALL ON FUNCTION public.start_sie_append_job(uuid, uuid, uuid, text, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_sie_append_job(uuid, uuid, uuid, text, text, jsonb, uuid) TO authenticated, service_role;

-- Body from 20261016005200_sie_undo_actor.sql. Added: a base import with a
-- live append (one that is not undone or failed) is refused: undo the
-- appends first, newest first, then the base.
CREATE OR REPLACE FUNCTION public.request_sie_import_undo(p_company_id uuid,p_import_id uuid,p_actor uuid,
  p_actor_type text DEFAULT NULL,p_actor_label text DEFAULT NULL)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods; v_refusal text;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  IF NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=p_company_id AND user_id=p_actor AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'SIE reversal requires company owner or administrator' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE id = p_import_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_state IS NULL THEN RAISE EXCEPTION 'SIE execution not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.job_kind<>'import' THEN RAISE EXCEPTION 'Reviewed repair requires its reviewed stop action' USING ERRCODE='55000'; END IF;
  IF v_job.job_state IN ('undone','failed') THEN RETURN v_job; END IF;
  IF EXISTS (SELECT 1 FROM public.sie_imports appended WHERE appended.company_id = p_company_id
      AND appended.base_import_id = p_import_id AND appended.job_state NOT IN ('undone','failed')) THEN
    RAISE EXCEPTION 'SIE undo requires review: an append batch is live' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sie_imports other
      WHERE other.company_id = p_company_id AND other.id <> p_import_id
        AND other.job_state NOT IN ('completed','undone','failed')
        AND NOT (v_job.job_phase = 'undo' AND other.supersedes_import_id = p_import_id)) THEN
    RAISE EXCEPTION 'Another SIE execution must finish before undo' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = v_job.fiscal_period_id AND company_id = p_company_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.journal_entries original JOIN public.journal_entries reversal
    ON reversal.reverses_id = original.id AND reversal.company_id = p_company_id
    WHERE original.company_id = p_company_id AND original.import_batch_id = p_import_id
      AND original.status = 'posted' AND reversal.status IN ('draft','posted')) THEN
    RAISE EXCEPTION 'SIE undo requires review: a voucher reversal is already in progress' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (WITH RECURSIVE descendants AS (
    SELECT id,status FROM public.journal_entries WHERE company_id = p_company_id AND import_batch_id = p_import_id
    UNION SELECT j.id,j.status FROM public.journal_entries j JOIN descendants d ON j.correction_of_id = d.id
      WHERE j.company_id = p_company_id
  ) SELECT 1 FROM descendants d JOIN public.journal_entries j ON j.id = d.id
    WHERE j.status IN ('draft','posted') AND j.import_batch_id IS DISTINCT FROM p_import_id) THEN
    RAISE EXCEPTION 'SIE undo requires review: an imported voucher has a live correction' USING ERRCODE = '55000';
  END IF;
  IF p_actor IS DISTINCT FROM coalesce(v_job.execution_actor_id,v_job.user_id) AND NOT EXISTS (
    SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_actor AND role IN ('owner','admin')
  ) THEN RAISE EXCEPTION 'SIE undo requires company administrator' USING ERRCODE = '42501'; END IF;
  -- The fiscal year row is locked above, and guard_sie_company_lock_date takes
  -- the same row locks before a lock date can move forward: this answer holds
  -- until the hold below is committed.
  v_refusal := public.sie_undo_lock_refusal(p_company_id,p_import_id);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SIE_IMPORT_PERIOD_LOCKED: ' || v_refusal;
  END IF;
  IF v_period.import_hold IS NOT NULL AND v_period.import_hold <> p_import_id THEN
    RAISE EXCEPTION 'SIE period is locked or has another execution' USING ERRCODE = '55000';
  END IF;
  UPDATE public.fiscal_periods SET import_hold = p_import_id WHERE id = v_period.id;
  -- WHO asked for the undo (the user, API key, OAuth client, ...), beside
  -- the uuid: undo_sie_import_chunk stamps it on every storno it posts.
  UPDATE public.sie_imports SET job_state = 'undoing',job_phase = 'undo',job_attempt = job_attempt+1,
    execution_actor_id = p_actor,worker_id = NULL,lease_until = NULL,next_attempt_at = NULL,error_message = NULL,
    undo_actor_type = p_actor_type,undo_actor_label = CASE WHEN p_actor_type IS NULL THEN NULL ELSE p_actor_label END
    WHERE id = p_import_id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

-- Body from 20261016120100_actor_type_service_account.sql. Changed: an
-- append job's cross-batch source-ref check reads only batches of its own
-- source program (manifest source_program, the plan's rule) and its own
-- batch. Every other job is checked as before.
CREATE OR REPLACE FUNCTION public.import_sie_chunk(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_phase text, p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
DECLARE v_job public.sie_imports; v_chunk public.sie_import_chunks;
  v_result jsonb; v_bad_source text; v_new jsonb; v_existing jsonb; v_actor_type text;
BEGIN
  v_job := public.lock_sie_execution(p_company_id, p_import_id, p_worker_id, p_attempt);
  SELECT * INTO v_chunk FROM public.sie_import_chunks WHERE import_id = p_import_id
    AND phase = p_phase AND chunk_no = p_chunk_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SIE chunk not found' USING ERRCODE = 'P0002'; END IF;
  IF v_chunk.state = 'completed' THEN RETURN v_chunk.result; END IF;
  -- A lease can expire during a slow transaction. Actual writer slots remain
  -- held until commit/rollback, so expiry cannot increase platform concurrency.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:0', 0)) AND
     NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:1', 0)) THEN
    RAISE EXCEPTION 'SIE platform write capacity is busy' USING ERRCODE = '55P03';
  END IF;
  IF p_phase NOT IN ('vouchers','finalize') OR p_phase IS NULL OR v_job.job_phase <> p_phase OR
     (p_phase = 'vouchers' AND p_chunk_no <> v_job.chunks_done) OR
     EXISTS (SELECT 1 FROM public.sie_import_chunks WHERE import_id = p_import_id
       AND phase = p_phase AND chunk_no < p_chunk_no AND state <> 'completed') THEN
    RAISE EXCEPTION 'SIE chunk is out of order' USING ERRCODE = '55000';
  END IF;
  -- Private writer receives only frozen, bounded, company-owned payload.
  -- Validate account ownership here even if a service-role caller prepared it.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_chunk.payload) e,
    LATERAL jsonb_array_elements(e->'lines') l
    WHERE NOT EXISTS (SELECT 1 FROM public.chart_of_accounts a WHERE a.company_id = p_company_id
      AND a.account_number = l->>'account_number' AND a.id = (l->>'account_id')::uuid)) THEN
    RAISE EXCEPTION 'SIE account does not belong to company' USING ERRCODE = '42501';
  END IF;
  SELECT e->>'sourceId' INTO v_bad_source
  FROM jsonb_array_elements(v_chunk.payload) e JOIN public.journal_entries j
    ON j.company_id = p_company_id AND j.fiscal_period_id = v_job.fiscal_period_id
    AND ((j.import_batch_id = p_import_id AND j.source_ordinal = (e->>'sourceOrdinal')::integer)
      OR (j.source_type = 'import' AND j.status = 'posted' AND
        j.source_voucher_series = e->>'sourceSeries' AND j.source_voucher_number = (e->>'sourceNumber')::integer
        AND (v_job.base_import_id IS NULL OR j.import_batch_id = p_import_id OR EXISTS (
          SELECT 1 FROM public.sie_imports b WHERE b.id = j.import_batch_id AND b.company_id = p_company_id
            AND (b.migration_documentation->>'sourceSystem') IS NOT DISTINCT FROM (v_job.manifest->>'source_program')))))
  WHERE j.import_batch_id IS DISTINCT FROM p_import_id OR j.source_ordinal IS DISTINCT FROM (e->>'sourceOrdinal')::integer OR
    j.source_content_hash IS DISTINCT FROM encode(extensions.digest((e - 'sieImportId' - 'sourceOrdinal')::text,'sha256'),'hex')
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'SIE conflicting voucher %', v_bad_source USING ERRCODE = '23505'; END IF;

  SELECT coalesce(jsonb_agg(e ORDER BY ord), '[]'::jsonb) INTO v_new
    FROM jsonb_array_elements(v_chunk.payload) WITH ORDINALITY p(e,ord)
    WHERE NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE import_batch_id = p_import_id
      AND source_ordinal = (e->>'sourceOrdinal')::integer);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', j.id,'sourceId',e->>'sourceId',
      'sourceOrdinal',j.source_ordinal,'series',j.voucher_series,'voucherNumber',j.voucher_number,'sourceType',j.source_type)), '[]'::jsonb)
    INTO v_existing FROM jsonb_array_elements(v_chunk.payload) e JOIN public.journal_entries j
      ON j.import_batch_id = p_import_id AND j.source_ordinal = (e->>'sourceOrdinal')::integer;
  -- WHO the chunk's verifikat record as committer: the actor sealed into the
  -- manifest when the import was submitted (the user, key or OAuth client),
  -- not the worker or cron running the chunk. write_sie_job_entries stamps
  -- it from these transaction-local settings, which the audit triggers read
  -- too. A type outside the committed_actor_type list is dropped, never a
  -- reason to fail the chunk; set on every chunk, so nothing carries over.
  v_actor_type := v_job.manifest #>> '{commit_actor,type}';
  IF v_actor_type NOT IN ('user','api_key','mcp_oauth','cron','system','agent_chat','service_account') THEN
    v_actor_type := NULL;
  END IF;
  PERFORM set_config('gnubok.actor_type', coalesce(v_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', CASE WHEN v_actor_type IS NULL THEN ''
    ELSE coalesce(left(v_job.manifest #>> '{commit_actor,label}', 200), '') END, true);
  v_result := public.write_sie_job_entries(p_company_id, coalesce(v_job.execution_actor_id, v_job.user_id), v_job.fiscal_period_id, v_new);
  v_result := jsonb_build_object('inserted_entries', v_existing || (v_result->'inserted_entries'));
  UPDATE public.sie_import_chunks SET state = 'completed', result = v_result, completed_at = clock_timestamp()
    WHERE id = v_chunk.id;
  UPDATE public.sie_imports SET transactions_count = transactions_count + jsonb_array_length(v_new),
    chunks_done = chunks_done + CASE WHEN p_phase = 'vouchers' THEN 1 ELSE 0 END,
    job_phase = CASE WHEN p_phase = 'vouchers' AND chunks_done + 1 = chunks_total THEN 'finalize' ELSE job_phase END,
    job_state = CASE WHEN p_phase = 'vouchers' AND chunks_done + 1 = chunks_total THEN 'finalizing' ELSE job_state END,
    consecutive_failures = 0, error_message = NULL
    WHERE id = p_import_id;
  RETURN v_result;
END;
$$;

NOTIFY pgrst, 'reload schema';
