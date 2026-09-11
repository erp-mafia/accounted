-- Keep operator-reviewed repairs separate from ordinary import actions.
-- Preserve the existing owner/admin permission boundary for whole-batch undo.
CREATE OR REPLACE FUNCTION public.request_sie_import_undo(p_company_id uuid,p_import_id uuid,p_actor uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods;
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

CREATE OR REPLACE FUNCTION public.replace_sie_import_job(p_company_id uuid,p_actor uuid,p_period_id uuid,
  p_filename text,p_file_hash text,p_manifest jsonb,p_supersedes_import_id uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_previous public.sie_imports;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_previous FROM public.sie_imports WHERE id = p_supersedes_import_id
    AND company_id = p_company_id AND fiscal_period_id = p_period_id FOR UPDATE;
  IF NOT FOUND OR v_previous.job_state IS NULL OR v_previous.job_kind<>'import' THEN
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

CREATE OR REPLACE FUNCTION public.stage_sie_duplicate_repair(p_company_id uuid,p_actor uuid,p_period_id uuid,
  p_review_hash text,p_items jsonb) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s' AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods; v_hash text;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  IF NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=p_company_id AND user_id=p_actor AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'SIE reversal requires company owner or administrator' USING ERRCODE='42501';
  END IF;
  IF p_review_hash IS NULL OR p_review_hash !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_items) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 5000 OR octet_length(p_items::text)>1000000 THEN
    RAISE EXCEPTION 'Invalid bounded SIE repair review' USING ERRCODE='22023';
  END IF;
  v_hash:=encode(extensions.digest(p_items::text,'sha256'),'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:'||p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE company_id=p_company_id AND fiscal_period_id=p_period_id
    AND job_kind='duplicate_repair' AND file_hash=p_review_hash;
  IF FOUND THEN
    IF v_job.manifest->>'itemsHash' IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'SIE repair retry changed the approved scope' USING ERRCODE='23505';
    END IF;
    RETURN v_job;
  END IF;
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id=p_period_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR v_period.is_closed OR v_period.locked_at IS NOT NULL OR v_period.import_hold IS NOT NULL THEN
    RAISE EXCEPTION 'SIE repair needs an open unheld fiscal period' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM public.sie_imports WHERE company_id=p_company_id
    AND job_state NOT IN ('completed','undone','failed')) THEN
    RAISE EXCEPTION 'Another SIE execution is unfinished' USING ERRCODE='55000';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) r
    LEFT JOIN public.journal_entries k ON k.id=(r->>'keepId')::uuid
    LEFT JOIN public.journal_entries d ON d.id=(r->>'reverseId')::uuid
    WHERE k.id IS NULL OR d.id IS NULL OR k.id=d.id OR k.company_id<>p_company_id OR d.company_id<>p_company_id
      OR k.fiscal_period_id<>p_period_id OR d.fiscal_period_id<>p_period_id
      OR k.source_type<>'import' OR d.source_type<>'import' OR k.status<>'posted' OR d.status<>'posted'
      OR k.import_batch_id IS NOT NULL OR d.import_batch_id IS NOT NULL
      OR k.source_voucher_series IS DISTINCT FROM d.source_voucher_series
      OR k.source_voucher_number IS DISTINCT FROM d.source_voucher_number
      OR k.source_voucher_series IS NULL OR k.source_voucher_number IS NULL
      OR jsonb_typeof(coalesce(r->'keepLinks','[]'::jsonb))<>'array'
      OR jsonb_typeof(coalesce(r->'reverseLinks','[]'::jsonb))<>'array'
      OR r->>'contentHash' IS NULL OR r->>'contentHash' !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'SIE repair requires exact legacy duplicate identities in one company and period' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT id FROM (SELECT r->>'keepId' id FROM jsonb_array_elements(p_items) r UNION ALL
      SELECT r->>'reverseId' FROM jsonb_array_elements(p_items) r) ids GROUP BY id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'SIE repair pairs overlap' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.sie_imports(company_id,user_id,execution_actor_id,filename,file_hash,sie_type,fiscal_period_id,
    fiscal_year_start,fiscal_year_end,status,job_state,job_phase,job_kind,chunks_total,transactions_count,manifest)
    VALUES(p_company_id,p_actor,p_actor,'Granskad rättelse av dubbla SIE-verifikationer',p_review_hash,4,p_period_id,
      v_period.period_start,v_period.period_end,'pending','undoing','undo','duplicate_repair',
      jsonb_array_length(p_items),jsonb_array_length(p_items),jsonb_build_object('reviewHash',p_review_hash,
        'itemsHash',v_hash,'treatment','storno','approvedActor',p_actor)) RETURNING * INTO v_job;
  INSERT INTO public.sie_duplicate_repair_items(import_id,company_id,user_id,ordinal,keep_entry_id,reverse_entry_id,
    content_hash,keep_links,reverse_links)
    SELECT v_job.id,p_company_id,p_actor,(ord-1)::integer,(r->>'keepId')::uuid,(r->>'reverseId')::uuid,
      r->>'contentHash',coalesce(r->'keepLinks','[]'::jsonb),coalesce(r->'reverseLinks','[]'::jsonb)
    FROM jsonb_array_elements(p_items) WITH ORDINALITY x(r,ord);
  UPDATE public.fiscal_periods SET import_hold=v_job.id WHERE id=p_period_id;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.undo_sie_duplicate_repair_chunk(p_company_id uuid,p_import_id uuid,p_worker_id uuid,p_attempt integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s' AS $$
DECLARE v_job public.sie_imports; v_actor uuid; v_ids uuid[]; v_keep_ids uuid[]; v_receipt jsonb;
  v_first integer; v_links uuid[]; v_bad uuid;
BEGIN
  v_job:=public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  IF v_job.job_kind<>'duplicate_repair' OR v_job.job_phase<>'undo' THEN RAISE EXCEPTION 'SIE job is not a reviewed repair'; END IF;
  v_actor:=coalesce(v_job.execution_actor_id,v_job.user_id);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:0',0)) AND
    NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:1',0)) THEN
    RAISE EXCEPTION 'SIE platform write capacity is busy' USING ERRCODE='55P03';
  END IF;
  WITH candidates AS (
    SELECT i.*,(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id=i.reverse_entry_id) n
      FROM public.sie_duplicate_repair_items i WHERE i.import_id=p_import_id AND i.reversal_id IS NULL AND i.cancelled_at IS NULL ORDER BY ordinal LIMIT 200
  ), sized AS (SELECT *,sum(n) OVER (ORDER BY ordinal) total FROM candidates)
  SELECT array_agg(reverse_entry_id ORDER BY ordinal),array_agg(keep_entry_id ORDER BY ordinal),min(ordinal)
    INTO v_ids,v_keep_ids,v_first FROM sized WHERE total<=2000;
  IF coalesce(cardinality(v_ids),0)=0 THEN
    IF EXISTS(SELECT 1 FROM public.sie_duplicate_repair_items WHERE import_id=p_import_id AND reversal_id IS NULL AND cancelled_at IS NULL) THEN
      RAISE EXCEPTION 'SIE repair voucher exceeds 2000 lines' USING ERRCODE='22023';
    END IF;
    UPDATE public.sie_imports SET job_state='undone',status='replaced',worker_id=NULL,lease_until=NULL,error_message=NULL
      WHERE id=p_import_id;
    UPDATE public.fiscal_periods SET import_hold=NULL WHERE id=v_job.fiscal_period_id AND import_hold=p_import_id;
    RETURN jsonb_build_object('reversed',0,'done',true);
  END IF;
  PERFORM 1 FROM public.journal_entries WHERE id=ANY(v_ids||v_keep_ids) ORDER BY id FOR UPDATE;
  SELECT i.reverse_entry_id INTO v_bad FROM public.sie_duplicate_repair_items i
    JOIN public.journal_entries d ON d.id=i.reverse_entry_id JOIN public.journal_entries k ON k.id=i.keep_entry_id
    WHERE i.import_id=p_import_id AND i.reverse_entry_id=ANY(v_ids) AND (
      d.status<>'posted' OR k.status<>'posted' OR d.company_id<>p_company_id OR k.company_id<>p_company_id
      OR d.fiscal_period_id<>v_job.fiscal_period_id OR k.fiscal_period_id<>v_job.fiscal_period_id
      OR public.sie_repair_content_hash(d.id) IS DISTINCT FROM i.content_hash
      OR public.sie_repair_content_hash(k.id) IS DISTINCT FROM i.content_hash
      OR public.sie_repair_entry_links(d.id) IS DISTINCT FROM i.reverse_links
      OR public.sie_repair_entry_links(k.id) IS DISTINCT FROM i.keep_links) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'SIE repair review changed for voucher %',v_bad USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM public.sie_duplicate_repair_items i,
    LATERAL jsonb_array_elements(i.reverse_links) l WHERE i.import_id=p_import_id AND i.reverse_entry_id=ANY(v_ids)
      AND l->>'relationship' NOT IN ('document_attachments.journal_entry_id','document_attachments.journal_entry_line_id',
        'transactions.journal_entry_id','transaction_voucher_links.journal_entry_id','journal_entry_no_doc_required.journal_entry_id')) THEN
    RAISE EXCEPTION 'SIE repair has a dependent record requiring separate review' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.sie_repair_job',p_import_id::text,true);
  -- The atomic storno writer below is shared in shape with ordinary batch undo.
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
    SELECT j.*,r.last_number-c.n+row_number() OVER (PARTITION BY j.voucher_series ORDER BY j.voucher_number,j.id) number
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
  UPDATE public.sie_duplicate_repair_items i SET reversal_id=(r->>'id')::uuid
    FROM jsonb_array_elements(v_receipt) r WHERE i.import_id=p_import_id AND i.reverse_entry_id=(r->>'reverses')::uuid;
  INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
    VALUES(p_import_id,p_company_id,v_actor,'undo',v_first,encode(extensions.digest(v_receipt::text,'sha256'),'hex'),
      'completed',jsonb_build_object('entries',v_receipt,'reviewHash',v_job.manifest->>'reviewHash'),clock_timestamp());
  UPDATE public.sie_imports SET chunks_done=chunks_done+cardinality(v_ids) WHERE id=p_import_id;
  RETURN jsonb_build_object('reversed',cardinality(v_ids),'done',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_sie_held_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_entry public.journal_entries; v_hold uuid; v_repair uuid;
  v_old jsonb; v_new jsonb; v_ids uuid[]; v_authorized_unlink boolean;
BEGIN
  IF TG_OP<>'INSERT' THEN v_old:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN v_new:=to_jsonb(NEW); END IF;
  v_ids:=ARRAY[(v_old->>'journal_entry_id')::uuid,(v_new->>'journal_entry_id')::uuid];
  IF TG_TABLE_NAME='document_attachments' THEN
    v_ids:=v_ids || ARRAY(SELECT journal_entry_id FROM public.journal_entry_lines
      WHERE id IN ((v_old->>'journal_entry_line_id')::uuid,(v_new->>'journal_entry_line_id')::uuid));
  END IF;
  FOR v_entry IN SELECT * FROM public.journal_entries WHERE id=ANY(v_ids) ORDER BY fiscal_period_id,id
  LOOP
    IF v_entry.import_batch_id IS NULL AND v_entry.source_type<>'import' THEN CONTINUE; END IF;
    SELECT import_hold INTO v_hold FROM public.fiscal_periods
      WHERE id=v_entry.fiscal_period_id FOR UPDATE NOWAIT;
    v_repair:=public.sie_active_repair_for_entry(v_entry.id);
    v_authorized_unlink:=false;
    -- Only the trusted reversal may remove a bank anchor, and only from its
    -- reviewed reverse target. It cannot attach a new record or touch a keeper.
    IF current_user NOT IN ('anon','authenticated','service_role') AND
      ((TG_TABLE_NAME='transaction_voucher_links' AND TG_OP='DELETE') OR
       (TG_TABLE_NAME='transactions' AND TG_OP='UPDATE' AND v_new->>'journal_entry_id' IS NULL)) THEN
      IF v_repair IS NOT NULL THEN
        v_authorized_unlink:=current_setting('app.sie_repair_job',true)=v_repair::text AND EXISTS(
          SELECT 1 FROM public.sie_duplicate_repair_items WHERE import_id=v_repair
            AND reverse_entry_id=v_entry.id);
      ELSE
        v_authorized_unlink:=v_entry.import_batch_id=v_hold AND EXISTS(
          SELECT 1 FROM public.sie_imports WHERE id=v_hold AND job_phase='undo');
      END IF;
    END IF;
    IF NOT coalesce(v_authorized_unlink,false) AND (v_repair IS NOT NULL OR v_entry.import_batch_id=v_hold) THEN
      RAISE EXCEPTION 'SIE_IMPORT_HOLD: vänta med underlag och bankmatchning tills importen är slutförd' USING ERRCODE='55000';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.stop_sie_duplicate_repair(p_company_id uuid,p_import_id uuid,p_actor uuid,
  p_review_hash text,p_reason text) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s' AS $$
DECLARE v_job public.sie_imports; v_cancelled integer; v_reversed integer;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  IF NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=p_company_id AND user_id=p_actor AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'SIE reversal requires company owner or administrator' USING ERRCODE='42501';
  END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'An explicit repair stop reason is required' USING ERRCODE='22023';
  END IF;
  -- Wait behind the current bounded chunk, then invalidate its worker/attempt.
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:'||p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE id=p_import_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_kind<>'duplicate_repair' THEN
    RAISE EXCEPTION 'Reviewed repair not found' USING ERRCODE='P0002';
  END IF;
  IF v_job.manifest->>'reviewHash' IS DISTINCT FROM p_review_hash THEN
    RAISE EXCEPTION 'Repair stop must name the exact approved review' USING ERRCODE='22023';
  END IF;
  IF v_job.job_state IN ('completed','undone') THEN RETURN v_job; END IF;
  PERFORM 1 FROM public.fiscal_periods WHERE id=v_job.fiscal_period_id AND import_hold=p_import_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Repair hold missing' USING ERRCODE='55000'; END IF;
  UPDATE public.sie_duplicate_repair_items SET cancelled_at=clock_timestamp()
    WHERE import_id=p_import_id AND reversal_id IS NULL AND cancelled_at IS NULL;
  GET DIAGNOSTICS v_cancelled=ROW_COUNT;
  SELECT count(*)::integer INTO v_reversed FROM public.sie_duplicate_repair_items
    WHERE import_id=p_import_id AND reversal_id IS NOT NULL;
  UPDATE public.sie_imports SET job_state='completed',status='completed',worker_id=NULL,lease_until=NULL,
    job_attempt=job_attempt+1,next_attempt_at=NULL,error_message=NULL,
    job_result=jsonb_build_object('repairOutcome','stopped','reversed',v_reversed,'cancelled',v_cancelled,
      'stoppedBy',p_actor,'stoppedAt',clock_timestamp(),'reason',trim(p_reason),'reviewHash',p_review_hash)
    WHERE id=p_import_id RETURNING * INTO v_job;
  UPDATE public.fiscal_periods SET import_hold=NULL WHERE id=v_job.fiscal_period_id AND import_hold=p_import_id;
  RETURN v_job;
END;
$$;

NOTIFY pgrst,'reload schema';
