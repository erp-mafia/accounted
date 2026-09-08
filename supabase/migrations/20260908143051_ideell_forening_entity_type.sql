-- =============================================================================
-- Ideell förening as a third legal form (issue #2072, step 1)
--
-- Widens entity_type from {enskild_firma, aktiebolag} to also accept
-- 'ideell_forening' everywhere the value is stored or validated:
--   1. CHECK constraints on companies, company_settings and
--      booking_template_library (the latter keeps 'all').
--   2. supported_entity_types(): the one list the create RPCs validate
--      against, so the next form is one function change, not four.
--   3. The three live create RPCs (create_company_with_owner,
--      create_company_for_user, create_company_for_brand_signup): bodies
--      byte-identical to 20260826130400 / 20260826130600 / 20260827120000
--      except the entity_type guard.
--   4. seed_chart_of_accounts(): a förening equity block. BAS 2060-2069 is
--      the equity group for ideella föreningar; the seed gives 2067
--      (balanserat), 2068 (föregående år), 2069 (årets resultat) and 2890
--      (member settlement: a förening has no owner accounts). Personnel
--      accounts are auto-created on first payroll, as for enskild firma.
--      sru_code stays NULL: föreningar file INK3, which is not modelled.
--   Everything else in seed_chart_of_accounts is byte-identical to
--   20260731090000.
-- =============================================================================

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_entity_type_check;
ALTER TABLE public.companies
  ADD CONSTRAINT companies_entity_type_check
  CHECK (entity_type IN ('enskild_firma', 'aktiebolag', 'ideell_forening'));

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_entity_type_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_entity_type_check
  CHECK (entity_type IN ('enskild_firma', 'aktiebolag', 'ideell_forening'));

ALTER TABLE public.booking_template_library
  DROP CONSTRAINT IF EXISTS booking_template_library_entity_type_check;
ALTER TABLE public.booking_template_library
  ADD CONSTRAINT booking_template_library_entity_type_check
  CHECK (entity_type IN ('all', 'enskild_firma', 'aktiebolag', 'ideell_forening'));

-- -----------------------------------------------------------------------------
-- The single list the create RPCs validate against.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.supported_entity_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY['enskild_firma', 'aktiebolag', 'ideell_forening']::text[];
$$;

REVOKE ALL ON FUNCTION public.supported_entity_types() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supported_entity_types() TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- create_company_with_owner: 20260826130400 with the widened guard.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_company_with_owner(
  p_name text,
  p_entity_type text,
  p_set_active boolean DEFAULT true,
  p_team_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_company_id uuid;
  v_team_kind text;
  v_team_role text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_entity_type IS NULL OR p_entity_type <> ALL (public.supported_entity_types()) THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  -- Authorize p_team_id before any write. SECURITY DEFINER bypasses RLS, so
  -- we must verify membership ourselves; without this any authenticated user
  -- could attach a company to an arbitrary team (20260519180000). On byrå
  -- teams the bar is higher: WL-15 locks client company creation to team
  -- owner/admin because every created company is +1 on the byrå's invoice.
  IF p_team_id IS NOT NULL THEN
    SELECT tm.role, t.kind
    INTO v_team_role, v_team_kind
    FROM public.team_members tm
    JOIN public.teams t ON t.id = tm.team_id
    WHERE tm.team_id = p_team_id
      AND tm.user_id = v_user_id;

    IF v_team_role IS NULL THEN
      RAISE EXCEPTION 'Not a member of team %', p_team_id
        USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;

    IF v_team_kind = 'byra' AND v_team_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Only byrå team owners and admins can create client companies'
        USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by, team_id)
  VALUES (p_name, p_entity_type, v_user_id, p_team_id)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, v_user_id, 'owner');

  -- Seed default 1930 SEK cash account so reconciliation routes work before
  -- any PSD2 connection is established. is_primary so the __PRIMARY_SEK__
  -- sentinel in skattekonto-booking resolves on day one.
  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  )
  VALUES (
    v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  )
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  IF p_set_active THEN
    INSERT INTO public.user_preferences (user_id, active_company_id)
    VALUES (v_user_id, v_company_id)
    ON CONFLICT (user_id)
    DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
  END IF;

  IF p_team_id IS NOT NULL THEN
    PERFORM public.sync_team_to_company(v_company_id, p_team_id);
  END IF;

  RETURN v_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_company_with_owner(text, text, boolean, uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- create_company_for_user: 20260826130600 with the widened guard.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_company_for_user(
  p_user_id uuid,
  p_name text,
  p_entity_type text,
  p_team_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_team_kind text;
  v_team_role text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Unknown user %', p_user_id
      USING ERRCODE = '23503'; -- foreign_key_violation
  END IF;

  IF p_entity_type IS NULL OR p_entity_type <> ALL (public.supported_entity_types()) THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'p_name is required';
  END IF;

  -- Same authorization as create_company_with_owner (20260826130400), against
  -- the explicit owner: SECURITY DEFINER bypasses RLS, so team membership is
  -- checked here. On byrå teams the bar is higher: WL-15 locks client company
  -- creation to team owner/admin because every created company is +1 on the
  -- byrå's invoice.
  IF p_team_id IS NOT NULL THEN
    SELECT tm.role, t.kind
    INTO v_team_role, v_team_kind
    FROM public.team_members tm
    JOIN public.teams t ON t.id = tm.team_id
    WHERE tm.team_id = p_team_id
      AND tm.user_id = p_user_id;

    IF v_team_role IS NULL THEN
      RAISE EXCEPTION 'Not a member of team %', p_team_id
        USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;

    IF v_team_kind = 'byra' AND v_team_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Only byrå team owners and admins can create client companies'
        USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by, team_id)
  VALUES (btrim(p_name), p_entity_type, p_user_id, p_team_id)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, p_user_id, 'owner');

  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  )
  VALUES (
    v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  )
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  INSERT INTO public.user_preferences (user_id, active_company_id)
  VALUES (p_user_id, v_company_id)
  ON CONFLICT (user_id)
  DO UPDATE SET active_company_id = EXCLUDED.active_company_id;

  IF p_team_id IS NOT NULL THEN
    PERFORM public.sync_team_to_company(v_company_id, p_team_id);
  END IF;

  RETURN v_company_id;
END;
$$;

-- Service role only. PostgREST exposes functions to every role by default
-- (PUBLIC grant), so revoke first, then grant the one role that may call it.
REVOKE ALL ON FUNCTION public.create_company_for_user(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_company_for_user(uuid, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_company_for_user(uuid, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_company_for_user(uuid, text, text, uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- create_company_for_brand_signup: 20260827120000 with the widened guard.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_company_for_brand_signup(
  p_user_id uuid,
  p_name text,
  p_entity_type text,
  p_brand_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_team_id uuid;
  v_email text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  IF p_brand_id IS NULL THEN
    RAISE EXCEPTION 'p_brand_id is required';
  END IF;

  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = p_user_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Unknown user %', p_user_id
      USING ERRCODE = '23503'; -- foreign_key_violation
  END IF;

  IF p_entity_type IS NULL OR p_entity_type <> ALL (public.supported_entity_types()) THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'p_name is required';
  END IF;

  SELECT b.team_id INTO v_team_id FROM public.brands b WHERE b.id = p_brand_id;
  IF v_team_id IS NULL THEN
    RAISE EXCEPTION 'Unknown brand %', p_brand_id
      USING ERRCODE = '23503'; -- foreign_key_violation
  END IF;

  -- The allowlist entry IS the authorization: it was recorded by a byrå
  -- owner/admin (RLS above) or ops, standing in for the WL-15 admin gate.
  IF NOT EXISTS (
    SELECT 1
    FROM public.brand_signup_allowlist a
    WHERE a.brand_id = p_brand_id
      AND a.email = v_email
  ) THEN
    RAISE EXCEPTION 'User % is not on the signup allowlist for brand %', p_user_id, p_brand_id
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by, team_id)
  VALUES (btrim(p_name), p_entity_type, p_user_id, v_team_id)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, p_user_id, 'owner');

  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  )
  VALUES (
    v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  )
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  INSERT INTO public.user_preferences (user_id, active_company_id)
  VALUES (p_user_id, v_company_id)
  ON CONFLICT (user_id)
  DO UPDATE SET active_company_id = EXCLUDED.active_company_id;

  PERFORM public.sync_team_to_company(v_company_id, v_team_id);

  RETURN v_company_id;
END;
$$;

-- Service role only. PostgREST exposes functions to every role by default
-- (PUBLIC grant), so revoke first, then grant the one role that may call it.
REVOKE ALL ON FUNCTION public.create_company_for_brand_signup(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_company_for_brand_signup(uuid, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_company_for_brand_signup(uuid, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_company_for_brand_signup(uuid, text, text, uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- seed_chart_of_accounts: 20260731090000 plus the ideell förening block.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_chart_of_accounts(p_company_id uuid, p_entity_type text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_count integer;
  v_user_id uuid;
BEGIN
  SELECT created_by INTO v_user_id FROM public.companies WHERE id = p_company_id;

  SELECT count(*) INTO v_account_count
  FROM public.chart_of_accounts
  WHERE company_id = p_company_id;

  IF v_account_count > 0 THEN
    RETURN;
  END IF;

  -- Assets (1xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '1510', 'Kundfordringar', 1, '15', 'asset', 'debit', 'k1', true, '7211'),
    (v_user_id, p_company_id, '1910', 'Kassa', 1, '19', 'asset', 'debit', 'k1', true, '7212'),
    (v_user_id, p_company_id, '1930', 'Företagskonto / checkkonto', 1, '19', 'asset', 'debit', 'k1', true, '7212'),
    (v_user_id, p_company_id, '1940', 'Övriga bankkonton', 1, '19', 'asset', 'debit', 'k1', true, '7212');

  -- Equity (2xxx)
  IF p_entity_type = 'enskild_firma' THEN
    -- Enskild firma equity accounts: sru_code intentionally NULL.
    -- BAS reference maps these to INK2 SRU 7221 ("Övrigt eget kapital"),
    -- which is the aktiebolag tax form. EF entities file NE-bilaga, not
    -- INK2, and owner drawings/contributions on 2013/2018 must not be
    -- reported as balance-sheet equity by SIE/INK2 consumers.
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2010', 'Eget kapital', 2, '20', 'equity', 'credit', 'k1', true, NULL),
      (v_user_id, p_company_id, '2013', 'Övriga egna uttag', 2, '20', 'equity', 'credit', 'k1', true, NULL),
      (v_user_id, p_company_id, '2018', 'Övriga egna insättningar', 2, '20', 'equity', 'credit', 'k1', true, NULL);
  END IF;

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2081', 'Aktiekapital', 2, '20', 'equity', 'credit', 'k1', true, '7220'),
      (v_user_id, p_company_id, '2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', 'k1', true, '7221'),
      (v_user_id, p_company_id, '2099', 'Årets resultat', 2, '20', 'equity', 'credit', 'k1', true, '7222');
  END IF;

  IF p_entity_type = 'ideell_forening' THEN
    -- Ideell förening equity (BAS 2060-2069). The year closes to 2069 and is
    -- carried to 2068 at the next year start (lib/company/entity-type.ts).
    -- sru_code NULL: föreningar file INK3, whose SRU codes are not modelled.
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2067', 'Balanserat överskott eller underskott', 2, '20', 'equity', 'credit', 'k1', true, NULL),
      (v_user_id, p_company_id, '2068', 'Överskott eller underskott från föregående år', 2, '20', 'equity', 'credit', 'k1', true, NULL),
      (v_user_id, p_company_id, '2069', 'Årets resultat', 2, '20', 'equity', 'credit', 'k1', true, NULL);
  END IF;

  -- Liabilities (2xxx) - BAS 2026 VAT account labels
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '2440', 'Leverantörsskulder', 2, '24', 'liability', 'credit', 'k1', true, '7230'),
    (v_user_id, p_company_id, '2611', 'Utgående moms försäljning inom Sverige, 25%', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (v_user_id, p_company_id, '2621', 'Utgående moms försäljning inom Sverige, 12%', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (v_user_id, p_company_id, '2631', 'Utgående moms försäljning inom Sverige, 6%', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (v_user_id, p_company_id, '2641', 'Debiterad ingående moms', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (v_user_id, p_company_id, '2650', 'Redovisningskonto för moms', 2, '26', 'liability', 'credit', 'k1', true, '7231'),
    (v_user_id, p_company_id, '2710', 'Personalskatt', 2, '27', 'liability', 'credit', 'k1', true, '7231'),
    (v_user_id, p_company_id, '2731', 'Avräkning socialavgifter', 2, '27', 'liability', 'credit', 'k1', true, '7231');

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2893', 'Skuld till aktieägare', 2, '28', 'liability', 'credit', 'k1', true, '7231');
  END IF;

  IF p_entity_type = 'ideell_forening' THEN
    -- A förening has no owner: money settled with a member (utlägg, an
    -- advance) is a plain short-term liability, the counterpart of EF
    -- 2013/2018 and AB 2893 in the booking paths.
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2890', 'Övriga kortfristiga skulder', 2, '28', 'liability', 'credit', 'k1', true, NULL);
  END IF;

  -- Revenue (3xxx). 3001/3002 carry the official BAS 2026 names: 3001 takes
  -- ALL 25% revenue and 3002 is the 12% account (invoice booking, category
  -- mapping and default_vat_rate all treat it as 12%), so the name must say
  -- so.
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '3001', 'Försäljning inom Sverige, 25 % moms', 3, '30', 'revenue', 'credit', 'k1', true, '7310'),
    (v_user_id, p_company_id, '3002', 'Försäljning inom Sverige, 12 % moms', 3, '30', 'revenue', 'credit', 'k1', true, '7310'),
    (v_user_id, p_company_id, '3100', 'Momsfri försäljning', 3, '31', 'revenue', 'credit', 'k1', true, '7311'),
    (v_user_id, p_company_id, '3900', 'Övriga rörelseintäkter', 3, '39', 'revenue', 'credit', 'k1', true, '7311'),
    (v_user_id, p_company_id, '3960', 'Valutakursvinster', 3, '39', 'revenue', 'credit', 'k1', true, '7310');

  -- COGS (4xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '4000', 'Varuinköp', 4, '40', 'expense', 'debit', 'k1', true, '7320');

  -- External expenses (5xxx-6xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '5010', 'Lokalhyra', 5, '50', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '5410', 'Förbrukningsinventarier', 5, '54', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '5420', 'Programvaror', 5, '54', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '5460', 'Förbrukningsmaterial', 5, '54', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '5800', 'Resekostnader', 5, '58', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '5910', 'Annonsering', 5, '59', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '6071', 'Representation avdragsgill', 6, '60', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '6110', 'Kontorsmateriel', 6, '61', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '6212', 'Mobiltelefon', 6, '62', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '6230', 'Datakommunikation', 6, '62', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '6530', 'Redovisningstjänster', 6, '65', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '6570', 'Bankavgifter', 6, '65', 'expense', 'debit', 'k1', true, '7321'),
    (v_user_id, p_company_id, '6991', 'Övriga avdragsgilla kostnader', 6, '69', 'expense', 'debit', 'k1', true, '7330');

  -- Personnel (7xxx). BAS names: 7010 kollektivanställda, 7210 tjänstemän.
  -- The payroll engine books gross salaries to 7210 and vacation pay to
  -- 7285 (auto-created with its BAS name when first needed).
  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '7010', 'Löner till kollektivanställda', 7, '70', 'expense', 'debit', 'k1', true, '7322'),
      (v_user_id, p_company_id, '7210', 'Löner till tjänstemän', 7, '72', 'expense', 'debit', 'k1', true, '7322'),
      (v_user_id, p_company_id, '7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', 'k1', true, '7322');
  END IF;

  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '7960', 'Valutakursförluster', 7, '79', 'expense', 'debit', 'k1', true, '7360');

  -- Financial (8xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '8310', 'Ränteintäkter', 8, '83', 'revenue', 'credit', 'k1', true, '7313'),
    (v_user_id, p_company_id, '8410', 'Räntekostnader', 8, '84', 'expense', 'debit', 'k1', true, '7323');
END;
$$;

NOTIFY pgrst, 'reload schema';
