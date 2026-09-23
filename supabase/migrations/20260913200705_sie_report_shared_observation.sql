-- Report acquisition observes periods; it must coexist with normal posting,
-- correction and bank-anchor observers. SHARE still excludes admission's UPDATE
-- and any concurrent import_hold update. The durable lease protects later HTTP
-- reads after this transaction releases its row locks.
-- pg-test: covered-by tests/pg/sie-report-lease-concurrency.pg.test.ts
CREATE OR REPLACE FUNCTION public.acquire_sie_period_read(p_company_id uuid,p_purpose text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token uuid;
BEGIN
  IF coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','') <> 'service_role'
    AND NOT public.caller_is_company_member(p_company_id) THEN RAISE EXCEPTION 'Company access required' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  PERFORM 1 FROM public.fiscal_periods WHERE company_id = p_company_id ORDER BY id FOR SHARE;
  IF EXISTS (SELECT 1 FROM public.fiscal_periods WHERE company_id = p_company_id AND import_hold IS NOT NULL) THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: importen pågår eller är oavslutad: fortsätt eller ångra den' USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.sie_period_read_leases WHERE company_id = p_company_id AND expires_at < clock_timestamp();
  INSERT INTO public.sie_period_read_leases(company_id,expires_at,purpose)
    VALUES(p_company_id,clock_timestamp()+interval '5 minutes',p_purpose) RETURNING token INTO v_token;
  RETURN v_token;
END;
$$;
REVOKE ALL ON FUNCTION public.acquire_sie_period_read(uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.acquire_sie_period_read(uuid,text) TO authenticated,service_role;


CREATE OR REPLACE FUNCTION public.guard_sie_held_attachment() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_entry public.journal_entries; v_hold uuid; v_repair uuid;
  v_old jsonb; v_new jsonb; v_ids uuid[]; v_authorized_unlink boolean;
BEGIN
  -- Unlinked bank-sync rows have no entry to guard. Avoid serializing the whole
  -- row and querying journal_entries on this common path. Keep all linked-row
  -- updates guarded: repair approval hashes their complete transaction record.
  IF TG_TABLE_NAME='transactions' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.journal_entry_id IS NULL THEN RETURN NEW; END IF;
    ELSIF TG_OP='DELETE' THEN
      IF OLD.journal_entry_id IS NULL THEN RETURN OLD; END IF;
    ELSIF OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
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
      WHERE id=v_entry.fiscal_period_id FOR SHARE NOWAIT;
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


NOTIFY pgrst, 'reload schema';
