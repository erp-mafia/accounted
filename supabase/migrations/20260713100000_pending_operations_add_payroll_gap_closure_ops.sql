-- Add the payroll gap-closure operation types to the pending_operations
-- operation_type CHECK constraint:
--
--   update_payslip_line            (MCP gnubok_update_payslip_line, medium)
--   register_absence               (MCP gnubok_register_absence, medium)
--   create_employee                (MCP gnubok_create_employee, medium: PII +
--                                   bank payment-routing fields, same BEC
--                                   rationale as create_supplier)
--   update_employee                (MCP gnubok_update_employee, medium)
--   set_employee_opening_balances  (MCP gnubok_set_employee_opening_balances,
--                                   medium: cutover state for mid-year
--                                   migrations; distinct from the SIE
--                                   'set_opening_balances' op)
--
-- The list below is the union with 20260703120000 (the previous expansion).
-- tests/pg/pending-operations-op-type-audit.pg.test.ts asserts every op type
-- staged in server.ts or tiered in risk-tiers.ts is accepted by this
-- constraint, so a hand-copy omission fails CI.

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
    'update_payslip_line',           -- payroll gap-closure 1.7
    'register_absence',              -- payroll gap-closure 1.7
    'create_employee',               -- payroll gap-closure 1.8
    'update_employee',               -- payroll gap-closure 1.8
    'set_employee_opening_balances'  -- payroll gap-closure 2.4 (cutover)
  )) NOT VALID;

-- NOT VALID: skips the full-table scan that ADD CONSTRAINT would otherwise
-- run while holding ACCESS EXCLUSIVE on this continuously written table.
-- Existing rows all satisfy the old (strict subset) list; the constraint is
-- validated in 20260713123000 under a non-blocking SHARE UPDATE EXCLUSIVE
-- lock. New writes are enforced either way.

NOTIFY pgrst, 'reload schema';
