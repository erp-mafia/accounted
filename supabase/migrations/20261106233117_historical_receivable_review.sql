-- Historical payment references are metadata, never new invoices or bookings.
CREATE TABLE public.historical_receivable_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  job_id uuid NOT NULL REFERENCES public.migration_jobs(id),
  provider text NOT NULL,
  account_key text NOT NULL,
  source_id text,
  payment_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id),
  invoice_number text NOT NULL,
  customer_name text NOT NULL,
  invoice_date date,
  payment_date date NOT NULL,
  payment_amount_sek numeric NOT NULL CHECK (payment_amount_sek>0),
  origin text NOT NULL CHECK (origin IN ('incomplete_invoice','voucher_only')),
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  evidence_description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,payment_journal_entry_id)
);
CREATE INDEX historical_receivable_references_company ON public.historical_receivable_references(company_id);
CREATE INDEX historical_receivable_references_job ON public.historical_receivable_references(job_id);
CREATE UNIQUE INDEX historical_receivable_references_source ON public.historical_receivable_references
  (company_id,provider,account_key,source_id) WHERE source_id IS NOT NULL AND decision='approved';
ALTER TABLE public.historical_receivable_references ENABLE ROW LEVEL SECURITY;
CREATE POLICY historical_receivable_references_read ON public.historical_receivable_references
  FOR SELECT TO authenticated USING (company_id IN (SELECT public.user_company_ids()));
GRANT SELECT ON public.historical_receivable_references TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.historical_receivable_references TO service_role;
-- Clients cannot mutate history: all decisions go through the gated server RPC.
CREATE TRIGGER historical_receivable_references_updated BEFORE UPDATE ON public.historical_receivable_references
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER historical_receivable_references_audit AFTER INSERT OR UPDATE OR DELETE ON public.historical_receivable_references
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE FUNCTION public.review_historical_receivable(
  p_company_id uuid,p_user_id uuid,p_job_id uuid,p_payment_id uuid,p_decision text,p_finding jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; e public.journal_entries;
  existing public.historical_receivable_references; result uuid; ar numeric; bank numeric; n text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id
    AND role IN ('owner','admin','member')) THEN RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  IF p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'MIGRATION_REVIEW_INVALID'; END IF;
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF j.provider<>'bokio' OR j.state NOT IN ('needs_attention','completed') THEN RAISE EXCEPTION 'MIGRATION_REVIEW_CONFLICT'; END IF;
  SELECT * INTO STRICT e FROM journal_entries WHERE id=p_payment_id AND company_id=p_company_id FOR SHARE;
  SELECT * INTO existing FROM historical_receivable_references WHERE company_id=p_company_id AND payment_journal_entry_id=e.id;
  IF FOUND THEN
    IF existing.decision=p_decision THEN RETURN existing.id; END IF;
    RAISE EXCEPTION 'MIGRATION_REVIEW_CONFLICT';
  END IF;
  IF e.status<>'posted' OR e.reversed_by_id IS NOT NULL
    OR e.description IS DISTINCT FROM p_finding->>'description'
    OR e.entry_date IS DISTINCT FROM (p_finding->>'paymentDate')::date THEN RAISE EXCEPTION 'MIGRATION_REVIEW_CONFLICT'; END IF;
  n:=p_finding->>'invoiceNumber';
  IF n !~ '^[0-9]{1,32}$' OR COALESCE(p_finding->>'customer','')='' THEN RAISE EXCEPTION 'MIGRATION_REVIEW_INVALID'; END IF;
  -- The server derives this summary from exact description tokens, never a substring search alone.
  IF e.description !~* ('(^|[^0-9])'||n||'([^0-9]|$)') THEN RAISE EXCEPTION 'MIGRATION_REVIEW_CONFLICT'; END IF;
  SELECT COALESCE(sum(CASE WHEN account_number LIKE '15%' THEN credit_amount-debit_amount ELSE 0 END),0),
    COALESCE(sum(CASE WHEN account_number LIKE '19%' THEN debit_amount-credit_amount ELSE 0 END),0)
    INTO ar,bank FROM journal_entry_lines WHERE journal_entry_id=e.id;
  IF ar<=0 OR abs(ar-bank)>0.01 OR abs(ar-(p_finding->>'paymentAmount')::numeric)>0.01
    THEN RAISE EXCEPTION 'MIGRATION_REVIEW_CONFLICT'; END IF;
  IF p_finding->>'chunkId' IS NOT NULL THEN
    SELECT * INTO STRICT c FROM migration_job_chunks WHERE id=(p_finding->>'chunkId')::uuid
      AND company_id=p_company_id AND job_id=j.id FOR UPDATE;
    IF c.resource<>'salesInvoices' OR c.target_id IS NOT NULL OR c.state<>'needs_attention'
      OR c.error_code<>'MIGRATION_SOURCE_LINES_MISSING' OR c.source_id IS DISTINCT FROM p_finding->>'sourceId'
      OR c.payload_hash IS DISTINCT FROM p_finding->>'payloadHash' THEN RAISE EXCEPTION 'MIGRATION_REVIEW_CONFLICT'; END IF;
  END IF;
  INSERT INTO historical_receivable_references(company_id,user_id,job_id,provider,account_key,source_id,
    payment_journal_entry_id,invoice_number,customer_name,invoice_date,payment_date,payment_amount_sek,origin,decision,evidence_description)
  VALUES(p_company_id,p_user_id,j.id,j.provider,j.account_key,p_finding->>'sourceId',e.id,n,p_finding->>'customer',
    (p_finding->>'invoiceDate')::date,e.entry_date,ar,p_finding->>'origin',p_decision,e.description) RETURNING id INTO result;
  IF c.id IS NOT NULL AND p_decision='approved' THEN
    UPDATE migration_job_chunks SET state='skipped',error_code=NULL,error_phase=NULL,
      receipt=receipt||jsonb_build_object('reason','historical_receivable','historicalReferenceId',result,
        'paymentJournalEntryId',e.id,'approvedBy',p_user_id,'approvedAt',now()) WHERE id=c.id;
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.review_historical_receivable(uuid,uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_historical_receivable(uuid,uuid,uuid,uuid,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
