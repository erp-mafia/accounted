-- Migration: counterparty aliases and the shared brand directory
--
-- A party is the authority record for a counterpart: one preferred name, any
-- number of variant headings. parties.alias_keys holds the ledger-side
-- variants (voucher texts). This table holds the bank-side ones: every
-- distinct transaction string that an anchor, the directory, a document, the
-- model, a rule or a person has tied to a party. Rows are a display-time
-- overlay, like a git mailmap: the transaction text itself never changes.
--
-- A row may carry a reading with no party (party_id NULL): the string was
-- named but nothing in the register matched, so the name shows muted until a
-- person or a later reading settles it. A row is never updated in place once
-- a person has answered; a correction inserts a new row and stamps
-- superseded_at on the old one, so the log of what the resolver decided and
-- what the person did stays intact for calibration.

CREATE TABLE public.counterparty_aliases (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The person who decided, when a person did. System rows carry NULL.
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- normalizeCounterpartyName(original_description), the key the mapping
  -- engine already uses for counterparty templates, so one identity serves both.
  alias_key     text NOT NULL CHECK (length(alias_key) BETWEEN 1 AND 300),
  sample_text   text NOT NULL CHECK (length(sample_text) <= 500),
  party_id      uuid REFERENCES public.parties(id) ON DELETE SET NULL,
  display_name  text CHECK (length(display_name) <= 200),
  kind          text NOT NULL CHECK (kind IN ('merchant', 'invoice_supplier', 'authority', 'bank', 'rail', 'payroll', 'transfer', 'person', 'category', 'unsure')),
  -- The payment facilitator when the string is FACILITATOR*SUBMERCHANT.
  rail          text CHECK (length(rail) <= 80),
  country       char(2),
  what          text CHECK (length(what) <= 120),
  -- ledger: the company booked this text before, under a party of its own.
  source        text NOT NULL CHECK (source IN ('anchor', 'ledger', 'directory', 'document', 'model', 'rule', 'person')),
  confidence    numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- link: shown as the counterpart. tentative: shown with "läst ur texten"
  -- and a one-click "inte samma". nil: nothing named, the cleansed text shows.
  band          text NOT NULL CHECK (band IN ('link', 'tentative', 'nil')),
  model         text,
  verified      boolean NOT NULL DEFAULT false,
  human_outcome text CHECK (human_outcome IN ('agree', 'disagree')),
  outcome_at    timestamptz,
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.counterparty_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company counterparty_aliases"
  ON public.counterparty_aliases FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company counterparty_aliases"
  ON public.counterparty_aliases FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company counterparty_aliases"
  ON public.counterparty_aliases FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company counterparty_aliases"
  ON public.counterparty_aliases FOR DELETE USING (company_id IN (SELECT user_company_ids()));

-- One live alias per string and company; superseded rows keep the history.
CREATE UNIQUE INDEX idx_counterparty_aliases_live_key
  ON public.counterparty_aliases (company_id, alias_key) WHERE superseded_at IS NULL;
CREATE INDEX idx_counterparty_aliases_company_id ON public.counterparty_aliases (company_id);
CREATE INDEX idx_counterparty_aliases_party_id ON public.counterparty_aliases (party_id) WHERE party_id IS NOT NULL;

CREATE TRIGGER set_updated_at_counterparty_aliases
  BEFORE UPDATE ON public.counterparty_aliases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_counterparty_aliases
  AFTER INSERT OR UPDATE OR DELETE ON public.counterparty_aliases
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- The shared brand directory: what a bank string means, fleet-wide. Brand
-- level only. A reading is promoted here only when the same name came out of
-- the same key in two or more companies and its kind is merchant, authority,
-- bank or rail; persons and one-company readings never enter. No tenant data
-- beyond the key itself is stored. No member policies: RLS is on and only the
-- service role reads or writes, through lib/parties/resolver.
CREATE TABLE public.counterparty_directory (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  -- A normalized string key, or 'bg:<bankgiro>' / 'pg:<plusgiro>' / 'domain:<host>'.
  directory_key text NOT NULL UNIQUE CHECK (length(directory_key) BETWEEN 1 AND 300),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  kind          text NOT NULL CHECK (kind IN ('merchant', 'authority', 'bank', 'rail')),
  rail          text CHECK (length(rail) <= 80),
  country       char(2),
  what          text CHECK (length(what) <= 120),
  logo_domain   text CHECK (length(logo_domain) <= 120),
  source        text NOT NULL CHECK (source IN ('seed', 'promoted')),
  company_count integer NOT NULL DEFAULT 0 CHECK (company_count >= 0),
  confidence    numeric(4,3) NOT NULL DEFAULT 0.9 CHECK (confidence >= 0 AND confidence <= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.counterparty_directory ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER set_updated_at_counterparty_directory
  BEFORE UPDATE ON public.counterparty_directory
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
