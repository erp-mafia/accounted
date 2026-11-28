-- Räntefaktura from the Dröjsmålsränta page.
--
-- 1. vat_treatment_override gains 'outside_scope': an amount that is not a
--    supply made in Sweden and so carries no Swedish VAT. Dröjsmålsränta is
--    compensation for a late payment, not consideration for a good or a
--    service (ML 8 kap. 2-3 §§), so it is booked on 8313 without VAT and
--    reaches no ruta of the momsdeklaration. The application validates it
--    fail-closed (resolveInvoiceVatRules: every line 0 % on an
--    interest-income account).
--
-- 2. invoices.late_interest_invoice_id: on an invoice that was paid late,
--    the räntefaktura that charges its interest. Set with a compare-and-set
--    (only where it is still NULL), so one late payment is never charged on
--    two räntefakturor. ON DELETE SET NULL: deleting an unnumbered draft
--    räntefaktura frees the invoices it covered.
--
-- 3. invoices.is_late_interest_invoice: the invoice is a räntefaktura. Its
--    own late payment earns no new dröjsmålsränta in Accounted, and its PDF
--    does not print the company's late-payment terms.
--
-- Adding nullable or constant-default columns rewrites nothing; existing
-- rows satisfy the wider CHECK. No trigger, RPC, policy or grant changes:
-- both columns are covered by the table's existing grants and policies.
-- NOT VALID then VALIDATE, as in 20261005220322. The index the foreign key
-- needs for its ON DELETE SET NULL is built concurrently in 20261127160600.

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_vat_treatment_override_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_vat_treatment_override_check
  CHECK (vat_treatment_override IS NULL OR vat_treatment_override IN ('standard', 'export', 'reverse_charge', 'reverse_charge_domestic', 'outside_scope')) NOT VALID;
ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_vat_treatment_override_check;

COMMENT ON COLUMN public.invoices.vat_treatment_override IS
  'VAT treatment the invoice states for its own supply (#2906): standard, export, reverse_charge, reverse_charge_domestic (construction services, ML 16 kap. 13 §) or outside_scope (no Swedish VAT: not a supply made in Sweden, e.g. dröjsmålsränta on a räntefaktura). NULL = the customer decides. Validated by resolveInvoiceVatRules.';

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS late_interest_invoice_id uuid NULL
    REFERENCES public.invoices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_late_interest_invoice boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.invoices.late_interest_invoice_id IS
  'The räntefaktura that charges the dröjsmålsränta of this invoice (paid after its due date). Set once, only where NULL. NULL = not charged.';
COMMENT ON COLUMN public.invoices.is_late_interest_invoice IS
  'This invoice is a räntefaktura: it charges dröjsmålsränta and earns none itself.';

NOTIFY pgrst, 'reload schema';
