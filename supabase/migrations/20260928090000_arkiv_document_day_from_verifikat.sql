-- A booked document is dated by its verifikat (2026-09-28).
--
-- A customer who uploaded the underlag for earlier years saw all of it under
-- 2026 in Dokument: the folder functions dated a document by the date the
-- inbox read off it, else by the upload day. A booked document has a better
-- date than either: the accounting date of the verifikat it supports. That
-- now comes second, before the upload day. The inbox date still wins for a
-- receipt or invoice that has one (the document's own date), and a loose
-- document keeps the upload day.
--
-- arkiv_document_day gains the entry date as a fourth argument; the two
-- folder functions join the verifikat (by journal_entry_id, else through the
-- linked line) and pass it. The three-argument function is dropped at the
-- end, after nothing refers to it.

CREATE OR REPLACE FUNCTION public.arkiv_document_day(p_doc_type text, p_extracted jsonb, p_created_at timestamptz, p_entry_date date)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_doc_type IN ('receipt', 'supplier_invoice', 'customer_invoice')
      AND (p_extracted -> 'invoice' ->> 'invoiceDate') ~ '^\d{4}-\d{2}-\d{2}'
      THEN left(p_extracted -> 'invoice' ->> 'invoiceDate', 10)
    WHEN p_entry_date IS NOT NULL THEN to_char(p_entry_date, 'YYYY-MM-DD')
    ELSE to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
  END
$$;

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
           je.entry_date
    FROM public.document_attachments d
    LEFT JOIN public.journal_entries je
      ON je.id = COALESCE(d.journal_entry_id, (SELECT l.journal_entry_id FROM public.journal_entry_lines l WHERE l.id = d.journal_entry_line_id))
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
           je.entry_date,
           public.arkiv_effective_doc_type(d.doc_type, d.id, d.journal_entry_id IS NOT NULL OR d.journal_entry_line_id IS NOT NULL) AS doc_type,
           (d.journal_entry_id IS NOT NULL OR d.journal_entry_line_id IS NOT NULL) AS booked
    FROM public.document_attachments d
    LEFT JOIN public.journal_entries je
      ON je.id = COALESCE(d.journal_entry_id, (SELECT l.journal_entry_id FROM public.journal_entry_lines l WHERE l.id = d.journal_entry_line_id))
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

DROP FUNCTION IF EXISTS public.arkiv_document_day(text, jsonb, timestamptz);

NOTIFY pgrst, 'reload schema';
