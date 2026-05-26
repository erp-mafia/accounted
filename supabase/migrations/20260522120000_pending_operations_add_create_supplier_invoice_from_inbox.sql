-- Expand pending_operations.operation_type to include
-- create_supplier_invoice_from_inbox.
--
-- The MCP tool gnubok_create_supplier_invoice_from_inbox already stages with
-- this operation_type (extensions/general/mcp-server/server.ts) and the risk
-- tier is set to 'medium' in lib/pending-operations/risk-tiers.ts, but the
-- CHECK constraint never got updated — so every call from Claude / the MCP
-- client failed with check_violation at INSERT time, before reaching the
-- dispatcher.
--
-- This migration extends the CHECK constraint to allow the value. The
-- corresponding commit executor (commitCreateSupplierInvoiceFromInbox in
-- lib/pending-operations/commit.ts) is added in the same change so the
-- dispatcher can route the op end-to-end.

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
    -- Phase 5: supplier CRUD
    'create_supplier',
    -- Phase 5 (this migration): inbox → supplier invoice conversion
    'create_supplier_invoice_from_inbox'
  ));

NOTIFY pgrst, 'reload schema';
