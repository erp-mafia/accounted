-- journal_entries.source_type: add 'spend_item', the verifikat of one
-- expense from a company card or spend platform (a card purchase, a fee, a
-- refund, an utlägg or its reimbursement), booked from spend_items by
-- lib/spend/book-item.ts with the receipt attached.
--
-- Rebuilt from 20261109170200_tax_account_source_type.sql (the latest
-- definition); the only change is the appended value. The TS union
-- (JournalEntrySourceType) and the Zod schema (JournalEntrySourceTypeSchema)
-- gain the value in the same change.
--
-- pg-test: covered-by src/lib/bookkeeping/__tests__/source-type-constraint.pg.test.ts and tests/pg/spend-expenses.pg.test.ts

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
    'tax_account',
    'spend_item'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

-- One live verifikat per expense. Same race guard as
-- journal_entries_pos_daily_sales_live_unique: two concurrent bookings of
-- the same expense must not both post; draft included so the loser fails at
-- the draft insert, before it can spend a voucher number.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_spend_item_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'spend_item'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');

NOTIFY pgrst, 'reload schema';
