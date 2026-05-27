-- Add vat_rate and vat_amount to invoice_items.
--
-- These columns hold the per-line VAT rate and computed VAT amount and
-- back the mixed-rate invoice support documented in CLAUDE.md
-- (generatePerRateLines + getAvailableVatRates). They existed in
-- production since the early invoicing work but were never declared by
-- a migration, so staging, preview branches, and CI databases booted
-- from a fresh migration replay were missing them.
--
-- Defaults match the prod shape: vat_rate defaults to 25 (Swedish
-- standard rate), vat_amount defaults to 0 (lines are recomputed by the
-- engine before persistence). Both NOT NULL because every committed
-- invoice line must carry a deterministic VAT figure for VAT-declaration
-- ruta mapping.
--
-- Application validation: lib/invoices/vat-rules.ts caps vat_rate to
-- the rates allowed for the customer type at the API boundary.

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS vat_rate NUMERIC NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS vat_amount NUMERIC NOT NULL DEFAULT 0;

NOTIFY pgrst, 'reload schema';
