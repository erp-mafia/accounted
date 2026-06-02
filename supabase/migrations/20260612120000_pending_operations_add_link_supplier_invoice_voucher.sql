-- Backfill `link_supplier_invoice_voucher` into the
-- pending_operations.operation_type CHECK constraint.
--
-- The supplier-side mirror of `link_invoice_voucher` (added in
-- 20260528120001). The new MCP tool gnubok_link_supplier_invoice_to_voucher
-- stages a `link_supplier_invoice_voucher` pending operation, which is then
-- committed by commitLinkSupplierInvoiceVoucher via the
-- link_supplier_invoice_to_voucher RPC (20260529130000 / 20260529140000).
-- The op also has a risk-tier entry ('medium', reversible — no journal entry
-- is created or modified).
--
-- Without this migration any INSERT staged by the new tool would be rejected
-- with a constraint violation, silently blocking the supplier_invoice_payments
-- audit-trail row required by BFL 5 kap 6–7§ (every affärshändelse must have a
-- verifikation with a logged payment match).

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
    'link_supplier_invoice_voucher'  -- supplier-side mirror of link_invoice_voucher
  ));

NOTIFY pgrst, 'reload schema';
