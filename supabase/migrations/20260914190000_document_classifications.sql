-- Arkiv phase 2 (dev_docs/arkiv_plan.md): what each document is, and whether
-- it belongs to the company at all.
--
-- document_classifications keeps every classification ever made for a
-- document (model or person), one current per document. The document itself
-- carries the current type and an admission state: a file that nothing ties
-- to the company is held, not admitted, until a person answers; admission is
-- the moment retention duties begin. Rows are written by the service role;
-- members read through RLS.

CREATE TABLE public.document_classifications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  doc_type text NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  language text,
  is_multi_document boolean NOT NULL DEFAULT false,
  relevance text NOT NULL CHECK (relevance IN ('relevant', 'ask', 'irrelevant')),
  relevance_reason text,
  addressed_to text,
  summary text,
  suggested_type text,
  model text,
  prompt_sha256 text,
  decided_by text NOT NULL CHECK (decided_by IN ('model', 'human')),
  decided_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_document_classifications_current
  ON public.document_classifications (document_id)
  WHERE is_current;
CREATE INDEX idx_document_classifications_company_type
  ON public.document_classifications (company_id, doc_type)
  WHERE is_current;

ALTER TABLE public.document_classifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company document classifications"
  ON public.document_classifications FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- No INSERT/UPDATE/DELETE policies: only the service role writes.

-- Current type and admission on the document itself. Everything already in
-- the archive was accepted by a person when it was uploaded: admitted.
ALTER TABLE public.document_attachments
  ADD COLUMN doc_type text,
  ADD COLUMN admission_state text NOT NULL DEFAULT 'admitted'
    CHECK (admission_state IN ('held', 'admitted')),
  ADD COLUMN admitted_at timestamptz,
  ADD COLUMN admission_reason text;

CREATE INDEX idx_document_attachments_held
  ON public.document_attachments (company_id, created_at DESC)
  WHERE admission_state = 'held';
CREATE INDEX idx_document_attachments_unclassified
  ON public.document_attachments (company_id, created_at DESC)
  WHERE doc_type IS NULL AND pages_read_at IS NOT NULL;

NOTIFY pgrst, 'reload schema';
