-- The Dokument tree's folder functions find a document's verifikat date by key
-- (2026-10-27).
--
-- 20260928090000 dated a booked document by its verifikat through
--   LEFT JOIN journal_entries je ON je.id = COALESCE(d.journal_entry_id,
--     (SELECT l.journal_entry_id FROM journal_entry_lines l WHERE l.id = d.journal_entry_line_id))
-- These SQL functions run on a generic plan, and with the key behind COALESCE
-- and a subquery the planner cannot probe journal_entries_pkey: it hash-joins
-- after a sequential scan of journal_entries, every company's rows, each one
-- filtered through RLS. On prod (2026-10-26, 2.27 million entries) one call
-- for a 3 800-document archive read about 650 MB and ran 13 s, past the 8 s
-- statement timeout, so /api/arkiv/documents and /folders answered 500:
-- 10 727 times from 2026-09-29, none before.
--
-- The date is now looked up per document by primary key: the verifikat the
-- document names, else the verifikat of the line it names. The answer is the
-- same; the cost follows the company's own archive instead of the whole
-- ledger. Signatures and return types are unchanged.

CREATE OR REPLACE FUNCTION public.arkiv_document_type_counts(p_company_id uuid, p_year int DEFAULT NULL)
RETURNS TABLE (doc_type text, booked boolean, n bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT t.doc_type, t.booked, count(*)
  FROM (
    SELECT public.arkiv_effective_doc_type(d.doc_type, d.id, d.journal_entry_id IS NOT NULL OR d.journal_entry_line_id IS NOT NULL) AS doc_type,
           (d.journal_entry_id IS NOT NULL OR d.journal_entry_line_id IS NOT NULL) AS booked,
           d.extracted_data,
           d.created_at,
           CASE
             WHEN d.journal_entry_id IS NOT NULL THEN
               (SELECT je.entry_date FROM public.journal_entries je WHERE je.id = d.journal_entry_id)
             WHEN d.journal_entry_line_id IS NOT NULL THEN
               (SELECT je.entry_date FROM public.journal_entry_lines l JOIN public.journal_entries je ON je.id = l.journal_entry_id WHERE l.id = d.journal_entry_line_id)
           END AS entry_date
    FROM public.document_attachments d
    WHERE d.company_id = p_company_id
      AND d.admission_state IN ('admitted', 'held')
      AND (d.mime_type IS NULL OR d.mime_type NOT IN ('application/xml', 'text/xml', 'application/json'))
  ) t
  WHERE p_year IS NULL OR left(public.arkiv_document_day(t.doc_type, t.extracted_data, t.created_at, t.entry_date), 4) = p_year::text
  GROUP BY t.doc_type, t.booked
$$;

CREATE OR REPLACE FUNCTION public.arkiv_document_page(
  p_company_id uuid,
  p_mode text,
  p_types text[],
  p_year int DEFAULT NULL,
  p_offset int DEFAULT 0,
  p_limit int DEFAULT 25
)
RETURNS TABLE (id uuid, doc_day text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT t.id, public.arkiv_document_day(t.doc_type, t.extracted_data, t.created_at, t.entry_date) AS doc_day
  FROM (
    SELECT d.id,
           d.created_at,
           d.extracted_data,
           CASE
             WHEN d.journal_entry_id IS NOT NULL THEN
               (SELECT je.entry_date FROM public.journal_entries je WHERE je.id = d.journal_entry_id)
             WHEN d.journal_entry_line_id IS NOT NULL THEN
               (SELECT je.entry_date FROM public.journal_entry_lines l JOIN public.journal_entries je ON je.id = l.journal_entry_id WHERE l.id = d.journal_entry_line_id)
           END AS entry_date,
           public.arkiv_effective_doc_type(d.doc_type, d.id, d.journal_entry_id IS NOT NULL OR d.journal_entry_line_id IS NOT NULL) AS doc_type,
           (d.journal_entry_id IS NOT NULL OR d.journal_entry_line_id IS NOT NULL) AS booked
    FROM public.document_attachments d
    WHERE d.company_id = p_company_id
      AND d.admission_state IN ('admitted', 'held')
      AND (d.mime_type IS NULL OR d.mime_type NOT IN ('application/xml', 'text/xml', 'application/json'))
  ) t
  WHERE CASE p_mode
      WHEN 'in' THEN t.doc_type = ANY (p_types)
      WHEN 'not_in' THEN t.doc_type IS NOT NULL AND NOT (t.doc_type = ANY (coalesce(p_types, '{}')))
      WHEN 'untyped' THEN t.doc_type IS NULL AND NOT t.booked
      WHEN 'booked' THEN t.doc_type IS NULL AND t.booked
      ELSE false
    END
    AND (p_year IS NULL OR left(public.arkiv_document_day(t.doc_type, t.extracted_data, t.created_at, t.entry_date), 4) = p_year::text)
  ORDER BY doc_day DESC, t.created_at DESC, t.id
  OFFSET greatest(0, coalesce(p_offset, 0))
  LIMIT least(greatest(1, coalesce(p_limit, 25)), 200)
$$;

NOTIFY pgrst, 'reload schema';
