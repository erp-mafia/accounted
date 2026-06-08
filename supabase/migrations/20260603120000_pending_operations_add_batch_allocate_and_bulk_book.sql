-- Expand pending_operations.operation_type to include the multi-tx
-- bookkeeping ops introduced in PRs #603, #606, #608, #610:
--
--   match_batch_allocate     — 1 bank tx → N customer or N supplier
--                              invoices (samlingsbetalning per
--                              BFL 5 kap 6§ st 3). Calls the SQL RPC
--                              `match_batch_allocate(tx_id, allocations,
--                              company_id)` on approval. Risk: medium
--                              (reversible via storno of the JE +
--                              deletion of the invoice_payments rows).
--
--   bulk_book_transactions   — N bank txs on the same date → 1
--                              combined verifikat (samlingsverifikation
--                              per BFL 5 kap 6§). Two branches:
--                              link-to-existing (no new JE; pure
--                              junction rows) or create-new (caller-
--                              supplied or template-expanded lines).
--                              Risk: high (creates a posted verifikat
--                              with arbitrary lines, same surface as
--                              create_voucher).

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
    'undo_sie_import',           -- backfilled (was missing from prior expansions)
    'match_batch_allocate',      -- PR #603/#607: 1 tx → N invoices
    'bulk_book_transactions'     -- PR #606/#610: N txs → 1 verifikat
  ));

NOTIFY pgrst, 'reload schema';
