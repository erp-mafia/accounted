-- Migration: add 'vat_settlement' to journal_entries.source_type CHECK
--
-- The momsredovisning netting entry (Dr 26xx utgående / Cr 26xx ingående /
-- net to 2650) can now be routed to its own voucher series so it stays
-- separate from "övriga" (series A). Applying a VAT-category booking template
-- (e.g. "Momsredovisning (nettning)") tags the entry source_type=
-- 'vat_settlement', which the engine maps to the company's configured VAT
-- series. That insert is rejected with PG 23514 unless the value is in the DB
-- allowlist; this migration appends it. The TS type (JournalEntrySourceType)
-- and the Zod schema (JournalEntrySourceTypeSchema) are updated in the same
-- change.
--
-- See 20260627120000 for the previous expansion pattern. We preserve all
-- pre-existing source_type values and append the new one.

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'inbox_item',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation',
    'supplier_invoice_privately_paid',
    'reminder_fee',
    'accrual',
    'result_appropriation',
    'rot_rut_payout',
    'vat_settlement'
  ));

NOTIFY pgrst, 'reload schema';
