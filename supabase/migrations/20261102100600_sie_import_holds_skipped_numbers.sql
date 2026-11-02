-- An SIE import keeps the number of a source voucher it does not book
-- (crm#1599).
--
-- A voucher the source system cancelled (Fortnox: every row struck, only
-- #BTRANS/#RTRANS left) has nothing to book, so prepareSIEVouchers skips it,
-- as it skips an unbalanced or one-line voucher. write_sie_job_entries then
-- numbered each series with a plain row_number() over the vouchers it was
-- given, so the skipped voucher left no trace: Fortnox A11-A76 became A10-A75
-- and every later number stopped matching the source system. Issue #1882 was
-- the same class from the other side (the IB entry took a number).
--
-- Now the application marks the next booked voucher of the series with
-- numberGap {count, explanation}: how many source vouchers right before it
-- were skipped, and which. Here:
--   * write_sie_job_entries reserves 1 + count numbers per entry, so the
--     entry lands on the number after the held ones, and records the held
--     range in voucher_gap_explanations (BFNAR 2013:2 punkt 5.8, the table
--     the year-end gap check reads; ON CONFLICT DO NOTHING). A malformed
--     numberGap fails the chunk before a number is reserved.
--   * source_content_hash leaves numberGap out, in the writer and in
--     import_sie_chunk's conflict check alike: it places a voucher, it is not
--     its content, so a voucher's identity does not change with it. For an
--     entry without numberGap the hash is byte for byte what it was.
--   * sie_append_plan reads a booked voucher as the same when its stored hash
--     matches the entry without numberGap (this writer) or with it: the
--     application can be live before this migration, and the previous writer
--     hashed every key, numberGap included. Without the second form a voucher
--     imported in that window would read as changed to every later append.
--     An append itself holds no numbers (the application drops numberGap from
--     what it writes); the plan still receives it for this compare.
--
-- write_sie_job_entries is the body from 20261015235000, import_sie_chunk and
-- sie_append_plan the bodies from 20261030131447, with only these changes.
-- Signatures, owners and grants are unchanged (CREATE OR REPLACE keeps them).
-- No journal entry is changed; imports already written keep their numbers.
--
-- pg-test: tests/pg/sie-import-number-gap.pg.test.ts

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
    j.source_content_hash IS DISTINCT FROM encode(extensions.digest((e - 'sieImportId' - 'sourceOrdinal' - 'numberGap')::text,'sha256'),'hex')
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

  -- numberGap (crm#1599): the source vouchers of this entry's series the
  -- import skipped right before it. Present only with a positive count and an
  -- explanation; anything else fails the chunk before a number is reserved.
  SELECT e.value->>'sourceId'
  INTO v_bad_source
  FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord)
  WHERE e.value ? 'numberGap'
    AND (jsonb_typeof(e.value->'numberGap') IS DISTINCT FROM 'object'
      OR coalesce(e.value->'numberGap'->>'count', '') !~ '^[1-9][0-9]{0,4}$'
      OR btrim(coalesce(e.value->'numberGap'->>'explanation', '')) = '')
  ORDER BY e.ord
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'SIE journal entry % has an invalid numberGap', COALESCE(v_bad_source, '<unknown>')
      USING ERRCODE = '22023';
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
      COALESCE(NULLIF(e.value->>'series', ''), 'A') AS series,
      COALESCE((e.value->'numberGap'->>'count')::integer, 0) AS gap
    FROM jsonb_array_elements(p_entries) WITH ORDINALITY AS e(value, ord)
  ),
  -- Each entry takes its own number plus the numbers its gap holds.
  counts AS (
    SELECT series, sum(1 + gap)::integer AS cnt, min(ord) AS first_ord
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
      s.gap,
      (r.last_number - c.cnt
        + sum(1 + s.gap) OVER (PARTITION BY s.series ORDER BY s.ord
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::integer AS voucher_number
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
      encode(extensions.digest((n.entry - 'sieImportId' - 'sourceOrdinal' - 'numberGap')::text, 'sha256'), 'hex')
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
  ),
  -- The numbers a gap held, documented where the year-end check reads them
  -- (BFNAR 2013:2, the same table a cancelled draft's number lands in).
  held_numbers AS (
    INSERT INTO public.voucher_gap_explanations
      (company_id, user_id, fiscal_period_id, voucher_series, gap_start, gap_end, explanation)
    SELECT p_company_id, p_user_id, p_fiscal_period_id, n.series,
      n.voucher_number - n.gap, n.voucher_number - 1,
      left(btrim(n.entry->'numberGap'->>'explanation'), 500)
    FROM numbered n
    WHERE n.gap > 0
    ON CONFLICT (company_id, fiscal_period_id, voucher_series, gap_start, gap_end) DO NOTHING
    RETURNING id
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
  -- The commit stamp: HOW is 'migration' (history brought in from a file or
  -- another system), WHO the actor import_sie_chunk set for this transaction
  -- (the user, key or OAuth client that submitted the import), else NULL.
  UPDATE public.journal_entries SET status = 'posted',
      commit_method = 'migration',
      committed_actor_type = nullif(current_setting('gnubok.actor_type', true), ''),
      committed_actor_label = nullif(current_setting('gnubok.actor_label', true), '')
    WHERE id IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_inserted) e);

  RETURN jsonb_build_object(
    'inserted_entries', COALESCE(v_inserted, '[]'::jsonb),
    'skipped_duplicates', '[]'::jsonb,
    'validation_errors', '[]'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.sie_append_plan(p_company_id uuid, p_period_id uuid, p_source_program text,
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
      j.source_content_hash IN (
        encode(extensions.digest(((s.e - 'sieImportId' - 'sourceOrdinal' - 'numberGap')
          || jsonb_build_object('series', j.voucher_series))::text, 'sha256'), 'hex'),
        encode(extensions.digest(((s.e - 'sieImportId' - 'sourceOrdinal')
          || jsonb_build_object('series', j.voucher_series))::text, 'sha256'), 'hex')) AS same
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

NOTIFY pgrst, 'reload schema';
