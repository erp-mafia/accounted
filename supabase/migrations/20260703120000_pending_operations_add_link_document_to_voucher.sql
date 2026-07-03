-- Add 'link_document_to_voucher' to the pending_operations operation_type
-- CHECK constraint.
--
-- Bug fix (dev_docs/mcp_optimization_plan.md P0-1): the MCP tool
-- gnubok_link_document_to_voucher shipped with its executor
-- (lib/pending-operations/commit.ts) and risk tier
-- (lib/pending-operations/risk-tiers.ts: 'medium') but its operation type was
-- never added to this constraint. Every real staging INSERT was rejected with
-- check_violation, while dry_run=true — which skips the INSERT — always
-- returned a clean preview. Reported 3 times by 2 companies via
-- agent.feedback; blocked the Bokio-attachment-migration flow entirely.
--
-- Risk tier: 'medium' — linking a doc to a posted verifikation becomes part of
-- räkenskapsinformation (BFL 5 kap 6 §) once approved, so a human confirms the
-- pairing; no journal entry is created or modified.
--
-- pg-test: this PR adds tests/pg/pending-operations-op-type-audit.pg.test.ts,
-- which asserts EVERY op type staged in server.ts or tiered in risk-tiers.ts
-- is accepted by this constraint — so a tool can never again ship without its
-- constraint expansion.
--
-- NOTE: the list below is the union with 20260702171000 (retag_line_dimensions,
-- dimensions PR6). An earlier draft of this migration was authored from a
-- checkout that predated that migration and briefly clobbered
-- 'retag_line_dimensions' on prod (repaired the same morning; zero staged
-- retag ops in the window) — the exact hand-copied-list hazard the audit test
-- exists to catch.

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
    'retag_line_dimensions',     -- audited retro-tagging of dimension maps on posted lines (dimensions PR6)
    'link_document_to_voucher'   -- koppla bilaga to a posted verifikat (imported/manual vouchers with no bank-tx row)
  ));

NOTIFY pgrst, 'reload schema';
