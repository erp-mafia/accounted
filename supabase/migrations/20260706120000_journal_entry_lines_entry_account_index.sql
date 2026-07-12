-- Covering index for get_account_usage_counts (kontoplan "Verifikat" column +
-- the "Rensa oanvända konton" prune dialog).
--
-- That RPC aggregates journal_entry_lines by account_number for a company:
--
--   SELECT l.account_number, count(*)
--   FROM journal_entry_lines l
--   JOIN journal_entries je ON je.id = l.journal_entry_id
--   WHERE je.company_id = $1
--   GROUP BY l.account_number;
--
-- For companies whose entries are a smallish fraction of the table, the planner
-- picks a nested loop: scan je by company_id, then for each entry look up its
-- lines via idx_journal_entry_lines_entry (journal_entry_id only). Because that
-- index does NOT carry account_number, every matched line needs a heap fetch
-- just to read the account number. On prod's heaviest company (~50k lines) that
-- was ~58k heap-buffer accesses and ~440 ms.
--
-- Adding account_number to the index makes that inner lookup an INDEX-ONLY scan
-- (verified on the staging branch: the node becomes "Index Only Scan using
-- idx_journal_entry_lines_entry_account" with a handful of heap fetches), which
-- eliminates the heap traffic that dominated the runtime.
--
-- Plain CREATE INDEX (not CONCURRENTLY): Supabase branching applies migrations
-- inside a transaction, where CONCURRENTLY is not allowed. The build takes a
-- brief write lock on journal_entry_lines; acceptable for a deploy migration.
-- journal_entry_lines is append-mostly, so no ongoing maintenance concern.

CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_entry_account
  ON public.journal_entry_lines (journal_entry_id, account_number);
