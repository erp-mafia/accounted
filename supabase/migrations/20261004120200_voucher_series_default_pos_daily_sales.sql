-- Migration: voucher-series column default gains pos_daily_sales (series F, Kassa).
--
-- 20261004120100 added 'pos_daily_sales' to the journal_entries.source_type
-- CHECK (the daily takings voucher of a point-of-sale day). The column
-- default for company_settings.default_voucher_series_per_source_type must
-- name every source type the CHECK accepts
-- (tests/pg/voucher-series-standard-default.pg.test.ts asserts it against
-- STANDARD_VOUCHER_SERIES_MAP). F is the existing preset named Kassa.
--
-- Same rules as 20260907160200: only the DEFAULT changes; existing rows keep
-- their map and fall back to 'A' for the missing key until the company
-- applies the standard set itself.

ALTER TABLE public.company_settings
  ALTER COLUMN default_voucher_series_per_source_type
  SET DEFAULT '{
    "manual": "A",
    "bank_transaction": "A",
    "invoice_created": "B",
    "credit_note": "B",
    "reminder_fee": "B",
    "invoice_paid": "C",
    "invoice_cash_payment": "C",
    "rot_rut_payout": "C",
    "rot_rut_reclaim": "C",
    "supplier_invoice_registered": "D",
    "supplier_credit_note": "D",
    "supplier_invoice_privately_paid": "D",
    "supplier_invoice_paid": "E",
    "supplier_invoice_cash_payment": "E",
    "accrual": "H",
    "year_end": "I",
    "result_appropriation": "I",
    "salary_payment": "K",
    "webshop_order": "L",
    "vat_settlement": "M",
    "opening_balance": "A",
    "currency_revaluation": "A",
    "inbox_item": "A",
    "import": "A",
    "system": "A",
    "storno": "A",
    "correction": "A",
    "stripe_payout": "A",
    "expense_claim": "A",
    "expense_payout": "A",
    "pos_daily_sales": "F"
  }'::jsonb;

NOTIFY pgrst, 'reload schema';
