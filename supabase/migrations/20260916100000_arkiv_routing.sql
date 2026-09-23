-- Arkiv phase 7 (dev_docs/arkiv_plan.md): one pipe. Every door already lands
-- a document in Arkiv; from now the Underlag queue is decided by what the
-- document turned out to be, not by which door it came through. A receipt or
-- invoice that arrived any other way is queued once Arkiv has read it; an
-- agreement or decision that arrived through the inbox leaves the queue for
-- its own page in Arkiv, and the inbox says so.

-- ---------------------------------------------------------------------------
-- Underlag items that turned out to be something else
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoice_inbox_items
  ADD COLUMN routed_to_arkiv_at timestamptz,
  ADD COLUMN routed_doc_type text;
COMMENT ON COLUMN public.invoice_inbox_items.routed_to_arkiv_at IS 'Set when Arkiv classified the document as something that is not booked from the queue (an agreement, a registration, a decision, minutes). The row leaves the queue and the inbox shows where it went. Cleared if a person retypes it as a receipt or invoice.';
COMMENT ON COLUMN public.invoice_inbox_items.routed_doc_type IS 'The Arkiv document type the item was routed as.';
CREATE INDEX idx_invoice_inbox_items_routed
  ON public.invoice_inbox_items (company_id, routed_to_arkiv_at DESC)
  WHERE routed_to_arkiv_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Run one document's next step now, for the person watching the upload
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_document_job_for(
  p_document_id uuid,
  p_worker      text,
  p_now         timestamptz DEFAULT now()
)
RETURNS TABLE (
  id          uuid,
  company_id  uuid,
  document_id uuid,
  kind        text,
  attempts    int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT j.id
    FROM public.document_jobs j
    WHERE j.document_id = p_document_id
      AND j.attempts < j.max_attempts
      AND (
        j.status = 'queued'
        -- a step that failed is retried at once for the person waiting, backoff or not
        OR j.status = 'failed'
        OR (j.status = 'running' AND j.locked_at < p_now - interval '10 minutes')
      )
    ORDER BY j.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.document_jobs j
  SET status = 'running', locked_at = p_now, locked_by = p_worker, attempts = j.attempts + 1
  FROM due
  WHERE j.id = due.id
  RETURNING j.id, j.company_id, j.document_id, j.kind, j.attempts;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_document_job_for(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_job_for(uuid, text, timestamptz) TO service_role;
COMMENT ON FUNCTION public.claim_document_job_for(uuid, text, timestamptz) IS
  'Arkiv: claims the one due job of a single document so the upload can be advanced while a person watches. Service role only.';
