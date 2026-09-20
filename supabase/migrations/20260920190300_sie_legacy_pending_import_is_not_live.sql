-- A legacy SIE import row cannot claim to be in progress (issue #2566).
--
-- Before the durable job backbone (20260911140515, live on prod 2026-09-14) an
-- import was one request: insert a sie_imports row with status 'pending', write
-- the verifikat, then finalize the row. A request that died in between (function
-- timeout, crash) left the row 'pending' for good. The cutover retired that
-- writer: every door now goes through start_sie_import_job, which always sets
-- job_state. So for a row with job_state NULL, 'pending' (or the never-written
-- 'mapped') names a writer that no longer exists. Nothing can ever finish it.
--
-- Two readers still take that status at its word, and between them they shut
-- both of the user's exits, with no door that can clear the row:
--   * start_sie_import_job (20260911141611) refuses every new import into an
--     overlapping fiscal year: 'Existing SIE import requires reviewed
--     replacement or reconciliation'. It keeps refusing after the year has been
--     reset to empty.
--   * company_migration_reset_snapshot (base body 20260818084050) counts the row
--     as an import that 'can still finalize rows against the source' and blocks
--     the whole-company archive with imports_in_progress. That archive is the
--     exit the 2026-09-11 retention decision points owners to.
-- Pinned in tests/pg/sie-legacy-import-dead-end.pg.test.ts.
--
-- The fix removes the false state instead of teaching each reader about it:
--   1. Existing rows: status becomes 'failed', which is what an attempt that
--      never finalized is. 'failed' grants nothing: legacy rows still cannot be
--      undone or replaced, and year-reset eligibility never reads this status.
--      No ownership of any verifikat is inferred (decision 2026-09-14), and no
--      journal entry, line, document or voucher number is touched.
--      audit_sie_imports_update records each change in behandlingshistoriken
--      (BFNAR 2013:2 p. 9.16: imports are processing history).
--   2. New rows: a CHECK makes the state unrepresentable, so the legacy branches
--      in both readers can never fire again. They are left in place, untouched.
--      The authenticated role may still INSERT into sie_imports under RLS, and
--      guard_sie_execution_metadata only fences rows that carry a job_state, so
--      without the CHECK one REST insert would recreate both dead ends.
--
-- Archived migration-reset source companies are skipped: their rows are
-- write-closed by block_migration_reset_source_mutation (any UPDATE raises,
-- which would abort this migration and queue every later one behind it, as
-- happened to 20260914110000). That is also why the CHECK is NOT VALID: it
-- binds every new and updated row, while a skipped archive row, which nothing
-- can update anyway, does not fail validation. Prod pre-check 2026-09-20:
-- 14 rows in 12 companies, none of them in an archived source company.

UPDATE public.sie_imports AS s
   SET status = 'failed',
       error_message = COALESCE(
         NULLIF(btrim(s.error_message), ''),
         'Importen avslutades aldrig i det äldre importflödet. Posten har stängts utan att någon bokföring ändrades.'
       )
 WHERE s.job_state IS NULL
   AND s.status IN ('pending', 'mapped')
   AND NOT EXISTS (
     SELECT 1
       FROM public.company_migration_resets r
      WHERE r.source_company_id = s.company_id
   );

ALTER TABLE public.sie_imports
  DROP CONSTRAINT IF EXISTS sie_imports_in_progress_needs_job;
ALTER TABLE public.sie_imports
  ADD CONSTRAINT sie_imports_in_progress_needs_job
  CHECK (job_state IS NOT NULL OR status NOT IN ('pending', 'mapped')) NOT VALID;

COMMENT ON CONSTRAINT sie_imports_in_progress_needs_job ON public.sie_imports IS
  'Only a durable job (job_state set) may be in progress. A legacy row claiming pending/mapped names a retired writer and would block new imports and the whole-company archive with no way to clear it (#2566).';

NOTIFY pgrst, 'reload schema';
