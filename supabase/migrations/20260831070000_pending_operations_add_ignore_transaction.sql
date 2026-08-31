-- Add 'ignore_transaction' to the pending_operations operation_type CHECK
-- constraint (issue #1661).
--
-- gnubok_ignore_transaction (MCP) stages "ignore this bank transaction" (or
-- restore it with ignored = false). Ignoring flips transactions.is_ignored
-- and writes no verifikat: it is the path for rows that are not
-- affärshändelser (PSD2 ghost rows, duplicates from a reconnect, transfers
-- that never executed), and the only way to clear such rows out of a locked
-- or closed period, where a private marking (a real eget uttag/insättning
-- booking) is refused with TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED. The user
-- approves it in Granskning and commitIgnoreTransaction in
-- lib/pending-operations/commit.ts applies it through
-- lib/transactions/ignore.ts (the same core as the dashboard and v1 routes),
-- which refuses booked rows through all three anchors. Risk 'low': no
-- ledger impact, reversible with the same op.
--
-- NOTE on the value list: this constraint is re-created wholesale (the
-- established pattern here), so the list below is every value of the
-- constraint as left by 20260830160000 (update_salary_run, which built on 20260830150000's delete_draft_invoice and 20260830130000's book_skattekonto_row / book_skattekonto_rows) PLUS the new value. Dropping any
-- existing value here would silently revoke it.
--
-- NOT VALID + separate VALIDATE migration (paired file, same pattern as
-- 20260828160000 / 20260828160001).
--
-- pg-test: tests/pg/pending-operations-ignore-transaction.pg.test.ts and
-- tests/pg/pending-operations-op-type-audit.pg.test.ts.
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
    'delete_draft_invoice',
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
    'set_run_salary',
    'update_salary_run',
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
    'reconciliation_residual',
    'book_skattekonto_row',
    'book_skattekonto_rows',
    'ignore_transaction'
  )) NOT VALID;
