-- Per-line percentage discount (rabatt i procent per artikelrad) and a
-- fakturamärkning field separate from Er referens (your_reference).
--
-- invoice_items.discount_percent: 0-100, default 0. The stored line_total is
-- always the NET amount (after discount); VAT is computed on the net, so the
-- bookkeeping generators need no change. Server code recomputes the discount
-- via lib/invoices/line-amounts.ts and never trusts a client-sent total.
--
-- invoices.invoice_marking: the buyer-required marking (kostnadsstalle,
-- project code, PO label) printed on the invoice and mapped to Peppol BT-10
-- BuyerReference when set. Distinct from your_reference, which stays the
-- contact person (Er referens).

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS discount_percent NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE public.invoice_items DROP CONSTRAINT IF EXISTS invoice_items_discount_percent_check;
ALTER TABLE public.invoice_items ADD CONSTRAINT invoice_items_discount_percent_check
  CHECK (discount_percent >= 0 AND discount_percent <= 100);

COMMENT ON COLUMN public.invoice_items.discount_percent IS
  'Percentage discount on the line (0-100). line_total and vat_amount are stored net of this discount.';

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS invoice_marking TEXT;

COMMENT ON COLUMN public.invoices.invoice_marking IS
  'Fakturamarkning: buyer-required marking (cost center/project/PO), separate from your_reference (Er referens). Feeds Peppol BT-10 BuyerReference when set.';

NOTIFY pgrst, 'reload schema';
