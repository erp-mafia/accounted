-- Add 'bulk_book_inbox_items' to the pending_operations operation_type CHECK
-- constraint.
--
-- The MCP tool gnubok_bulk_book_inbox_items (Lena driving the Underlag view /
-- Dokumentinkorgen) stages a pending operation that, on approval, dispatches
-- into commitBulkBookInboxItems. That executor books each selected inbox item
-- against its matched bank transaction using one shared category + VAT
-- treatment (reusing the same categorize core as gnubok_categorize_transaction,
-- so reverse-charge moms is handled correctly). Without this expansion the
-- staged INSERT would be rejected by the constraint before the commit-side code
-- ever runs, blocking the staged-operation review flow — mirrors
-- create_supplier_invoice_from_inbox / bulk_book_transactions.
--
-- Risk tier (lib/pending-operations/risk-tiers.ts): 'high' — posts N verifikat
-- with VAT in one approval, the same compliance surface as
-- bulk_book_transactions. Never auto-committed.
--
-- pg-test: covered-by — CHECK-list expansion only (no trigger/RPC/RLS/
-- DEFERRABLE change), so no *.pg.test.ts is required. Mirrors
-- 20260621120100_pending_operations_add_articles.sql.

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
    'bulk_book_inbox_items'  -- N matched Underlag → N verifikat (one shared category)
  ));

NOTIFY pgrst, 'reload schema';
