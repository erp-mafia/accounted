-- Credit notes are adjustments, not customer receivables. They must not enter
-- the ordinary customer-payment lifecycle.
--
-- NOT VALID avoids scanning or rewriting existing rows during deployment. The
-- constraint still applies to every new row and every future update, so all
-- API, RPC, extension, and legacy write paths share the same invariant.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'invoices_credit_note_not_paid'
      AND conrelid = 'public.invoices'::regclass
  ) THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_credit_note_not_paid
      CHECK (
        credited_invoice_id IS NULL
        OR status NOT IN ('paid', 'partially_paid')
      ) NOT VALID;
  END IF;
END
$migration$;

COMMENT ON CONSTRAINT invoices_credit_note_not_paid ON public.invoices IS
  'Credit notes cannot use the ordinary customer-invoice payment states.';

NOTIFY pgrst, 'reload schema';
