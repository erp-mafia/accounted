-- Fakturareferens on the customer card (crm#1200).
--
-- customers.invoice_reference: the reference a buyer wants on every invoice
-- (a cost centre, a reference code, a person). When a new invoice to the
-- customer is written and the caller states no Er referens, the customer's
-- value is COPIED into invoices.your_reference: the invoice PDF prints it as
-- Er referens and the Peppol e-invoice sends it as BT-10 BuyerReference
-- (src/lib/customers/invoice-reference.ts). Copied, never read back, so an
-- issued invoice keeps the reference it was issued with when the card
-- changes.
--
-- NULL for every existing customer and nothing is backfilled: no customer's
-- invoices change until someone fills the field in.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS invoice_reference text;

COMMENT ON COLUMN public.customers.invoice_reference IS
  'Fakturareferens: copied into invoices.your_reference (Er referens, Peppol BT-10) on a new invoice to this customer when the caller states none. Never read back by an issued invoice.';

NOTIFY pgrst, 'reload schema';
