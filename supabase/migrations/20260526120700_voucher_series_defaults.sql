-- Migration: Voucher series defaults per source type
-- Item 8 of make-a-detailed-plan-fancy-pie.md
--
-- The schema and RPCs already support multi-series voucher numbering
-- (voucher_sequences.voucher_series, journal_entries.voucher_series,
-- next_voucher_number(p_series)). This migration exposes the per-source
-- defaulting mapping in company_settings so users can configure which
-- series each journal_entries.source_type lands on by default.
--
-- All values default to 'A' to preserve current behavior. Common Swedish
-- conventions (B for supplier invoices, C for salaries) can be applied
-- by the user via the settings UI without a code change.

ALTER TABLE public.company_settings
  ADD COLUMN default_voucher_series_per_source_type JSONB NOT NULL DEFAULT '{
    "manual": "A",
    "invoice_created": "A",
    "invoice_paid": "A",
    "invoice_cash_payment": "A",
    "credit_note": "A",
    "supplier_invoice_registered": "A",
    "supplier_invoice_paid": "A",
    "supplier_invoice_cash_payment": "A",
    "supplier_invoice_privately_paid": "A",
    "supplier_credit_note": "A",
    "salary_payment": "A",
    "bank_transaction": "A",
    "reminder_fee": "A",
    "opening_balance": "A",
    "year_end": "A",
    "currency_revaluation": "A",
    "inbox_item": "A",
    "import": "A",
    "system": "A",
    "storno": "A",
    "correction": "A"
  }'::jsonb;

COMMENT ON COLUMN public.company_settings.default_voucher_series_per_source_type IS
  'Maps journal_entries.source_type -> default voucher_series (single uppercase letter A-Z). Read by lib/bookkeeping/voucher-series-resolver.ts; written via /api/settings. Defaults to all "A" to preserve legacy single-series behaviour. Common Swedish conventions: supplier_invoice_* -> "B", salary_payment -> "C".';

NOTIFY pgrst, 'reload schema';
