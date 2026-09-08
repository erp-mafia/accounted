-- Migration: voucher-series column default gains rot_rut_reclaim (series C).
--
-- 20260907160000 added 'rot_rut_reclaim' to the journal_entries.source_type
-- CHECK (Skatteverkets avslag booked back onto the customer, debit 1510 /
-- credit 1513). The column default for
-- company_settings.default_voucher_series_per_source_type must name every
-- source type the CHECK accepts (tests/pg/voucher-series-standard-default
-- .pg.test.ts asserts it against STANDARD_VOUCHER_SERIES_MAP), or a new
-- company's reclaim vouchers would fall back to 'A' through the resolver
-- while the settings picker shows them on C next to the payout vouchers.
--
-- Same rules as 20260906210500: only the DEFAULT changes. Existing rows are
-- NOT updated (a company on A keeps A until it chooses the standard set), and
-- rows already on the standard set fall back to 'A' for the missing key
-- exactly as they did for rot_rut_payout before their own migration; the
-- settings action writes the full map when the company touches it.

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
    "expense_payout": "A"
  }'::jsonb;

NOTIFY pgrst, 'reload schema';
