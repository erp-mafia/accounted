-- Arkiv phase 4 (dev_docs/arkiv_plan.md): records attach to what already
-- exists, and agreements become expected money and dates.
--
-- document_links ties a document to a party, an agreement or an asset, each
-- link with a basis (proven by a hard key, or guessed from a name) and the
-- method that made it. The legal link journal_entry_id on document_attachments
-- is untouched. agreements is the first-class entity the founder decided on;
-- agreement_obligations is what the agreement says will fall due, observed
-- against bank transactions but never booked from. Deadlines derived from an
-- agreement carry their source document and an idempotency key.

-- ---------------------------------------------------------------------------
-- Agreements
-- ---------------------------------------------------------------------------
CREATE TABLE public.agreements (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('rental', 'lease', 'loan', 'subscription')),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  counterparty_party_id uuid,
  -- as printed in the document, kept even when no party could be resolved
  counterparty_name text,
  starts_on date,
  ends_on date,
  notice_months integer CHECK (notice_months IS NULL OR notice_months >= 0),
  renewal_terms text,
  -- the recurring amount and its period; a loan carries principal and rate instead
  amount numeric(15, 2) CHECK (amount IS NULL OR amount >= 0),
  currency text NOT NULL DEFAULT 'SEK',
  period text CHECK (period IS NULL OR period IN ('monthly', 'quarterly', 'yearly', 'one_time')),
  principal numeric(15, 2) CHECK (principal IS NULL OR principal >= 0),
  interest_rate numeric(6, 3),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  -- one agreement per document; a re-derivation updates the row
  source_document_id uuid NOT NULL UNIQUE REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  source_extraction_id uuid REFERENCES public.document_extractions(id) ON DELETE SET NULL,
  -- field name -> { page, quote } for every value the row was derived from
  sources jsonb NOT NULL DEFAULT '{}'::jsonb,
  derived_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (counterparty_party_id, company_id)
    REFERENCES public.parties(id, company_id) ON DELETE SET NULL (counterparty_party_id)
);
CREATE INDEX idx_agreements_company ON public.agreements (company_id, status, ends_on);
CREATE INDEX idx_agreements_counterparty ON public.agreements (counterparty_party_id) WHERE counterparty_party_id IS NOT NULL;
CREATE TRIGGER agreements_updated_at BEFORE UPDATE ON public.agreements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.agreements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company agreements"
  ON public.agreements FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- Writes: service role only.

-- What the agreement says will fall due. Observed against bank transactions
-- (matched, missed) and never booked from: the ledger stays the arbiter.
CREATE TABLE public.agreement_obligations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  agreement_id uuid NOT NULL REFERENCES public.agreements(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('payment', 'deposit', 'first_payment', 'residual', 'amortisation', 'interest')),
  due_on date NOT NULL,
  amount numeric(15, 2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'SEK',
  -- computed from principal and rate rather than printed: never matched on amount alone
  amount_is_estimate boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'matched', 'missed', 'waived')),
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  matched_basis text CHECK (matched_basis IS NULL OR matched_basis IN ('proven', 'guessed')),
  matched_at timestamptz,
  -- the extracted fields the row was derived from
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, kind, due_on),
  CHECK ((status = 'matched') = (transaction_id IS NOT NULL))
);
CREATE INDEX idx_agreement_obligations_due ON public.agreement_obligations (company_id, status, due_on);
CREATE INDEX idx_agreement_obligations_transaction ON public.agreement_obligations (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE TRIGGER agreement_obligations_updated_at BEFORE UPDATE ON public.agreement_obligations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.agreement_obligations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company agreement obligations"
  ON public.agreement_obligations FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- ---------------------------------------------------------------------------
-- Links from documents to existing objects
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_links (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('party', 'agreement', 'asset')),
  party_id uuid,
  agreement_id uuid REFERENCES public.agreements(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES public.assets(id) ON DELETE CASCADE,
  target_id uuid GENERATED ALWAYS AS (COALESCE(party_id, agreement_id, asset_id)) STORED,
  -- proven: a hard key (organisation number, a person's choice, derivation); guessed: a name
  basis text NOT NULL CHECK (basis IN ('proven', 'guessed')),
  -- org_number | name | derived | person
  method text NOT NULL,
  confidence numeric(4, 3) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  -- { field, page, quote } or whatever the method saw
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  activity_id uuid REFERENCES public.activities(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_reason text,
  FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE CASCADE,
  CHECK (
    (target_kind = 'party' AND party_id IS NOT NULL AND agreement_id IS NULL AND asset_id IS NULL)
    OR (target_kind = 'agreement' AND agreement_id IS NOT NULL AND party_id IS NULL AND asset_id IS NULL)
    OR (target_kind = 'asset' AND asset_id IS NOT NULL AND party_id IS NULL AND agreement_id IS NULL)
  )
);
CREATE UNIQUE INDEX idx_document_links_live ON public.document_links (document_id, target_kind, target_id) WHERE retired_at IS NULL;
CREATE INDEX idx_document_links_target ON public.document_links (target_kind, target_id) WHERE retired_at IS NULL;
ALTER TABLE public.document_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company document links"
  ON public.document_links FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- ---------------------------------------------------------------------------
-- Deadlines derived from a document carry their source and a key
-- ---------------------------------------------------------------------------
ALTER TABLE public.deadlines
  ADD COLUMN source_document_id uuid REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  -- agreement:<id>:<notice|end|maturity|amortisation_start>; one live row per key
  ADD COLUMN source_key text;
CREATE UNIQUE INDEX idx_deadlines_source_key ON public.deadlines (company_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX idx_deadlines_source_document ON public.deadlines (source_document_id) WHERE source_document_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The pipeline gains a derive step
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_jobs DROP CONSTRAINT document_jobs_kind_check;
ALTER TABLE public.document_jobs ADD CONSTRAINT document_jobs_kind_check CHECK (kind IN ('read', 'classify', 'extract', 'derive'));
ALTER TABLE public.activities DROP CONSTRAINT activities_kind_check;
ALTER TABLE public.activities ADD CONSTRAINT activities_kind_check CHECK (kind IN ('extract', 'review', 'derive'));

NOTIFY pgrst, 'reload schema';
