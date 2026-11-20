-- Journal source type 'tax_account' for skattekonto bookings (#172).
-- pg-test: tests/pg/tax-account-source-type.pg.test.ts,
--          tests/pg/skattekonto-booking-invariants.pg.test.ts
--
-- A verifikat booked from a Skatteverket skattekonto row
-- (extensions/general/skatteverket/lib/skattekonto-booking.ts) is written
-- with source_type 'tax_account' instead of 'system', so
-- company_settings.default_voucher_series_per_source_type can give it a
-- series of its own. Entries booked before keep 'system' (the immutability
-- trigger forbids rewriting source_type on posted rows); readers accept both.
-- The column default of the series map follows in 20261109170210.

-- =============================================================================
-- 1. journal_entries.source_type: 'tax_account'
-- =============================================================================
-- Rebuilt from 20261022130100_counterparty_setoffs.sql (the latest
-- definition); the only change is the appended value. TS
-- (JournalEntrySourceType) and Zod (JournalEntrySourceTypeSchema) gain it in
-- the same change.

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
    'webshop_order',
    'expense_claim',
    'expense_payout',
    'rot_rut_reclaim',
    'pos_daily_sales',
    'rot_rut_reclassification',
    'collection_settlement',
    'customer_loss',
    'counterparty_setoff',
    'tax_account'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

-- =============================================================================
-- 2. One live verifikat per skattekonto row, across 'system' and 'tax_account'
-- =============================================================================
-- journal_entries_system_source_live_unique (20260920145033) held one live
-- (draft or posted) 'system' entry per (company_id, source_id). It now spans
-- both source types: a skattekonto row whose live verifikat was booked as
-- 'system' before this migration cannot get a second one as 'tax_account',
-- and the reverse. Same key, same status predicate, same name: the booking
-- path recognises the race by the index name in the error
-- (isSystemSourceLiveUniqueError), so the name stays.
--
-- The rebuild cannot fail on existing data: every row the old predicate
-- covered is still covered and no 'tax_account' row exists before this
-- migration. Dropped and created in the same transaction, so no write runs
-- without the guard.

DROP INDEX IF EXISTS public.journal_entries_system_source_live_unique;

CREATE UNIQUE INDEX journal_entries_system_source_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type IN ('system', 'tax_account')
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');

NOTIFY pgrst, 'reload schema';
