-- The Dokument tree counts and pages its folders over the whole archive (2026-09-26).
--
-- The tree loaded the newest 500 documents and sorted them into folders in the
-- browser, so a company with more had wrong folder counts and older documents
-- nowhere (prod 2026-09-25: 21 companies over 500, 35 369 documents out of
-- sight, 220 of them agreements, authority letters and corporate records).
-- These two functions count by type and hand out one page of a folder, with
-- the same filters and the same date the list shows. SECURITY INVOKER: RLS on
-- document_attachments keeps a member to their own companies.

-- The date a document row is sorted and filtered by: the date the inbox read
-- off a receipt or invoice, the upload day otherwise (documentDate in
-- src/lib/arkiv/documents/title.ts, outside the company brain). Text, so a
-- malformed date never fails a cast.
CREATE OR REPLACE FUNCTION public.arkiv_document_day(p_doc_type text, p_extracted jsonb, p_created_at timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_doc_type IN ('receipt', 'supplier_invoice', 'customer_invoice')
      AND (p_extracted -> 'invoice' ->> 'invoiceDate') ~ '^\d{4}-\d{2}-\d{2}'
      THEN left(p_extracted -> 'invoice' ->> 'invoiceDate', 10)
    ELSE to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
  END
$$;

-- How many documents of each type, over the whole archive or one year.
CREATE OR REPLACE FUNCTION public.arkiv_document_type_counts(p_company_id uuid, p_year int DEFAULT NULL)
RETURNS TABLE (doc_type text, n bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT d.doc_type, count(*)
  FROM public.document_attachments d
  WHERE d.company_id = p_company_id
    AND d.admission_state IN ('admitted', 'held')
    AND (d.mime_type IS NULL OR d.mime_type NOT IN ('application/xml', 'text/xml', 'application/json'))
    AND (p_year IS NULL OR left(public.arkiv_document_day(d.doc_type, d.extracted_data, d.created_at), 4) = p_year::text)
  GROUP BY d.doc_type
$$;

-- One page of a folder, newest document date first. p_mode picks the rows:
-- 'in' the given types, 'not_in' every typed document whose type is not
-- among them (the Övrigt folder, which also holds any type no folder names),
-- 'untyped' the documents with no type yet.
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
  SELECT d.id, public.arkiv_document_day(d.doc_type, d.extracted_data, d.created_at) AS doc_day
  FROM public.document_attachments d
  WHERE d.company_id = p_company_id
    AND d.admission_state IN ('admitted', 'held')
    AND (d.mime_type IS NULL OR d.mime_type NOT IN ('application/xml', 'text/xml', 'application/json'))
    AND CASE p_mode
      WHEN 'in' THEN d.doc_type = ANY (p_types)
      WHEN 'not_in' THEN d.doc_type IS NOT NULL AND NOT (d.doc_type = ANY (coalesce(p_types, '{}')))
      WHEN 'untyped' THEN d.doc_type IS NULL
      ELSE false
    END
    AND (p_year IS NULL OR left(public.arkiv_document_day(d.doc_type, d.extracted_data, d.created_at), 4) = p_year::text)
  ORDER BY doc_day DESC, d.created_at DESC, d.id
  OFFSET greatest(0, coalesce(p_offset, 0))
  LIMIT least(greatest(1, coalesce(p_limit, 25)), 200)
$$;

REVOKE EXECUTE ON FUNCTION public.arkiv_document_type_counts(uuid, int) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.arkiv_document_page(uuid, text, text[], int, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.arkiv_document_type_counts(uuid, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arkiv_document_page(uuid, text, text[], int, int, int) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
