-- Parties, phase 1: the identity substrate.
--
-- One party per real-world counterpart, with customers and suppliers as
-- roles on it. customers and suppliers keep their tables and every foreign
-- key; each gains a nullable party_id. Facts about a party are statements
-- with a source, a rank and two time axes (valid_from/valid_to for the world,
-- recorded_at/superseded_at for us), never overwritten. Payment identities
-- (bankgiro, plusgiro, IBAN...) are first-class rows so a changed payee on an
-- invoice can be compared against history. Decisions record every human
-- action on a party as a labelled example.
--
-- Observed parties (keys derived from voucher and bank text) are NOT stored
-- here; they are computed by the ledger-context RPC. Only suggested and
-- confirmed parties are rows.
--
-- Nothing here touches posted journal entries: the immutability trigger
-- forbids it and the alias key is the only link the design needs.

-- ── Org-number normalisation, mirror of lib/invariants/org-number.ts ────────
-- Canonical form is 10 digits. Input may carry spaces or hyphens and may be
-- the 12-digit form with a century prefix; the last digit is a Luhn check
-- digit. Returns NULL for anything that does not normalise to a valid number.
CREATE OR REPLACE FUNCTION public.normalize_org_number(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  cleaned text;
  total int := 0;
  dg int;
  i int;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  cleaned := regexp_replace(raw, '[[:space:]-]', '', 'g');
  IF cleaned !~ '^[0-9]{10}$' AND cleaned !~ '^[0-9]{12}$' THEN RETURN NULL; END IF;
  IF length(cleaned) = 12 THEN cleaned := substr(cleaned, 3); END IF;
  -- Luhn over the 10 digits, rightmost digit weight 1, then alternating 2/1.
  FOR i IN 1..10 LOOP
    dg := substr(reverse(cleaned), i, 1)::int;
    IF i % 2 = 0 THEN
      dg := dg * 2;
      IF dg > 9 THEN dg := dg - 9; END IF;
    END IF;
    total := total + dg;
  END LOOP;
  IF total % 10 <> 0 THEN RETURN NULL; END IF;
  RETURN cleaned;
END;
$$;

GRANT EXECUTE ON FUNCTION public.normalize_org_number(text) TO authenticated, service_role;

-- ── parties ─────────────────────────────────────────────────────────────────
CREATE TABLE public.parties (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  text NOT NULL CHECK (length(btrim(display_name)) > 0),
  legal_name    text,
  kind          text NOT NULL DEFAULT 'company'
                  CHECK (kind IN ('company', 'person', 'authority', 'bank', 'intermediary')),
  status        text NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('suggested', 'confirmed')),
  org_number    text CHECK (org_number ~ '^[0-9]{10}$'),
  vat_number    text,
  alias_keys    text[] NOT NULL DEFAULT '{}',
  origin        text NOT NULL DEFAULT 'manual'
                  CHECK (origin IN ('manual', 'import', 'document', 'bank', 'ledger', 'backfill')),
  merged_into   uuid,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (merged_into IS DISTINCT FROM id),
  -- (id, company_id) is the target every child and role link references, so
  -- a row can only ever point at a party in its own company. A party UUID
  -- from another tenant is useless to a caller by construction.
  CONSTRAINT parties_id_company_unique UNIQUE (id, company_id),
  CONSTRAINT parties_merged_into_same_company
    FOREIGN KEY (merged_into, company_id) REFERENCES public.parties(id, company_id)
    ON DELETE SET NULL (merged_into)
);

-- One live party per org number and company. Merged parties leave the index,
-- which is what lets a merge keep the loser row for undo. This is the unique
-- key the duplicate-invoice guard has lacked: suppliers never had one.
CREATE UNIQUE INDEX parties_company_org_number_live
  ON public.parties (company_id, org_number)
  WHERE org_number IS NOT NULL AND merged_into IS NULL;
CREATE INDEX idx_parties_company_id ON public.parties (company_id);
CREATE INDEX idx_parties_company_status ON public.parties (company_id, status) WHERE merged_into IS NULL;
CREATE INDEX idx_parties_alias_keys ON public.parties USING gin (alias_keys);
CREATE INDEX idx_parties_merged_into ON public.parties (merged_into) WHERE merged_into IS NOT NULL;

ALTER TABLE public.parties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company parties"
  ON public.parties FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company parties"
  ON public.parties FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company parties"
  ON public.parties FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company parties"
  ON public.parties FOR DELETE USING (company_id IN (SELECT user_company_ids()));

CREATE TRIGGER set_updated_at_parties
  BEFORE UPDATE ON public.parties
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER audit_parties
  AFTER INSERT OR UPDATE OR DELETE ON public.parties
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ── party_facts: statements with provenance, never overwritten ──────────────
CREATE TABLE public.party_facts (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  party_id          uuid NOT NULL,
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  field             text NOT NULL CHECK (length(field) BETWEEN 1 AND 64),
  value             jsonb NOT NULL,
  rank              text NOT NULL DEFAULT 'normal'
                      CHECK (rank IN ('preferred', 'normal', 'deprecated')),
  deprecated_reason text,
  source            text NOT NULL
                      CHECK (source IN ('user', 'registry_scb', 'registry_tic', 'vies', 'peppol', 'document', 'bank', 'ledger', 'model')),
  -- Where the value was read: {document_id, page, cited_text} for documents,
  -- {url, retrieved_at} for the web, {endpoint} for registries.
  reference         jsonb,
  fetched_at        timestamptz,
  valid_from        date,
  valid_to          date,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  superseded_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CHECK (rank <> 'deprecated' OR deprecated_reason IS NOT NULL),
  CONSTRAINT party_facts_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE CASCADE
);
CREATE INDEX idx_party_facts_party_field ON public.party_facts (party_id, field) WHERE superseded_at IS NULL;
CREATE INDEX idx_party_facts_company_id ON public.party_facts (company_id);

ALTER TABLE public.party_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company party_facts"
  ON public.party_facts FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company party_facts"
  ON public.party_facts FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company party_facts"
  ON public.party_facts FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company party_facts"
  ON public.party_facts FOR DELETE USING (company_id IN (SELECT user_company_ids()));

CREATE TRIGGER set_updated_at_party_facts
  BEFORE UPDATE ON public.party_facts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER audit_party_facts
  AFTER INSERT OR UPDATE OR DELETE ON public.party_facts
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ── party_identities: how a party gets paid ─────────────────────────────────
CREATE TABLE public.party_identities (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  party_id    uuid NOT NULL,
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scheme      text NOT NULL
                CHECK (scheme IN ('bankgiro', 'plusgiro', 'iban', 'bank_account', 'swish', 'peppol')),
  value       text NOT NULL CHECK (length(btrim(value)) > 0),
  -- known = seen on two or more documents or paid at least once;
  -- unverified = seen once, the state that asks for a second approver.
  status      text NOT NULL DEFAULT 'unverified' CHECK (status IN ('known', 'unverified')),
  source      text NOT NULL
                CHECK (source IN ('user', 'registry_scb', 'registry_tic', 'vies', 'peppol', 'document', 'bank', 'ledger', 'model')),
  first_seen  date,
  last_seen   date,
  last_paid   date,
  seen_count  integer NOT NULL DEFAULT 0 CHECK (seen_count >= 0),
  paid_count  integer NOT NULL DEFAULT 0 CHECK (paid_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (party_id, scheme, value),
  CONSTRAINT party_identities_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE CASCADE
);
CREATE INDEX idx_party_identities_company_value ON public.party_identities (company_id, scheme, value);

ALTER TABLE public.party_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company party_identities"
  ON public.party_identities FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company party_identities"
  ON public.party_identities FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company party_identities"
  ON public.party_identities FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company party_identities"
  ON public.party_identities FOR DELETE USING (company_id IN (SELECT user_company_ids()));

CREATE TRIGGER set_updated_at_party_identities
  BEFORE UPDATE ON public.party_identities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER audit_party_identities
  AFTER INSERT OR UPDATE OR DELETE ON public.party_identities
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ── party_decisions: every human action is a labelled example ───────────────
CREATE TABLE public.party_decisions (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  party_id    uuid NOT NULL,
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        text NOT NULL
                CHECK (kind IN ('confirm', 'merge', 'split', 'rename', 'role', 'dismiss', 'pin', 'ignore', 'label')),
  before      jsonb,
  after       jsonb,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT party_decisions_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE CASCADE
);
CREATE INDEX idx_party_decisions_party ON public.party_decisions (party_id, created_at);
CREATE INDEX idx_party_decisions_company_id ON public.party_decisions (company_id);

ALTER TABLE public.party_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company party_decisions"
  ON public.party_decisions FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company party_decisions"
  ON public.party_decisions FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company party_decisions"
  ON public.party_decisions FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company party_decisions"
  ON public.party_decisions FOR DELETE USING (company_id IN (SELECT user_company_ids()));

CREATE TRIGGER audit_party_decisions
  AFTER INSERT OR UPDATE OR DELETE ON public.party_decisions
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ── Roles: customers and suppliers point at their party ─────────────────────
-- Composite keys so a role can only point at a party in its own company.
-- ON DELETE SET NULL names the column: a plain SET NULL would null company_id.
ALTER TABLE public.customers ADD COLUMN party_id uuid;
ALTER TABLE public.customers ADD CONSTRAINT customers_party_same_company
  FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE SET NULL (party_id);
ALTER TABLE public.suppliers ADD COLUMN party_id uuid;
ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_party_same_company
  FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE SET NULL (party_id);
CREATE INDEX idx_customers_party_id ON public.customers (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX idx_suppliers_party_id ON public.suppliers (party_id) WHERE party_id IS NOT NULL;

-- ── ensure_party: find by org number inside the company, else create ────────
-- The one write path for a party that comes from a role (a supplier or
-- customer being created). Name-only rows never merge here: merging by name
-- is a human decision recorded in party_decisions, never an insert-time
-- guess.
CREATE OR REPLACE FUNCTION public.ensure_party(
  p_company_id uuid,
  p_user_id uuid,
  p_name text,
  p_org_number text DEFAULT NULL,
  p_kind text DEFAULT 'company',
  p_origin text DEFAULT 'manual'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_org text := public.normalize_org_number(p_org_number);
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
BEGIN
  IF v_name = '' THEN
    RAISE EXCEPTION 'ensure_party: name is required';
  END IF;
  IF v_org IS NOT NULL THEN
    SELECT id INTO v_id FROM public.parties
     WHERE company_id = p_company_id AND org_number = v_org AND merged_into IS NULL
     LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  INSERT INTO public.parties (company_id, user_id, display_name, org_number, kind, origin)
  VALUES (p_company_id, p_user_id, v_name, v_org, p_kind, p_origin)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    -- Lost a race on the live org-number index: return the winner.
    SELECT id INTO v_id FROM public.parties
     WHERE company_id = p_company_id AND org_number = v_org AND merged_into IS NULL
     LIMIT 1;
  END IF;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_party(uuid, uuid, text, text, text, text) TO authenticated, service_role;

-- ── Backfill: one party per existing supplier and customer, merged on org ──
-- Suppliers first (they carry payment data), then customers, so a company
-- that both buys from and sells to the same organisation ends up with one
-- party carrying both roles. Rows without a valid org number get their own
-- party; nothing is merged on name. Rows with an empty name (three exist on
-- prod: one supplier, two customers) keep party_id NULL: ensure_party
-- refuses a nameless party, and the suggestion pipeline names them later.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, company_id, user_id, name, org_number
      FROM public.suppliers
     WHERE party_id IS NULL AND company_id IS NOT NULL
       AND nullif(btrim(name), '') IS NOT NULL
     ORDER BY created_at, id
  LOOP
    UPDATE public.suppliers
       SET party_id = public.ensure_party(r.company_id, r.user_id, r.name, r.org_number, 'company', 'backfill')
     WHERE id = r.id;
  END LOOP;

  FOR r IN
    SELECT id, company_id, user_id, name, org_number
      FROM public.customers
     WHERE party_id IS NULL AND company_id IS NOT NULL
       AND nullif(btrim(name), '') IS NOT NULL
     ORDER BY created_at, id
  LOOP
    UPDATE public.customers
       SET party_id = public.ensure_party(r.company_id, r.user_id, r.name, r.org_number, 'company', 'backfill')
     WHERE id = r.id;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
