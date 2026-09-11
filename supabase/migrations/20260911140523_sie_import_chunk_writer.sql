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

REVOKE ALL ON FUNCTION public.write_sie_job_entries(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.write_sie_job_entries(uuid, uuid, uuid, jsonb) FROM authenticated, service_role;

NOTIFY pgrst, 'reload schema';

CREATE FUNCTION public.save_sie_import_chunk(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_phase text, p_chunk_no integer,
  p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_existing public.sie_import_chunks; v_hash text;
BEGIN
  v_job := public.lock_sie_execution(p_company_id, p_import_id, p_worker_id, p_attempt);
  IF v_job.job_phase <> 'prepare' OR p_phase NOT IN ('prepare','vouchers','finalize') OR p_phase IS NULL OR
     p_chunk_no IS NULL OR p_chunk_no < 0 OR jsonb_typeof(p_payload) IS DISTINCT FROM 'array' OR
     octet_length(p_payload::text) > 1200000 THEN
    RAISE EXCEPTION 'Invalid SIE preparation checkpoint' USING ERRCODE = '22023';
  END IF;
  IF p_phase IN ('vouchers','finalize') AND (
    jsonb_array_length(p_payload) > 200 OR
    (SELECT coalesce(sum(jsonb_array_length(e->'lines')),0) FROM jsonb_array_elements(p_payload) e) > 2000 OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload) e
      WHERE jsonb_typeof(e->'lines') IS DISTINCT FROM 'array' OR
        e->>'sieImportId' IS DISTINCT FROM p_import_id::text OR
        e->>'sourceOrdinal' IS NULL OR (e->>'sourceOrdinal')::integer < 0 OR
        coalesce(e->>'sourceType','') NOT IN ('import','opening_balance'))
  ) THEN RAISE EXCEPTION 'SIE chunk exceeds its limits or has invalid provenance' USING ERRCODE = '22023'; END IF;
  v_hash := encode(extensions.digest(p_payload::text, 'sha256'), 'hex');
  SELECT * INTO v_existing FROM public.sie_import_chunks WHERE import_id = p_import_id
    AND phase = p_phase AND chunk_no = p_chunk_no;
  IF FOUND THEN
    IF v_existing.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'SIE preparation retry changed payload' USING ERRCODE = '23505';
    END IF;
    RETURN;
  END IF;
  INSERT INTO public.sie_import_chunks(import_id, company_id, user_id, phase, chunk_no, payload, payload_hash)
    VALUES(p_import_id, p_company_id, v_job.user_id, p_phase, p_chunk_no, p_payload, v_hash);
END;
$$;
REVOKE ALL ON FUNCTION public.save_sie_import_chunk(uuid,uuid,uuid,integer,text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_sie_import_chunk(uuid,uuid,uuid,integer,text,integer,jsonb) TO service_role;

CREATE FUNCTION public.seal_sie_import_preparation(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_manifest jsonb, p_chunks_total integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_count integer;
BEGIN
  v_job := public.lock_sie_execution(p_company_id, p_import_id, p_worker_id, p_attempt);
  IF v_job.job_phase <> 'prepare' THEN RETURN; END IF;
  SELECT count(*) INTO v_count FROM public.sie_import_chunks WHERE import_id = p_import_id AND phase = 'vouchers';
  IF p_chunks_total IS NULL OR v_count <> p_chunks_total OR EXISTS (
    SELECT 1 FROM generate_series(0, p_chunks_total - 1) n
    WHERE NOT EXISTS (SELECT 1 FROM public.sie_import_chunks WHERE import_id = p_import_id AND phase = 'vouchers' AND chunk_no = n)
  ) THEN RAISE EXCEPTION 'SIE preparation is incomplete' USING ERRCODE = '55000'; END IF;
  IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR
     p_manifest->'input' IS DISTINCT FROM v_job.manifest->'input' THEN
    RAISE EXCEPTION 'SIE approved input changed' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sie_imports SET chunks_total = v_count, manifest = p_manifest,
    job_phase = CASE WHEN v_count = 0 THEN 'finalize' ELSE 'vouchers' END,
    job_state = CASE WHEN v_count = 0 THEN 'finalizing' ELSE 'running' END
    WHERE id = p_import_id;
END;
$$;
REVOKE ALL ON FUNCTION public.seal_sie_import_preparation(uuid,uuid,uuid,integer,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.seal_sie_import_preparation(uuid,uuid,uuid,integer,jsonb,integer) TO service_role;

CREATE FUNCTION public.import_sie_chunk(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_phase text, p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
DECLARE v_job public.sie_imports; v_chunk public.sie_import_chunks;
  v_result jsonb; v_bad_source text; v_new jsonb; v_existing jsonb;
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
        j.source_voucher_series = e->>'sourceSeries' AND j.source_voucher_number = (e->>'sourceNumber')::integer))
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
REVOKE ALL ON FUNCTION public.import_sie_chunk(uuid,uuid,uuid,integer,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_sie_chunk(uuid,uuid,uuid,integer,text,integer) TO service_role;

CREATE FUNCTION public.complete_sie_import_job(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_result jsonb, p_documentation jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_opening uuid; v_opening_count integer; v_manifest jsonb;
BEGIN
  v_job := public.lock_sie_execution(p_company_id, p_import_id, p_worker_id, p_attempt);
  IF v_job.job_phase <> 'finalize' OR v_job.chunks_done <> v_job.chunks_total OR EXISTS (
    SELECT 1 FROM public.sie_import_chunks WHERE import_id = p_import_id AND phase IN ('vouchers','finalize') AND state <> 'completed'
  ) THEN RAISE EXCEPTION 'SIE import has unfinished work' USING ERRCODE = '55000'; END IF;
  IF p_result->>'success' IS DISTINCT FROM 'true' OR p_documentation IS NULL OR v_job.file_storage_path IS NULL THEN
    RAISE EXCEPTION 'SIE import archive or result missing' USING ERRCODE = '55000';
  END IF;
  SELECT count(*), (array_agg(id))[1] INTO v_opening_count,v_opening FROM public.journal_entries
    WHERE import_batch_id = p_import_id AND source_type = 'opening_balance' AND status = 'posted';
  IF v_opening_count > 1 THEN RAISE EXCEPTION 'SIE has multiple opening balance entries'; END IF;
  IF v_opening IS NOT NULL THEN
    UPDATE public.fiscal_periods SET opening_balance_entry_id = v_opening,opening_balances_set = true
      WHERE id = v_job.fiscal_period_id AND (opening_balance_entry_id IS NULL OR opening_balance_entry_id = v_opening);
    IF NOT FOUND THEN RAISE EXCEPTION 'SIE opening balance was changed concurrently'; END IF;
  END IF;
  SELECT v_job.manifest || jsonb_build_object('chunks',coalesce(jsonb_agg(jsonb_build_object(
      'phase',phase,'number',chunk_no,'hash',payload_hash) ORDER BY phase,chunk_no),'[]'::jsonb),
      'openingBalanceEntryId',v_opening,'adjustmentEntryId',(SELECT id FROM public.journal_entries
        WHERE import_batch_id = p_import_id AND source_ordinal = 50001)) INTO v_manifest
    FROM public.sie_import_chunks WHERE import_id = p_import_id AND phase IN ('vouchers','finalize');
  UPDATE public.sie_imports SET job_state = 'completed', status = 'completed',
    manifest = v_manifest,opening_balance_entry_id = v_opening,
    job_result = p_result, migration_documentation = p_documentation, imported_at = clock_timestamp(),
    worker_id = NULL, lease_until = NULL, error_message = NULL
    WHERE id = p_import_id;
  UPDATE public.fiscal_periods SET import_hold = NULL WHERE id = v_job.fiscal_period_id AND import_hold = p_import_id;
  UPDATE public.sie_import_chunks SET payload = NULL WHERE import_id = p_import_id AND
    (phase IN ('vouchers','finalize') OR (phase = 'prepare' AND chunk_no > 100000 AND chunk_no < 200000));
END;
$$;
REVOKE ALL ON FUNCTION public.complete_sie_import_job(uuid,uuid,uuid,integer,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_sie_import_job(uuid,uuid,uuid,integer,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.pre_request_statement_timeout() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_path text := coalesce(current_setting('request.path', true), '');
BEGIN
  IF v_path ~ '/rpc/(import_sie_chunk|reconcile_sie_import)$' THEN
    PERFORM set_config('statement_timeout', '30s', true);
  ELSIF v_path ~ '/rpc/import_sie_journal_entries$' THEN
    PERFORM set_config('statement_timeout', '60s', true);
  ELSIF v_path ~ '/rpc/(replace_sie_import|undo_sie_import)$' THEN
    PERFORM set_config('statement_timeout', '290s', true);
  END IF;
END;
$$;
ALTER FUNCTION public.import_sie_journal_entries(uuid,uuid,uuid,jsonb) SET statement_timeout = '60s';
NOTIFY pgrst, 'reload schema';


