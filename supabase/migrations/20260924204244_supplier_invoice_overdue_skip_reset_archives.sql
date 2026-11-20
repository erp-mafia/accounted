-- Migration: supplier_invoice_overdue_skip_reset_archives
--
-- The daily pg_cron job update-overdue-supplier-invoices has failed every run
-- since 2026-08-29 with "Archived migration reset source records are
-- immutable". Its UPDATE matched a past-due payable inside a company that had
-- become a migration-reset source; the block_migration_reset_source_mutation
-- trigger (20260818084050, tightened in 20260818143004) refuses any change to
-- such a company's rows, and the exception rolled back the whole statement.
-- One frozen archive therefore stopped the overdue flip for every company.
--
-- Fix: both statements skip archived reset sources. Their rows are frozen by
-- design, so leaving the label as it was at archive time is correct. The
-- predicates are otherwise unchanged from 20260727160000.
--
-- CREATE OR REPLACE rewrites the whole definition, so re-declare the
-- search_path pinned by 20260304191528. Grants from 20260902093000
-- (service_role only) survive CREATE OR REPLACE.
CREATE OR REPLACE FUNCTION public.update_overdue_supplier_invoices()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Flip. 0.005 mirrors the "fully paid" threshold used by the payment/match
  -- paths, and credit notes (kreditfakturor) are not payables.
  UPDATE supplier_invoices si
  SET status = 'overdue',
      updated_at = NOW()
  WHERE si.due_date < CURRENT_DATE
    AND si.status IN ('registered', 'approved')
    AND si.remaining_amount > 0.005
    AND COALESCE(si.is_credit_note, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM company_migration_resets r
      WHERE r.source_company_id = si.company_id
    );

  -- Un-flip: the exact inverse of the predicate above.
  UPDATE supplier_invoices si
  SET status = CASE WHEN si.approved_at IS NOT NULL THEN 'approved' ELSE 'registered' END,
      updated_at = NOW()
  WHERE si.status = 'overdue'
    AND si.due_date >= CURRENT_DATE
    AND si.remaining_amount > 0.005
    AND COALESCE(si.is_credit_note, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM company_migration_resets r
      WHERE r.source_company_id = si.company_id
    );
END;
$$;
