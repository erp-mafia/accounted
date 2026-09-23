-- Every journal line carries exactly one side: debit OR credit, never both.
--
-- A line with debit_amount = 100 AND credit_amount = 100 cancels itself, and
-- check_journal_entry_balance() sums the two columns, so it never fires: the
-- entry "balances" and posts as a nollverifikat. Storno then reverses the
-- line on its net, lands on {0, 0} and dies on the voucher trigger's "has
-- zero total", which leaves the entry uncorrectable (issue #2551). Nothing in
-- the stack refused the shape: the engine checked only signs and totals, and
-- no line schema had a cross-field rule.
--
-- The companion to journal_entry_lines_amounts_non_negative (20260908164944):
-- that one says neither side is below zero, this one says only one side is
-- above it.
--
-- NOT VALID: rows stored before the constraint are not scanned, they are
-- checked on their next INSERT or UPDATE. Existing rows are repaired by a
-- separate, founder-approved data fix (net the two amounts onto the larger
-- side, net unchanged); VALIDATE CONSTRAINT follows in a later migration once
-- prod reports zero offending rows:
--   select count(*) from journal_entry_lines
--    where debit_amount > 0 and credit_amount > 0;
ALTER TABLE public.journal_entry_lines
  ADD CONSTRAINT journal_entry_lines_single_side
  CHECK (debit_amount = 0 OR credit_amount = 0)
  NOT VALID;

COMMENT ON CONSTRAINT journal_entry_lines_single_side ON public.journal_entry_lines IS
  'Issue #2551: a journal line carries one side only. Both sides above zero self-cancels, posts as a nollverifikat and makes storno impossible. Mirrored by assertLinesWellFormed in lib/bookkeeping/engine.ts and by isSingleSidedLine in lib/api/schemas.ts. NOT VALID until prod reports zero offending rows.';

NOTIFY pgrst, 'reload schema';
