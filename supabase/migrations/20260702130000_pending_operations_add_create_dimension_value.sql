-- Add 'create_dimension_value' to the pending_operations operation_type CHECK
-- constraint.
--
-- The MCP tool gnubok_create_dimension_value (dimensions PR3 —
-- dev_docs/dimensions_implementation_plan.md §6) stages a pending operation
-- that, on approval, dispatches into commitCreateDimensionValue. That executor
-- validates the strict Fortnox code format, get-or-creates the system
-- dimensions (1 = kostnadsställe, 6 = projekt) via ensure_company_dimensions,
-- and inserts the dimension value (idempotent on duplicate code). Agents must
-- never silently mint reporting values — resolve-don't-select on the voucher
-- tools rejects unknown codes and routes the agent here instead. Without this
-- expansion the staged INSERT would be rejected by the constraint before the
-- commit-side code ever runs, blocking the staged-operation review flow —
-- mirrors create_customer / create_article.
--
-- Risk tier (lib/pending-operations/risk-tiers.ts): 'low' — registry master
-- data with no journal impact, no external side-effects and no payment-routing
-- surface, same tier as create_customer / create_article. Still staged and
-- human-approved (no auto-commit path exists).
--
-- pg-test: covered-by — CHECK-list expansion only (no trigger/RPC/RLS/
-- DEFERRABLE change), so no *.pg.test.ts is required. Mirrors
-- 20260630120000_pending_operations_add_bulk_book_inbox_items.sql.

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
    'link_transaction_journal_entry',
    'link_supplier_invoice_voucher',
    'submit_vat_declaration',
    'submit_agi',
    'create_article',
    'update_article',
    'bulk_book_inbox_items',
    'create_dimension_value'  -- dimensions registry: stage a new kostnadsställe/projekt value (SIE #OBJEKT)
  ));

NOTIFY pgrst, 'reload schema';
