-- Backfill `create_salary_run` and `generate_agi` into the
-- pending_operations.operation_type CHECK constraint.
--
-- Same bug class as `undo_sie_import` (fixed in 20260603120000): both
-- ops have a risk-tier entry (lib/pending-operations/risk-tiers.ts)
-- and a commit executor (lib/pending-operations/commit.ts) but were
-- never added to the CHECK constraint. Production currently has no
-- pending rows of either type — confirmed via SELECT operation_type,
-- COUNT(*) FROM pending_operations — so this is a forward-looking
-- fix, not a hot repair.
--
-- Flagged by swedish-compliance review on PR #614.

ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_operation_type_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_operation_type_check
  CHECK (operation_type IN (
    'categorize_transaction',
    'create_customer',
    'create_invoice',
    'mark_invoice_paid',
    'send_invoice',
    'mark_invoice_sent',
    'match_transaction_invoice',
    'close_period',
    'lock_period',
    'unlock_period',
    'set_opening_balances',
    'run_year_end',
    'run_currency_revaluation',
    'import_sie',
    'explain_voucher_gap',
    'uncategorize_transaction',
    'approve_supplier_invoice',
    'credit_supplier_invoice',
    'credit_invoice',
    'convert_invoice',
    'create_transaction',
    'attach_document_to_transaction',
    'create_voucher',
    'correct_entry',
    'reverse_entry',
    'create_supplier',
    'create_supplier_invoice_from_inbox',
    'post_annual_depreciation',
    'link_invoice_voucher',
    'undo_sie_import',
    'match_batch_allocate',
    'bulk_book_transactions',
    'create_salary_run',     -- backfilled (swedish-compliance PR #614)
    'generate_agi'           -- backfilled (swedish-compliance PR #614)
  ));

NOTIFY pgrst, 'reload schema';
