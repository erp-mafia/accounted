-- journal_entries.source_type: add 'pos_daily_sales', the daily takings
-- voucher of a point-of-sale day (gemensam verifikation, BFL 5 kap 6 §),
-- booked from pos_sales_days by lib/pos-sales/book-day.ts.
--
-- Same expansion pattern as 20260907160000: the full list from that
-- migration (the latest definition), the new value appended; the TS union
-- (JournalEntrySourceType) and the Zod schema (JournalEntrySourceTypeSchema)
-- gain the value in the same change.
--
-- pg-test: covered-by src/lib/bookkeeping/__tests__/source-type-constraint.pg.test.ts and tests/pg/pos-sales.pg.test.ts

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
    'pos_daily_sales'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

-- One live daily takings voucher per POS day. Same race guard as
-- journal_entries_rot_rut_reclaim_live_unique: two concurrent bookings of
-- the same day must not both post; draft included so the loser fails at
-- the draft insert, before it can spend a voucher number.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_pos_daily_sales_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'pos_daily_sales'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');

NOTIFY pgrst, 'reload schema';
