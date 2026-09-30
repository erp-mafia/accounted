-- The read backfill picks only documents it can finish (2026-09-24).
--
-- The backfill stamps pages_read_at on every document it reads. Two triggers
-- on document_attachments refuse that update for some rows, by design:
-- enforce_period_lock_documents for a document on an entry in a closed or
-- locked period, and block_migration_reset_source_mutation for the archived
-- source of a migration reset. Such a row kept pages_read_at null, stayed the
-- newest unread, and was read again every five minutes (prod: the 40 newest
-- were all on locked periods, backlog reads down to a handful a day). This
-- function leaves those rows out, mirroring the two triggers' conditions, so
-- the queue always advances. They are read when someone opens them. The
-- triggers themselves are unchanged.

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
  ORDER BY d.created_at DESC
  LIMIT greatest(0, least(coalesce(p_limit, 0), 500))
$$;

REVOKE EXECUTE ON FUNCTION public.document_backfill_candidates(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.document_backfill_candidates(int) TO service_role;

NOTIFY pgrst, 'reload schema';
