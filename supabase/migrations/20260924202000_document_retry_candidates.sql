-- The read backfill's retry pass picks only documents it can finish (2026-09-24).
--
-- Same cause as document_backfill_candidates (20260924194000), in the pass
-- that runs first: a gated document on an entry in a closed or locked period
-- was read again with the model on every run, its stamp refused by
-- enforce_period_lock_documents, so it kept the oldest pages_read_at and led
-- the next batch. Nineteen such rows took the whole time budget every five
-- minutes (prod: vision pages 616 on 09-23, 4 383 on 09-24; 265 rows in two
-- companies), and the unread pass never ran. This function leaves out the
-- rows either trigger would refuse. The triggers are unchanged.

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
  ORDER BY d.pages_read_at ASC
  LIMIT greatest(0, least(coalesce(p_limit, 0), 500))
$$;

REVOKE EXECUTE ON FUNCTION public.document_retry_candidates(text[], int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_retry_candidates(text[], int) TO service_role;

NOTIFY pgrst, 'reload schema';
