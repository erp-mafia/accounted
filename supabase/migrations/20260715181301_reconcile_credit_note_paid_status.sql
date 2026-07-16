-- The linked production database contained one legacy credit note in the
-- ordinary payment lifecycle. It was reconciled before this migration by
-- linking its existing balanced reversal voucher and normalizing the invoice
-- metadata. Keep an explicit forward migration that verifies the repaired
-- invariant before the remaining migration chain proceeds.
-- pg-test: covered-by lib/invoices/__tests__/credit-note-not-payable.pg.test.ts
DO $reconcile$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.invoices
    WHERE credited_invoice_id IS NOT NULL
      AND status IN ('paid', 'partially_paid')
  ) THEN
    RAISE EXCEPTION
      'Legacy credit notes still use ordinary customer-payment states';
  END IF;
END
$reconcile$;

ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_credit_note_not_paid;

NOTIFY pgrst, 'reload schema';
