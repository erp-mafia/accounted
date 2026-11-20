-- Dokument for every company (2026-09-26): a booked document with no type is a
-- verifikat's underlag, not a question, and a document tied to a closed or
-- locked period keeps its type on the classification.
--
-- Prod 2026-09-26: 60 859 of 75 071 documents had no type, 50 660 of them
-- booked. A booked document is never classified in the background (the
-- verifikat says what it is, and reading it would only cost), so 443 of the
-- 512 companies with 20 or more documents would have opened Dokument to a
-- single folder, "Utan typ", promising a typing that never comes. The folder
-- functions now tell a booked document with no type apart from a loose one
-- that awaits its type.
--
-- enforce_period_lock_documents (20240101000017, never changed) refuses every
-- update of a document whose entry sits in a closed or locked period, so a
-- type set on such a document (5 736 of them in 64 companies) never landed on
-- the row: 105 documents carried it on the current classification only. The
-- folder functions read the type from there when the row has none, the way
-- document_integrity_checks (20260901130000) keeps the integrity stamp beside
-- the row for the same reason. lib/documents/locked-period.ts does the same
-- for the rows the routes read.

-- The type a reader shows: the row's own, else, for a booked document, the
-- current classification's. A loose document with no type has none yet.
CREATE OR REPLACE FUNCTION public.arkiv_effective_doc_type(p_doc_type text, p_document_id uuid, p_booked boolean)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_doc_type IS NOT NULL THEN p_doc_type
    WHEN p_booked THEN (SELECT c.doc_type FROM public.document_classifications c WHERE c.document_id = p_document_id AND c.is_current)
    ELSE NULL
  END
$$;

-- The count now says whether the documents are booked, so the function is
-- dropped and made again (a return type cannot be replaced in place).
DROP FUNCTION IF EXISTS public.arkiv_document_type_counts(uuid, int);
CREATE FUNCTION public.arkiv_document_type_counts(p_company_id uuid, p_year int DEFAULT NULL)
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
           d.created_at
    FROM public.document_attachments d
    WHERE d.company_id = p_company_id
      AND d.admission_state IN ('admitted', 'held')
      AND (d.mime_type IS NULL OR d.mime_type NOT IN ('application/xml', 'text/xml', 'application/json'))
  ) t
  WHERE p_year IS NULL OR left(public.arkiv_document_day(t.doc_type, t.extracted_data, t.created_at), 4) = p_year::text
  GROUP BY t.doc_type, t.booked
$$;

-- One page of a folder, newest document date first. p_mode picks the rows:
-- 'in' the given types, 'not_in' every typed document whose type is not
-- among them (the Övrigt folder, which also holds any type no folder names),
-- 'untyped' a loose document with no type yet, 'booked' a booked document
-- with no type (a verifikat's underlag).
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
  SELECT t.id, public.arkiv_document_day(t.doc_type, t.extracted_data, t.created_at) AS doc_day
  FROM (
    SELECT d.id,
           d.created_at,
           d.extracted_data,
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
    AND (p_year IS NULL OR left(public.arkiv_document_day(t.doc_type, t.extracted_data, t.created_at), 4) = p_year::text)
  ORDER BY doc_day DESC, t.created_at DESC, t.id
  OFFSET greatest(0, coalesce(p_offset, 0))
  LIMIT least(greatest(1, coalesce(p_limit, 25)), 200)
$$;

NOTIFY pgrst, 'reload schema';
