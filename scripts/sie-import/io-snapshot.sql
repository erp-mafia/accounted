-- READ ONLY. Save two snapshots at least a week apart. Include month/year-end
-- query plans before considering any index removal. Zero scans is not proof
-- that a uniqueness, foreign-key support, or rare reporting index is unused.
SELECT clock_timestamp() captured_at,pg_postmaster_start_time() instance_started_at,
  d.stats_reset,i.relname table_name,i.indexrelname index_name,
  pg_get_indexdef(i.indexrelid) definition,x.indisunique,x.indisprimary,x.indisvalid,
  pg_size_pretty(pg_relation_size(i.indexrelid)) index_size,
  i.idx_scan,i.idx_tup_read,i.idx_tup_fetch,
  s.idx_blks_read,s.idx_blks_hit,
  ARRAY(SELECT conname FROM pg_constraint WHERE conindid=i.indexrelid) constraints
FROM pg_stat_user_indexes i JOIN pg_index x ON x.indexrelid=i.indexrelid
JOIN pg_statio_user_indexes s ON s.indexrelid=i.indexrelid
JOIN pg_stat_database d ON d.datname=current_database()
WHERE i.schemaname='public' AND i.relname IN ('journal_entries','journal_entry_lines','audit_log')
ORDER BY i.relname,i.indexrelname;

SELECT clock_timestamp() captured_at,queryid,calls,total_exec_time,mean_exec_time,
  shared_blks_written,shared_blks_dirtied,shared_blks_read,wal_bytes,wal_records,wal_fpi,
  left(query,200) query_shape
FROM extensions.pg_stat_statements
WHERE query ILIKE '%import_sie_chunk%' OR query ILIKE '%undo_sie_import_chunk%'
  OR query ILIKE '%import_sie_journal_entries%'
ORDER BY wal_bytes DESC;
