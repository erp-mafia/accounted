-- Provider migration link phase: a registration link moves from the reversed
-- copy an SIE re-sync left to the live verifikat of the same source voucher.
--
-- Replacing a fiscal year by an SIE re-sync (replace_sie_import_job) reverses
-- every verifikat the previous import brought in (Makulering) and imports the
-- year again under new voucher numbers. Each source ref (series and number)
-- is then carried twice in that year: by the reversed first copy and by the
-- live second one. The linker counted the copy, so every re-synced ref stopped
-- as ambiguous, and an invoice an earlier run had linked kept pointing at the
-- copy, because the link phase wrote from NULL only. The linker
-- (src/lib/invoices/link-migrated-registration-vouchers.ts) now resolves refs
-- from live entries only, and reports an invoice that still points at the
-- reversed copy with report.replacesJournalEntryId.
--
-- commit_provider_migration_followup accepts that move only when the database
-- shows it is the same source voucher: the replaced entry belongs to the job's
-- company, is reversed, and sits in the target's fiscal year under the
-- target's source series and number. The target is a posted verifikat of the
-- company, as for every link (checked first, unchanged). Anything else raises
-- MIGRATION_VOUCHER_UNAVAILABLE, the chunk stops for review and nothing is
-- written. The write moves the link from that entry only, or writes it from
-- NULL as before, for invoices and supplier invoices alike.
--
-- No journal entry or line is written: the reversed copy, its Makulering and
-- the live verifikat stay as they are; only the invoice's pointer moves. The
-- function body is the 20261005193000 text plus the replaced-copy check and
-- the two widened writes. Signature, SECURITY INVOKER, search_path and grants
-- are unchanged.
--
-- pg-test: tests/pg/provider-migration-replaced-copy-link.pg.test.ts

CREATE OR REPLACE FUNCTION public.commit_provider_migration_followup(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; entry uuid; outcome jsonb; message text; si supplier_invoices; source jsonb;
  replaced uuid;
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
          -- A link that moves from the reversed copy an SIE re-sync left: only
          -- the same source voucher, proven here, never the worker's word.
          replaced:=NULLIF(r#>>'{report,replacesJournalEntryId}','')::uuid;
          IF replaced IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries rev
              JOIN journal_entries tgt ON tgt.id=entry AND tgt.company_id=j.company_id
              WHERE rev.id=replaced AND rev.company_id=j.company_id AND rev.status='reversed'
                AND rev.fiscal_period_id=tgt.fiscal_period_id
                AND rev.source_voucher_number=tgt.source_voucher_number
                AND upper(rev.source_voucher_series)=upper(tgt.source_voucher_series)) THEN
            RAISE EXCEPTION 'MIGRATION_VOUCHER_UNAVAILABLE'; END IF;
          IF c.resource='salesInvoices' THEN
            UPDATE invoices SET journal_entry_id=entry WHERE id=c.target_id AND company_id=j.company_id
              AND (journal_entry_id IS NULL OR journal_entry_id=replaced);
          ELSIF r#>>'{report,linkType}' IS DISTINCT FROM 'settlement' THEN
            UPDATE supplier_invoices SET registration_journal_entry_id=entry
              WHERE id=c.target_id AND company_id=j.company_id
                AND (registration_journal_entry_id IS NULL OR registration_journal_entry_id=replaced);
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

NOTIFY pgrst,'reload schema';
