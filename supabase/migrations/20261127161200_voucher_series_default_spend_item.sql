-- Migration: voucher-series column default gains spend_item (series A,
-- Redovisning, beside bank transactions and utlägg).
--
-- 20261127161100 added 'spend_item' to the journal_entries.source_type
-- CHECK (one expense from a company card or spend platform). The column
-- default for company_settings.default_voucher_series_per_source_type must
-- name every source type the CHECK accepts
-- (tests/pg/voucher-series-standard-default.pg.test.ts asserts it against
-- STANDARD_VOUCHER_SERIES_MAP). A card purchase is the same kind of voucher
-- as a bank-paid cost or an utlägg, so it joins A like them; a company that
-- wants a series of its own for the card picks a letter in Inställningar.
--
-- Rebuilt from 20261109170210_voucher_series_default_tax_account.sql (the
-- latest definition). Same rules as 20260907160200: only the DEFAULT
-- changes; existing rows keep their map and resolve the missing key to 'A'
-- until the company applies the standard set itself.

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
    "customer_loss": "A",
    "counterparty_setoff": "A",
    "tax_account": "A",
    "spend_item": "A"
  }'::jsonb;

NOTIFY pgrst, 'reload schema';
