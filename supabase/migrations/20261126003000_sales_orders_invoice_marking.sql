-- Märkning on a kundorder.
--
-- sales_orders.invoice_marking: the buyer's marking for the invoices of this
-- order, typically their purchase order number. An offert or proforma
-- converted into an order copies its own invoice_marking here, and the order
-- form sets it by hand. An invoice created from the order takes it as
-- invoices.invoice_marking, which the PDF prints as Märkning and the Peppol
-- e-invoice sends as BT-13 OrderReference; an order without one leaves the
-- invoice to the customer card's Märkning
-- (src/lib/customers/invoice-marking.ts: invoiceMarkingForNewInvoice).
-- Until now the order had no such column, so the marking an offert carried
-- was lost on its way through the order to the invoice.
--
-- Nullable and nothing is backfilled: an existing order states no marking of
-- its own, and its next invoice takes the card's, exactly as before.
--
-- No GRANT: a column added to an existing table is covered by that table's
-- grants, and sales_orders has no column-level privileges.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS invoice_marking text;

COMMENT ON COLUMN public.sales_orders.invoice_marking IS
  'Märkning: copied into invoices.invoice_marking (Peppol BT-13 OrderReference) on every invoice created from the order; NULL leaves the invoice to the customer card''s Märkning.';

NOTIFY pgrst, 'reload schema';
