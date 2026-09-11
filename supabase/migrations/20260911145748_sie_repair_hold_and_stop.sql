-- Legacy repair targets need the same period lock before every link/line
-- decision. NOWAIT avoids reversing the sequence/period lock order of booking.
CREATE OR REPLACE FUNCTION public.guard_sie_held_lines() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_entry public.journal_entries; v_hold uuid;
BEGIN
  FOR v_entry IN SELECT * FROM public.journal_entries WHERE id IN (
    CASE WHEN TG_OP<>'INSERT' THEN OLD.journal_entry_id END,
    CASE WHEN TG_OP<>'DELETE' THEN NEW.journal_entry_id END) ORDER BY fiscal_period_id,id
  LOOP
    IF v_entry.import_batch_id IS NOT NULL OR v_entry.source_type='import' THEN
      SELECT import_hold INTO v_hold FROM public.fiscal_periods
        WHERE id=v_entry.fiscal_period_id FOR UPDATE NOWAIT;
      IF public.sie_active_repair_for_entry(v_entry.id) IS NOT NULL OR
        (v_hold=v_entry.import_batch_id AND v_entry.status<>'draft') THEN
        RAISE EXCEPTION 'SIE_IMPORT_HOLD: vänta med rättelser tills importen är slutförd' USING ERRCODE='55000';
      END IF;
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
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
    IF TG_TABLE_NAME<>'document_attachments' AND current_user NOT IN ('anon','authenticated','service_role')
      AND (TG_OP='DELETE' OR (TG_OP='UPDATE' AND v_new->>'journal_entry_id' IS NULL)) THEN
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

DROP TRIGGER guard_sie_held_bank_pointer ON public.transactions;
CREATE TRIGGER guard_sie_held_bank_pointer BEFORE INSERT OR UPDATE OR DELETE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_held_attachment();
DROP TRIGGER guard_sie_held_bank_link ON public.transaction_voucher_links;
CREATE TRIGGER guard_sie_held_bank_link BEFORE INSERT OR UPDATE OR DELETE ON public.transaction_voucher_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_held_attachment();

-- An immutable review can be closed with pending items explicitly cancelled.
-- Completed reversals stay reserved forever. A fresh approved review may claim
-- cancelled targets; it never edits the original scope or its receipts.
ALTER TABLE public.sie_duplicate_repair_items ADD COLUMN cancelled_at timestamptz,
  ADD CONSTRAINT sie_repair_one_outcome CHECK (reversal_id IS NULL OR cancelled_at IS NULL);
ALTER TABLE public.sie_duplicate_repair_items DROP CONSTRAINT sie_duplicate_repair_items_reverse_entry_id_key;
CREATE UNIQUE INDEX sie_repair_active_reverse_key ON public.sie_duplicate_repair_items(reverse_entry_id)
  WHERE cancelled_at IS NULL;

CREATE OR REPLACE FUNCTION public.guard_sie_repair_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR current_user IN ('anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'SIE repair scope is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'reversal_id'-'cancelled_at'-'updated_at') IS DISTINCT FROM
    (to_jsonb(OLD)-'reversal_id'-'cancelled_at'-'updated_at') OR OLD.reversal_id IS NOT NULL OR OLD.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'SIE repair receipt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.stop_sie_duplicate_repair(p_company_id uuid,p_import_id uuid,p_actor uuid,
  p_review_hash text,p_reason text) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s' AS $$
DECLARE v_job public.sie_imports; v_cancelled integer; v_reversed integer;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
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
REVOKE ALL ON FUNCTION public.stop_sie_duplicate_repair(uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stop_sie_duplicate_repair(uuid,uuid,uuid,text,text) TO service_role;

NOTIFY pgrst,'reload schema';
