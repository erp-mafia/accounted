-- pg-test: tests/pg/supplier-auto-debit.pg.test.ts
-- "Dras automatiskt": supplier invoices the supplier debits from the
-- company's account itself (autogiro or a bank's own account debit), for
-- crm#1463.
--
-- A bank's account fee or an insurance paid by autogiro has nothing for the
-- company to pay: the money is taken on the due date. Such invoices sat as
-- approved and to pay, in the to-pay lists and the payment file and bank
-- payment choices, with only "Betalas för hand" to mark them, which means a
-- payment typed into the bank. This migration:
--   1. adds suppliers.auto_debit, the supplier card's payment method;
--   2. adds supplier_invoices.auto_debit, what the invoice is paid by;
--   3. gives a new invoice its supplier's auto_debit on insert, so every
--      create path (dashboard, inbox, v1, MCP, imports, Peppol) inherits it
--      without code changes. An invoice is changed afterwards on its own.
--
-- The flag books nothing and changes no amount or status: the invoice is
-- settled when the bank debit is matched, like any paid invoice. Existing
-- rows get false, which is what they were.

ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS auto_debit boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.suppliers.auto_debit IS
  'The supplier debits its invoices from the company account itself (autogiro, account debit): new invoices inherit it (crm#1463).';

ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS auto_debit boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.supplier_invoices.auto_debit IS
  'Paid by the supplier''s own debit (autogiro, account debit): left out of to-pay lists and payments, settled when the debit is matched (crm#1463).';

-- A new invoice takes its supplier's payment method. Only true is inherited:
-- an insert that says auto_debit itself keeps it, and a supplier without the
-- flag leaves the default.
CREATE OR REPLACE FUNCTION public.inherit_supplier_auto_debit()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT NEW.auto_debit AND NEW.supplier_id IS NOT NULL THEN
    NEW.auto_debit := coalesce(
      (SELECT s.auto_debit FROM public.suppliers s
        WHERE s.id = NEW.supplier_id AND s.company_id = NEW.company_id),
      false);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.inherit_supplier_auto_debit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS inherit_supplier_auto_debit ON public.supplier_invoices;
CREATE TRIGGER inherit_supplier_auto_debit
  BEFORE INSERT ON public.supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.inherit_supplier_auto_debit();

NOTIFY pgrst, 'reload schema';
