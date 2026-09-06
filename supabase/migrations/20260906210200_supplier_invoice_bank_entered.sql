-- "Inlagd i banken" for supplier invoices paid by hand (#2220).
-- pg-test: tests/pg/supplier-invoice-bank-entered.pg.test.ts
--
-- A user who types payments into the internet bank instead of uploading a
-- betalfil has no way to see which invoices are already handled: the payment
-- instruction sits at the bank, the money has not left the account, and the
-- invoice is still 'approved'. Betalfil users already have this fact as an
-- active supplier_payment_batch item; that model cannot carry a manual mark
-- without contortion (the batch is an immutable pain.001 snapshot with NOT
-- NULL debtor, payee and reference columns, and the create RPC refuses an
-- invoice whose supplier has no payee or whose company has no IBAN), so the
-- manual mark is one nullable timestamp on the invoice itself.
--
-- The mark is a mellanlage between attesterad and betald, never a status:
-- it books nothing, changes no amount, and must vanish on its own when the
-- payment actually lands. That last part is enforced here rather than in
-- each write path (mark-paid, bank match, v1 mark-paid, MCP, batch
-- settlement all update the same row): a BEFORE UPDATE trigger clears the
-- mark whenever paid_amount rises or the row reaches 'paid'. An UPDATE that
-- writes bank_entered_at explicitly in the same statement keeps its value,
-- so the mark-as-entered route itself can never be overridden by the
-- trigger. A reversal (paid_amount going down) leaves the column alone: the
-- mark was already consumed by the payment being reversed, and re-marking is
-- the user's call.

ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS bank_entered_at timestamptz;

COMMENT ON COLUMN public.supplier_invoices.bank_entered_at IS
  'Set when the user marks the payment as entered at the bank by hand (#2220). Cleared by clear_supplier_invoice_bank_entered() when a payment lands. Display-only: books nothing.';

CREATE OR REPLACE FUNCTION public.clear_supplier_invoice_bank_entered()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.bank_entered_at IS NOT NULL
     AND NEW.bank_entered_at IS NOT DISTINCT FROM OLD.bank_entered_at
     AND (
       NEW.paid_amount > OLD.paid_amount + 0.005
       OR (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
     ) THEN
    NEW.bank_entered_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clear_supplier_invoice_bank_entered ON public.supplier_invoices;
CREATE TRIGGER clear_supplier_invoice_bank_entered
  BEFORE UPDATE OF paid_amount, status ON public.supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.clear_supplier_invoice_bank_entered();

NOTIFY pgrst, 'reload schema';
