-- A retry judges again the invoices a register import declined as outside the
-- imported fiscal years, once more years have been imported (crm#2002).
-- pg-test: tests/pg/provider-migration-rejudge-outside-years.pg.test.ts
--
-- The worker declines a listed invoice whose year has no imported ledger
-- (invoiceWithinScope) and records it as skipped with receipt.reason
-- 'outsideFiscalYears'. A skip is final: retry_provider_migration_job
-- re-queued only the records in needs_attention. A company that imported its
-- first fiscal years, ran the register import, and imported the remaining
-- years while that job waited for its review kept every invoice of those
-- years out of the register: "Försök igen" retried the few records under
-- review and never looked at the skipped invoices again. The worker now
-- judges an invoice by the years imported when it is processed, not by the
-- years stored on the job when it was created.
--
--   * provider_migration_stale_year_skips lists a job's records declined as
--     outside the imported years before an SIE import last completed for the
--     company. It only says that the books may have grown since the record
--     was judged; which years count is the worker's to decide, from the
--     imports in place. An import that completed and was undone later still
--     counts here, and costs one retry that declines the same records again.
--   * retry_provider_migration_job re-queues those records too, as pending,
--     so the import phase judges them again: an invoice of a year imported
--     since is imported (adopted, not copied, when another job already
--     stored it: commit_provider_migration_records finds it by its source
--     record, or by number, party, date, currency and total); one still
--     outside is declined again, which also makes it current. Unchanged from
--     20261005193000 apart from that statement.
--   * provider_migration_counts gains outside_years_stale, the same records
--     counted per register, so the review offers the retry and says what it
--     will look at. The return type gains a column, which CREATE OR REPLACE
--     cannot do, hence DROP + CREATE (as 20260920190600). Old application code
--     ignores the extra column; new code reads a missing one as zero, so the
--     deploy order does not matter.
--
-- No journal entry, invoice or payment is written here.

CREATE FUNCTION public.provider_migration_stale_year_skips(p_job_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH grown AS (
    SELECT max(s.imported_at) AS at FROM sie_imports s
      JOIN migration_jobs j ON j.company_id = s.company_id
     WHERE j.id = p_job_id AND s.status = 'completed'
  )
  SELECT c.id FROM migration_job_chunks c, grown
   WHERE c.job_id = p_job_id AND c.state = 'skipped' AND c.receipt->>'reason' = 'outsideFiscalYears'
     AND c.updated_at < grown.at
$$;
REVOKE ALL ON FUNCTION public.provider_migration_stale_year_skips(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provider_migration_stale_year_skips(uuid) TO authenticated, service_role;

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
  -- And the invoices declined as outside the imported years before more
  -- years were imported: the import phase judges them again.
  UPDATE migration_job_chunks SET state='pending',receipt='{}'::jsonb
    WHERE job_id=j.id AND id IN (SELECT provider_migration_stale_year_skips(j.id));
  UPDATE migration_jobs SET user_id=p_user_id,state='queued',phase=CASE WHEN phase='discover' THEN 'discover' ELSE 'import' END,
    worker_id=NULL,lease_until=NULL,next_attempt_at=NULL,failures=0,error_code=NULL WHERE id=j.id;
END $$;
REVOKE ALL ON FUNCTION public.retry_provider_migration_job(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retry_provider_migration_job(uuid,uuid,uuid) TO service_role;

DROP FUNCTION public.provider_migration_counts(uuid);
CREATE FUNCTION public.provider_migration_counts(p_job_id uuid)
RETURNS TABLE(resource text,total bigint,imported bigint,completed bigint,skipped bigint,needs_attention bigint,pending bigint,
  fx_unresolved bigint,vat_unresolved bigint,credit_notes_unlinked bigint,credit_notes_linked bigint,outside_years_stale bigint)
LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
  SELECT c.resource,count(*),count(*) FILTER(WHERE c.target_id IS NOT NULL),count(*) FILTER(WHERE c.state='done'),
    count(*) FILTER(WHERE c.state='skipped'),count(*) FILTER(WHERE c.state='needs_attention'),
    count(*) FILTER(WHERE c.state IN ('pending','imported','linked','planned')),
    count(*) FILTER(WHERE c.receipt->'warnings'->>'fxUnresolved'='true'),
    count(*) FILTER(WHERE c.receipt->'warnings'->>'vatUnresolved'='true'),
    -- No reference at all (flagged at import), or a reference the link phase
    -- could not resolve. 'imported' means the link phase has not run yet:
    -- such a row is not unlinked, it is not yet paired.
    count(*) FILTER(WHERE c.receipt->'warnings'->>'creditNoteUnlinked'='true'
      OR (c.resource='salesInvoices' AND c.target_id IS NOT NULL AND c.state<>'imported'
        AND jsonb_typeof(c.receipt->'link'->'creditedInvoiceRef')='object'
        AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=c.target_id AND i.company_id=c.company_id
          AND i.credited_invoice_id IS NOT NULL))),
    count(*) FILTER(WHERE c.resource='salesInvoices' AND c.target_id IS NOT NULL
      AND jsonb_typeof(c.receipt->'link'->'creditedInvoiceRef')='object'
      AND EXISTS(SELECT 1 FROM invoices i WHERE i.id=c.target_id AND i.company_id=c.company_id
        AND i.credited_invoice_id IS NOT NULL)),
    -- Declined as outside the imported years before more years were imported:
    -- a retry judges them again (provider_migration_stale_year_skips).
    count(*) FILTER(WHERE c.id IN (SELECT provider_migration_stale_year_skips(p_job_id)))
  FROM migration_job_chunks c WHERE c.job_id=p_job_id GROUP BY c.resource;
$$;
REVOKE ALL ON FUNCTION public.provider_migration_counts(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.provider_migration_counts(uuid) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
