-- journal_entry_lines.account_id (FK to chart_of_accounts, ON DELETE SET
-- NULL) has no index, while account_number, journal_entry_id, cost_center,
-- project and the dimension bags all do. Deleting a chart account therefore
-- seq-scans all ~730k journal_entry_lines rows per account; sandbox teardown
-- deletes ~37 chart accounts per company, which is where most of its ~3s
-- per-user cost goes (caught live: the backlog purge timed out inside
-- "UPDATE ONLY journal_entry_lines SET account_id = NULL WHERE account_id =
-- $1" cascading from DELETE FROM auth.users).

CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_account_id
  ON public.journal_entry_lines (account_id);
