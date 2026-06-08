-- Backfill `link_transaction_journal_entry` into the
-- pending_operations.operation_type CHECK constraint.
--
-- Same bug class as 20260603121000 (which backfilled create_salary_run +
-- generate_agi): the op has a risk-tier entry, a commit executor, and a
-- new MCP tool (gnubok_link_transaction_to_journal_entry, PR #614), but
-- the CHECK constraint was last enumerated in 20260603121000 and did
-- not include this value. Without this migration, any INSERT staged
-- by the new MCP tool would be rejected with constraint violation,
-- silently preventing the verifikat-link audit-trail row required by
-- BFL 5 kap 6–7§ (every affärshändelse must have a verifikation with
-- a logged match event).
--
-- Flagged by swedish-compliance review on commit 5b884c3a (PR #614).

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
    'create_salary_run',
    'generate_agi',
    'link_transaction_journal_entry'  -- backfilled (swedish-compliance PR #614 round 5)
  ));

NOTIFY pgrst, 'reload schema';
