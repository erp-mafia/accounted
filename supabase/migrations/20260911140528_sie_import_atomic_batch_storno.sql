-- The existing period-scoped delete RPC is never used for durable executions.
-- Storno uses the same draft/lines/post/reversed lifecycle as the engine, with
-- the sequence, links, original status and receipt in one transaction.
CREATE FUNCTION public.request_sie_import_undo(p_company_id uuid,p_import_id uuid,p_actor uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE id = p_import_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_state IS NULL THEN RAISE EXCEPTION 'SIE execution not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.job_state IN ('undone','failed') THEN RETURN v_job; END IF;
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
    WHERE j.status = 'posted' AND j.import_batch_id IS DISTINCT FROM p_import_id) THEN
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
REVOKE ALL ON FUNCTION public.request_sie_import_undo(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.request_sie_import_undo(uuid,uuid,uuid) TO authenticated,service_role;

CREATE FUNCTION public.undo_sie_import_chunk(p_company_id uuid,p_import_id uuid,p_worker_id uuid,p_attempt integer)
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
  UPDATE public.journal_entries SET status = 'posted',committed_at = now()
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
REVOKE ALL ON FUNCTION public.undo_sie_import_chunk(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.undo_sie_import_chunk(uuid,uuid,uuid,integer) TO service_role;

NOTIFY pgrst,'reload schema';

