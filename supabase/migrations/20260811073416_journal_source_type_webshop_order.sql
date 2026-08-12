-- Migration: add 'webshop_order' to journal_entries.source_type CHECK
--
-- Webshop order booking (Dr mapped payment account 1930/15xx gross /
-- Cr 30xx net + 26xx VAT per rate) is created from the Orders page and tags
-- its entries source_type='webshop_order' so they are distinguishable from
-- manual entries and routable to their own voucher series. The insert is
-- rejected with PG 23514 unless the value is in the DB allowlist; this
-- migration appends it. The TS type (JournalEntrySourceType) and the Zod
-- schema (JournalEntrySourceTypeSchema) are updated in the same change.
--
-- See 20260712100500 for the previous expansion pattern. We preserve all
-- pre-existing source_type values and append the new one. The voucher-series
-- default JSONB is deliberately not touched (same as previous expansions):
-- lib/bookkeeping/voucher-series-resolver.ts falls back to 'A' for keys
-- missing from default_voucher_series_per_source_type.

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
    'vat_settlement',
    'stripe_payout',
    'webshop_order'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

NOTIFY pgrst, 'reload schema';
