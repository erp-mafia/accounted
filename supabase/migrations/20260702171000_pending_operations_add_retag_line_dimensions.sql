-- Add 'retag_line_dimensions' to the pending_operations operation_type CHECK
-- constraint.
--
-- The MCP tool gnubok_tag_journal_lines (dimensions PR6 — retro-tagging,
-- dev_docs/dimensions_implementation_plan.md §3) stages a pending operation
-- that, on approval, dispatches into commitRetagLineDimensions. That executor
-- loops the staged line_ids through the retag_line_dimensions RPC
-- (20260702170000) — the ONE audited write path for changing dimension tags
-- on posted lines. The RPC enforces everything per line at commit time: open
-- period, company lock date, active registry values, writer role, and it
-- writes an immutable dimension_retag_log row before touching the line.
-- Without this expansion the staged INSERT would be rejected by the
-- constraint before the commit-side code ever runs, blocking the
-- staged-operation review flow — mirrors create_dimension_value.
--
-- Risk tier (lib/pending-operations/risk-tiers.ts): 'medium' — dimension-only
-- diff on posted lines (accounts, amounts, description stay immutable), fully
-- audited via dimension_retag_log, no external side-effects. But it rewrites
-- reporting history on up to 500 lines at once, so it always crosses a human.
--
-- pg-test: covered-by — CHECK-list expansion only (no trigger/RPC/RLS/
-- DEFERRABLE change), so no *.pg.test.ts is required. Mirrors
-- 20260702130000_pending_operations_add_create_dimension_value.sql. The RPC
-- itself is covered by tests/pg/dimension-retag.pg.test.ts (20260702170000).

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
    'create_dimension_value',  -- dimensions registry: stage a new kostnadsställe/projekt value (SIE #OBJEKT)
    'retag_line_dimensions'  -- dimensions retag: bulk-tag posted lines via the audited retag RPC (PR6)
  ));

NOTIFY pgrst, 'reload schema';
