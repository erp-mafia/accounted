-- Migration: voucher-series column default gains customer_loss (series A).
--
-- 20261021120700 added 'customer_loss' to the journal_entries.source_type
-- CHECK (kundförlust: befarad reserve, konstaterad write-off, recovery). The
-- column default for company_settings.default_voucher_series_per_source_type
-- must name every source type the CHECK accepts
-- (tests/pg/voucher-series-standard-default.pg.test.ts asserts it against
-- STANDARD_VOUCHER_SERIES_MAP). Kundförlust is neither a kundfaktura nor an
-- inbetalning, so it stays in the general series A.
--
-- Rebuilt from 20261021120100_voucher_series_default_collection_settlement.sql
-- (the latest definition: main's map from 20261015001100, with
-- "pos_daily_sales": "F" and "rot_rut_reclassification": "C", plus
-- "collection_settlement": "C"). Same rules as
-- 20260907160200: only the DEFAULT changes; existing rows are not updated,
-- and a row without the key falls back to 'A' through the resolver, which is
-- this source type's standard letter anyway.

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
    "rot_rut_reclassification": "C",
    "collection_settlement": "C",
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
    "pos_daily_sales": "F",
    "customer_loss": "A"
  }'::jsonb;

NOTIFY pgrst, 'reload schema';
