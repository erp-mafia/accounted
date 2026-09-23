-- pg-test: covered-by tests/pg/file-subledger-import.pg.test.ts
-- Resolve company membership and invoice relations before caller-owned temp tables.
-- Preserve the existing function body, grants and timeout settings.
ALTER FUNCTION public.import_file_subledger(uuid, text, date, jsonb, boolean, text)
  SET search_path = public, pg_temp;

NOTIFY pgrst, 'reload schema';
