-- Provider migration review: a finished import can be accepted with the
-- records that need attention, and a retry that changes nothing says so
-- (PH 143, PH 145, PH 149).
--
-- A job whose every record has an outcome ended in state needs_attention when
-- any record failed, and the wizard's only action was a retry. A retry
-- re-queues exactly the failed records and runs the same checks on the same
-- source data, so the same records failed again and the job came back to
-- needs_attention, every time. needs_attention also holds the company's one
-- active job (migration_jobs_one_active_company), so no new import could start
-- either: the user could neither finish nor begin again.
--
--   * accept_provider_migration_job finishes such a job: state 'completed',
--     with who accepted it and when. It accepts only a job in phase
--     'completed' (every record has an outcome, no worker holds it); a job
--     paused mid-run is resumed, never accepted, or its unprocessed records
--     would disappear unseen. The records that need attention keep their
--     state, code and phase, so the result goes on listing them. Nothing is
--     dropped, rewritten or retried.
--   * retry_provider_migration_job notes each failed record's code in its
--     receipt (receipt.previous_error_code) before re-queueing it, so the
--     next outcome shows whether the retry changed anything. Kept in the
--     receipt, not a new column, so status reads never depend on whether this
--     migration has been applied yet.
--   * commit_provider_migration_followup keeps the review detail the worker
--     sends with a review outcome (receipt.review: what the voucher books
--     against the invoice), and stores a code raised by name (BOKIO_*,
--     PROVIDER_*) under that name instead of the bare SQLSTATE P0001. Codes
--     only, as before: a constraint message can quote source personal data.
--     Copied from 20260922172815; only the receipt and code handling changed.
--
-- No journal entry, invoice or payment is written here.

ALTER TABLE public.migration_jobs ADD COLUMN review_accepted_at timestamptz;
ALTER TABLE public.migration_jobs ADD COLUMN review_accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.migration_jobs.review_accepted_at IS
  'When a member accepted the finished import with the records still in needs_attention (accept_provider_migration_job). Those records keep their state and are listed in the result.';
COMMENT ON COLUMN public.migration_jobs.review_accepted_by IS
  'The member who accepted the finished import with records in needs_attention.';
CREATE INDEX migration_jobs_review_accepted_by ON public.migration_jobs(review_accepted_by)
  WHERE review_accepted_by IS NOT NULL;

CREATE OR REPLACE FUNCTION public.retry_provider_migration_job(p_job_id uuid,p_company_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF j.state NOT IN ('needs_attention','retry_wait') THEN RETURN; END IF;
  -- Only the failed records go back to work, each to the phase it failed in.
  -- Their last code stays in the receipt: the same code after the retry means
  -- the retry changed nothing for that record.
  UPDATE migration_job_chunks SET state=CASE error_phase WHEN 'link' THEN 'imported' WHEN 'reconcile' THEN 'linked' WHEN 'settle' THEN 'planned' ELSE 'pending' END,
    receipt=receipt||jsonb_build_object('previous_error_code',error_code),
    error_code=NULL,error_phase=NULL WHERE job_id=j.id AND state='needs_attention';
  UPDATE migration_jobs SET user_id=p_user_id,state='queued',phase=CASE WHEN phase='discover' THEN 'discover' ELSE 'import' END,
    worker_id=NULL,lease_until=NULL,next_attempt_at=NULL,failures=0,error_code=NULL WHERE id=j.id;
END $$;

CREATE FUNCTION public.accept_provider_migration_job(p_job_id uuid,p_company_id uuid,p_user_id uuid)
RETURNS public.migration_jobs LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  SELECT * INTO j FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MIGRATION_JOB_NOT_FOUND'; END IF;
  -- A repeated acceptance (a lost response, a second click) gets the job back.
  IF j.state='completed' THEN RETURN j; END IF;
  -- Only a finished job: every record has an outcome and no worker holds it.
  IF j.phase<>'completed' OR j.state<>'needs_attention' THEN RAISE EXCEPTION 'MIGRATION_NOT_ACCEPTABLE'; END IF;
  UPDATE migration_jobs SET state='completed',review_accepted_at=clock_timestamp(),review_accepted_by=p_user_id,
    worker_id=NULL,lease_until=NULL,next_attempt_at=NULL,error_code=NULL
    WHERE id=j.id RETURNING * INTO j;
  RETURN j;
END $$;

CREATE OR REPLACE FUNCTION public.commit_provider_migration_followup(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; entry uuid; outcome jsonb; message text; si supplier_invoices; source jsonb;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase NOT IN ('link','reconcile','settle') OR jsonb_array_length(p_records)>25 THEN
    RAISE EXCEPTION 'MIGRATION_PHASE_CONFLICT'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    SELECT * INTO STRICT c FROM migration_job_chunks WHERE id=(r->>'id')::uuid AND job_id=j.id FOR UPDATE;
    IF (j.phase='link' AND c.state<>'imported') OR (j.phase='reconcile' AND c.state<>'linked')
      OR (j.phase='settle' AND c.state<>'planned') THEN CONTINUE; END IF;
    BEGIN
      IF r ? 'error' THEN RAISE EXCEPTION '%',r->>'error'; END IF;
      IF j.phase='link' THEN
        entry:=NULLIF(r->>'journal_entry_id','')::uuid;
        IF entry IS NOT NULL THEN
          IF NOT EXISTS(SELECT 1 FROM journal_entries WHERE id=entry AND company_id=j.company_id AND status='posted') THEN
            RAISE EXCEPTION 'MIGRATION_VOUCHER_UNAVAILABLE'; END IF;
          IF EXISTS(SELECT 1 FROM invoices WHERE company_id=j.company_id AND journal_entry_id=entry AND id<>c.target_id)
            OR EXISTS(SELECT 1 FROM supplier_invoices WHERE company_id=j.company_id AND registration_journal_entry_id=entry AND id<>c.target_id) THEN
            RAISE EXCEPTION 'MIGRATION_REGISTRATION_AMBIGUOUS'; END IF;
          -- A matching source ref on multiple invoices is ambiguous across the
          -- whole job, including invoices in other worker batches.
          IF (SELECT count(*) FROM migration_job_chunks other
            JOIN journal_entries e ON e.id=entry
            JOIN fiscal_periods fp ON fp.id=e.fiscal_period_id
            WHERE other.job_id=j.id AND other.target_id IS NOT NULL
              AND other.receipt->'link'->'sourceVoucher'=c.receipt->'link'->'sourceVoucher'
              AND COALESCE((other.receipt#>>'{link,sourceVoucher,date}')::date,(other.receipt->'link'->>'invoiceDate')::date) BETWEEN fp.period_start AND fp.period_end)>1 THEN
            RAISE EXCEPTION 'MIGRATION_REGISTRATION_AMBIGUOUS'; END IF;
          IF c.resource='salesInvoices' THEN
            UPDATE invoices SET journal_entry_id=entry WHERE id=c.target_id AND company_id=j.company_id AND journal_entry_id IS NULL;
          ELSIF r#>>'{report,linkType}' IS DISTINCT FROM 'settlement' THEN
            UPDATE supplier_invoices SET registration_journal_entry_id=entry
              WHERE id=c.target_id AND company_id=j.company_id AND registration_journal_entry_id IS NULL;
          END IF;
        END IF;
        IF j.provider='bokio' AND c.resource='supplierInvoices' AND c.receipt#>'{link,bokioSource}' IS NOT NULL THEN
          SELECT * INTO STRICT si FROM supplier_invoices WHERE id=c.target_id AND company_id=j.company_id;
          source:=c.receipt#>'{link,bokioSource}' || jsonb_build_object('supplier_id',si.supplier_id);
          outcome:=complete_bokio_supplier_invoice(j.company_id,j.consent_id,si.id,j.id,source,
            jsonb_build_object('updated_at',si.updated_at,'total',si.total,'supplier_id',si.supplier_id),
            jsonb_build_object('origin','import') || CASE WHEN entry IS NOT NULL AND r#>>'{report,linkType}'='settlement'
              THEN jsonb_build_object('voucher_id',entry,'voucher_kind','cash_purchase') ELSE '{}'::jsonb END,false);
          IF outcome->>'outcome'='concurrent_change' OR (outcome->'settlement' IS NOT NULL AND outcome->'settlement'<>'null'::jsonb
            AND NOT COALESCE((outcome#>>'{settlement,ok}')::boolean,false)
            AND outcome#>>'{settlement,code}'<>'ATTACH_SI_SETTLEMENT_ALREADY_LINKED') THEN
            RAISE EXCEPTION 'MIGRATION_BOKIO_COMPLETION_REJECTED'; END IF;
        END IF;
        UPDATE migration_job_chunks SET state=CASE WHEN resource='supplierInvoices' THEN 'linked' ELSE 'done' END,
          receipt=(receipt-'review'-'previous_error_code')||jsonb_build_object('registration',r->'report') WHERE id=c.id;
      ELSIF j.phase='reconcile' THEN
        UPDATE migration_job_chunks SET state='planned',
          receipt=(receipt-'review'-'previous_error_code')||jsonb_build_object('payment',r->'payment') WHERE id=c.id;
      ELSE
        entry:=NULLIF(c.receipt->'payment'->>'journal_entry_id','')::uuid;
        IF entry IS NOT NULL THEN
          IF (SELECT count(*) FROM migration_job_chunks WHERE job_id=j.id
            AND receipt->'payment'->>'journal_entry_id'=entry::text)>1 THEN
            RAISE EXCEPTION 'MIGRATION_PAYMENT_AMBIGUOUS'; END IF;
          IF EXISTS(SELECT 1 FROM supplier_invoice_payments WHERE company_id=j.company_id AND journal_entry_id=entry) THEN
            RAISE EXCEPTION 'MIGRATION_PAYMENT_AMBIGUOUS'; END IF;
          outcome:=link_supplier_invoice_to_voucher(c.target_id,entry,j.user_id,j.company_id,'Provider migration');
          IF NOT COALESCE((outcome->>'ok')::boolean,false) THEN
            RAISE EXCEPTION 'MIGRATION_PAYMENT_REJECTED'; END IF;
        END IF;
        UPDATE migration_job_chunks SET state='done',receipt=receipt-'review'-'previous_error_code' WHERE id=c.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
      -- Codes only: Postgres constraint errors can contain source personal
      -- data. A code raised by name keeps that name; anything else its
      -- SQLSTATE. The review detail the worker sent (receipt.review) explains
      -- a review outcome; one left from an earlier attempt is cleared.
      UPDATE migration_job_chunks SET state='needs_attention',error_phase=j.phase,
        error_code=COALESCE(substring(message FROM '^((?:MIGRATION|BOKIO|PROVIDER)_[A-Z0-9_]+)'),SQLSTATE),
        receipt=CASE WHEN jsonb_typeof(r->'review')='object' THEN receipt||jsonb_build_object('review',r->'review')
          ELSE receipt-'review' END
        WHERE id=c.id;
    END;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.accept_provider_migration_job(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accept_provider_migration_job(uuid,uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
