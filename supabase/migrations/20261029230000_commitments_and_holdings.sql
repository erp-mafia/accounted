-- =============================================================================
-- Bolaget W5: commitments and holdings (aktiebolag and enskild firma alike)
--
--   1. agreements open to manual rows: a person registers an agreement
--      without a document reading behind it (origin 'manual'). The Arkiv
--      brain keeps deriving its own rows from documents (origin 'derived',
--      source_document_id set, one agreement per document as before). New
--      kinds: permit, ip_right, domain, guarantee, added to the kind CHECK as
--      it stands (expand-from-current, parallel branches add kinds too).
--      Members with a writing role write manual rows and their expected
--      payments through RLS; derived rows stay service-role only.
--   2. securities_and_contingencies: ställda säkerheter and
--      eventualförpliktelser (ÅRL 5 kap. 14-16 §§, K2 punkt 18.13-18.19),
--      the register the årsredovisning note text is generated from.
--   3. company_group_links: the group structure (parent, subsidiary,
--      associate) with ownership and votes over time, for the
--      koncernförhållanden note.
--   4. assets: fastighetsbeteckning and taxeringsvärde for a building,
--      registration number for a vehicle and its bilförmån.
--   5. pending_operations: the staged writes of the agreement, security and
--      group link operations (NOT VALID; validated in 20261029230100).
--
-- Nothing here posts to the ledger. Documents are linked, never parsed.
-- pg-test: tests/pg/commitments-and-holdings.pg.test.ts
-- =============================================================================

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. agreements: manual rows
-- =============================================================================

ALTER TABLE public.agreements
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'derived',
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS document_id uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_due_on date;

ALTER TABLE public.agreements DROP CONSTRAINT IF EXISTS agreements_origin_check;
ALTER TABLE public.agreements
  ADD CONSTRAINT agreements_origin_check CHECK (origin IN ('derived', 'manual'));

-- A derived agreement is the reading of one document; a manual one has no
-- reading behind it. The UNIQUE on source_document_id stays: it keeps one
-- derived agreement per document and lets any number of manual rows be NULL.
ALTER TABLE public.agreements ALTER COLUMN source_document_id DROP NOT NULL;
ALTER TABLE public.agreements DROP CONSTRAINT IF EXISTS agreements_origin_source_check;
ALTER TABLE public.agreements
  ADD CONSTRAINT agreements_origin_source_check CHECK ((origin = 'manual') = (source_document_id IS NULL));

ALTER TABLE public.agreements DROP CONSTRAINT IF EXISTS agreements_notes_check;
ALTER TABLE public.agreements
  ADD CONSTRAINT agreements_notes_check CHECK (notes IS NULL OR length(notes) <= 4000);

COMMENT ON COLUMN public.agreements.origin IS
  'derived: read from source_document_id by the Arkiv pipeline (service role only). manual: registered by a person or through the API, with an optional document_id link.';
COMMENT ON COLUMN public.agreements.document_id IS
  'Manual agreements: the archived document the agreement is in, linked only (never read into fields).';
COMMENT ON COLUMN public.agreements.first_due_on IS
  'Manual agreements: the first payment date when it is not starts_on; the expected payments repeat from it by period.';

-- The kinds: the CHECK as it stands plus permit, ip_right, domain, guarantee.
DO $$
DECLARE
  v_kinds text[];
  v_new text;
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_kinds
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.agreements'::regclass
     AND c.conname = 'agreements_kind_check';
  IF v_kinds IS NULL OR cardinality(v_kinds) < 10 THEN
    RAISE EXCEPTION 'agreements_kind_check: expected the full list, read % values', coalesce(cardinality(v_kinds), 0);
  END IF;
  FOREACH v_new IN ARRAY ARRAY['permit', 'ip_right', 'domain', 'guarantee'] LOOP
    IF NOT (v_new = ANY (v_kinds)) THEN
      v_kinds := v_kinds || v_new;
    END IF;
  END LOOP;
  ALTER TABLE public.agreements DROP CONSTRAINT agreements_kind_check;
  EXECUTE format(
    'ALTER TABLE public.agreements ADD CONSTRAINT agreements_kind_check CHECK (kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(v_kinds) AS k)
  );
END;
$$;

-- Same-company references (a security names the loan it secures).
CREATE UNIQUE INDEX IF NOT EXISTS agreements_id_company_key ON public.agreements (id, company_id);
CREATE INDEX IF NOT EXISTS idx_agreements_manual ON public.agreements (company_id, status) WHERE origin = 'manual';
CREATE INDEX IF NOT EXISTS idx_agreements_created_by ON public.agreements (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agreements_document ON public.agreements (document_id) WHERE document_id IS NOT NULL;

-- Members with a writing role write manual agreements; derived rows stay the
-- pipeline's (service role, which RLS does not apply to).
DROP POLICY IF EXISTS "insert own-company manual agreements" ON public.agreements;
CREATE POLICY "insert own-company manual agreements"
  ON public.agreements FOR INSERT WITH CHECK (
    origin = 'manual'
    AND company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company manual agreements" ON public.agreements;
CREATE POLICY "update own-company manual agreements"
  ON public.agreements FOR UPDATE
  USING (origin = 'manual' AND company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (
    origin = 'manual'
    AND company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
  );
-- No delete policy: an agreement is ended, not removed.

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.agreements;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.agreements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- Who registered or changed a manual agreement. The weekly re-derivation of
-- derived rows stays out of the log.
DROP TRIGGER IF EXISTS audit_manual_agreements ON public.agreements;
CREATE TRIGGER audit_manual_agreements
  AFTER INSERT OR UPDATE ON public.agreements
  FOR EACH ROW WHEN (NEW.origin = 'manual')
  EXECUTE FUNCTION public.write_audit_log();
DROP TRIGGER IF EXISTS audit_manual_agreements_delete ON public.agreements;
CREATE TRIGGER audit_manual_agreements_delete
  AFTER DELETE ON public.agreements
  FOR EACH ROW WHEN (OLD.origin = 'manual')
  EXECUTE FUNCTION public.write_audit_log();

GRANT SELECT, INSERT, UPDATE ON TABLE public.agreements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agreements TO service_role;

-- The expected payments of a manual agreement: written with it, by the same
-- member. Observation (matched, missed) stays the daily job's.
DROP POLICY IF EXISTS "write own-company manual agreement obligations" ON public.agreement_obligations;
CREATE POLICY "write own-company manual agreement obligations"
  ON public.agreement_obligations FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND EXISTS (
      SELECT 1 FROM public.agreements a
       WHERE a.id = agreement_obligations.agreement_id
         AND a.company_id = agreement_obligations.company_id
         AND a.origin = 'manual'
    )
  );
DROP POLICY IF EXISTS "update own-company manual agreement obligations" ON public.agreement_obligations;
CREATE POLICY "update own-company manual agreement obligations"
  ON public.agreement_obligations FOR UPDATE
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND EXISTS (
      SELECT 1 FROM public.agreements a
       WHERE a.id = agreement_obligations.agreement_id
         AND a.company_id = agreement_obligations.company_id
         AND a.origin = 'manual'
    )
  )
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND EXISTS (
      SELECT 1 FROM public.agreements a
       WHERE a.id = agreement_obligations.agreement_id
         AND a.company_id = agreement_obligations.company_id
         AND a.origin = 'manual'
    )
  );
-- Only an expected payment the schedule no longer implies is removed.
DROP POLICY IF EXISTS "delete own-company manual agreement obligations" ON public.agreement_obligations;
CREATE POLICY "delete own-company manual agreement obligations"
  ON public.agreement_obligations FOR DELETE USING (
    status = 'expected'
    AND company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND EXISTS (
      SELECT 1 FROM public.agreements a
       WHERE a.id = agreement_obligations.agreement_id
         AND a.company_id = agreement_obligations.company_id
         AND a.origin = 'manual'
    )
  );

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.agreement_obligations;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.agreement_obligations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agreement_obligations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agreement_obligations TO service_role;

-- =============================================================================
-- 2. securities_and_contingencies
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.securities_and_contingencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Ställda säkerheter (K2 punkt 18.13-18.14) by type, and
  -- eventualförpliktelser (18.15-18.19), borgen apart (always disclosed).
  kind text NOT NULL CHECK (kind IN (
    'foretagsinteckning',
    'fastighetsinteckning',
    'aganderattsforbehall',
    'belanad_fordran',
    'borgen',
    'other_security',
    'other_contingency'
  )),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 300),
  -- The mortgage amount (pantbrev, företagsinteckning) or the book value of
  -- the asset pledged or sold under äganderättsförbehåll, in SEK.
  amount numeric(15, 2) NOT NULL CHECK (amount >= 0),
  in_favour_of_party_id uuid,
  in_favour_of_name text CHECK (in_favour_of_name IS NULL OR length(in_favour_of_name) <= 200),
  -- Given for or to a group company (ÅRL 5 kap. 16 §): stated separately.
  for_group_company boolean NOT NULL DEFAULT false,
  -- The loan agreement the security is for, when registered.
  agreement_id uuid,
  valid_from date,
  valid_to date,
  document_id uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (in_favour_of_party_id, company_id)
    REFERENCES public.parties(id, company_id) ON DELETE SET NULL (in_favour_of_party_id),
  FOREIGN KEY (agreement_id, company_id)
    REFERENCES public.agreements(id, company_id) ON DELETE SET NULL (agreement_id)
);

COMMENT ON TABLE public.securities_and_contingencies IS
  'Ställda säkerheter and eventualförpliktelser (ÅRL 5 kap. 14-16 §§). The årsredovisning note text is generated from the rows active at the balance date; arsredovisning_narratives free text overrides it.';

ALTER TABLE public.securities_and_contingencies ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.securities_and_contingencies TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.securities_and_contingencies TO authenticated;

CREATE POLICY "view own-company securities_and_contingencies"
  ON public.securities_and_contingencies FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "insert own-company securities_and_contingencies"
  ON public.securities_and_contingencies FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
CREATE POLICY "update own-company securities_and_contingencies"
  ON public.securities_and_contingencies FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));
-- No delete policy: a released security gets valid_to, the history stays.

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.securities_and_contingencies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE INDEX idx_securities_and_contingencies_company ON public.securities_and_contingencies (company_id, kind);
CREATE INDEX idx_securities_and_contingencies_user ON public.securities_and_contingencies (user_id);
CREATE INDEX idx_securities_and_contingencies_party ON public.securities_and_contingencies (in_favour_of_party_id)
  WHERE in_favour_of_party_id IS NOT NULL;
CREATE INDEX idx_securities_and_contingencies_agreement ON public.securities_and_contingencies (agreement_id)
  WHERE agreement_id IS NOT NULL;
CREATE INDEX idx_securities_and_contingencies_document ON public.securities_and_contingencies (document_id)
  WHERE document_id IS NOT NULL;

CREATE TRIGGER set_updated_at_securities_and_contingencies
  BEFORE UPDATE ON public.securities_and_contingencies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_securities_and_contingencies
  AFTER INSERT OR UPDATE OR DELETE ON public.securities_and_contingencies
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 3. company_group_links
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_group_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- parent: the company that holds this one; subsidiary: a dotterföretag
  -- this one holds; associate: an intresseföretag.
  relation text NOT NULL CHECK (relation IN ('parent', 'subsidiary', 'associate')),
  counterparty_name text NOT NULL CHECK (length(btrim(counterparty_name)) BETWEEN 1 AND 200),
  counterparty_org_number text CHECK (counterparty_org_number IS NULL OR length(btrim(counterparty_org_number)) BETWEEN 1 AND 40),
  -- Säte, for the koncernförhållanden note.
  counterparty_registered_office text CHECK (counterparty_registered_office IS NULL OR length(counterparty_registered_office) <= 120),
  party_id uuid,
  ownership_percent numeric(7, 4) CHECK (ownership_percent IS NULL OR (ownership_percent >= 0 AND ownership_percent <= 100)),
  voting_percent numeric(7, 4) CHECK (voting_percent IS NULL OR (voting_percent >= 0 AND voting_percent <= 100)),
  valid_from date,
  valid_to date,
  -- The 13xx account the holding or the claim is booked on.
  bas_account text CHECK (bas_account IS NULL OR bas_account ~ '^13[0-9]{2}$'),
  -- The same company in Accounted, when both are in one team.
  linked_company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CHECK (linked_company_id IS NULL OR linked_company_id <> company_id),
  FOREIGN KEY (party_id, company_id)
    REFERENCES public.parties(id, company_id) ON DELETE SET NULL (party_id)
);

COMMENT ON TABLE public.company_group_links IS
  'The group structure: parent, subsidiaries and associates over time. An active parent link prefills the koncernförhållanden note of the årsredovisning; arsredovisning_narratives free text overrides it.';

ALTER TABLE public.company_group_links ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_group_links TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.company_group_links TO authenticated;

CREATE POLICY "view own-company company_group_links"
  ON public.company_group_links FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "insert own-company company_group_links"
  ON public.company_group_links FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
CREATE POLICY "update own-company company_group_links"
  ON public.company_group_links FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));
-- No delete policy: a link that ends gets valid_to, the history stays.

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_group_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE INDEX idx_company_group_links_company ON public.company_group_links (company_id, relation);
CREATE INDEX idx_company_group_links_user ON public.company_group_links (user_id);
CREATE INDEX idx_company_group_links_party ON public.company_group_links (party_id) WHERE party_id IS NOT NULL;
CREATE INDEX idx_company_group_links_linked_company ON public.company_group_links (linked_company_id)
  WHERE linked_company_id IS NOT NULL;

CREATE TRIGGER set_updated_at_company_group_links
  BEFORE UPDATE ON public.company_group_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_company_group_links
  AFTER INSERT OR UPDATE OR DELETE ON public.company_group_links
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 4. assets: property and vehicle identification
-- =============================================================================

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS fastighetsbeteckning text
    CHECK (fastighetsbeteckning IS NULL OR length(btrim(fastighetsbeteckning)) BETWEEN 1 AND 120),
  ADD COLUMN IF NOT EXISTS taxeringsvarde numeric(15, 2)
    CHECK (taxeringsvarde IS NULL OR taxeringsvarde >= 0),
  ADD COLUMN IF NOT EXISTS registration_number text
    CHECK (registration_number IS NULL OR length(btrim(registration_number)) BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS employee_benefit_id uuid REFERENCES public.employee_benefits(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.assets.fastighetsbeteckning IS 'Building: the property designation in the fastighetsregister.';
COMMENT ON COLUMN public.assets.taxeringsvarde IS 'Building: the latest taxeringsvärde, SEK.';
COMMENT ON COLUMN public.assets.registration_number IS 'Vehicle: the registration number.';
COMMENT ON COLUMN public.assets.employee_benefit_id IS 'Vehicle: the bilförmån (employee_benefits) the car is used for.';

CREATE INDEX IF NOT EXISTS idx_assets_employee_benefit ON public.assets (employee_benefit_id)
  WHERE employee_benefit_id IS NOT NULL;

-- =============================================================================
-- 5. pending_operations.operation_type: the staged writes
-- =============================================================================

DO $$
DECLARE
  v_types text[];
  v_new text;
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_types
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.pending_operations'::regclass
     AND c.conname = 'pending_operations_operation_type_check';
  IF v_types IS NULL OR cardinality(v_types) < 150 THEN
    RAISE EXCEPTION 'pending_operations_operation_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[
    'create_agreement',
    'update_agreement',
    'end_agreement',
    'create_security',
    'update_security',
    'create_group_link',
    'update_group_link'
  ] LOOP
    IF NOT (v_new = ANY (v_types)) THEN
      v_types := v_types || v_new;
    END IF;
  END LOOP;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
