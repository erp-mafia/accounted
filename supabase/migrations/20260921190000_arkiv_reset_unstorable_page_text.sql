-- Arkiv: documents whose page text could not be stored are unread again.
--
-- Before #2886 a PDF whose text layer carries NUL characters failed its read
-- with "pages_insert_failed: unsupported Unicode escape sequence" (Postgres
-- holds no NUL in text or jsonb), and the row was stamped with that failure.
-- The store now cleans the text on the way in, so the stamp comes off and the
-- read job is queued again. Only Arkiv's own bookkeeping is touched.

UPDATE public.document_attachments
SET pages_read_at = NULL,
    page_count = NULL,
    read_error = NULL
WHERE read_error LIKE 'pages_insert_failed: unsupported Unicode escape sequence%';

UPDATE public.document_jobs
SET status = 'queued',
    attempts = 0,
    run_after = now(),
    locked_at = NULL,
    locked_by = NULL,
    last_error = NULL
WHERE kind = 'read'
  AND status = 'failed'
  AND last_error LIKE 'pages_insert_failed: unsupported Unicode escape sequence%';
