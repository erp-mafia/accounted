-- document_jobs: the jobs that can still run, by company, longest-due first.
--
-- claim_document_jobs finds each company's longest-due job and takes one of
-- them at random (20261123093100_claim_document_jobs_fair_per_company). It
-- walks this index company by company, and in each company stops at the first
-- due job, so a company with 17 000 due jobs costs what one with a single job
-- does. Jobs not due yet (a backoff ahead) are passed over in the index
-- itself, without reading the table: about 0.7 ms for 14 000 of them on a
-- copy. The only index on company_id holds every job ever run (375 000 rows
-- in production on 2026-11-23, 22 000 of them open), and the due index
-- (idx_document_jobs_due) is ordered by run_after across all companies.
--
-- The predicate is the claim's own: not done, and attempts left. A job that
-- gave up (failed with no attempts left) is never claimed again and is not in
-- it.
--
-- Built CONCURRENTLY so uploads and the worker keep writing during the build;
-- the CLI that applies migrations runs it outside the migration's transaction,
-- and a half-built index left by a cancelled run is dropped first (on a normal
-- run the drop finds nothing). As in
-- 20261123004700_document_attachments_company_id_id_index, the timeout is lifted
-- for the build and restored after, and the drop gives up within seconds
-- instead of holding the table behind a long transaction.
--
-- pg-test: skip an index only; no trigger, RPC, policy or constraint changes.

SET statement_timeout = 0;

SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_document_jobs_open_by_company;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY idx_document_jobs_open_by_company
  ON public.document_jobs (company_id, run_after, created_at)
  WHERE status <> 'done' AND attempts < max_attempts;

RESET statement_timeout;
