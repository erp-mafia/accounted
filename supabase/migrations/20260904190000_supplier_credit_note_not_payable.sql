-- Supplier credit notes are reversals, not payables (support case 2026-09-04).
--
-- A kreditfaktura from a supplier is created from the original invoice with
-- Kreditera: the reversing verifikat is booked in the same request and the
-- original moves to 'credited'. Nothing is left to attest or to pay, yet the
-- credit note was inserted at the payable lifecycle's entry state,
-- 'registered', which every consumer reads as "waiting for attest". The
-- worklist counted it as a supplier invoice to attest while the detail page
-- (correctly) offered no attest for a credit note, so the item could never be
-- cleared. 'approved' was reachable the same way through the MCP approve
-- executor.
--
-- 1. Move every stuck credit note to 'credited', the status the provider
--    importers already give incoming credit notes. Archived migration-reset
--    sources are skipped: block_migration_reset_source_mutation() makes their
--    rows immutable and would abort the migration.
-- 2. Add a CHECK so no writer (dashboard, MCP executor, v1 API, importers)
--    can put a credit note into a payable state again. NOT VALID because the
--    archived reset-source row above cannot be repaired; the constraint is
--    enforced on every new insert and update regardless.
-- pg-test: covered-by tests/pg/supplier-credit-note-not-payable.pg.test.ts

UPDATE public.supplier_invoices
SET status = 'credited'
WHERE is_credit_note
  AND status IN ('registered', 'approved', 'overdue')
  AND company_id NOT IN (
    SELECT source_company_id FROM public.company_migration_resets
  );

ALTER TABLE public.supplier_invoices
  ADD CONSTRAINT supplier_invoices_credit_note_not_payable
  CHECK (
    NOT is_credit_note
    OR status NOT IN ('registered', 'approved', 'overdue', 'paid', 'partially_paid')
  ) NOT VALID;

COMMENT ON CONSTRAINT supplier_invoices_credit_note_not_payable ON public.supplier_invoices IS
  'A supplier credit note is a reversal, never a payable: it cannot use the attest or payment lifecycle states.';

NOTIFY pgrst, 'reload schema';
