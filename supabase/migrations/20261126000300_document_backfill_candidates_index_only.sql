-- document_backfill_candidates: the walk and the period test read indexes, not
-- tables (2026-11-26).
--
-- pg-test: tests/pg/document-backfill-candidates.pg.test.ts
--
-- The read cron (every five minutes) walks the unread documents newest first
-- until it has its batch. Almost every unread document can never be stamped:
-- it sits on a closed or locked period, which enforce_period_lock_documents
-- keeps it on, or on the source of a migration reset. So a run with little to
-- read walks all of them and tests the period of every voucher it meets. Fast
-- while those pages are in memory; when other work had pushed them out of it
-- (an import, the crons that start on the same minute), reading them back
-- passed the 8 s statement timeout, and the run was lost. Per document it
-- read:
--
-- 1. the document's row, for the columns the walk tests: one table page per
--    document, over the whole table;
-- 2. its voucher by primary key, for fiscal_period_id: voucher ids are random,
--    so the vouchers of one company's documents sat on primary-key pages
--    spread over the whole index, and each was followed by a visit to the
--    table.
--
-- Now the walk reads only idx_document_attachments_backfill_walk
-- (20261126000100), which holds the columns it tests, and looks the voucher up
-- by (company_id, id) in idx_journal_entries_company_id_id_period
-- (20261126000200), which holds the period: one company's vouchers sit
-- together there, so the whole walk reads a small set of index pages that the
-- next run finds in memory. The full rows of the batch, at most 500, are read
-- by primary key.
--
-- The answer is unchanged. The company lookup finds the voucher whenever the
-- document belongs to the voucher's own company; nothing in the schema says
-- it must, so when it finds nothing the voucher is read by primary key as
-- before, and a voucher of another company is tested as it was. The period
-- test is the one 20261123004000 ships, and the same rows come back, newest
-- first. The pg test runs the shipped bodies next to this one on the same
-- rows.

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
  -- The batch the walk picked, read from the table by primary key. An array, not a join: the planner cannot turn
  -- it into a scan of the whole table, whatever it guesses the batch's size to be.
  WHERE d.id = ANY (ARRAY(
    -- The walk tests only columns idx_document_attachments_backfill_walk holds, so it reads that index, not the table.
    SELECT w.id
    FROM public.document_attachments w
    WHERE w.pages_read_at IS NULL
      -- A structured archive (a bank response, an XML payload) is the record itself and is never read.
      AND (w.mime_type IS NULL OR w.mime_type NOT IN ('application/xml', 'text/xml', 'application/json'))
      -- block_migration_reset_source_mutation would refuse the stamp. One set per call.
      AND w.company_id NOT IN (SELECT r.source_company_id FROM public.company_migration_resets r)
      -- The job queue is reading it, or still going to, and has acted within the hour. One set per call.
      -- The classify backfill holds the same rule in lib/documents/jobs/hold.ts.
      AND w.id NOT IN (
        SELECT j.document_id
        FROM public.document_jobs j
        WHERE j.kind = 'read'
          AND (
            (j.status = 'running' AND j.locked_at > now() - interval '1 hour')
            OR (j.status IN ('queued', 'failed') AND j.attempts < j.max_attempts AND j.run_after > now() - interval '1 hour')
          )
      )
      -- Its last reading got no answer: not before the wait is over.
      AND (w.read_retry_after IS NULL OR w.read_retry_after <= now())
      -- enforce_period_lock_documents would refuse the stamp: the voucher's period is closed or locked. Its period
      -- is tested against one set per call. No voucher, or a voucher on an open period, is NULL or false here.
      AND NOT coalesce(
        coalesce(
          -- The document's own company's voucher, from idx_journal_entries_company_id_id_period.
          (SELECT je.fiscal_period_id FROM public.journal_entries je WHERE je.company_id = w.company_id AND je.id = w.journal_entry_id),
          -- Nothing ties a document to its own company's voucher: another company's is read by primary key.
          (SELECT je.fiscal_period_id FROM public.journal_entries je WHERE je.id = w.journal_entry_id)
        ) IN (SELECT fp.id FROM public.fiscal_periods fp WHERE fp.is_closed OR fp.locked_at IS NOT NULL),
        false
      )
    ORDER BY w.created_at DESC
    LIMIT greatest(0, least(coalesce(p_limit, 0), 500))
  ))
  ORDER BY d.created_at DESC
$$;

REVOKE EXECUTE ON FUNCTION public.document_backfill_candidates(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_backfill_candidates(int) TO service_role;

NOTIFY pgrst, 'reload schema';
