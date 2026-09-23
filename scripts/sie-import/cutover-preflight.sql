-- Read-only sizing and blocking-transaction inventory. Run immediately before
-- the approved cutover; no customer rows or query text are returned.
BEGIN READ ONLY;

SELECT clock_timestamp() AS captured_at, c.relname AS table_name,
  c.reltuples::bigint AS estimated_rows,
  pg_size_pretty(pg_relation_size(c.oid)) AS heap_size,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('journal_entries', 'journal_entry_lines', 'fiscal_periods', 'sie_imports')
ORDER BY c.relname;

SELECT pid, state, clock_timestamp() - xact_start AS transaction_age,
  wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
  AND (xact_start < clock_timestamp() - interval '30 seconds'
    OR wait_event_type = 'Lock')
ORDER BY xact_start NULLS LAST;

SELECT c.relname AS table_name, l.pid, l.mode, l.granted,
  a.state, clock_timestamp() - a.xact_start AS transaction_age
FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE n.nspname = 'public'
  AND c.relname IN ('journal_entries', 'journal_entry_lines', 'fiscal_periods', 'sie_imports')
ORDER BY c.relname, l.granted, l.pid;

COMMIT;
