-- Arkiv phase 6 (dev_docs/arkiv_plan.md): the archive reads every document
-- type, checks itself nightly, and earns autonomy per document type.
--
-- agreements.kind grows to the whole agreement taxonomy. agreement_obligations
-- learns the direction of the money (a customer's fee arrives; rent leaves).
-- document_classifications carries authenticity signals and a content hash
-- so the same document uploaded twice is seen. arkiv_findings is what the
-- nightly lint files for a person: a setting that contradicts a decision, an
-- agreement ending with an unknown notice period, a duplicate, a document
-- that could not be read. arkiv_autonomy is the earned level per document
-- type that sets how often a settled record is still audited by a person.

-- ---------------------------------------------------------------------------
-- Agreements: every kind in the taxonomy; obligations with a direction
-- ---------------------------------------------------------------------------
ALTER TABLE public.agreements DROP CONSTRAINT agreements_kind_check;
ALTER TABLE public.agreements
  ADD CONSTRAINT agreements_kind_check
  CHECK (kind IN ('rental', 'lease', 'loan', 'subscription', 'insurance', 'employment', 'shareholder', 'investment', 'customer', 'other'));

ALTER TABLE public.agreement_obligations
  ADD COLUMN direction text NOT NULL DEFAULT 'out' CHECK (direction IN ('out', 'in'));
COMMENT ON COLUMN public.agreement_obligations.direction IS 'out: the company pays (rent, premium, instalment). in: money arrives (a customer fee, an investment).';

-- ---------------------------------------------------------------------------
-- Classification: authenticity signals and a content hash
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_classifications
  ADD COLUMN signals text[] NOT NULL DEFAULT '{}',
  ADD COLUMN content_sha256 text;
COMMENT ON COLUMN public.document_classifications.signals IS 'What a person should know before trusting the file: no_text_layer, duplicate_content, multi_document. Signals, not verdicts.';
COMMENT ON COLUMN public.document_classifications.content_sha256 IS 'sha256 of the folded page text; equal for the same document read twice.';
CREATE INDEX idx_document_classifications_content
  ON public.document_classifications (company_id, content_sha256)
  WHERE is_current AND content_sha256 IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Findings of the nightly lint
-- ---------------------------------------------------------------------------
CREATE TABLE public.arkiv_findings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('settings_mismatch', 'agreement_ending', 'agreement_no_counterparty', 'duplicate_document', 'document_stuck')),
  -- Stable per company, so a rerun refreshes the finding instead of repeating it.
  key text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning')),
  subject_kind text NOT NULL CHECK (subject_kind IN ('company', 'agreement', 'document')),
  subject_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  -- applied: a person acted on it. dismissed: a person closed it. gone: the lint no longer sees it.
  resolution text CHECK (resolution IN ('applied', 'dismissed', 'gone')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (company_id, key)
);
CREATE INDEX idx_arkiv_findings_open ON public.arkiv_findings (company_id, first_seen_at DESC) WHERE status = 'open';

ALTER TABLE public.arkiv_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company arkiv findings"
  ON public.arkiv_findings FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- A member closes a finding; the guard below keeps everything else the lint's.
CREATE POLICY "close own-company arkiv findings"
  ON public.arkiv_findings FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE OR REPLACE FUNCTION public.arkiv_findings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- PostgREST and the tests run a member as the authenticated role; the service role and migrations are not members.
  IF current_user IN ('authenticated', 'anon') THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.key IS DISTINCT FROM OLD.key
       OR NEW.severity IS DISTINCT FROM OLD.severity
       OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
       OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
       OR NEW.detail IS DISTINCT FROM OLD.detail
       OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
       OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at THEN
      RAISE EXCEPTION 'arkiv_findings: a member may only close a finding' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status <> 'open' THEN
      RAISE EXCEPTION 'arkiv_findings: the finding is already closed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'open' OR NEW.resolution IS NULL OR NEW.resolution NOT IN ('applied', 'dismissed') THEN
      RAISE EXCEPTION 'arkiv_findings: closing needs a resolution of applied or dismissed' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER arkiv_findings_guard
  BEFORE UPDATE ON public.arkiv_findings
  FOR EACH ROW EXECUTE FUNCTION public.arkiv_findings_guard();

-- ---------------------------------------------------------------------------
-- Autonomy: the earned level per document type
-- ---------------------------------------------------------------------------
CREATE TABLE public.arkiv_autonomy (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  schema_type text NOT NULL,
  -- 0: one settled record in 20 goes to a person; 1: in 40; 2: in 80; 3: in 160.
  level smallint NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 3),
  audited integer NOT NULL DEFAULT 0 CHECK (audited >= 0),
  changed integer NOT NULL DEFAULT 0,
  CONSTRAINT arkiv_autonomy_changed_check CHECK (changed >= 0 AND changed <= audited),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, schema_type)
);
ALTER TABLE public.arkiv_autonomy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company arkiv autonomy"
  ON public.arkiv_autonomy FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- Writes: service role only.
