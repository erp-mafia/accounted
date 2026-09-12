-- Reject stale work without PostgREST serialization retries, and enforce
-- source trust boundaries before preparation and journal writes.

CREATE OR REPLACE FUNCTION public.lock_sie_execution(p_company_id uuid, p_import_id uuid,
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
    RAISE EXCEPTION 'SIE worker lease or attempt is stale' USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM public.fiscal_periods WHERE id = v_job.fiscal_period_id
    AND company_id = p_company_id AND import_hold = p_import_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SIE import hold missing' USING ERRCODE = '55000'; END IF;
  UPDATE public.sie_imports SET lease_until = clock_timestamp() + interval '2 minutes'
    WHERE id = p_import_id;
  RETURN v_job;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.write_sie_job_entries(
  p_company_id uuid,
  p_user_id uuid,
  p_fiscal_period_id uuid,
  p_entries jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
  v_bad_source text;
  v_bad_debit numeric;
  v_bad_credit numeric;
  v_inserted jsonb;
  v_sie_import_id uuid;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'p_entries must be a JSON array';
  END IF;

  -- Tenant guard: anon/authenticated may only import into their own companies;
  -- service_role / direct access (no JWT role) bypasses for migrations and
  -- server-side maintenance paths that scope company access before calling.
  -- NULL-safe predicate (a NULL company resolves to false) per #881.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF v_jwt_role IN ('anon', 'authenticated')
     AND auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'unauthorized: p_user_id must match auth.uid()'
      USING ERRCODE = '42501';
  END IF;

  -- The fiscal period must belong to the target company: a caller could
  -- otherwise post into another company's period id (defense in depth; the
  -- header company_id/FK would still scope the rows, but fail closed here).
  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_periods
    WHERE id = p_fiscal_period_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'fiscal period % does not belong to company %', p_fiscal_period_id, p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Period identity must cover every entry date, not just the company id.
  SELECT e.value->>'sourceId' INTO v_bad_source
    FROM jsonb_array_elements(p_entries) e
    JOIN public.fiscal_periods p ON p.id = p_fiscal_period_id AND p.company_id = p_company_id
    WHERE e.value->>'date' IS NULL OR (e.value->>'date')::date NOT BETWEEN p.period_start AND p.period_end
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'SIE journal entry % lies outside the target fiscal period', coalesce(v_bad_source,'<unknown>')
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_entries) = 0 THEN
    RETURN jsonb_build_object(
      'inserted_entries', '[]'::jsonb,
      'skipped_duplicates', '[]'::jsonb,
      'validation_errors', '[]'::jsonb
    );
  END IF;

  -- Shape check before any write: every entry must carry a non-empty lines
  -- array. A header without lines would otherwise be skipped by the line join
  -- below and only caught by the deferred trigger at commit, which cannot
  -- name the offending source voucher.
  SELECT e.value->>'sourceId'
  INTO v_bad_source
  FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord)
  WHERE jsonb_typeof(e.value->'lines') IS DISTINCT FROM 'array'
     OR jsonb_array_length(e.value->'lines') = 0
  ORDER BY e.ord
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'SIE journal entry % has no lines', COALESCE(v_bad_source, '<unknown>');
  END IF;

  -- Correction-history provenance (#2427) is caller-supplied JSON, so verify
  -- it before it becomes WORM audit trail: every sieImportId on an entry that
  -- carries #BTRANS/#RTRANS rows must be this company's own sie_imports row
  -- (a foreign or fabricated id fails closed, never silently nulled). A
  -- malformed uuid string raises on the cast, which rolls the whole import
  -- back like every other payload defect.
  SELECT c.sie_import_id
  INTO v_sie_import_id
  FROM (
    SELECT NULLIF(btrim(COALESCE(e.value->>'sieImportId', '')), '')::uuid AS sie_import_id
    FROM jsonb_array_elements(p_entries) AS e(value)
    WHERE jsonb_typeof(e.value->'corrections') = 'object'
      AND (
        (jsonb_typeof(e.value->'corrections'->'struck') = 'array'
          AND jsonb_array_length(e.value->'corrections'->'struck') > 0)
        OR (jsonb_typeof(e.value->'corrections'->'added') = 'array'
          AND jsonb_array_length(e.value->'corrections'->'added') > 0)
      )
  ) c
  WHERE c.sie_import_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.sie_imports si
      WHERE si.id = c.sie_import_id AND si.company_id = p_company_id
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'sie import % does not belong to company %', v_sie_import_id, p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- One statement: reserve numbers per series, insert draft headers,
  -- insert their lines and their source-system correction history, and
  -- collect the inserted set in payload order.
  -- Headers are matched back to their ordinal by (series, voucher_number),
  -- which is unique within the call because each series gets a contiguous
  -- block from voucher_sequences.
  WITH src AS (
    SELECT
      e.ord,
      e.value AS entry,
      COALESCE(NULLIF(e.value->>'series', ''), 'A') AS series
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord)
  ),
  counts AS (
    SELECT series, count(*)::integer AS cnt, min(ord) AS first_ord
    FROM src
    GROUP BY series
  ),
  reserved AS (
    INSERT INTO public.voucher_sequences
      (company_id, user_id, fiscal_period_id, voucher_series, last_number)
    SELECT p_company_id, p_user_id, p_fiscal_period_id, c.series, c.cnt
    FROM counts c
    ORDER BY c.first_ord
    ON CONFLICT (company_id, fiscal_period_id, voucher_series)
    DO UPDATE SET
      last_number = public.voucher_sequences.last_number + EXCLUDED.last_number,
      updated_at = now()
    RETURNING voucher_series, last_number
  ),
  numbered AS (
    SELECT
      s.ord,
      s.entry,
      s.series,
      (r.last_number - c.cnt
        + row_number() OVER (PARTITION BY s.series ORDER BY s.ord))::integer AS voucher_number
    FROM src s
    JOIN counts c ON c.series = s.series
    JOIN reserved r ON r.voucher_series = s.series
  ),
  headers AS (
    INSERT INTO public.journal_entries (
      user_id,
      company_id,
      fiscal_period_id,
      voucher_number,
      voucher_series,
      entry_date,
      description,
      source_type,
      source_voucher_series,
      source_voucher_number,
      status,
      committed_at, import_batch_id, source_ordinal, source_content_hash
    )
    SELECT
      p_user_id,
      p_company_id,
      p_fiscal_period_id,
      n.voucher_number,
      n.series,
      (n.entry->>'date')::date,
      n.entry->>'description',
      COALESCE(NULLIF(n.entry->>'sourceType', ''), 'import'),
      NULLIF(n.entry->>'sourceSeries', ''),
      CASE
        WHEN n.entry ? 'sourceNumber' AND n.entry->>'sourceNumber' IS NOT NULL
        THEN (n.entry->>'sourceNumber')::integer
        ELSE NULL
      END,
      'draft',
      NULL, (n.entry->>'sieImportId')::uuid, (n.entry->>'sourceOrdinal')::integer,
      encode(extensions.digest((n.entry - 'sieImportId' - 'sourceOrdinal')::text, 'sha256'), 'hex')
    FROM numbered n
    ORDER BY n.ord
    RETURNING id, voucher_series, voucher_number
  ),
  placed AS (
    SELECT n.ord, n.entry, n.series, n.voucher_number, h.id
    FROM numbered n
    JOIN headers h
      ON h.voucher_series = n.series
     AND h.voucher_number = n.voucher_number
  ),
  lines AS (
    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      account_number,
      account_id,
      debit_amount,
      credit_amount,
      currency,
      line_description,
      sort_order,
      dimensions
    )
    SELECT
      p.id,
      l.value->>'account_number',
      CASE
        WHEN l.value ? 'account_id' AND l.value->>'account_id' IS NOT NULL
        THEN (l.value->>'account_id')::uuid
        ELSE NULL
      END,
      COALESCE((l.value->>'debit_amount')::numeric, 0),
      COALESCE((l.value->>'credit_amount')::numeric, 0),
      COALESCE(NULLIF(l.value->>'currency', ''), 'SEK'),
      NULLIF(l.value->>'line_description', ''),
      COALESCE((l.value->>'sort_order')::integer, 0),
      COALESCE(l.value->'dimensions', '{}'::jsonb)
    FROM placed p
    CROSS JOIN LATERAL jsonb_array_elements(p.entry->'lines') WITH ORDINALITY AS l(value, ord)
    ORDER BY p.ord, l.ord
    RETURNING journal_entry_id
  ),
  -- Source-system correction history (#2427). The SIE file's #BTRANS
  -- (struck) and #RTRANS (added) rows for a voucher land as ONE rättelselogg
  -- row with source='sie_import': the same snapshot shape
  -- correct_entry_lines_inline writes, so the verifikat page and
  -- behandlingshistoriken render it unchanged. Never booked as lines; the
  -- ledger above is built from #TRANS only.
  corrected AS (
    SELECT
      p.id,
      p.entry,
      CASE WHEN jsonb_typeof(p.entry->'corrections'->'struck') = 'array'
           THEN p.entry->'corrections'->'struck' ELSE '[]'::jsonb END AS struck,
      CASE WHEN jsonb_typeof(p.entry->'corrections'->'added') = 'array'
           THEN p.entry->'corrections'->'added' ELSE '[]'::jsonb END AS added
    FROM placed p
    WHERE jsonb_typeof(p.entry->'corrections') = 'object'
  ),
  history AS (
    INSERT INTO public.journal_entry_rattelse_log (
      company_id,
      journal_entry_id,
      rattelse_type,
      struck_lines,
      added_lines,
      actor,
      source,
      sie_import_id,
      external_signature
    )
    SELECT
      p_company_id,
      c.id,
      'lines',
      public.sie_correction_snapshots(c.id, c.struck),
      public.sie_correction_snapshots(c.id, c.added),
      NULL,
      'sie_import',
      NULLIF(btrim(COALESCE(c.entry->>'sieImportId', '')), '')::uuid,
      NULLIF(btrim(COALESCE(c.entry->'corrections'->>'signature', '')), '')
    FROM corrected c
    WHERE jsonb_array_length(c.struck) > 0 OR jsonb_array_length(c.added) > 0
    RETURNING journal_entry_id
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'sourceId', p.entry->>'sourceId',
      'sourceOrdinal', (p.entry->>'sourceOrdinal')::integer,
      'series', p.series,
      'voucherNumber', p.voucher_number,
      'sourceType', COALESCE(NULLIF(p.entry->>'sourceType', ''), 'import')
    )
    ORDER BY p.ord
  )
  INTO v_inserted
  FROM placed p;

  -- Per-voucher balance enforcement (hard rule #3), one aggregate over the
  -- rows this call inserted. RAISE names the source voucher; the deferred
  -- check_balance_on_posted_insert would only name the new id.
  SELECT
    h."sourceId",
    COALESCE(sum(l.debit_amount), 0),
    COALESCE(sum(l.credit_amount), 0)
  INTO v_bad_source, v_bad_debit, v_bad_credit
  FROM jsonb_to_recordset(v_inserted) AS h(id uuid, "sourceId" text, "voucherNumber" integer)
  JOIN public.journal_entry_lines l ON l.journal_entry_id = h.id
  GROUP BY h.id, h."sourceId", h."voucherNumber"
  HAVING round(COALESCE(sum(l.debit_amount), 0), 2) <> round(COALESCE(sum(l.credit_amount), 0), 2)
      OR round(COALESCE(sum(l.debit_amount), 0), 2) <= 0
  ORDER BY h."voucherNumber"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'SIE journal entry % is unbalanced (debit %, credit %)',
      COALESCE(v_bad_source, '<unknown>'), v_bad_debit, v_bad_credit;
  END IF;

  -- Keep the ordinary draft -> posted invariant on every supported schema.
  -- Both this update and the reserved numbers roll back with the chunk.
  UPDATE public.journal_entries SET status = 'posted', committed_at = now()
    WHERE id IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_inserted) e);

  RETURN jsonb_build_object(
    'inserted_entries', COALESCE(v_inserted, '[]'::jsonb),
    'skipped_duplicates', '[]'::jsonb,
    'validation_errors', '[]'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.request_sie_import_undo(p_company_id uuid,p_import_id uuid,p_actor uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE id = p_import_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_state IS NULL THEN RAISE EXCEPTION 'SIE execution not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.job_state IN ('undone','failed') THEN RETURN v_job; END IF;
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
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL OR
    (v_period.import_hold IS NOT NULL AND v_period.import_hold <> p_import_id) THEN
    RAISE EXCEPTION 'SIE period is locked or has another execution' USING ERRCODE = '55000';
  END IF;
  UPDATE public.fiscal_periods SET import_hold = p_import_id WHERE id = v_period.id;
  UPDATE public.sie_imports SET job_state = 'undoing',job_phase = 'undo',job_attempt = job_attempt+1,
    execution_actor_id = p_actor,worker_id = NULL,lease_until = NULL,next_attempt_at = NULL,error_message = NULL
    WHERE id = p_import_id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

NOTIFY pgrst, 'reload schema';