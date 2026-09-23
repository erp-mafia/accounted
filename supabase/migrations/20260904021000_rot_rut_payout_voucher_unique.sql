-- One live settlement voucher per ROT/RUT begäran, enforced at the journal.
--
-- Two concurrent settles (two same-amount bank rows, or a headless call racing
-- a bank-row match) can both pass the application's "not yet settled" read and
-- both book debit 19xx / credit 1513 before the request row's compare-and-set
-- picks a winner. The loser's voucher would stand (posted entries are
-- immutable) and 1513 would be credited twice for one payout. This index makes
-- the second entry fail at insert, before it can ever be committed.
--
-- draft is included on purpose: the engine inserts a draft and commits it in a
-- second step, so a loser must fail at the draft insert and leave nothing
-- behind. Reversed/cancelled entries fall outside the predicate, so a storno
-- of a settlement never blocks a later re-settle.
-- pg-test: tests/pg/rot-rut-payout-voucher-unique.pg.test.ts

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_rot_rut_payout_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'rot_rut_payout'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');
