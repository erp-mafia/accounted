-- Invoice inbox: several underlag may back one verifikat.
--
-- Migration 20260515090000 added UNIQUE (created_journal_entry_id) on
-- invoice_inbox_items to stop a book-direct double commit. It never could:
-- that race is two UPDATEs of the SAME inbox row to different vouchers, and a
-- cross-row UNIQUE does not see it. What the constraint did enforce was a 1:1
-- between inbox item and verifikat that the product never had: an invoice
-- plus its payment confirmation, or three kvitton on one samlingsverifikat,
-- are one verifikat backed by several inbox items. Only the first stamp
-- landed; every later one raised 23505, which the link_document_to_voucher
-- stamp tolerated silently, so gnubok_list_unmatched_documents and
-- gnubok_list_inbox_items(unprocessed_only) kept listing already-attached
-- underlag forever (MCP feedback seq 389343, 395894, 395931, 366701; four
-- companies; one user nearly deleted underlag sitting on posted verifikat).
--
-- The real double-claim guard is the compare-and-set predicate the executor
-- stamps carry (`created_journal_entry_id IS NULL`, plus
-- `created_supplier_invoice_id IS NULL` where a supplier-invoice claim can
-- race): it guards the row being claimed, which is the only thing that can be
-- claimed twice. That stays; only the constraint goes.
--
-- Dropping the constraint also drops its backing index, the only index keyed
-- on created_journal_entry_id alone (the FK's ON DELETE SET NULL looks rows up
-- through it when a draft voucher is deleted). The partial index from
-- 20260514120000 leads with company_id and keeps serving the company-scoped
-- reads; a plain partial index takes over the per-voucher lookup.
--
-- pg-test: covered-by tests/pg/invoice-inbox-shared-voucher.pg.test.ts

ALTER TABLE public.invoice_inbox_items
  DROP CONSTRAINT IF EXISTS invoice_inbox_items_journal_entry_unique;

CREATE INDEX IF NOT EXISTS idx_inbox_items_journal_entry_id
  ON public.invoice_inbox_items (created_journal_entry_id)
  WHERE created_journal_entry_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
