-- document_backfill_candidates: the voucher is joined, so the planner reads its
-- period from idx_journal_entries_company_id_id_period (2026-11-26).
--
-- pg-test: tests/pg/document-backfill-candidates.pg.test.ts
--
-- 20261126000300 looked the voucher up in a subquery per document, by
-- (company_id, id), for idx_journal_entries_company_id_id_period (20261126000200)
-- to answer from the index. On production the planner kept the primary key.
-- A subquery is planned as one lookup on its own, and for one lookup it
-- prices an index-only scan at one table page whenever any of the table's
-- pages is not yet marked all-visible, the same as the primary key's visit to
-- the table; the tie went to the primary key. Planned as the inner side of a
-- join, the lookup is priced for every document the walk passes, the share of
-- pages marked all-visible counts, and production's plan reads the period
-- from the index (Index Only Scan, the primary-key fallback never executed).
--
-- The answer is unchanged. A LEFT JOIN on (company_id, id) finds at most one
-- voucher per document (id is the primary key) and keeps a document with none.
-- The period test is 20261126000300's: the joined voucher's period, or, when
-- the join found none (no voucher, or another company's), the voucher read by
-- primary key. The pg test runs the shipped bodies next to this one on the same
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
    -- The document's own company's voucher, from idx_journal_entries_company_id_id_period: at most one.
    LEFT JOIN public.journal_entries je ON je.company_id = w.company_id AND je.id = w.journal_entry_id
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
          je.fiscal_period_id,
          -- Nothing ties a document to its own company's voucher: another company's is read by primary key.
          (SELECT o.fiscal_period_id FROM public.journal_entries o WHERE o.id = w.journal_entry_id)
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
