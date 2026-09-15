-- =============================================================================
-- Ekonomisk förening as a fourth legal form (foundation, behind a flag)
--
-- Widens entity_type to also accept 'ekonomisk_forening' everywhere the value
-- is stored or validated, mirroring 20260908143051 (ideell förening):
--   1. CHECK constraints on companies, company_settings and
--      booking_template_library (the latter keeps 'all').
--   2. supported_entity_types(): the one list the three create RPCs
--      (create_company_with_owner, create_company_for_user,
--      create_company_for_brand_signup) validate against since
--      20260908143051, so no RPC body changes here.
--   3. seed_chart_of_accounts(): an ekonomisk förening block. Bundet eget
--      kapital is member capital, not share capital (ÅRL 3 kap. 10 b §):
--      2083 Medlemsinsatser, 2084 Förlagsinsatser (EFL 10-11 kap.), 2086
--      Reservfond; the result closes to 2099 and carries to 2098 like an AB
--      because the association files INK2 (SRU 7301 bundet / 7302 fritt eget
--      kapital, as fixed in 20260911120000). Member settlement is a plain
--      short-term liability on 2890 (no owner, no aktieägare). 3901
--      Medlemsavgifter (BAS group 39, SRU 7413) isolates the tax-exempt
--      membership fees for the INK2S 4.5c adjustment. Personnel accounts
--      are seeded as for an AB: a förening's workers are employees.
--      Everything else in seed_chart_of_accounts is byte-identical to
--      20260911120000.
--
-- Product creation stays gated by NEXT_PUBLIC_EKONOMISK_FORENING_ENABLED
-- until the annual-report and member-capital work ships; the database accepts
-- the value regardless so the first association can be switched on without a
-- migration.
-- =============================================================================

-- The replacement CHECKs are added NOT VALID so the swap never scans (and
-- never blocks writes to) companies, company_settings or the template
-- library on a live deploy; every existing row already satisfies the wider
-- list. 20260915150300 validates them under SHARE UPDATE EXCLUSIVE.
ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_entity_type_check;
ALTER TABLE public.companies
  ADD CONSTRAINT companies_entity_type_check
  CHECK (entity_type IN ('enskild_firma', 'aktiebolag', 'ideell_forening', 'ekonomisk_forening'))
  NOT VALID;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_entity_type_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_entity_type_check
  CHECK (entity_type IN ('enskild_firma', 'aktiebolag', 'ideell_forening', 'ekonomisk_forening'))
  NOT VALID;

ALTER TABLE public.booking_template_library
  DROP CONSTRAINT IF EXISTS booking_template_library_entity_type_check;
ALTER TABLE public.booking_template_library
  ADD CONSTRAINT booking_template_library_entity_type_check
  CHECK (entity_type IN ('all', 'enskild_firma', 'aktiebolag', 'ideell_forening', 'ekonomisk_forening'))
  NOT VALID;

CREATE OR REPLACE FUNCTION public.supported_entity_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY['enskild_firma', 'aktiebolag', 'ideell_forening', 'ekonomisk_forening']::text[];
$$;

REVOKE ALL ON FUNCTION public.supported_entity_types() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.supported_entity_types() TO anon, authenticated, service_role;

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
    (v_user_id, p_company_id, '1510', 'Kundfordringar', 1, '15', 'asset', 'debit', 'k1', true, '7251'),
    (v_user_id, p_company_id, '1910', 'Kassa', 1, '19', 'asset', 'debit', 'k1', true, '7281'),
    (v_user_id, p_company_id, '1930', 'Företagskonto / checkkonto', 1, '19', 'asset', 'debit', 'k1', true, '7281'),
    (v_user_id, p_company_id, '1940', 'Övriga bankkonton', 1, '19', 'asset', 'debit', 'k1', true, '7281');

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
      (v_user_id, p_company_id, '2081', 'Aktiekapital', 2, '20', 'equity', 'credit', 'k1', true, '7301'),
      (v_user_id, p_company_id, '2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', 'k1', true, '7302'),
      (v_user_id, p_company_id, '2099', 'Årets resultat', 2, '20', 'equity', 'credit', 'k1', true, '7302');
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

  IF p_entity_type = 'ekonomisk_forening' THEN
    -- Bundet eget kapital uses member and debenture contributions, not share
    -- capital. Retained and current-year results remain in the 2090 group.
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2083', 'Medlemsinsatser', 2, '20', 'equity', 'credit', 'k1', true, '7301'),
      (v_user_id, p_company_id, '2084', 'Förlagsinsatser', 2, '20', 'equity', 'credit', 'k1', true, '7301'),
      (v_user_id, p_company_id, '2086', 'Reservfond', 2, '20', 'equity', 'credit', 'k1', true, '7301'),
      (v_user_id, p_company_id, '2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', 'k1', true, '7302'),
      (v_user_id, p_company_id, '2099', 'Årets resultat', 2, '20', 'equity', 'credit', 'k1', true, '7302');
  END IF;

  -- Liabilities (2xxx) - BAS 2026 VAT account labels
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '2440', 'Leverantörsskulder', 2, '24', 'liability', 'credit', 'k1', true, '7365'),
    (v_user_id, p_company_id, '2611', 'Utgående moms försäljning inom Sverige, 25%', 2, '26', 'liability', 'credit', 'k1', true, '7369'),
    (v_user_id, p_company_id, '2621', 'Utgående moms försäljning inom Sverige, 12%', 2, '26', 'liability', 'credit', 'k1', true, '7369'),
    (v_user_id, p_company_id, '2631', 'Utgående moms försäljning inom Sverige, 6%', 2, '26', 'liability', 'credit', 'k1', true, '7369'),
    (v_user_id, p_company_id, '2641', 'Debiterad ingående moms', 2, '26', 'liability', 'credit', 'k1', true, '7369'),
    (v_user_id, p_company_id, '2650', 'Redovisningskonto för moms', 2, '26', 'liability', 'credit', 'k1', true, '7369'),
    (v_user_id, p_company_id, '2710', 'Personalskatt', 2, '27', 'liability', 'credit', 'k1', true, '7369'),
    (v_user_id, p_company_id, '2731', 'Avräkning socialavgifter', 2, '27', 'liability', 'credit', 'k1', true, '7369');

  IF p_entity_type = 'aktiebolag' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2893', 'Skuld till aktieägare', 2, '28', 'liability', 'credit', 'k1', true, '7369');
  END IF;

  IF p_entity_type = 'ideell_forening' THEN
    -- A förening has no owner: money settled with a member (utlägg, an
    -- advance) is a plain short-term liability, the counterpart of EF
    -- 2013/2018 and AB 2893 in the booking paths.
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2890', 'Övriga kortfristiga skulder', 2, '28', 'liability', 'credit', 'k1', true, NULL);
  END IF;

  IF p_entity_type = 'ekonomisk_forening' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2890', 'Övriga kortfristiga skulder', 2, '28', 'liability', 'credit', 'k1', true, '7369');
  END IF;

  -- Membership fees (medlemsavgifter) are övriga rörelseintäkter that are
  -- tax-exempt for the association and outside VAT; a dedicated sub-account
  -- under BAS group 39 lets the INK2S 4.5c adjustment be detected from the
  -- ledger (lib/bokslut/tax-provision/tax-adjustment-service.ts).
  IF p_entity_type = 'ekonomisk_forening' THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '3901', 'Medlemsavgifter', 3, '39', 'revenue', 'credit', 'k1', true, '7413');
  END IF;

  -- Revenue (3xxx). 3001/3002 carry the official BAS 2026 names: 3001 takes
  -- ALL 25% revenue and 3002 is the 12% account (invoice booking, category
  -- mapping and default_vat_rate all treat it as 12%), so the name must say
  -- so.
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '3001', 'Försäljning inom Sverige, 25 % moms', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
    (v_user_id, p_company_id, '3002', 'Försäljning inom Sverige, 12 % moms', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
    (v_user_id, p_company_id, '3100', 'Momsfri försäljning', 3, '31', 'revenue', 'credit', 'k1', true, '7410'),
    (v_user_id, p_company_id, '3900', 'Övriga rörelseintäkter', 3, '39', 'revenue', 'credit', 'k1', true, '7413'),
    (v_user_id, p_company_id, '3960', 'Valutakursvinster', 3, '39', 'revenue', 'credit', 'k1', true, '7413');

  -- COGS (4xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '4000', 'Varuinköp', 4, '40', 'expense', 'debit', 'k1', true, '7511');

  -- External expenses (5xxx-6xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '5010', 'Lokalhyra', 5, '50', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '5410', 'Förbrukningsinventarier', 5, '54', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '5420', 'Programvaror', 5, '54', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '5460', 'Förbrukningsmaterial', 5, '54', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '5800', 'Resekostnader', 5, '58', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '5910', 'Annonsering', 5, '59', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '6071', 'Representation avdragsgill', 6, '60', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '6110', 'Kontorsmateriel', 6, '61', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '6212', 'Mobiltelefon', 6, '62', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '6230', 'Datakommunikation', 6, '62', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '6530', 'Redovisningstjänster', 6, '65', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '6570', 'Bankavgifter', 6, '65', 'expense', 'debit', 'k1', true, '7513'),
    (v_user_id, p_company_id, '6991', 'Övriga avdragsgilla kostnader', 6, '69', 'expense', 'debit', 'k1', true, '7513');

  -- Personnel (7xxx). BAS names: 7010 kollektivanställda, 7210 tjänstemän.
  -- The payroll engine books gross salaries to 7210 and vacation pay to
  -- 7285 (auto-created with its BAS name when first needed).
  IF p_entity_type IN ('aktiebolag', 'ekonomisk_forening') THEN
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '7010', 'Löner till kollektivanställda', 7, '70', 'expense', 'debit', 'k1', true, '7514'),
      (v_user_id, p_company_id, '7210', 'Löner till tjänstemän', 7, '72', 'expense', 'debit', 'k1', true, '7514'),
      (v_user_id, p_company_id, '7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', 'k1', true, '7514');
  END IF;

  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '7960', 'Valutakursförluster', 7, '79', 'expense', 'debit', 'k1', true, '7517');

  -- Financial (8xxx)
  INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
  VALUES
    (v_user_id, p_company_id, '8310', 'Ränteintäkter', 8, '83', 'revenue', 'credit', 'k1', true, '7417'),
    (v_user_id, p_company_id, '8410', 'Räntekostnader', 8, '84', 'expense', 'debit', 'k1', true, '7522');
END;
$$;

-- Refresh PostgREST's schema cache after constraints and function metadata change.
NOTIFY pgrst, 'reload schema';

