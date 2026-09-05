-- Lock supplier payment batch INSERTs to the RPC (#2060, residual from #1989).
-- pg-test: tests/pg/supplier-payment-batches.pg.test.ts
--
-- create_supplier_payment_batch (20260827100000) is SECURITY DEFINER and the
-- only legitimate writer of supplier_payment_batches and
-- supplier_payment_batch_items: it locks the selected invoices FOR UPDATE,
-- rechecks active batches inside the transaction, computes the header totals
-- from the items, and inserts header + items atomically. SECURITY DEFINER
-- bypasses RLS, so the RPC never consulted the two INSERT policies below.
-- Their only effect was to let any company member INSERT straight through
-- PostgREST (browser devtools, a raw JWT call) and skip every one of those
-- checks: a header whose total_amount / item_count disagree with its rows, or
-- a second active batch for an invoice already sitting in one, both of which
-- the RPC exists to prevent. The write path was single in code only, not in
-- the database.
--
-- No application code inserts into either table: every
-- .from('supplier_payment_batches') / .from('supplier_payment_batch_items')
-- in app/, lib/, extensions/ and scripts/ is a SELECT or an UPDATE, and
-- service-role paths bypass RLS regardless. Kept untouched: the SELECT
-- policies on both tables and the UPDATE policy on batches (the cancel
-- route's created -> cancelled transition, column-guarded by
-- enforce_supplier_payment_batch_immutability). Items keep no UPDATE/DELETE
-- policy, as before: they are immutable snapshots.
--
-- Policy-only change, no table structure change, so no schema reload.

DROP POLICY IF EXISTS "insert own-company supplier_payment_batches"
  ON public.supplier_payment_batches;
DROP POLICY IF EXISTS "insert own-company supplier_payment_batch_items"
  ON public.supplier_payment_batch_items;
