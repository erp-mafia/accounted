-- Let the existing draft-to-posted trigger assign committed_at. Supplying it
-- explicitly invokes the exceptional historical timestamp audit path.

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
  UPDATE public.journal_entries SET status = 'posted'
    WHERE id IN (SELECT (e->>'id')::uuid FROM jsonb_array_elements(v_inserted) e);

  RETURN jsonb_build_object(
    'inserted_entries', COALESCE(v_inserted, '[]'::jsonb),
    'skipped_duplicates', '[]'::jsonb,
    'validation_errors', '[]'::jsonb
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.undo_sie_import_chunk(p_company_id uuid,p_import_id uuid,p_worker_id uuid,p_attempt integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
DECLARE v_job public.sie_imports; v_actor uuid; v_ids uuid[]; v_receipt jsonb;
  v_first integer; v_links uuid[]; v_renames public.sie_import_chunks;
BEGIN
  v_job := public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  IF v_job.job_phase <> 'undo' THEN RAISE EXCEPTION 'SIE job is not undoing'; END IF;
  v_actor := coalesce(v_job.execution_actor_id,v_job.user_id);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:0',0)) AND
     NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:1',0)) THEN
    RAISE EXCEPTION 'SIE platform write capacity is busy' USING ERRCODE = '55P03';
  END IF;
  -- Bound both header and line work. A voucher is never split.
  WITH candidates AS (
    SELECT j.id,j.source_ordinal,(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id = j.id) n
    FROM public.journal_entries j WHERE j.import_batch_id = p_import_id AND j.company_id = p_company_id
      AND j.status = 'posted' ORDER BY j.source_ordinal LIMIT 500
  ), sized AS (SELECT *,sum(n) OVER (ORDER BY source_ordinal) total FROM candidates)
  SELECT array_agg(id ORDER BY source_ordinal),min(source_ordinal) INTO v_ids,v_first FROM sized WHERE total <= 2000;
  IF coalesce(cardinality(v_ids),0) = 0 THEN
    IF EXISTS (SELECT 1 FROM public.journal_entries WHERE import_batch_id = p_import_id AND status = 'posted') THEN
      RAISE EXCEPTION 'SIE undo voucher exceeds 2000 lines';
    END IF;
    -- Restore names only while they still equal this import's write; preserve
    -- subsequent user edits. Each batch of at most 100 names has a receipt.
    SELECT c.* INTO v_renames FROM public.sie_import_chunks c WHERE c.import_id = p_import_id
      AND c.phase = 'prepare' AND ((c.chunk_no >= 50000 AND c.chunk_no < 60000) OR (c.chunk_no >= 70000 AND c.chunk_no < 80000))
      AND NOT EXISTS (SELECT 1 FROM public.sie_import_chunks u WHERE u.import_id = p_import_id
        AND u.phase = 'undo' AND u.chunk_no = 100000+c.chunk_no)
      ORDER BY c.chunk_no LIMIT 1;
    IF FOUND THEN
      UPDATE public.chart_of_accounts a SET account_name = r->>'from'
        FROM jsonb_array_elements(coalesce(v_renames.result->'renamed','[]'::jsonb)) r
        WHERE a.company_id = p_company_id AND a.account_number = r->>'accountNumber' AND a.account_name = r->>'to';
      UPDATE public.chart_of_accounts a SET default_vat_treatment = r->>'fromTreatment',default_vat_rate = (r->>'fromRate')::numeric
        FROM jsonb_array_elements(coalesce(v_renames.result->'vatDefaults','[]'::jsonb)) r
        WHERE a.company_id = p_company_id AND a.account_number = r->>'accountNumber'
          AND a.default_vat_treatment IS NOT DISTINCT FROM r->>'toTreatment'
          AND a.default_vat_rate IS NOT DISTINCT FROM (r->>'toRate')::numeric;
      INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
        VALUES(p_import_id,p_company_id,v_actor,'undo',100000+v_renames.chunk_no,v_renames.payload_hash,
          'completed',jsonb_build_object('accountNamesRestored',true),clock_timestamp());
      RETURN jsonb_build_object('reversed',0,'done',false);
    END IF;
    UPDATE public.sie_imports SET job_state = 'undone',status = 'replaced',worker_id = NULL,lease_until = NULL,
      error_message = NULL WHERE id = p_import_id;
    UPDATE public.fiscal_periods SET import_hold = NULL WHERE id = v_job.fiscal_period_id AND import_hold = p_import_id;
    RETURN jsonb_build_object('reversed',0,'done',true);
  END IF;
  PERFORM 1 FROM public.journal_entries WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE id = ANY(v_ids) AND
      (source_type NOT IN ('import','opening_balance') OR status <> 'posted')) THEN
    RAISE EXCEPTION 'SIE batch contains a changed or unsupported entry';
  END IF;
  WITH counts AS (
    SELECT voucher_series,count(*)::integer n FROM public.journal_entries WHERE id = ANY(v_ids) GROUP BY voucher_series
  ), reserved AS (
    INSERT INTO public.voucher_sequences(company_id,user_id,fiscal_period_id,voucher_series,last_number)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,n FROM counts ORDER BY voucher_series
      ON CONFLICT (company_id,fiscal_period_id,voucher_series) DO UPDATE
        SET last_number = voucher_sequences.last_number+EXCLUDED.last_number,updated_at = now()
      RETURNING voucher_series,last_number
  ), originals AS (
    SELECT j.*,r.last_number-c.n+row_number() OVER (PARTITION BY j.voucher_series ORDER BY j.source_ordinal) number
      FROM public.journal_entries j JOIN counts c USING (voucher_series) JOIN reserved r USING (voucher_series)
      WHERE j.id = ANY(v_ids)
  ), headers AS (
    INSERT INTO public.journal_entries(company_id,user_id,fiscal_period_id,voucher_series,voucher_number,entry_date,
      description,source_type,source_id,reverses_id,status)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,number::integer,entry_date,
        'Makulering: ' || description,'storno',source_id,id,'draft' FROM originals
      RETURNING id,reverses_id,voucher_number,voucher_series
  ), lines AS (
    INSERT INTO public.journal_entry_lines(journal_entry_id,account_number,account_id,debit_amount,credit_amount,
      line_description,currency,amount_in_currency,exchange_rate,tax_code,dimensions,sort_order)
      SELECT h.id,l.account_number,l.account_id,greatest(l.credit_amount-l.debit_amount,0),
        greatest(l.debit_amount-l.credit_amount,0),'Reversal: ' || coalesce(l.line_description,''),l.currency,
        -l.amount_in_currency,l.exchange_rate,l.tax_code,l.dimensions,l.sort_order
      FROM headers h JOIN public.journal_entry_lines l ON l.journal_entry_id = h.reverses_id
      RETURNING journal_entry_id
  )
  SELECT jsonb_agg(jsonb_build_object('id',id,'reverses',reverses_id,'number',voucher_number,'series',voucher_series))
    INTO v_receipt FROM headers;
  UPDATE public.journal_entries SET status = 'posted'
    WHERE id IN (SELECT (r->>'id')::uuid FROM jsonb_array_elements(v_receipt) r);
  UPDATE public.journal_entries j SET status = 'reversed',reversed_by_id = (r->>'id')::uuid
    FROM jsonb_array_elements(v_receipt) r WHERE j.id = (r->>'reverses')::uuid AND j.status = 'posted';

  -- Preserve documents and audit records. Release bank anchors atomically.
  PERFORM 1 FROM public.transactions t WHERE t.company_id = p_company_id AND
    (t.journal_entry_id = ANY(v_ids) OR EXISTS (SELECT 1 FROM public.transaction_voucher_links l
      WHERE l.transaction_id = t.id AND l.company_id = p_company_id AND l.journal_entry_id = ANY(v_ids)))
    ORDER BY t.id FOR UPDATE;
  SELECT array_agg(DISTINCT transaction_id) INTO v_links FROM public.transaction_voucher_links
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT id FROM public.transactions WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids));
  UPDATE public.transactions SET journal_entry_id = NULL,is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  -- A partly reversed split no longer explains the transaction: release its
  -- remaining bank-line slices, as reverseEntry does for an individual storno.
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT t.id FROM public.transactions t JOIN public.transaction_voucher_links l ON l.transaction_id = t.id
      AND l.company_id = p_company_id WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
    GROUP BY t.id,t.amount HAVING bool_and(l.role = 'bank_line') AND abs(round(sum(l.allocated_amount)-t.amount,2)) > 0.005);
  UPDATE public.transactions t SET is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links l WHERE l.company_id = p_company_id AND l.transaction_id = t.id);
  UPDATE public.fiscal_periods SET opening_balances_set = false
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
    VALUES(p_import_id,p_company_id,v_actor,'undo',v_first,encode(extensions.digest(v_receipt::text,'sha256'),'hex'),
      'completed',jsonb_build_object('entries',v_receipt),clock_timestamp());
  RETURN jsonb_build_object('reversed',cardinality(v_ids),'done',false);
END;
$$;

NOTIFY pgrst, 'reload schema';
