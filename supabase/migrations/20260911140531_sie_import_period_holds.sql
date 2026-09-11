-- A read/export spans several HTTP queries. A row lock released at the first
-- query is insufficient, so imports also respect these short database leases.
CREATE TABLE public.sie_period_read_leases (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  expires_at timestamptz NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('sie_export','vat_submission'))
);
ALTER TABLE public.sie_period_read_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sie_period_read_leases FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX sie_period_read_lease_company_idx ON public.sie_period_read_leases(company_id,expires_at);

CREATE FUNCTION public.acquire_sie_period_read(p_company_id uuid,p_purpose text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token uuid;
BEGIN
  IF coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','') <> 'service_role'
    AND NOT public.caller_is_company_member(p_company_id) THEN RAISE EXCEPTION 'Company access required' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  PERFORM 1 FROM public.fiscal_periods WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
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

CREATE FUNCTION public.finish_sie_period_read(p_company_id uuid,p_token uuid,p_require_valid boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lease public.sie_period_read_leases;
BEGIN
  IF coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','') <> 'service_role'
    AND NOT public.caller_is_company_member(p_company_id) THEN RAISE EXCEPTION 'Company access required' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  DELETE FROM public.sie_period_read_leases WHERE company_id = p_company_id AND token = p_token RETURNING * INTO v_lease;
  IF p_require_valid AND (v_lease.token IS NULL OR v_lease.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'SIE export or filing snapshot expired; retry' USING ERRCODE = '55000';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_sie_period_read(uuid,uuid,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.finish_sie_period_read(uuid,uuid,boolean) TO authenticated,service_role;

CREATE FUNCTION public.guard_sie_read_lease() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.import_hold IS NOT NULL AND NEW.import_hold IS DISTINCT FROM OLD.import_hold AND EXISTS (
    SELECT 1 FROM public.sie_period_read_leases WHERE company_id = NEW.company_id AND expires_at > clock_timestamp()
  ) THEN RAISE EXCEPTION 'An export or VAT submission is in progress; retry the import' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_read_lease() FROM PUBLIC;
CREATE TRIGGER guard_sie_read_lease BEFORE UPDATE OF import_hold ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_read_lease();

CREATE FUNCTION public.guard_sie_held_entry() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_hold uuid; v_phase text; v_original_batch uuid;
BEGIN
  -- Native unrelated bookkeeping does not depend on the import. In particular
  -- commit_journal_entry already owns its sequence lock when this trigger runs.
  IF NEW.import_batch_id IS NULL AND NEW.correction_of_id IS NULL AND
    NEW.source_type NOT IN ('import','opening_balance','year_end','storno') THEN RETURN NEW; END IF;
  SELECT import_hold INTO v_hold FROM public.fiscal_periods
    WHERE id = NEW.fiscal_period_id AND company_id = NEW.company_id FOR UPDATE NOWAIT;
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
REVOKE ALL ON FUNCTION public.guard_sie_held_entry() FROM PUBLIC;
CREATE TRIGGER guard_sie_held_entry BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_held_entry();

CREATE FUNCTION public.guard_sie_held_attachment() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_entry uuid; v_period uuid; v_batch uuid; v_hold uuid;
BEGIN
  v_entry := NEW.journal_entry_id;
  IF TG_TABLE_NAME = 'document_attachments' AND v_entry IS NULL THEN
    SELECT journal_entry_id INTO v_entry FROM public.journal_entry_lines WHERE id = (to_jsonb(NEW)->>'journal_entry_line_id')::uuid;
  END IF;
  IF v_entry IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id
    AND (to_jsonb(NEW)->>'journal_entry_line_id') IS NOT DISTINCT FROM (to_jsonb(OLD)->>'journal_entry_line_id') THEN RETURN NEW; END IF;
  SELECT fiscal_period_id,import_batch_id INTO v_period,v_batch FROM public.journal_entries WHERE id = v_entry;
  IF v_batch IS NULL THEN RETURN NEW; END IF;
  SELECT import_hold INTO v_hold FROM public.fiscal_periods WHERE id = v_period FOR UPDATE NOWAIT;
  IF v_batch IS NOT NULL AND v_hold = v_batch THEN
    RAISE EXCEPTION 'SIE_IMPORT_HOLD: vänta med underlag och bankmatchning tills importen är slutförd' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_held_attachment() FROM PUBLIC;
CREATE TRIGGER guard_sie_held_document BEFORE INSERT OR UPDATE ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_held_attachment();
CREATE TRIGGER guard_sie_held_bank_pointer BEFORE INSERT OR UPDATE OF journal_entry_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_held_attachment();
CREATE TRIGGER guard_sie_held_bank_link BEFORE INSERT OR UPDATE OF journal_entry_id ON public.transaction_voucher_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_held_attachment();

CREATE FUNCTION public.guard_sie_company_lock_date() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.bookkeeping_locked_through IS DISTINCT FROM OLD.bookkeeping_locked_through THEN
    -- A row trigger already owns the settings row. Never wait for a period
    -- owned by a worker that may need those settings; return a retryable lock
    -- conflict. An acquired lock still protects the check through commit.
    PERFORM 1 FROM public.fiscal_periods WHERE company_id = NEW.company_id ORDER BY id FOR UPDATE NOWAIT;
    IF EXISTS (SELECT 1 FROM public.fiscal_periods WHERE company_id = NEW.company_id AND import_hold IS NOT NULL) THEN
      RAISE EXCEPTION 'SIE_IMPORT_HOLD: importen måste slutföras innan bokföringen låses' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_company_lock_date() FROM PUBLIC;
CREATE TRIGGER guard_sie_company_lock_date BEFORE UPDATE OF bookkeeping_locked_through ON public.company_settings
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_company_lock_date();

NOTIFY pgrst,'reload schema';

