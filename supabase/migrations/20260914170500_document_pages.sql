-- Arkiv phase 1 (dev_docs/arkiv_plan.md): page text for every document.
--
-- One row per page of readable text, produced locally when the file has a
-- text layer (pdf-inspector for PDFs, AnyDoc for Office files) and by the
-- model for scans and photos. Derived data: the original in
-- document_attachments is never touched (BFL 7 kap 1 §: received documents
-- are kept in the format and with the content they had on arrival). Rows are
-- written by the service role only; company members read them through RLS.

CREATE TABLE public.document_pages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  page_no integer NOT NULL CHECK (page_no >= 1),
  text text NOT NULL,
  -- Word boxes in PDF points with a top-left origin, present only when the
  -- page was read locally: [{t, x0, y0, x1, y1}]. Photos and scans read by
  -- the model carry no boxes, so their citations stay at page level.
  words jsonb,
  page_width real,
  page_height real,
  reader text NOT NULL CHECK (reader IN ('pdf_text', 'office', 'claude_vision', 'text', 'html')),
  has_text_layer boolean NOT NULL DEFAULT false,
  -- Swedish full-text index. Pages are capped well under the tsvector limit.
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('swedish', left(coalesce(text, ''), 200000))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, page_no)
);

CREATE INDEX idx_document_pages_company_document ON public.document_pages (company_id, document_id);
CREATE INDEX idx_document_pages_document ON public.document_pages (document_id);
CREATE INDEX idx_document_pages_tsv ON public.document_pages USING gin (tsv);

ALTER TABLE public.document_pages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company document pages"
  ON public.document_pages FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- No INSERT/UPDATE/DELETE policies: only the service role writes pages.

-- Reading state on the document itself. pages_read_at is stamped on every
-- outcome (pages written, nothing readable, or a recorded error) so the
-- backfill never polls a row twice; read_error holds the reason when no pages
-- could be produced.
ALTER TABLE public.document_attachments
  ADD COLUMN pages_read_at timestamptz,
  ADD COLUMN page_count integer,
  ADD COLUMN read_error text;

CREATE INDEX idx_document_attachments_pages_unread
  ON public.document_attachments (created_at DESC)
  WHERE pages_read_at IS NULL;

-- Search across a company's page text. SECURITY INVOKER: RLS applies for
-- signed-in users; service-role callers (MCP) pass the company explicitly and
-- the filter is enforced here as well (defense in depth).
CREATE OR REPLACE FUNCTION public.search_document_pages(
  p_company_id uuid,
  p_query text,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  document_id uuid,
  page_no integer,
  file_name text,
  rank real,
  headline text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH q AS (SELECT websearch_to_tsquery('swedish', p_query) AS tsq)
  SELECT
    p.document_id,
    p.page_no,
    d.file_name,
    ts_rank_cd(p.tsv, q.tsq) AS rank,
    ts_headline('swedish', p.text, q.tsq, 'MaxWords=24, MinWords=12, MaxFragments=1') AS headline
  FROM public.document_pages p
  JOIN public.document_attachments d ON d.id = p.document_id
  CROSS JOIN q
  WHERE p.company_id = p_company_id
    AND p.tsv @@ q.tsq
  ORDER BY rank DESC, p.document_id, p.page_no
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
$$;

GRANT EXECUTE ON FUNCTION public.search_document_pages(uuid, text, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
