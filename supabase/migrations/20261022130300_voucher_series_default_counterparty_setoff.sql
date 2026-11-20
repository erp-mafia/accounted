-- Migration: voucher-series column default gains counterparty_setoff (series A).
--
-- 20261022130100 added 'counterparty_setoff' to the journal_entries.source_type
-- CHECK (kvittning of a customer invoice against a supplier invoice of the same
-- counterparty). The column default for
-- company_settings.default_voucher_series_per_source_type must name every
-- source type the CHECK accepts (tests/pg/voucher-series-standard-default.pg
-- .test.ts asserts it against STANDARD_VOUCHER_SERIES_MAP). A set-off is
-- neither an inbetalning (C) nor an utbetalning (E): no money moves, two
-- debts settle each other, so it stays in the general series A, as
-- customer_loss does.
--
-- Rebuilt from 20261021120900_voucher_series_default_customer_loss.sql (the
-- latest definition). Same rules as 20260907160200: only the DEFAULT changes;
-- existing rows are not updated, and a row without the key falls back to 'A'
-- through the resolver, which is this source type's standard letter anyway.

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
    "counterparty_setoff": "A"
  }'::jsonb;

NOTIFY pgrst, 'reload schema';
