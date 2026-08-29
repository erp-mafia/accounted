-- Add 'reconciliation_residual' to the pending_operations operation_type CHECK
-- constraint.
--
-- gnubok_reconcile_residual (MCP) stages "link these bank transactions to this
-- verifikat and book the small difference as fee / interest / rounding"
-- (lib/reconciliation/residual.ts); the user approves it in Granskning and
-- commitReconciliationResidual in lib/pending-operations/commit.ts links and
-- books. Risk 'medium': one typed, capped verifikat against the bank account,
-- undone by storno + unmatch.
--
-- NOTE on the value list: this constraint is re-created wholesale (the
-- established pattern here), so the list below is every value of the
-- constraint as left by 20260823140001 (the LIVE prod list read on
-- 2026-08-25) PLUS the new value. Dropping any existing value here would
-- silently revoke it.
--
-- NOT VALID + separate VALIDATE migration (paired file, same pattern as
-- 20260823140001 / 20260823140002).
--
-- pg-test: tests/pg/pending-operations-op-type-audit.pg.test.ts asserts every
-- op type staged in server.ts or tiered in risk-tiers.ts is accepted here.
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
    'post_kontantmetod_cutoff',
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
    'create_dimension_value',
    'retag_line_dimensions',
    'link_document_to_voucher',
    'update_payslip_line',
    'register_absence',
    'create_employee',
    'update_employee',
    'set_employee_opening_balances',
    'vacation_year_close',
    'create_account',
    'update_account',
    'set_voucher_note',
    'book_salary_run',
    'delete_absence',
    'update_company_settings',
    'update_customer',
    'update_invoice',
    'create_recurring_schedule',
    'update_recurring_schedule',
    'log_mileage_trip',
    'book_mileage_period',
    'link_documents_to_vouchers',
    'reconciliation_match',
    'reconciliation_unmatch',
    'reconciliation_signoff',
    'reconciliation_residual'
  )) NOT VALID;
