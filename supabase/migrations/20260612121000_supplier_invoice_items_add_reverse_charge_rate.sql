-- Add reverse_charge_rate to supplier_invoice_items.
--
-- For omvänd skattskyldighet (reverse charge, ML 16 kap) the EU/non-EU or
-- domestic-RC supplier charges no VAT, so the line's own vat_rate is 0 — the
-- v1 supplier-invoice API even mandates vat_rate=0 on every RC line. The buyer
-- must nonetheless self-assess BOTH output and input VAT at the Swedish
-- statutory rate that would apply to the service domestically: 25% under
-- huvudregeln for EU services (ML 6 kap 34 §), or 12%/6% for reduced-rated
-- services. That self-assessed rate is conceptually distinct from "what the
-- supplier charged" (0%), so it gets its own column instead of overloading
-- vat_rate — which previously caused the engine to skip the fiktiv-moms lines
-- (2614/2624/2634 + 2645/2647) and basbeloppsrader (44xx/45xx) entirely,
-- understating momsdeklaration ruta 20-24 / 30-32 / 48.
--
-- NULL  = not a reverse-charge line (the booking engine then falls back to a
--         positive vat_rate if present, else the 25% huvudregel default).
-- 0.06 / 0.12 / 0.25 = explicit self-assessed rate (set by the UI picker).

ALTER TABLE supplier_invoice_items
  ADD COLUMN IF NOT EXISTS reverse_charge_rate numeric
    CHECK (reverse_charge_rate IS NULL OR reverse_charge_rate IN (0.06, 0.12, 0.25));

COMMENT ON COLUMN supplier_invoice_items.reverse_charge_rate IS
  'Self-assessed VAT rate for omvänd skattskyldighet (decimal 0.06/0.12/0.25). NULL for non-RC lines. The line vat_rate stays 0 (supplier charges no VAT); this rate drives fiktiv moms (2614/2624/2634 + 2645/2647) and basbelopp (44xx/45xx) booking — see lib/bookkeeping/supplier-invoice-entries.ts.';

NOTIFY pgrst, 'reload schema';
