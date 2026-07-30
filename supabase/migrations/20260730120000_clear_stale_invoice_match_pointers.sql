-- Issue #1259: retire suggestion pointers left behind when the invoice was
-- settled by a different transaction.
--
-- potential_invoice_id / potential_supplier_invoice_id are write-once import
-- suggestions. Until now nothing revisited them, so a recurring invoice paid
-- off by transaction B left every other transaction pointing at a fully paid
-- invoice. The read paths already refuse to offer such a candidate, but the
-- non-NULL column blocks a FRESH suggestion (both re-suggestion scans require
-- it to be NULL), so the affected transactions can never be suggested again.
--
-- Data only, no DDL. The potential_* columns carry no accounting meaning: the
-- confirmed links live in invoice_id / supplier_invoice_id, which are
-- untouched here, as are all journal entries, verifikat and period locks.
-- Idempotent: re-running clears nothing extra.
--
-- The status lists below are byte-identical to
-- lib/invoices/matchable-statuses.ts (MATCHABLE_SUPPLIER_INVOICE_STATUSES /
-- MATCHABLE_INVOICE_STATUSES). Keep them in sync.

UPDATE public.transactions t
SET potential_supplier_invoice_id = NULL
WHERE t.potential_supplier_invoice_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.supplier_invoices si
    WHERE si.id = t.potential_supplier_invoice_id
      AND si.status IN ('registered', 'approved', 'overdue', 'partially_paid')
      AND COALESCE(si.remaining_amount, 0) > 0
  );

UPDATE public.transactions t
SET potential_invoice_id = NULL
WHERE t.potential_invoice_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = t.potential_invoice_id
      AND i.status IN ('sent', 'overdue', 'partially_paid')
      AND COALESCE(i.remaining_amount, 0) > 0
  );
