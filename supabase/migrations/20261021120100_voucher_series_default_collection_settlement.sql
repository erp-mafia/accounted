-- Migration: voucher-series column default gains collection_settlement (series C).
--
-- 20261021120000 added 'collection_settlement' to the journal_entries
-- .source_type CHECK (a collections provider's payout). The column default for
-- company_settings.default_voucher_series_per_source_type must name every
-- source type the CHECK accepts (tests/pg/voucher-series-standard-default
-- .pg.test.ts asserts it against STANDARD_VOUCHER_SERIES_MAP). Series C, next
-- to the customer payments it pays out.
--
-- Rebuilt from 20261015001100_voucher_series_default_rot_rut_reclassification
-- .sql (main's latest definition, so "pos_daily_sales": "F" and
-- "rot_rut_reclassification": "C" stay; an older copy applied after it would
-- drop the latter). Same rules: only the DEFAULT changes; existing rows keep
-- their own map, and the settings action writes the full map when the
-- company touches it.

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
    "pos_daily_sales": "F"
  }'::jsonb;

NOTIFY pgrst, 'reload schema';
