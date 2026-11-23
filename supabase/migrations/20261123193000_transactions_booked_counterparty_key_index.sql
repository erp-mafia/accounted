-- transactions: the booked bank rows of a company by counterparty key, newest
-- first (1 of 2; the function that reads it is 20261123193100).
--
-- booking_precedents asks, for a handful of counterparty keys of one company,
-- which booked bank rows carry each key and takes the newest of them. The key
-- is normalize_counterparty_key over the row's counterparty text (the
-- merchant name, else the bank's original description, else the description):
-- the key the counterparty templates are stored under. No index holds it, so
-- without this one the read computes the key for every booked row of the
-- company in the window on every call.
--
-- The indexed expression is the function's own, word for word, and the
-- predicate is its "journal_entry_id IS NOT NULL": the planner matches an
-- expression index by the expression as written and proves a partial index
-- from the statement's WHERE clause. An edit to either side must change the
-- other with it; tests/pg/booking-precedents.pg.test.ts fails when the
-- planner stops using the index.
--
-- normalize_counterparty_key is IMMUTABLE, which is what lets an index hold
-- its result. The index stores the key as the function computed it when the
-- row was written, so a migration that changes what the function returns
-- must rebuild this index in the same change (REINDEX INDEX CONCURRENTLY
-- public.idx_transactions_booked_counterparty_key), or rows written before
-- it are looked up under their old key.
-- src/lib/bookkeeping/__tests__/counterparty-key-index.test.ts fails a later
-- migration that redefines the function without it.
--
-- A write that puts a row into the index runs the key function as the role
-- that writes. The roles that write bank rows (authenticated, service_role
-- and the owner) hold EXECUTE on it since 20260707120000; anon does not, and
-- writes no bank rows.
--
-- One entry per booked bank row: the company id, the key and the date.
-- Writes that change none of the indexed columns and leave the row booked or
-- unbooked as it was do not touch it; a booking, an unbooking and an edit of
-- the row's texts or date compute the key once.
--
-- Built CONCURRENTLY so bank sync and bookings keep writing during the build,
-- which computes the key for every booked row; the CLI that applies
-- migrations runs it outside the migration's transaction, and a half-built
-- index left by a cancelled run is dropped first (on a normal run the drop
-- finds nothing). As in 20261123093000_document_jobs_open_by_company_index,
-- the timeout is lifted for the build and restored after, and the drop gives
-- up within seconds instead of holding the table behind a long transaction.
--
-- pg-test: covered-by tests/pg/booking-precedents.pg.test.ts

SET statement_timeout = 0;

SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_transactions_booked_counterparty_key;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY idx_transactions_booked_counterparty_key
  ON public.transactions (
    company_id,
    public.normalize_counterparty_key(coalesce(nullif(merchant_name, ''), nullif(original_description, ''), description)),
    date DESC
  )
  WHERE journal_entry_id IS NOT NULL;

RESET statement_timeout;
