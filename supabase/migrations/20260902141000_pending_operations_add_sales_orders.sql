-- Add the four kundorder (sales order) operation types to the
-- pending_operations operation_type CHECK constraint.
--
-- The MCP server stages every sales-order write for approval, exactly like
-- invoices and articles; the user approves it in Granskning and the commit
-- executors in lib/pending-operations/commit.ts apply it through the same
-- lib/sales-orders services the cookie routes under app/api/sales-orders
-- use, so the MCP door and the web door cannot drift:
--
--   create_sales_order            gnubok_create_sales_order: a draft order
--                                 with its lines (number allocated at
--                                 creation; orders are not verifikationer).
--                                 Risk 'low': nothing is booked.
--   transition_sales_order        gnubok_transition_sales_order: the header
--                                 state machine (confirm / cancel / reopen).
--                                 Cancel and reopen are refused while linked
--                                 invoices exist. Risk 'low'.
--   register_sales_order_delivery gnubok_register_sales_order_delivery:
--                                 cumulative delivered quantities per line
--                                 (no inventory, nothing is booked; the
--                                 order's last_delivery_date becomes the
--                                 taxable-event date on later invoices).
--                                 Risk 'low'.
--   create_invoice_from_sales_order gnubok_create_invoice_from_sales_order:
--                                 an unnumbered DRAFT kundfaktura from a
--                                 confirmed order (remaining, delivered or
--                                 explicit line picks) through
--                                 buildInvoiceWriteData, so VAT gating and
--                                 totals stay in the invoice builder. Risk
--                                 'medium', same tier as create_invoice.
--
-- NOTE on the value list: this constraint is re-created wholesale (the
-- established pattern here), so the list below is every value of the
-- constraint as left by 20260831070000 (ignore_transaction, which built on
-- 20260830160000's update_salary_run) PLUS the four new values. Dropping
-- any existing value here would silently revoke it.
--
-- NOT VALID + separate VALIDATE migration (paired file, same pattern as
-- 20260831070000 / 20260831070001).
--
-- pg-test: tests/pg/pending-operations-op-type-audit.pg.test.ts (collects
-- the staged op types from server.ts and OPERATION_RISK_TIERS).
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
    'ignore_transaction',
    'create_sales_order',
    'transition_sales_order',
    'register_sales_order_delivery',
    'create_invoice_from_sales_order'
  )) NOT VALID;
