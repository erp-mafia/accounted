-- O09 (run t1027): drop one unused index on a write-heavy table.
--
-- idx_inbox_items_correlation_id (20260420180000_inbox_smart_match) was
-- added "for correlation-id audit queries" that were never written: no code
-- path, RPC or cron filters invoice_inbox_items by correlation_id (readers
-- only select the column next to the row id). Production since the last
-- stats reset (2026-09-11): idx_scan = 0, while every inbox item written
-- with a correlation id still pays for an index entry.
--
-- It backs no constraint and no foreign key. The column itself stays.
--
-- The other advisor "unused_index" findings are kept on purpose: either code
-- filters on their leading column (company_id, deadline_type, run_id, the
-- dimension key in the SIE undo and reset RPCs), a foreign key action could
-- need them, or the table is too small for the drop to matter.

SELECT set_config('lock_timeout', '2s', true);

DROP INDEX IF EXISTS public.idx_inbox_items_correlation_id;
