-- =============================================================================
-- Member register for an ekonomisk förening (EFL 2018:672 5 kap.) and a
-- read-only preview for correcting a company's legal form when its books are
-- not empty.
--
-- EFL 5 kap. 1-3 §§: the board keeps a medlemsförteckning stating each
-- member's name and postal address, the date of admission and exit, and the
-- number and amount of the member's insatser as of the latest adopted balance
-- sheet; the register is kept for seven years after a member leaves (EFL 5
-- kap. 6 §) and every member may request a membership certificate (5 kap.
-- 5 §). EFL 11 kap. 6 § requires a separate förteckning over förlagsinsatser.
-- The ledger holds the totals (2083 Medlemsinsatser, 2084 Förlagsinsatser,
-- 2087 Insatsemission); this register holds who owns which part of them.
--
-- Three tables, all company-scoped and RLS-protected like account_reconciliations:
--   association_members: the roster (append-only in spirit: an exit is a date,
--     never a delete, so the seven-year retention holds).
--   association_member_contributions: one row per paid, credited (emission)
--     or subscribed förlagsinsats, optionally linked to the verifikat that
--     booked it and to the one that repaid or forfeited it. Aggregates per
--     kind reconcile to 2083/2087 and 2084 (lib/associations/member-capital).
--   association_member_events: append-only log of admissions, exit notices,
--     exits, expulsions, transfers and adjustments (no UPDATE or DELETE policy
--     and no grant), the audit trail EFL 5 kap. asks the board to be able to
--     show.
-- Personal identity numbers are deliberately not stored: EFL 5 kap. 2 § asks
-- for name and address, and personnummer would need the encrypted handling
-- customers get. A member can be linked to a party row instead.
--
-- preview_company_entity_type_change(): the read-only half of the design's
-- section 11. It reports why the empty-books RPC (correct_company_entity_type)
-- would refuse and the posted balances on the accounts whose remap needs a
-- human decision (2081/2082 share capital, 2087, 2893 owner liability,
-- 2098/2099 result chain). It never writes.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.association_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The association's own running number (EFL 5 kap. 2 § does not require
  -- one, but every förening has one); unique per company.
  member_number TEXT NOT NULL CHECK (char_length(member_number) BETWEEN 1 AND 40),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  postal_address TEXT CHECK (postal_address IS NULL OR char_length(postal_address) <= 500),
  email TEXT CHECK (email IS NULL OR char_length(email) <= 254),
  -- Optional link to the party layer (a member who is also a customer).
  party_id UUID REFERENCES public.parties(id) ON DELETE SET NULL,
  member_class TEXT CHECK (member_class IS NULL OR char_length(member_class) <= 60),
  admitted_on DATE NOT NULL,
  -- The date the membership ended (EFL 4 kap.). NULL while active.
  exited_on DATE CHECK (exited_on IS NULL OR exited_on >= admitted_on),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT association_members_number_unique UNIQUE (company_id, member_number)
);

COMMENT ON TABLE public.association_members IS
  'Medlemsförteckning för ekonomisk förening (EFL 5 kap.): name, address, admission and exit. Exits are dated, never deleted (seven-year retention).';

CREATE INDEX IF NOT EXISTS idx_association_members_company
  ON public.association_members (company_id, exited_on, name);

CREATE TABLE IF NOT EXISTS public.association_member_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.association_members(id) ON DELETE RESTRICT,
  -- obligatory: insats per stadgarna (EFL 10 kap. 1 §); over: överinsats
  -- (10 kap. 2 §); emission: insats credited through insatsemission (10 kap.
  -- 18-19 §§, booked on 2087); forlags: förlagsinsats (11 kap., booked on 2084).
  kind TEXT NOT NULL CHECK (kind IN ('obligatory', 'over', 'emission', 'forlags')),
  units INTEGER NOT NULL DEFAULT 1 CHECK (units >= 0),
  amount NUMERIC(15, 2) NOT NULL CHECK (amount >= 0),
  -- paid: in the association's hands; repaid: returned on exit (10 kap. 11 §)
  -- or redeemed (11 kap. 7 §); forfeited: kept by the association and taxable
  -- income for it (Skatteverket, "Deklarera för en ekonomisk förening").
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'repaid', 'forfeited')),
  paid_on DATE NOT NULL,
  settled_on DATE CHECK (settled_on IS NULL OR settled_on >= paid_on),
  journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  settlement_journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT association_member_contributions_settlement_pair
    CHECK ((status = 'paid') = (settled_on IS NULL))
);

COMMENT ON TABLE public.association_member_contributions IS
  'Insatser per member (EFL 10-11 kap.): kind, units, amount, status and the verifikat that booked and settled them. Aggregates reconcile to 2083/2087 and 2084.';

CREATE INDEX IF NOT EXISTS idx_association_member_contributions_company
  ON public.association_member_contributions (company_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_association_member_contributions_member
  ON public.association_member_contributions (member_id);

CREATE TABLE IF NOT EXISTS public.association_member_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.association_members(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('admission', 'exit_notice', 'exit', 'expulsion', 'transfer', 'contribution', 'settlement', 'note')
  ),
  occurred_on DATE NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.association_member_events IS
  'Append-only history of the member register (EFL 5 kap.): no update, no delete.';

CREATE INDEX IF NOT EXISTS idx_association_member_events_member
  ON public.association_member_events (member_id, occurred_on);

DROP TRIGGER IF EXISTS association_members_updated_at ON public.association_members;
CREATE TRIGGER association_members_updated_at
  BEFORE UPDATE ON public.association_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS association_member_contributions_updated_at ON public.association_member_contributions;
CREATE TRIGGER association_member_contributions_updated_at
  BEFORE UPDATE ON public.association_member_contributions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.association_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.association_member_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.association_member_events ENABLE ROW LEVEL SECURITY;

-- Every company member reads the register (a viewer may look). Owners, admins
-- and members write; the routes add requireWrite on top (defense in depth).
-- No DELETE policy on any of the three tables and no UPDATE policy on the
-- events table: the register is history.
DROP POLICY IF EXISTS "association_members_select" ON public.association_members;
CREATE POLICY "association_members_select" ON public.association_members
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "association_members_insert" ON public.association_members;
CREATE POLICY "association_members_insert" ON public.association_members
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );
DROP POLICY IF EXISTS "association_members_update" ON public.association_members;
CREATE POLICY "association_members_update" ON public.association_members
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS "association_member_contributions_select" ON public.association_member_contributions;
CREATE POLICY "association_member_contributions_select" ON public.association_member_contributions
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "association_member_contributions_insert" ON public.association_member_contributions;
CREATE POLICY "association_member_contributions_insert" ON public.association_member_contributions
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );
DROP POLICY IF EXISTS "association_member_contributions_update" ON public.association_member_contributions;
CREATE POLICY "association_member_contributions_update" ON public.association_member_contributions
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );

DROP POLICY IF EXISTS "association_member_events_select" ON public.association_member_events;
CREATE POLICY "association_member_events_select" ON public.association_member_events
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "association_member_events_insert" ON public.association_member_events;
CREATE POLICY "association_member_events_insert" ON public.association_member_events
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );

-- The events table is append-only for the API roles as well: revoke the
-- grants a policy could otherwise be added for later.
REVOKE UPDATE, DELETE ON TABLE public.association_member_events FROM anon, authenticated;
REVOKE DELETE ON TABLE public.association_members FROM anon, authenticated;
REVOKE DELETE ON TABLE public.association_member_contributions FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- preview_company_entity_type_change: read-only assessment for the owner.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_company_entity_type_change(
  p_company_id uuid,
  p_entity_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_role           text;
  v_current        text;
  v_entries        integer;
  v_invoices       integer;
  v_supplier       integer;
  v_custom         integer;
  v_configured     integer;
  v_balances       jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_FORBIDDEN');
  END IF;

  SELECT role INTO v_role
  FROM public.company_members
  WHERE company_id = p_company_id AND user_id = v_actor;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_NOT_FOUND');
  END IF;

  SELECT entity_type INTO v_current FROM public.companies WHERE id = p_company_id AND archived_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_NOT_FOUND');
  END IF;

  IF p_entity_type IS NULL OR NOT (p_entity_type = ANY (public.supported_entity_types())) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_UNSUPPORTED');
  END IF;

  SELECT count(*) INTO v_entries FROM public.journal_entries WHERE company_id = p_company_id;
  SELECT count(*) INTO v_invoices FROM public.invoices WHERE company_id = p_company_id;
  SELECT count(*) INTO v_supplier FROM public.supplier_invoices WHERE company_id = p_company_id;
  SELECT count(*) INTO v_custom
  FROM public.chart_of_accounts
  WHERE company_id = p_company_id AND is_system_account IS DISTINCT FROM true;
  SELECT
    (SELECT count(*) FROM public.mapping_rules WHERE company_id = p_company_id)
    + (SELECT count(*) FROM public.account_dimension_rules WHERE company_id = p_company_id)
  INTO v_configured;

  -- Posted balances on the accounts whose meaning changes with the form.
  -- 2081/2082: share capital (aktiebolag only); 2087: bunden överkursfond in
  -- an AB but insatsemission in a förening; 2893: skuld till aktieägare vs
  -- 2890 member settlement; 2098/2099: the AB and förening result chain vs
  -- 2010 (enskild firma) and 2068/2069 (ideell förening).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'account', t.account_number,
           'balance', t.balance
         ) ORDER BY t.account_number), '[]'::jsonb)
  INTO v_balances
  FROM (
    SELECT l.account_number,
           round(sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0))::numeric, 2) AS balance
    FROM public.journal_entry_lines l
    JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = p_company_id
      AND e.status = 'posted'
      AND l.account_number IN ('2010', '2013', '2018', '2068', '2069', '2081', '2082', '2083', '2084', '2087', '2890', '2893', '2098', '2099')
    GROUP BY l.account_number
    HAVING round(sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0))::numeric, 2) <> 0
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'current_entity_type', v_current,
    'target_entity_type', p_entity_type,
    'same_form', v_current = p_entity_type,
    'empty_books_path_available',
      v_role = 'owner' AND v_entries = 0 AND v_invoices = 0 AND v_supplier = 0
      AND v_custom = 0 AND v_configured = 0,
    'caller_role', v_role,
    'blockers', jsonb_build_object(
      'journal_entries', v_entries,
      'invoices', v_invoices,
      'supplier_invoices', v_supplier,
      'custom_accounts', v_custom,
      'configured_account_references', v_configured
    ),
    'decision_accounts', v_balances
  );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_company_entity_type_change(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_company_entity_type_change(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
