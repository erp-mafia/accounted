-- Migration: document_attachments AI-extraction columns
--
-- Adds columns the document-extraction extension (paid AI tier) writes to
-- when it runs Sonnet on a freshly uploaded receipt or invoice. The agent
-- composer + chat intents read these to surface "what we already know"
-- without re-asking the user.
--
-- All three columns are nullable so:
--   * The free tier (no extraction extension) leaves them as-is — uploads
--     still work, agent UI degrades gracefully.
--   * Older documents predating this migration stay readable; a backfill
--     job can populate retroactively later.
--   * Failed extractions can be distinguished from never-attempted by
--     looking at extracted_at (set on attempt) vs extracted_data (null on
--     failure).

ALTER TABLE public.document_attachments
  ADD COLUMN extracted_data    jsonb,
  ADD COLUMN extracted_at      timestamptz,
  ADD COLUMN extraction_model  text;

-- Partial index for the "needs extraction" backfill / retry job: rows
-- that have never been attempted. Sparse — most production rows will
-- have extracted_at set after the handler runs.
CREATE INDEX idx_document_attachments_pending_extraction
  ON public.document_attachments (company_id, created_at)
  WHERE extracted_at IS NULL;

NOTIFY pgrst, 'reload schema';
