-- invoices.remaining_amount insert guard.
--
-- remaining_amount is NOT NULL DEFAULT 0 (20260323120001). Every payment
-- surface (payment dialog, bank match, Stripe sync, agent mark-paid) treats it
-- as the customer's open balance, so a writer that omits it leaves an unpaid
-- invoice looking settled: the dialog rejects any payment as an overpayment
-- and the bank match sees nothing to clear. On 2026-08-17 prod carried 337
-- such open invoices (proforma conversion, MCP create_invoice, sandbox seed,
-- older imports); they were backfilled the same day. This trigger keeps the
-- default from ever meaning "0 kr open" again on a fresh unpaid invoice.
--
-- Rule (BEFORE INSERT only; updates are owned by the settlement code, which
-- legitimately writes 0 when an invoice is paid in full):
--   when remaining_amount is NULL or 0
--   and the row is a real invoice (document_type invoice, not a credit note)
--   with total > 0 and a status that still owes money,
--   derive remaining_amount = total - paid_amount - deduction_total (>= 0).
-- The ROT/RUT deduction is a receivable on Skatteverket (1513), never the
-- customer's to pay, so it is excluded exactly as buildInvoiceWriteData does.

CREATE OR REPLACE FUNCTION public.invoices_derive_remaining_amount()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NEW.remaining_amount, 0) = 0
     AND NEW.credited_invoice_id IS NULL
     AND COALESCE(NEW.document_type, 'invoice') = 'invoice'
     AND COALESCE(NEW.total, 0) > 0
     AND COALESCE(NEW.status, 'draft') NOT IN ('paid', 'cancelled', 'credited')
  THEN
    NEW.remaining_amount := GREATEST(
      0,
      ROUND((NEW.total - COALESCE(NEW.paid_amount, 0) - COALESCE(NEW.deduction_total, 0))::numeric, 2)
    );
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.invoices_derive_remaining_amount() IS
  'BEFORE INSERT guard: an unpaid real invoice inserted with remaining_amount NULL/0 gets total - paid_amount - deduction_total, so the NOT NULL DEFAULT 0 can never read as "settled".';

DROP TRIGGER IF EXISTS invoices_derive_remaining_amount ON public.invoices;
CREATE TRIGGER invoices_derive_remaining_amount
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_derive_remaining_amount();
