-- Migration: counterparty_profiles
--
-- What Accounted believes about a counterparty, written once by a model at
-- first sight from the best evidence available (the invoice text first, the
-- bank text as fallback) and cached per company and counterparty key.
--
-- A sidecar by design (DECISIONS.md 2026-07-10, D8): model priors never
-- live in categorization_templates, and a profile is never a hard key. Org
-- and VAT numbers keep coming from documents, registries and people. Every
-- attribute in `profile` cites the text it was read from in `evidence`, and
-- an attribute without a citation is dropped before the row is written.
--
-- Keyed on the booking key (normalizeCounterpartyName of the bank text) so
-- the categoriser finds it, and carries the ledger key so the Motparter
-- dossier finds it through parties.alias_keys. party_id is filled when a
-- party exists for the key, and may be filled later.

CREATE TABLE public.counterparty_profiles (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Who triggered the reading, when a person did. Null for background jobs.
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  counterparty_key  text NOT NULL CHECK (length(counterparty_key) BETWEEN 1 AND 200),
  ledger_key        text,
  party_id          uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  -- Where the reading came from: the document's text or only the bank's.
  source_kind       text NOT NULL CHECK (source_kind IN ('document', 'bank_text')),
  model             text NOT NULL,
  confidence        text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  -- {name, country, kind, sells, industry, typical_account, recurrence, vat_posture}
  profile           jsonb NOT NULL,
  -- [{field, quote, document_id}] : the text each attribute was read from.
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  superseded_at     timestamptz
);

ALTER TABLE public.counterparty_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company counterparty_profiles"
  ON public.counterparty_profiles FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company counterparty_profiles"
  ON public.counterparty_profiles FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company counterparty_profiles"
  ON public.counterparty_profiles FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company counterparty_profiles"
  ON public.counterparty_profiles FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

-- One live profile per counterparty and company; superseded rows stay as history.
CREATE UNIQUE INDEX idx_counterparty_profiles_live_key
  ON public.counterparty_profiles (company_id, counterparty_key) WHERE superseded_at IS NULL;
CREATE INDEX idx_counterparty_profiles_company_id
  ON public.counterparty_profiles (company_id);
CREATE INDEX idx_counterparty_profiles_ledger_key
  ON public.counterparty_profiles (company_id, ledger_key) WHERE superseded_at IS NULL;
CREATE INDEX idx_counterparty_profiles_party
  ON public.counterparty_profiles (party_id) WHERE party_id IS NOT NULL;

CREATE TRIGGER set_updated_at_counterparty_profiles
  BEFORE UPDATE ON public.counterparty_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_counterparty_profiles
  AFTER INSERT OR UPDATE OR DELETE ON public.counterparty_profiles
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
