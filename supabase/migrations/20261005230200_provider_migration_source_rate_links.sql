-- A migrated foreign-currency invoice takes the SEK amount its verifikat books
-- (crm#1039; founder decision 2026-10-06).
--
-- The provider worker links an imported invoice to the verifikat the source
-- system booked it with, once that verifikat's amount on 151x (customer) or
-- 244x (supplier) corroborates the invoice's SEK total. A foreign-currency
-- invoice got its SEK total from our own rate index, while the source booked
-- the verifikat at its own rate: the two differed by a few kronor, the link
-- stopped for review (MIGRATION_REGISTRATION_REVIEW), and the invoice stayed
-- unlinked at our rate. The kundreskontra then disagreed with 1510 (the
-- leverantörsreskontra with 2440), and a payment would have cleared 1510 at
-- our rate and left the difference standing on it.
--
-- The worker now decides that such a verifikat is this invoice at the source's
-- rate (linkMigratedRegistrationVouchers: it books within 10% of the invoice's
-- SEK total, the band match_batch_allocate and link_supplier_invoice_to_voucher
-- read a rate difference by) and computes what the invoice takes from it
-- (report.sourceRate). commit_provider_migration_source_rate_links commits the
-- batch through commit_provider_migration_followup, unchanged, and then writes
-- those values onto each invoice the followup linked, in the same transaction:
-- exchange_rate (the SEK total over the invoice total), exchange_rate_date (the
-- verifikat's date) and the three *_sek columns. An invoice the followup
-- refused keeps its own values. The invoice's own currency amounts, status and
-- payments are never touched, and no journal entry or line is written: the
-- verifikat is the record, and the invoice is brought in line with it.
--
-- The values are checked against the database before they are written: the
-- invoice is in a foreign currency, still has the total they were derived
-- from and links that verifikat, the verifikat books the new SEK total on
-- 151x/244x to the öre (a supplier credit note debits 2440), and the rate gives
-- that total back. A failed check raises MIGRATION_SOURCE_RATE_CONFLICT, which
-- rolls the whole batch back, links included, for the worker to retry on
-- fresh reads.

CREATE FUNCTION public.commit_provider_migration_source_rate_links(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; v jsonb; entry uuid;
  v_total numeric; v_total_sek numeric; v_rate numeric; v_booked numeric; v_written integer;
BEGIN
  -- Fencing, the link checks, review outcomes and receipts: the followup's own.
  PERFORM commit_provider_migration_followup(p_job_id,p_worker_id,p_attempt,p_records);
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase<>'link' THEN RAISE EXCEPTION 'MIGRATION_PHASE_CONFLICT'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    v:=r#>'{report,sourceRate}';
    entry:=NULLIF(r->>'journal_entry_id','')::uuid;
    CONTINUE WHEN jsonb_typeof(v) IS DISTINCT FROM 'object' OR entry IS NULL;
    SELECT * INTO c FROM migration_job_chunks WHERE id=(r->>'id')::uuid AND job_id=j.id;
    -- Only an invoice the followup linked takes the verifikat's amount.
    CONTINUE WHEN NOT FOUND OR c.state NOT IN ('done','linked') OR c.target_id IS NULL;
    v_total:=(v->>'total')::numeric;
    v_total_sek:=(v->>'totalSek')::numeric;
    v_rate:=(v->>'exchangeRate')::numeric;
    IF c.resource='salesInvoices' THEN
      SELECT COALESCE(sum(debit_amount-credit_amount),0) INTO v_booked FROM journal_entry_lines
        WHERE journal_entry_id=entry AND account_number LIKE '151%';
      UPDATE invoices SET exchange_rate=v_rate,exchange_rate_date=(v->>'exchangeRateDate')::date,total_sek=v_total_sek,
          subtotal_sek=(v->>'subtotalSek')::numeric,vat_amount_sek=(v->>'vatAmountSek')::numeric
        WHERE id=c.target_id AND company_id=j.company_id AND journal_entry_id=entry
          AND COALESCE(currency,'SEK')<>'SEK' AND total=v_total
          AND abs(v_booked-v_total_sek)<=0.005 AND abs(v_total*v_rate-v_total_sek)<=0.005;
    ELSE
      SELECT COALESCE(sum(credit_amount-debit_amount),0) INTO v_booked FROM journal_entry_lines
        WHERE journal_entry_id=entry AND account_number LIKE '244%';
      UPDATE supplier_invoices SET exchange_rate=v_rate,exchange_rate_date=(v->>'exchangeRateDate')::date,total_sek=v_total_sek,
          subtotal_sek=(v->>'subtotalSek')::numeric,vat_amount_sek=(v->>'vatAmountSek')::numeric
        WHERE id=c.target_id AND company_id=j.company_id AND registration_journal_entry_id=entry
          AND currency<>'SEK' AND total=v_total
          AND abs(v_booked-CASE WHEN is_credit_note THEN -v_total_sek ELSE v_total_sek END)<=0.005
          AND abs(v_total*v_rate-v_total_sek)<=0.005;
    END IF;
    GET DIAGNOSTICS v_written=ROW_COUNT;
    IF v_written<>1 THEN RAISE EXCEPTION 'MIGRATION_SOURCE_RATE_CONFLICT'; END IF;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.commit_provider_migration_source_rate_links(uuid,uuid,integer,jsonb) IS
  'Provider worker link phase: commit_provider_migration_followup, then the SEK amount each linked foreign-currency invoice takes from its verifikat (report.sourceRate). crm#1039.';

REVOKE ALL ON FUNCTION public.commit_provider_migration_source_rate_links(uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.commit_provider_migration_source_rate_links(uuid,uuid,integer,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
