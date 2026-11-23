-- audit_log: a fiscal year's behandlingshistorik finds the rows about its own
-- verifikat logged outside the year by verifikat, without reading each
-- verifikat's INSERT and COMMIT rows (2 of 2; the other is 20261123091600).
--
-- In fiscal-year mode behandlingshistorik_sources (last restated in
-- 20261121150000) also reads, for every verifikat of the year, its audit rows
-- logged before or after the year: a storno or bokslut after year end. It
-- looks each verifikat up in idx_audit_log_table_record and drops the INSERT,
-- COMMIT and draft UPDATE rows it finds, every one fetched from the heap
-- first. A year whose verifikat were imported after it ended has all of them
-- outside the window, so the year reads two rows per verifikat to keep none.
-- Production, 2026-11-23, the largest company, fiscal year 2025 (36 340
-- verifikat): 72 680 rows read, 0 kept, 36 703 blocks read, 15.0 s, past the
-- 8 s statement timeout.
--
-- This index holds a verifikat's audit rows of the kinds the statement keeps
-- (not its INSERT, COMMIT or draft UPDATE rows), by company and record_id.
-- Its predicate is that statement's own conditions on the row, word for word
-- (20261123091600 says why nothing shorter is proven). Whether the planner
-- looks each verifikat up in it or reads the company's kept rows from it in
-- one scan and joins them, the INSERT and COMMIT rows are not read. The
-- function is not changed, so neither is what it returns.
-- tests/pg/behandlingshistorik-sources.pg.test.ts fails if the statement
-- stops matching the predicate.
--
-- Built CONCURRENTLY, for the reasons and with the guards given in
-- 20261123091600.
--
-- pg-test: covered-by tests/pg/behandlingshistorik-sources.pg.test.ts

SET statement_timeout = 0;

SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_audit_log_history_entry;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY idx_audit_log_history_entry
  ON public.audit_log (company_id, record_id)
  WHERE table_name = 'journal_entries'
    AND NOT coalesce(
          action IN ('INSERT', 'COMMIT')
          OR (action = 'UPDATE'
              AND coalesce(old_state->>'status', '') NOT IN ('posted', 'reversed')
              AND coalesce(new_state->>'status', '') NOT IN ('posted', 'reversed')),
          false);

RESET statement_timeout;
