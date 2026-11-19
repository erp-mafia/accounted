SELECT set_config('lock_timeout', '5s', true);

-- The read backfill leaves a document to the job queue while the queue has
-- it, and stops asking about a document that never gets an answer (2026-11-12).
-- The lock timeout above: document_attachments is written on every upload, and
-- the ALTER below must give way rather than queue every writer behind it.
--
-- pg-test: tests/pg/document-backfill-candidates.pg.test.ts
--
-- 1. The queue holds its documents.
--
-- An upload queues a read job (document_jobs, kind 'read') and the worker
-- cron runs it within the minute. The read backfill (documents/read/cron,
-- every five minutes) takes the newest unread documents, which are exactly
-- the ones just uploaded, and the worker ticks in the same minute. Neither
-- knew about the other, so both read the same document: every page went to
-- the model twice, the usage meter counted it twice, and both replaced the
-- document's pages (delete, then insert), where the loser's insert hit the
-- winner's rows and stamped a document that had just been read fine as
-- pages_insert_failed. The retry pass had the same overlap for a document
-- capped at one page whose second read is queued (read_error 'partial:budget').
--
-- Both candidate functions now leave out a document the queue is still going
-- to read: its read job is running, or it is queued or failed with attempts
-- left (claim_document_jobs takes both; a failed job waits out its backoff,
-- up to four hours after a provider outage, and the backfill reading the
-- document in between is the same double work). A job that has given up
-- (failed, no attempts left) or ended without a read holds nothing.
--
-- The hold ends after an hour of the queue not acting: a job due (run_after)
-- or locked more than an hour ago is a queue that is not draining, and the
-- backfill is then the only reader left. Without that bound a stopped worker
-- would keep every queued document unread for as long as it stays stopped.
-- The lookup is one probe of the UNIQUE (document_id, kind) index per row.
--
-- 2. A document that never gets an answer is given up on, and tried again
-- once a day.
--
-- A reading the model provider did not answer (a 5xx, a throttle, a call
-- ended by its time limit) is not stamped: the document is fine and is tried
-- again (stamping those left documents unread for good). Tried again
-- without end, though: a scan too long to read
-- inside one run was read from the start every five minutes, for as long as
-- it existed, and before the calls had a time limit each of those runs ended
-- in the 300 s kill. Nothing counted the tries.
--
-- document_attachments.read_failures counts them and read_retry_after says
-- when the next may start. note_document_read_unavailable() records one with
-- the waits the caller passes (30, 60, 120 and 240 minutes, the job queue's
-- outage backoff, then a day), and counts only once the last wait is over:
-- the upload screen retries a failed read every 1.5 s and the job worker
-- every few minutes, and a one-minute 503 burst must not add up to five. So
-- five take at least 7.5 hours by construction, and an outage is waited out,
-- not counted out. The count is of readings in a row: it starts again when
-- the document was stamped after the last one (a later pass got an answer),
-- and when the last wait ended more than a day ago (a new episode).
--
-- At the fifth the reader (lib/documents/read/store.ts) gives the document
-- up: read_error 'read_failed: gave up', reported once. pages_read_at stays
-- NULL, so the document is still unread: the backfill takes it again once its
-- wait (a day) is over, and a question or an agent asking for its text reads
-- it at once. A document a pass already stored pages for is never marked.
-- Both candidate functions leave a document out until its wait is over.
--
-- Everything else in the two functions is unchanged from 20260924194000 and
-- 20260924202000. The code works without this migration (it then counts
-- nothing and behaves as before).

ALTER TABLE public.document_attachments
  ADD COLUMN IF NOT EXISTS read_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS read_retry_after timestamptz;

COMMENT ON COLUMN public.document_attachments.read_failures IS
  'Arkiv: readings in a row that the model provider did not answer, counted once per wait (note_document_read_unavailable). The reader gives the document up at five.';
COMMENT ON COLUMN public.document_attachments.read_retry_after IS
  'Arkiv: the read backfill does not try the document again before this, and a failure before it is not counted (set with read_failures).';

CREATE OR REPLACE FUNCTION public.note_document_read_unavailable(
  p_document_id     uuid,
  p_backoff_minutes integer[]
)
RETURNS TABLE (failures integer, counted boolean)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH cur AS (
    SELECT a.id, a.read_failures, a.read_retry_after, a.pages_read_at,
           -- When the last unanswered reading was noted: the end of its wait, less that wait.
           a.read_retry_after - make_interval(mins => coalesce(
             p_backoff_minutes[least(greatest(a.read_failures, 1), cardinality(p_backoff_minutes))], 30)) AS last_noted_at
    FROM public.document_attachments a
    WHERE a.id = p_document_id
    FOR UPDATE
  ),
  next AS (
    SELECT cur.id,
           CASE
             WHEN cur.read_retry_after IS NULL THEN 1
             -- The last wait ended more than a day ago: a new episode.
             WHEN cur.read_retry_after < now() - interval '1 day' THEN 1
             -- Stamped after the last unanswered reading (a later pass got an answer): the row is broken, and this
             -- is the first failure of a new one, not the next of the old.
             WHEN cur.pages_read_at IS NOT NULL AND cur.pages_read_at > cur.last_noted_at THEN 1
             ELSE cur.read_failures + 1
           END AS n
    FROM cur
    -- Inside the wait of the last one it is not counted: however often the document is tried meanwhile (the upload
    -- screen every 1.5 s, the worker every few minutes), five take the whole schedule.
    WHERE cur.read_retry_after IS NULL OR cur.read_retry_after <= now()
  ),
  noted AS (
    UPDATE public.document_attachments d
       SET read_failures = next.n,
           -- The wait of this failure; past the end of the list, its last entry. Half an hour when none was passed.
           read_retry_after = now() + make_interval(mins => coalesce(
             p_backoff_minutes[least(next.n, cardinality(p_backoff_minutes))], 30))
      FROM next
     WHERE d.id = next.id
    RETURNING d.read_failures
  )
  SELECT noted.read_failures, true FROM noted
  UNION ALL
  -- Not counted: the count as it stands, its wait unchanged.
  SELECT cur.read_failures, false FROM cur WHERE NOT EXISTS (SELECT 1 FROM next)
$$;
REVOKE EXECUTE ON FUNCTION public.note_document_read_unavailable(uuid, integer[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_document_read_unavailable(uuid, integer[]) TO service_role;
COMMENT ON FUNCTION public.note_document_read_unavailable(uuid, integer[]) IS
  'Arkiv: records one reading of a document that the model provider did not answer, once its last wait is over, and returns how many there are in a row and whether this one counted. Service role only.';

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
    -- enforce_period_lock_documents would refuse the stamp.
    AND NOT EXISTS (
      SELECT 1
      FROM public.journal_entries je
      JOIN public.fiscal_periods fp ON fp.id = je.fiscal_period_id
      WHERE je.id = d.journal_entry_id
        AND (fp.is_closed OR fp.locked_at IS NOT NULL)
    )
    -- block_migration_reset_source_mutation would refuse the stamp.
    AND NOT EXISTS (
      SELECT 1 FROM public.company_migration_resets r WHERE r.source_company_id = d.company_id
    )
    -- The job queue is reading it, or still going to, and has acted within the hour.
    -- The classify backfill holds the same rule in lib/documents/jobs/hold.ts.
    AND NOT EXISTS (
      SELECT 1
      FROM public.document_jobs j
      WHERE j.document_id = d.id
        AND j.kind = 'read'
        AND (
          (j.status = 'running' AND j.locked_at > now() - interval '1 hour')
          OR (j.status IN ('queued', 'failed') AND j.attempts < j.max_attempts AND j.run_after > now() - interval '1 hour')
        )
    )
    -- Its last reading got no answer: not before the wait is over.
    AND (d.read_retry_after IS NULL OR d.read_retry_after <= now())
  ORDER BY d.created_at DESC
  LIMIT greatest(0, least(coalesce(p_limit, 0), 500))
$$;

REVOKE EXECUTE ON FUNCTION public.document_backfill_candidates(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_backfill_candidates(int) TO service_role;

CREATE OR REPLACE FUNCTION public.document_retry_candidates(p_reasons text[], p_limit int)
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
  WHERE d.read_error = ANY (p_reasons)
    -- enforce_period_lock_documents would refuse the stamp.
    AND NOT EXISTS (
      SELECT 1
      FROM public.journal_entries je
      JOIN public.fiscal_periods fp ON fp.id = je.fiscal_period_id
      WHERE je.id = d.journal_entry_id
        AND (fp.is_closed OR fp.locked_at IS NOT NULL)
    )
    -- block_migration_reset_source_mutation would refuse the stamp.
    AND NOT EXISTS (
      SELECT 1 FROM public.company_migration_resets r WHERE r.source_company_id = d.company_id
    )
    -- The job queue is reading it, or still going to, and has acted within the hour.
    AND NOT EXISTS (
      SELECT 1
      FROM public.document_jobs j
      WHERE j.document_id = d.id
        AND j.kind = 'read'
        AND (
          (j.status = 'running' AND j.locked_at > now() - interval '1 hour')
          OR (j.status IN ('queued', 'failed') AND j.attempts < j.max_attempts AND j.run_after > now() - interval '1 hour')
        )
    )
    -- Its last reading got no answer: not before the wait is over.
    AND (d.read_retry_after IS NULL OR d.read_retry_after <= now())
  ORDER BY d.pages_read_at ASC
  LIMIT greatest(0, least(coalesce(p_limit, 0), 500))
$$;

REVOKE EXECUTE ON FUNCTION public.document_retry_candidates(text[], int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_retry_candidates(text[], int) TO service_role;

NOTIFY pgrst, 'reload schema';
