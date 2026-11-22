-- document_backfill_candidates: the small sides of its checks are read once
-- per call, not once per document (2026-11-23).
--
-- pg-test: tests/pg/document-backfill-candidates.pg.test.ts
--
-- The read cron (every five minutes) walks the unread documents newest first
-- until it has its batch. Most of them can never be stamped (production,
-- 2026-11-22: 21 514 of 37 453 sit on a closed or locked period and 1 185 on
-- the source of a migration reset), so a run with little to read walks every
-- one of them. The runs that passed the 8 s statement timeout on 2026-11-18
-- and 11-19 had 23 000 to 25 000 unread documents and a few dozen to read.
-- The function checked each document with three probes:
--
-- 1. The job queue's hold: planned as a nested loop over every held read job,
--    compared with every document the walk reaches. Production, 2026-11-22
--    with about 3 000 held read jobs: 3.5 million comparisons, 0.5 s of a
--    0.55 s call, and the count grows with the square of an upload burst.
-- 2. The reset check: a probe of company_migration_resets per document.
-- 3. The period lock: the voucher by primary key, then its period by primary
--    key, per document.
--
-- Now the held read jobs, the reset companies and the closed or locked periods
-- are each read once per call into a hashed set, and a document is tested
-- against them. The voucher is still read per document (its period is only on
-- the voucher), and only for a document that passed the cheaper tests. Same
-- walk on production, generic plan as the function runs: the full walk
-- 196 000 buffers in two processes to 128 000 in one; the call on today's
-- queue 545 ms to 35 ms.
--
-- The answer is unchanged: NOT IN is the NOT EXISTS it replaces because both
-- sides of each are NOT NULL (document_attachments.id and company_id,
-- document_jobs.document_id, company_migration_resets.source_company_id,
-- fiscal_periods.id), and the period test is false exactly when the old join
-- found no closed or locked period (no voucher, or a voucher on an open
-- period). The pg test runs the shipped body next to this one on the same
-- rows.
--
-- Not fixed here: the walk still reads the voucher of each of the 21 500
-- documents on a closed or locked period, every run. Skipping them needs the
-- fact that a document cannot be stamped stored where the scan sees it, and
-- the row itself refuses every update (enforce_period_lock_documents).

CREATE OR REPLACE FUNCTION public.document_backfill_candidates(p_limit int)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  storage_path text,
  mime_type text,
  created_at timestamptz,
  journal_entry_id uuid,
  journal_entry_line_id uuid,
  doc_type text,
  pages_read_at timestamptz,
  read_error text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT d.id, d.company_id, d.storage_path, d.mime_type, d.created_at,
         d.journal_entry_id, d.journal_entry_line_id, d.doc_type, d.pages_read_at, d.read_error
  FROM public.document_attachments d
  WHERE d.pages_read_at IS NULL
    -- A structured archive (a bank response, an XML payload) is the record itself and is never read.
    AND (d.mime_type IS NULL OR d.mime_type NOT IN ('application/xml', 'text/xml', 'application/json'))
    -- block_migration_reset_source_mutation would refuse the stamp. One set per call.
    AND d.company_id NOT IN (SELECT r.source_company_id FROM public.company_migration_resets r)
    -- The job queue is reading it, or still going to, and has acted within the hour. One set per call.
    -- The classify backfill holds the same rule in lib/documents/jobs/hold.ts.
    AND d.id NOT IN (
      SELECT j.document_id
      FROM public.document_jobs j
      WHERE j.kind = 'read'
        AND (
          (j.status = 'running' AND j.locked_at > now() - interval '1 hour')
          OR (j.status IN ('queued', 'failed') AND j.attempts < j.max_attempts AND j.run_after > now() - interval '1 hour')
        )
    )
    -- Its last reading got no answer: not before the wait is over.
    AND (d.read_retry_after IS NULL OR d.read_retry_after <= now())
    -- enforce_period_lock_documents would refuse the stamp: the voucher's period is closed or locked. The
    -- voucher is read by primary key and its period tested against one set per call. No voucher, or a voucher
    -- on an open period, is NULL or false here, as the old join found nothing.
    AND NOT coalesce(
      (SELECT je.fiscal_period_id FROM public.journal_entries je WHERE je.id = d.journal_entry_id)
        IN (SELECT fp.id FROM public.fiscal_periods fp WHERE fp.is_closed OR fp.locked_at IS NOT NULL),
      false
    )
  ORDER BY d.created_at DESC
  LIMIT greatest(0, least(coalesce(p_limit, 0), 500))
$$;

REVOKE EXECUTE ON FUNCTION public.document_backfill_candidates(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_backfill_candidates(int) TO service_role;

NOTIFY pgrst, 'reload schema';
