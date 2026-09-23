-- Observers may run together while admission and execution retain exclusive
-- period locks. FOR SHARE also blocks non-key updates to import_hold; KEY SHARE
-- would not. NOWAIT still prevents the voucher-sequence/period lock inversion.
-- The ordinary posting, correction, document-retention and balance guards stay
-- unchanged. A transaction that already owns the execution lock can observe it.
-- pg-test: covered-by tests/pg/sie-observer-concurrency.pg.test.ts
CREATE OR REPLACE FUNCTION public.guard_sie_held_entry() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_hold uuid; v_phase text; v_original_batch uuid; v_repair uuid;
BEGIN
  IF NEW.import_batch_id IS NULL AND (TG_OP='UPDATE' OR NEW.correction_of_id IS NOT NULL OR NEW.reverses_id IS NOT NULL) THEN
    v_repair:=coalesce(public.sie_active_repair_for_entry(NEW.id),
      public.sie_active_repair_for_entry(NEW.correction_of_id),public.sie_active_repair_for_entry(NEW.reverses_id));
  END IF;
  IF v_repair IS NOT NULL THEN
    IF current_user NOT IN ('anon','authenticated','service_role') AND
      current_setting('app.sie_repair_job',true)=v_repair::text AND
      (NEW.source_type='storno' OR (TG_OP='UPDATE' AND NEW.status='reversed')) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: granskad dubbletträttelse pågår' USING ERRCODE='55000';
  END IF;
  -- Native unrelated bookkeeping does not depend on the import. In particular
  -- commit_journal_entry already owns its sequence lock when this trigger runs.
  IF NEW.import_batch_id IS NULL AND NEW.correction_of_id IS NULL AND
    NEW.source_type NOT IN ('import','opening_balance','year_end','storno') THEN RETURN NEW; END IF;
  SELECT import_hold INTO v_hold FROM public.fiscal_periods
    WHERE id = NEW.fiscal_period_id AND company_id = NEW.company_id FOR SHARE NOWAIT;
  IF v_hold IS NULL THEN RETURN NEW; END IF;
  SELECT job_phase INTO v_phase FROM public.sie_imports WHERE id = v_hold;
  IF current_user NOT IN ('anon','authenticated','service_role') THEN
    IF NEW.import_batch_id = v_hold AND v_phase IN ('vouchers','finalize') AND
      ((TG_OP = 'INSERT' AND NEW.status = 'draft') OR
       (TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'posted')) THEN RETURN NEW; END IF;
    IF v_phase = 'undo' THEN
      IF TG_OP = 'UPDATE' AND NEW.import_batch_id = v_hold AND NEW.status = 'reversed' THEN RETURN NEW; END IF;
      IF NEW.source_type = 'storno' THEN
        SELECT import_batch_id INTO v_original_batch FROM public.journal_entries WHERE id = NEW.reverses_id AND company_id = NEW.company_id;
        IF v_original_batch = v_hold THEN RETURN NEW; END IF;
      END IF;
    END IF;
  END IF;
  IF NEW.correction_of_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.journal_entries
    WHERE id = NEW.correction_of_id AND company_id = NEW.company_id AND import_batch_id = v_hold) THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: vänta med rättelser tills importen är slutförd' USING ERRCODE = '55000';
  END IF;
  -- Ordinary unrelated bookkeeping remains usable; work that changes the
  -- import or period balances' initialization must wait for finalization.
  IF NEW.import_batch_id IS NOT NULL OR NEW.source_type IN ('import','opening_balance','year_end','storno') THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: importen pågår eller är oavslutad' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

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
        WHERE id=v_entry.fiscal_period_id FOR SHARE NOWAIT;
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
