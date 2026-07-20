-- Add 'set_bookkeeping_locked_through' to the pending_operations
-- operation_type CHECK.
--
-- The per-month bookkeeping lock (company_settings.bookkeeping_locked_through)
-- is today a raw settings PUT with no review gate. The month-end close run
-- (granskningskö) makes locking the month a STAGED operation: the run
-- proposes the lock, a human approves, the executor advances the date.
-- Risk tier HIGH (lib/pending-operations/risk-tiers.ts): locking is the
-- period-lock family and is excluded from bulk approval.
--
-- The list below is the union with 20260717090000 (previous expansion).
-- tests/pg/pending-operations-op-type-audit.pg.test.ts asserts every op type
-- staged in server.ts or tiered in risk-tiers.ts is accepted here.

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
    'set_bookkeeping_locked_through' -- month-end close run: staged month lock
  )) NOT VALID;

-- NOT VALID for the same reason as 20260713121000: no full-table scan under
-- ACCESS EXCLUSIVE. Validated in 20260719100100.

NOTIFY pgrst, 'reload schema';
