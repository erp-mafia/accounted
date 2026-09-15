-- =============================================================================
-- Bostadsrättsförening as a fifth legal form (foundation, behind a flag)
--
-- A bostadsrättsförening is an ekonomisk förening whose purpose is to grant
-- bostadsrätt in its buildings (BRL 1991:614 1 kap. 1 §; EFL 2018:672 applies
-- where BRL is silent). Everything the ekonomisk förening foundation
-- (20260915150000) added carries over; this migration widens the value set
-- and adds what the form needs of its own:
--   1. CHECK constraints on companies, company_settings and
--      booking_template_library accept 'bostadsrattsforening' (added NOT
--      VALID, validated in 20260915170100 under SHARE UPDATE EXCLUSIVE).
--   2. supported_entity_types(): the one allow-list of the create RPCs.
--   3. seed_chart_of_accounts(): a BRF block that is the ekonomisk förening
--      block plus the building and its components (1110-1130, K3 17.4 with
--      38.10), 2087 relabelled Upplåtelseavgifter (ÅRL 3 kap. 10 b § counts
--      them as insatser; BAS has no account), 2088 Fond för yttre underhåll
--      (K3 38.11), 2892 Inre reparationsfond (a liability to the members),
--      the årsavgift and hyra revenue split (3011-3033), the property costs
--      needed for the ÅRL 6 kap. 3 a § nyckeltal and 7830 depreciation.
--      Every other seed is byte-identical to 20260915150000.
--   4. brf_property_facts: the per-company facts the nyckeltal and
--      fastighetsavgift need and the ledger does not hold (kvm upplåten med
--      bostadsrätt/hyresrätt, lägenheter, taxeringsvärde, tomträtt,
--      samfällighet, underhållsplan).
--   5. brf_tax_profiles: the per-year privatbostadsföretag assessment (IL 2
--      kap. 17 §: at least 60 % of the activity, measured by hyresvärde on
--      the taxeringsvärde, consists of providing homes to members) that
--      decides whether IL 39 kap. 25 § removes the property result from the
--      tax base. Re-assessed every year, hence one row per fiscal year.
--
-- Product creation stays gated by NEXT_PUBLIC_BOSTADSRATTSFORENING_ENABLED
-- until the K3 document, the fastighetsavgift step and the apartment register
-- ship; the database accepts the value regardless.
-- =============================================================================

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_entity_type_check;
ALTER TABLE public.companies
  ADD CONSTRAINT companies_entity_type_check
  CHECK (entity_type IN ('enskild_firma', 'aktiebolag', 'ideell_forening', 'ekonomisk_forening', 'bostadsrattsforening'))
  NOT VALID;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_entity_type_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_entity_type_check
  CHECK (entity_type IN ('enskild_firma', 'aktiebolag', 'ideell_forening', 'ekonomisk_forening', 'bostadsrattsforening'))
  NOT VALID;

ALTER TABLE public.booking_template_library
  DROP CONSTRAINT IF EXISTS booking_template_library_entity_type_check;
ALTER TABLE public.booking_template_library
  ADD CONSTRAINT booking_template_library_entity_type_check
  CHECK (entity_type IN ('all', 'enskild_firma', 'aktiebolag', 'ideell_forening', 'ekonomisk_forening', 'bostadsrattsforening'))
  NOT VALID;

CREATE OR REPLACE FUNCTION public.supported_entity_types()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY['enskild_firma', 'aktiebolag', 'ideell_forening', 'ekonomisk_forening', 'bostadsrattsforening']::text[];
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

  IF p_entity_type = 'bostadsrattsforening' THEN
    -- A bostadsrättsförening is an ekonomisk förening (BRL 1 kap. 1 §): the
    -- same member-capital equity, plus upplåtelseavgifter (ÅRL 3 kap. 10 b §
    -- treats them as insatser; BAS has no account of its own, so 2087 is
    -- relabelled, see lib/bookkeeping/form-accounts.ts) and the fond för
    -- yttre underhåll as its own bundet post (K3 38.11). The building and
    -- its components (K3 17.4 with 38.10) are seeded because every BRF owns
    -- one; 1113-1117 are free BAS numbers used for the component split.
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '1110', 'Byggnader', 1, '11', 'asset', 'debit', 'k1', true, '7214'),
      (v_user_id, p_company_id, '1113', 'Byggnader, komponent stomme och grund', 1, '11', 'asset', 'debit', 'k1', true, '7214'),
      (v_user_id, p_company_id, '1114', 'Byggnader, komponent fasad och fönster', 1, '11', 'asset', 'debit', 'k1', true, '7214'),
      (v_user_id, p_company_id, '1115', 'Byggnader, komponent tak', 1, '11', 'asset', 'debit', 'k1', true, '7214'),
      (v_user_id, p_company_id, '1116', 'Byggnader, komponent stammar och VVS', 1, '11', 'asset', 'debit', 'k1', true, '7214'),
      (v_user_id, p_company_id, '1117', 'Byggnader, komponent installationer', 1, '11', 'asset', 'debit', 'k1', true, '7214'),
      (v_user_id, p_company_id, '1119', 'Ackumulerade avskrivningar på byggnader', 1, '11', 'asset', 'credit', 'k1', true, '7214'),
      (v_user_id, p_company_id, '1130', 'Mark', 1, '11', 'asset', 'debit', 'k1', true, '7214'),
      (v_user_id, p_company_id, '2083', 'Insatser', 2, '20', 'equity', 'credit', 'k1', true, '7301'),
      (v_user_id, p_company_id, '2084', 'Förlagsinsatser', 2, '20', 'equity', 'credit', 'k1', true, '7301'),
      (v_user_id, p_company_id, '2086', 'Reservfond', 2, '20', 'equity', 'credit', 'k1', true, '7301'),
      (v_user_id, p_company_id, '2087', 'Upplåtelseavgifter', 2, '20', 'equity', 'credit', 'k1', true, '7301'),
      (v_user_id, p_company_id, '2088', 'Fond för yttre underhåll', 2, '20', 'equity', 'credit', 'k1', true, '7301'),
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

  IF p_entity_type = 'bostadsrattsforening' THEN
    -- 2890 member settlement as for any förening; 2892 the inre
    -- reparationsfond, which belongs to the bostadsrättshavare and is a
    -- liability, never eget kapital.
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '2890', 'Övriga kortfristiga skulder', 2, '28', 'liability', 'credit', 'k1', true, '7369'),
      (v_user_id, p_company_id, '2892', 'Inre reparationsfond', 2, '28', 'liability', 'credit', 'k1', true, '7369');
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

  IF p_entity_type = 'bostadsrattsforening' THEN
    -- Årsavgifter and hyror per BRL 7 kap. 14 § and the stadgar, split so
    -- the ÅRL 6 kap. 3 a § nyckeltal (årsavgift per kvm, nettoomsättningens
    -- fördelning per K3 38.13) can be read from the ledger. 3011-3033 are not
    -- BAS reference accounts (see lib/bookkeeping/form-accounts.ts).
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '3011', 'Hyresintäkter bostäder', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
      (v_user_id, p_company_id, '3012', 'Hyresintäkter lokaler', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
      (v_user_id, p_company_id, '3013', 'Hyresintäkter garage', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
      (v_user_id, p_company_id, '3014', 'Hyresintäkter parkeringsplatser', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
      (v_user_id, p_company_id, '3020', 'Årsavgifter bostäder', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
      (v_user_id, p_company_id, '3021', 'Årsavgifter lokaler', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
      (v_user_id, p_company_id, '3031', 'Överlåtelseavgifter', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
      (v_user_id, p_company_id, '3032', 'Pantsättningsavgifter', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
      (v_user_id, p_company_id, '3033', 'Andrahandsupplåtelseavgifter', 3, '30', 'revenue', 'credit', 'k1', true, '7410'),
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

  IF p_entity_type = 'bostadsrattsforening' THEN
    -- Property running costs: 5191 fastighetsskatt/fastighetsavgift (lag
    -- 2007:1398) and the BAS 53 energy accounts kept apart so värme (5370),
    -- el (5310) and vatten (5380) can be summed into energikostnad per kvm
    -- (ÅRL 6 kap. 3 a §, K3 38.7); 5170 for repairs and maintenance.
    INSERT INTO public.chart_of_accounts (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    VALUES
      (v_user_id, p_company_id, '5170', 'Reparation och underhåll av fastighet', 5, '51', 'expense', 'debit', 'k1', true, '7513'),
      (v_user_id, p_company_id, '5191', 'Fastighetsskatt/fastighetsavgift', 5, '51', 'expense', 'debit', 'k1', true, '7513'),
      (v_user_id, p_company_id, '5192', 'Fastighetsförsäkringspremier', 5, '51', 'expense', 'debit', 'k1', true, '7513'),
      (v_user_id, p_company_id, '5310', 'El för drift', 5, '53', 'expense', 'debit', 'k1', true, '7513'),
      (v_user_id, p_company_id, '5370', 'Fjärrvärme, kyla och ånga för drift', 5, '53', 'expense', 'debit', 'k1', true, '7513'),
      (v_user_id, p_company_id, '5380', 'Vatten för drift', 5, '53', 'expense', 'debit', 'k1', true, '7513'),
      (v_user_id, p_company_id, '7830', 'Avskrivningar på byggnader och markanläggningar', 7, '78', 'expense', 'debit', 'k1', true, '7515');
  END IF;

  -- Personnel (7xxx). BAS names: 7010 kollektivanställda, 7210 tjänstemän.
  -- The payroll engine books gross salaries to 7210 and vacation pay to
  -- 7285 (auto-created with its BAS name when first needed).
  IF p_entity_type IN ('aktiebolag', 'ekonomisk_forening', 'bostadsrattsforening') THEN
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

-- -----------------------------------------------------------------------------
-- brf_property_facts: one row per company (what the nyckeltal need).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brf_property_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL UNIQUE REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Square metres upplåtna med bostadsrätt, uthyrda med hyresrätt and lokaler
  -- (ÅRL 6 kap. 3 a §: årsavgift, skuldsättning, sparande and energikostnad
  -- are all "per kvadratmeter").
  kvm_bostadsratt NUMERIC(12, 2) CHECK (kvm_bostadsratt IS NULL OR kvm_bostadsratt >= 0),
  kvm_hyresratt NUMERIC(12, 2) CHECK (kvm_hyresratt IS NULL OR kvm_hyresratt >= 0),
  kvm_lokaler NUMERIC(12, 2) CHECK (kvm_lokaler IS NULL OR kvm_lokaler >= 0),
  antal_bostadslagenheter INTEGER CHECK (antal_bostadslagenheter IS NULL OR antal_bostadslagenheter >= 0),
  antal_lokaler INTEGER CHECK (antal_lokaler IS NULL OR antal_lokaler >= 0),
  -- Taxeringsvärde in whole kronor: the fastighetsavgift cap (0,3 % of it)
  -- and the IL 2 kap. 17 § hyresvärde test both start here.
  taxeringsvarde NUMERIC(15, 2) CHECK (taxeringsvarde IS NULL OR taxeringsvarde >= 0),
  tomtratt BOOLEAN,
  tomtratt_avgald_until DATE,
  samfallighet TEXT CHECK (samfallighet IS NULL OR char_length(samfallighet) <= 500),
  underhallsplan BOOLEAN,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.brf_property_facts IS
  'Bostadsrättsförening: kvm, lägenheter, taxeringsvärde, tomträtt, samfällighet och underhållsplan för nyckeltalen i förvaltningsberättelsen (ÅRL 6 kap. 3 a §, K3 kap. 38) och fastighetsavgiften.';

DROP TRIGGER IF EXISTS brf_property_facts_updated_at ON public.brf_property_facts;
CREATE TRIGGER brf_property_facts_updated_at
  BEFORE UPDATE ON public.brf_property_facts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.brf_property_facts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brf_property_facts_select" ON public.brf_property_facts;
CREATE POLICY "brf_property_facts_select" ON public.brf_property_facts
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "brf_property_facts_insert" ON public.brf_property_facts;
CREATE POLICY "brf_property_facts_insert" ON public.brf_property_facts
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );
DROP POLICY IF EXISTS "brf_property_facts_update" ON public.brf_property_facts;
CREATE POLICY "brf_property_facts_update" ON public.brf_property_facts
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

-- -----------------------------------------------------------------------------
-- brf_tax_profiles: the privatbostadsföretag assessment, one row per year.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.brf_tax_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The taxation year the assessment is made for (IL 2 kap. 17 § is judged
  -- per beskattningsår from the latest taxeringsvärde).
  fiscal_year INTEGER NOT NULL CHECK (fiscal_year BETWEEN 1990 AND 2200),
  privatbostadsforetag BOOLEAN NOT NULL,
  -- The share of the activity (hyresvärde on the taxeringsvärde) that
  -- consists of providing homes to members: the 60 % test input, 0-1.
  qualified_share NUMERIC(6, 4) CHECK (qualified_share IS NULL OR (qualified_share >= 0 AND qualified_share <= 1)),
  assessed_on DATE NOT NULL,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brf_tax_profiles_company_year_unique UNIQUE (company_id, fiscal_year)
);

COMMENT ON TABLE public.brf_tax_profiles IS
  'Bostadsrättsförening: årlig bedömning av om föreningen är ett privatbostadsföretag (IL 2 kap. 17 §, minst 60 % kvalificerad verksamhet) och därmed skattefri för fastighetsinkomsten (IL 39 kap. 25 §).';

CREATE INDEX IF NOT EXISTS idx_brf_tax_profiles_company_year
  ON public.brf_tax_profiles (company_id, fiscal_year DESC);

DROP TRIGGER IF EXISTS brf_tax_profiles_updated_at ON public.brf_tax_profiles;
CREATE TRIGGER brf_tax_profiles_updated_at
  BEFORE UPDATE ON public.brf_tax_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.brf_tax_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brf_tax_profiles_select" ON public.brf_tax_profiles;
CREATE POLICY "brf_tax_profiles_select" ON public.brf_tax_profiles
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "brf_tax_profiles_insert" ON public.brf_tax_profiles;
CREATE POLICY "brf_tax_profiles_insert" ON public.brf_tax_profiles
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin', 'member')
    )
  );
DROP POLICY IF EXISTS "brf_tax_profiles_update" ON public.brf_tax_profiles;
CREATE POLICY "brf_tax_profiles_update" ON public.brf_tax_profiles
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

-- Both tables are facts about the company, not history: a wrong figure is
-- corrected in place (the row is not a bokföringspost), so an admin may
-- delete a stale profile year; viewers and anon may not.
REVOKE DELETE ON TABLE public.brf_property_facts FROM anon;
REVOKE DELETE ON TABLE public.brf_tax_profiles FROM anon;

-- Refresh PostgREST's schema cache after constraints and function metadata change.
NOTIFY pgrst, 'reload schema';
