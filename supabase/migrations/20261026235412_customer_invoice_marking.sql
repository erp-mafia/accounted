-- Märkning on the customer card (crm#1477).
--
-- customers.invoice_marking: the marking a buyer wants on every invoice,
-- typically the purchase order number of a framework order or a project.
-- When a new invoice to the customer is written and the caller states no
-- Märkning, the customer's value is COPIED into invoices.invoice_marking: the
-- invoice PDF prints it as Märkning and the Peppol e-invoice sends it as BT-13
-- OrderReference (src/lib/customers/invoice-marking.ts). Copied, never read
-- back, so an issued invoice keeps the marking it was issued with when the
-- card changes. The sibling of customers.invoice_reference (Fakturareferens,
-- 20261015203000), which fills Er referens the same way.
--
-- NULL for every existing customer and nothing is backfilled: no customer's
-- invoices change until someone fills the field in.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS invoice_marking text;

COMMENT ON COLUMN public.customers.invoice_marking IS
  'Märkning: copied into invoices.invoice_marking (Peppol BT-13 OrderReference) on a new invoice to this customer when the caller states none. Never read back by an issued invoice.';

NOTIFY pgrst, 'reload schema';
