-- audit_log: the behandlingshistorik reads the window's rows it keeps, not
-- every row the window holds (1 of 2; the other is 20261123091700).
--
-- behandlingshistorik_sources (last restated in 20261121150000) selects the
-- window's audit rows with idx_audit_log_company_table_created and then drops
-- the rows no event comes from: a verifikat's INSERT and COMMIT (the commit is
-- read from journal_entries itself), a draft's UPDATE, and an underlag's
-- INSERT and UPDATE. Every one of those rows is fetched from the heap first.
-- Two of them are written for every verifikat booked, so for a company that
-- books or imports in bulk they are nearly all of the window. Production,
-- 2026-11-23, the largest company:
--
--   window            rows read   rows kept   blocks read   time
--   September 2026      201 755         778        34 860   10.8 s
--   fiscal year 2026    573 832      27 860       118 379   15.6 s
--
-- both past the 8 s statement timeout PostgREST runs the report's call under.
--
-- This index leaves out the rows the statement drops (a verifikat's INSERT
-- and COMMIT, a draft's UPDATE, an underlag's INSERT and UPDATE); of the
-- rest, the read still takes only the audited tables. Its predicate is the
-- statement's own exclusion, word for word: the planner proves a partial
-- index's predicate from the statement's WHERE clause and cannot see through
-- the coalesce, so even a shorter predicate the exclusion implies is never
-- proven. The dropped rows then never reach the heap. The function is not
-- changed, so neither is what it returns. A later edit to that exclusion must
-- change this predicate with it, or the planner stops using the index;
-- tests/pg/behandlingshistorik-sources.pg.test.ts fails when it does.
--
-- Built CONCURRENTLY, as 20261120134000 built the index beside it: audit_log
-- takes a row for every audited write, and a plain CREATE INDEX would hold
-- those writes for the minutes a build of the whole table takes (that one
-- took 5 minutes on production). The CLI that applies migrations runs a
-- CONCURRENTLY statement outside the migration's transaction and records the
-- version only once it succeeded. A build cancelled half-way leaves an
-- invalid index of this name behind, which the next run drops first (on a
-- normal run the drop finds nothing and takes no lock).
--
-- pg-test: covered-by tests/pg/behandlingshistorik-sources.pg.test.ts

-- The build reads all of audit_log, past the migration connection's
-- statement_timeout (2 minutes): lifted for this file's statements and
-- restored after, so a later migration in the same push runs under the usual
-- limit.
SET statement_timeout = 0;

-- The drop of a half-built index takes an exclusive lock on audit_log, which
-- every audited write needs: lock_timeout makes it give up within seconds
-- instead of holding those writes behind a long transaction, and the run is
-- retried (as in 20261123004700). Reset before the build, whose waits for
-- older transactions are lock waits too.
SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_audit_log_history_window;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY idx_audit_log_history_window
  ON public.audit_log (company_id, table_name, created_at)
  WHERE NOT coalesce(
          (table_name = 'journal_entries' AND action IN ('INSERT', 'COMMIT'))
          OR (table_name = 'journal_entries' AND action = 'UPDATE'
              AND coalesce(old_state->>'status', '') NOT IN ('posted', 'reversed')
              AND coalesce(new_state->>'status', '') NOT IN ('posted', 'reversed'))
          OR (table_name = 'document_attachments' AND action IN ('INSERT', 'UPDATE')),
          false);

RESET statement_timeout;
