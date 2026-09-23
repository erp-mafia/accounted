-- Count a migrated kreditfaktura as unlinked when it IS unlinked (#2789).
--
-- provider_migration_counts read one flag, receipt.warnings.creditNoteUnlinked,
-- which the worker writes at import time and only for a credit note whose
-- provider sent no reference at all. A credit note that NAMES the invoice it
-- credits is paired later, in the link phase, and when that invoice is not
-- among the imported ones the pairing finds nothing: the row stays without a
-- credited_invoice_id, and nothing ever counted it. The wizard then reported
-- fewer unlinked credit notes than the company has. With Fortnox now naming
-- the credited invoice (CreditInvoiceReference) that gap stops being a Bokio
-- corner and becomes the common case.
--
-- The fix derives the count from the fact instead of keeping a second copy of
-- it: a referenced credit note is unlinked when its link phase has run and
-- invoices.credited_invoice_id is still NULL. That needs no change to the
-- fenced write path (commit_provider_migration_followup keeps its contract)
-- and cannot drift from the row it describes. credit_notes_linked is the
-- other half of the same read, so the wizard can state both.
--
-- Read-only function, SECURITY INVOKER as before: the caller's RLS on
-- migration_job_chunks and invoices applies. The return type gains a column,
-- which CREATE OR REPLACE cannot do, hence DROP + CREATE (as 20260918142217).
-- Old application code ignores the extra column; new code reads a missing one
-- as zero, so the deploy order does not matter.
DROP FUNCTION public.provider_migration_counts(uuid);
CREATE FUNCTION public.provider_migration_counts(p_job_id uuid)
RETURNS TABLE(resource text,total bigint,imported bigint,completed bigint,skipped bigint,needs_attention bigint,pending bigint,
  fx_unresolved bigint,vat_unresolved bigint,credit_notes_unlinked bigint,credit_notes_linked bigint)
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
        AND i.credited_invoice_id IS NOT NULL))
  FROM migration_job_chunks c WHERE c.job_id=p_job_id GROUP BY c.resource;
$$;
REVOKE ALL ON FUNCTION public.provider_migration_counts(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.provider_migration_counts(uuid) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
