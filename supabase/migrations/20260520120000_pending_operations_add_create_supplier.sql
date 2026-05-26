-- Expand pending_operations.operation_type to include create_supplier.
--
-- The MCP server can already stage customers via gnubok_create_customer, but
-- supplier creation (gnubok_create_supplier) requires its own staged op type
-- so the dispatcher in lib/pending-operations/commit.ts can route it to the
-- suppliers-table insert path. Without this CHECK update the INSERT into
-- pending_operations fails with a check_violation.
--
-- Same low-risk tier as create_customer (pure data, no booking impact).

ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_operation_type_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_operation_type_check
  CHECK (operation_type IN (
    -- Phase 0: original 7 op types
    'categorize_transaction',
    'create_customer',
    'create_invoice',
    'mark_invoice_paid',
    'send_invoice',
    'mark_invoice_sent',
    'match_transaction_invoice',
    -- Stream 1 Phase 1: bookkeeping period operations
    'close_period',
    'lock_period',
    'unlock_period',
    'set_opening_balances',
    'run_year_end',
    'run_currency_revaluation',
    -- Stream 1 Phase 1: SIE import (export is read-only)
    'import_sie',
    -- Stream 1 Phase 1: voucher gap explanations
    'explain_voucher_gap',
    -- Stream 1 Phase 1: transaction reversal
    'uncategorize_transaction',
    -- Stream 1 Phase 1: supplier invoice lifecycle
    'approve_supplier_invoice',
    'credit_supplier_invoice',
    -- Stream 1 Phase 1: invoice operations beyond simple create/send
    'credit_invoice',
    'convert_invoice',
    -- Phase 3: manual transaction ingestion + document attachment
    'create_transaction',
    'attach_document_to_transaction',
    -- Phase 4: arbitrary-line bookkeeping primitives
    'create_voucher',
    'correct_entry',
    -- Phase 5 (this migration): supplier CRUD
    'create_supplier'
  ));

NOTIFY pgrst, 'reload schema';
