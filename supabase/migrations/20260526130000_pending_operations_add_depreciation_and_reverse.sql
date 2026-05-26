-- Expand pending_operations.operation_type to include post_annual_depreciation
-- AND reverse_entry — two tools that could stage but never commit.
--
-- Both gnubok_post_annual_depreciation and gnubok_reverse_journal_entry stage with
-- their operation_type (extensions/general/mcp-server/server.ts) and both have a
-- risk tier (lib/pending-operations/risk-tiers.ts) and a commit executor
-- (lib/pending-operations/commit.ts), but neither value was ever added to this
-- CHECK constraint. So every call from Claude failed with check_violation at INSERT
-- time, before reaching the dispatcher — the tools could stage nothing and could
-- never be committed. Same bug class as create_supplier_invoice_from_inbox (20260522120000).
--
-- post_annual_depreciation: new commitPostAnnualDepreciation executor (thin adapter
--   over lib/bokslut/assets/depreciation-engine.ts commitAnnualPostings), risk 'medium'.
-- reverse_entry: commitReverseEntry already existed and is wired in the dispatcher;
--   this just unblocks staging. Risk 'high' (storno is compliance-critical).

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
    'reverse_entry',
    -- Phase 5: supplier CRUD + inbox conversion
    'create_supplier',
    'create_supplier_invoice_from_inbox',
    -- Bokslut: planenlig avskrivning (one journal entry per asset)
    'post_annual_depreciation'
  ));

NOTIFY pgrst, 'reload schema';
