-- Repair the SRU codes on chart_of_accounts and in seed_chart_of_accounts.
--
-- Report 2026-09-10 (support): the chart showed 2614 and 2645 under SRU 7231
-- ("Andelar i intresseföretag"); the customer expected 7369 ("Övriga
-- skulder"). The customer was right, and the defect is wider than two
-- accounts: sru_code was assigned by the range table in
-- 20240101000021_sru_codes.sql (mirrored in lib/bookkeeping/bas-data/
-- sru-mapping.ts), which mixed made-up NE-style codes for the income
-- statement (7310-7325; the NE-bilaga uses 7400-7505) with a coarse
-- balance-sheet table whose codes mostly do not exist on INK2R (7203,
-- 7210-7212, 7220-7222) or point at the wrong post (all of 12xx on 7202
-- "Förskott immateriella", 21xx-24xx on 7230 "Andelar i koncernföretag",
-- 25xx-29xx on 7231). The INK2 filing engine never read sru_code (it maps
-- by account range itself), so no declaration was affected; the chart of
-- accounts, the accounts API and the SIE export (#SRU records) were.
--
-- Target: the INK2R code from the engine's own BAS-to-SRU table
-- (lib/reports/ink2/account-mappings.ts, bas.se/kontoplaner/sru/), so the
-- chart, the SIE #SRU records and the filed form agree.
--
-- Two parts:
--   1. Backfill existing rows, but ONLY where sru_code still equals the value
--      the old table would have assigned to that account number. A code a
--      user set by hand (the chart lets you edit it inline) is never touched.
--      NULL stays NULL (enskild firma equity accounts are NULL on purpose).
--   2. Redefine seed_chart_of_accounts with the corrected literals so new
--      companies start right. Body otherwise identical to 20260908143051
--      (the latest definition); signature unchanged, grants kept.

UPDATE public.chart_of_accounts
SET sru_code = CASE
      WHEN account_number !~ '^[0-9]{4}$' THEN NULL
      WHEN account_number = '8999' THEN '7450'
      WHEN account_number BETWEEN '1010' AND '1079' THEN '7201'
      WHEN account_number BETWEEN '1090' AND '1099' THEN '7201'
      WHEN account_number BETWEEN '1080' AND '1089' THEN '7202'
      WHEN account_number BETWEEN '1100' AND '1119' THEN '7214'
      WHEN account_number BETWEEN '1130' AND '1179' THEN '7214'
      WHEN account_number BETWEEN '1190' AND '1199' THEN '7214'
      WHEN account_number BETWEEN '1200' AND '1299' THEN '7215'
      WHEN account_number BETWEEN '1120' AND '1129' THEN '7216'
      WHEN account_number BETWEEN '1180' AND '1189' THEN '7217'
      WHEN account_number BETWEEN '1310' AND '1319' THEN '7230'
      WHEN account_number BETWEEN '1330' AND '1338' THEN '7231'
      WHEN account_number BETWEEN '1350' AND '1359' THEN '7233'
      WHEN account_number BETWEEN '1380' AND '1389' THEN '7233'
      WHEN account_number BETWEEN '1320' AND '1329' THEN '7232'
      WHEN account_number BETWEEN '1340' AND '1349' THEN '7232'
      WHEN account_number BETWEEN '1360' AND '1369' THEN '7234'
      WHEN account_number BETWEEN '1370' AND '1379' THEN '7235'
      WHEN account_number BETWEEN '1390' AND '1399' THEN '7235'
      WHEN account_number BETWEEN '1410' AND '1429' THEN '7241'
      WHEN account_number BETWEEN '1440' AND '1449' THEN '7242'
      WHEN account_number BETWEEN '1450' AND '1469' THEN '7243'
      WHEN account_number BETWEEN '1470' AND '1489' THEN '7244'
      WHEN account_number BETWEEN '1490' AND '1499' THEN '7245'
      WHEN account_number BETWEEN '1400' AND '1409' THEN '7246'
      WHEN account_number BETWEEN '1500' AND '1519' THEN '7251'
      WHEN account_number BETWEEN '1560' AND '1579' THEN '7252'
      WHEN account_number BETWEEN '1520' AND '1559' THEN '7261'
      WHEN account_number BETWEEN '1580' AND '1599' THEN '7261'
      WHEN account_number BETWEEN '1600' AND '1619' THEN '7261'
      WHEN account_number BETWEEN '1621' AND '1699' THEN '7261'
      WHEN account_number BETWEEN '1620' AND '1620' THEN '7262'
      WHEN account_number BETWEEN '1700' AND '1799' THEN '7263'
      WHEN account_number BETWEEN '1860' AND '1869' THEN '7270'
      WHEN account_number BETWEEN '1800' AND '1859' THEN '7271'
      WHEN account_number BETWEEN '1870' AND '1899' THEN '7271'
      WHEN account_number BETWEEN '1900' AND '1999' THEN '7281'
      WHEN account_number BETWEEN '2010' AND '2089' THEN '7301'
      WHEN account_number BETWEEN '2090' AND '2099' THEN '7302'
      WHEN account_number BETWEEN '2100' AND '2109' THEN '7321'
      WHEN account_number BETWEEN '2110' AND '2129' THEN '7321'
      WHEN account_number BETWEEN '2150' AND '2159' THEN '7322'
      WHEN account_number BETWEEN '2130' AND '2149' THEN '7323'
      WHEN account_number BETWEEN '2160' AND '2199' THEN '7323'
      WHEN account_number BETWEEN '2210' AND '2219' THEN '7331'
      WHEN account_number BETWEEN '2220' AND '2229' THEN '7332'
      WHEN account_number BETWEEN '2230' AND '2299' THEN '7333'
      WHEN account_number BETWEEN '2300' AND '2319' THEN '7350'
      WHEN account_number BETWEEN '2320' AND '2329' THEN '7350'
      WHEN account_number BETWEEN '2330' AND '2339' THEN '7351'
      WHEN account_number BETWEEN '2340' AND '2359' THEN '7352'
      WHEN account_number BETWEEN '2360' AND '2379' THEN '7353'
      WHEN account_number BETWEEN '2380' AND '2399' THEN '7354'
      WHEN account_number BETWEEN '2410' AND '2419' THEN '7360'
      WHEN account_number BETWEEN '2420' AND '2439' THEN '7361'
      WHEN account_number BETWEEN '2400' AND '2409' THEN '7362'
      WHEN account_number BETWEEN '2450' AND '2459' THEN '7363'
      WHEN account_number BETWEEN '2460' AND '2469' THEN '7364'
      WHEN account_number BETWEEN '2440' AND '2449' THEN '7365'
      WHEN account_number BETWEEN '2490' AND '2490' THEN '7366'
      WHEN account_number BETWEEN '2470' AND '2479' THEN '7367'
      WHEN account_number BETWEEN '2480' AND '2489' THEN '7369'
      WHEN account_number BETWEEN '2491' AND '2499' THEN '7369'
      WHEN account_number BETWEEN '2600' AND '2799' THEN '7369'
      WHEN account_number BETWEEN '2800' AND '2899' THEN '7369'
      WHEN account_number BETWEEN '2500' AND '2599' THEN '7368'
      WHEN account_number BETWEEN '2900' AND '2999' THEN '7370'
      WHEN account_number BETWEEN '3000' AND '3799' THEN '7410'
      WHEN account_number BETWEEN '3800' AND '3899' THEN '7412'
      WHEN account_number BETWEEN '3900' AND '3999' THEN '7413'
      WHEN account_number BETWEEN '4900' AND '4999' THEN '7411'
      WHEN account_number BETWEEN '4000' AND '4499' THEN '7511'
      WHEN account_number BETWEEN '4500' AND '4599' THEN '7511'
      WHEN account_number BETWEEN '4700' AND '4899' THEN '7511'
      WHEN account_number BETWEEN '4600' AND '4699' THEN '7512'
      WHEN account_number BETWEEN '5000' AND '6999' THEN '7513'
      WHEN account_number BETWEEN '7000' AND '7699' THEN '7514'
      WHEN account_number BETWEEN '7700' AND '7739' THEN '7515'
      WHEN account_number BETWEEN '7750' AND '7789' THEN '7515'
      WHEN account_number BETWEEN '7800' AND '7899' THEN '7515'
      WHEN account_number BETWEEN '7740' AND '7749' THEN '7516'
      WHEN account_number BETWEEN '7790' AND '7799' THEN '7516'
      WHEN account_number BETWEEN '7900' AND '7999' THEN '7517'
      WHEN account_number BETWEEN '8000' AND '8099' THEN '7414'
      WHEN account_number BETWEEN '8100' AND '8199' THEN '7415'
      WHEN account_number BETWEEN '8200' AND '8269' THEN '7423'
      WHEN account_number BETWEEN '8270' AND '8299' THEN '7416'
      WHEN account_number BETWEEN '8300' AND '8399' THEN '7417'
      WHEN account_number BETWEEN '8400' AND '8499' THEN '7522'
      WHEN account_number BETWEEN '8500' AND '8599' THEN '7521'
      WHEN account_number BETWEEN '8811' AND '8811' THEN '7525'
      WHEN account_number BETWEEN '8819' AND '8819' THEN '7420'
      WHEN account_number BETWEEN '8820' AND '8820' THEN '7419'
      WHEN account_number BETWEEN '8830' AND '8830' THEN '7524'
      WHEN account_number BETWEEN '8850' AND '8859' THEN '7421'
      WHEN account_number BETWEEN '8840' AND '8840' THEN '7422'
      WHEN account_number BETWEEN '8860' AND '8899' THEN '7422'
      WHEN account_number BETWEEN '8900' AND '8989' THEN '7528'
      ELSE NULL
    END,
    updated_at = now()
WHERE sru_code IS NOT NULL
  AND sru_code = CASE
      WHEN account_number BETWEEN '3000' AND '3499' AND account_number <> '3100' THEN '7310'
      WHEN account_number IN ('3100', '3900') OR account_number BETWEEN '3970' AND '3980' THEN '7311'
      WHEN account_number BETWEEN '3200' AND '3299' THEN '7312'
      WHEN account_number BETWEEN '8310' AND '8330' THEN '7313'
      WHEN account_number BETWEEN '4000' AND '4990' THEN '7320'
      WHEN account_number BETWEEN '5000' AND '6990' OR account_number = '7970' THEN '7321'
      WHEN account_number BETWEEN '7000' AND '7699' THEN '7322'
      WHEN account_number BETWEEN '8400' AND '8499' THEN '7323'
      WHEN account_number = '7820' THEN '7324'
      WHEN account_number BETWEEN '7700' AND '7899' THEN '7325'
      WHEN account_number BETWEEN '1000' AND '1099' THEN '7201'
      WHEN account_number BETWEEN '1100' AND '1299' THEN '7202'
      WHEN account_number BETWEEN '1300' AND '1399' THEN '7203'
      WHEN account_number BETWEEN '1400' AND '1499' THEN '7210'
      WHEN account_number BETWEEN '1500' AND '1599' THEN '7211'
      WHEN account_number BETWEEN '1600' AND '1999' THEN '7212'
      WHEN account_number = '2081' THEN '7220'
      WHEN account_number BETWEEN '2085' AND '2098' THEN '7221'
      WHEN account_number = '2099' THEN '7222'
      WHEN account_number BETWEEN '2100' AND '2499' THEN '7230'
      WHEN account_number BETWEEN '2500' AND '2999' THEN '7231'
      WHEN account_number BETWEEN '3000' AND '3999' THEN '7310'
      WHEN account_number BETWEEN '4000' AND '4999' THEN '7320'
      WHEN account_number BETWEEN '5000' AND '6999' THEN '7330'
      WHEN account_number BETWEEN '7000' AND '7699' THEN '7340'
      WHEN account_number BETWEEN '7700' AND '7899' THEN '7350'
      WHEN account_number BETWEEN '7900' AND '7999' THEN '7360'
      WHEN account_number BETWEEN '8000' AND '8499' THEN '7370'
      WHEN account_number BETWEEN '8500' AND '8999' THEN '7380'
      WHEN account_number BETWEEN '2000' AND '2084' THEN '7221'
      ELSE NULL
    END
  AND sru_code IS DISTINCT FROM CASE
      WHEN account_number !~ '^[0-9]{4}$' THEN NULL
      WHEN account_number = '8999' THEN '7450'
      WHEN account_number BETWEEN '1010' AND '1079' THEN '7201'
      WHEN account_number BETWEEN '1090' AND '1099' THEN '7201'
      WHEN account_number BETWEEN '1080' AND '1089' THEN '7202'
      WHEN account_number BETWEEN '1100' AND '1119' THEN '7214'
      WHEN account_number BETWEEN '1130' AND '1179' THEN '7214'
      WHEN account_number BETWEEN '1190' AND '1199' THEN '7214'
      WHEN account_number BETWEEN '1200' AND '1299' THEN '7215'
      WHEN account_number BETWEEN '1120' AND '1129' THEN '7216'
      WHEN account_number BETWEEN '1180' AND '1189' THEN '7217'
      WHEN account_number BETWEEN '1310' AND '1319' THEN '7230'
      WHEN account_number BETWEEN '1330' AND '1338' THEN '7231'
      WHEN account_number BETWEEN '1350' AND '1359' THEN '7233'
      WHEN account_number BETWEEN '1380' AND '1389' THEN '7233'
      WHEN account_number BETWEEN '1320' AND '1329' THEN '7232'
      WHEN account_number BETWEEN '1340' AND '1349' THEN '7232'
      WHEN account_number BETWEEN '1360' AND '1369' THEN '7234'
      WHEN account_number BETWEEN '1370' AND '1379' THEN '7235'
      WHEN account_number BETWEEN '1390' AND '1399' THEN '7235'
      WHEN account_number BETWEEN '1410' AND '1429' THEN '7241'
      WHEN account_number BETWEEN '1440' AND '1449' THEN '7242'
      WHEN account_number BETWEEN '1450' AND '1469' THEN '7243'
      WHEN account_number BETWEEN '1470' AND '1489' THEN '7244'
      WHEN account_number BETWEEN '1490' AND '1499' THEN '7245'
      WHEN account_number BETWEEN '1400' AND '1409' THEN '7246'
      WHEN account_number BETWEEN '1500' AND '1519' THEN '7251'
      WHEN account_number BETWEEN '1560' AND '1579' THEN '7252'
      WHEN account_number BETWEEN '1520' AND '1559' THEN '7261'
      WHEN account_number BETWEEN '1580' AND '1599' THEN '7261'
      WHEN account_number BETWEEN '1600' AND '1619' THEN '7261'
      WHEN account_number BETWEEN '1621' AND '1699' THEN '7261'
      WHEN account_number BETWEEN '1620' AND '1620' THEN '7262'
      WHEN account_number BETWEEN '1700' AND '1799' THEN '7263'
      WHEN account_number BETWEEN '1860' AND '1869' THEN '7270'
      WHEN account_number BETWEEN '1800' AND '1859' THEN '7271'
      WHEN account_number BETWEEN '1870' AND '1899' THEN '7271'
      WHEN account_number BETWEEN '1900' AND '1999' THEN '7281'
      WHEN account_number BETWEEN '2010' AND '2089' THEN '7301'
      WHEN account_number BETWEEN '2090' AND '2099' THEN '7302'
      WHEN account_number BETWEEN '2100' AND '2109' THEN '7321'
      WHEN account_number BETWEEN '2110' AND '2129' THEN '7321'
      WHEN account_number BETWEEN '2150' AND '2159' THEN '7322'
      WHEN account_number BETWEEN '2130' AND '2149' THEN '7323'
      WHEN account_number BETWEEN '2160' AND '2199' THEN '7323'
      WHEN account_number BETWEEN '2210' AND '2219' THEN '7331'
      WHEN account_number BETWEEN '2220' AND '2229' THEN '7332'
      WHEN account_number BETWEEN '2230' AND '2299' THEN '7333'
      WHEN account_number BETWEEN '2300' AND '2319' THEN '7350'
      WHEN account_number BETWEEN '2320' AND '2329' THEN '7350'
      WHEN account_number BETWEEN '2330' AND '2339' THEN '7351'
      WHEN account_number BETWEEN '2340' AND '2359' THEN '7352'
      WHEN account_number BETWEEN '2360' AND '2379' THEN '7353'
      WHEN account_number BETWEEN '2380' AND '2399' THEN '7354'
      WHEN account_number BETWEEN '2410' AND '2419' THEN '7360'
      WHEN account_number BETWEEN '2420' AND '2439' THEN '7361'
      WHEN account_number BETWEEN '2400' AND '2409' THEN '7362'
      WHEN account_number BETWEEN '2450' AND '2459' THEN '7363'
      WHEN account_number BETWEEN '2460' AND '2469' THEN '7364'
      WHEN account_number BETWEEN '2440' AND '2449' THEN '7365'
      WHEN account_number BETWEEN '2490' AND '2490' THEN '7366'
      WHEN account_number BETWEEN '2470' AND '2479' THEN '7367'
      WHEN account_number BETWEEN '2480' AND '2489' THEN '7369'
      WHEN account_number BETWEEN '2491' AND '2499' THEN '7369'
      WHEN account_number BETWEEN '2600' AND '2799' THEN '7369'
      WHEN account_number BETWEEN '2800' AND '2899' THEN '7369'
      WHEN account_number BETWEEN '2500' AND '2599' THEN '7368'
      WHEN account_number BETWEEN '2900' AND '2999' THEN '7370'
      WHEN account_number BETWEEN '3000' AND '3799' THEN '7410'
      WHEN account_number BETWEEN '3800' AND '3899' THEN '7412'
      WHEN account_number BETWEEN '3900' AND '3999' THEN '7413'
      WHEN account_number BETWEEN '4900' AND '4999' THEN '7411'
      WHEN account_number BETWEEN '4000' AND '4499' THEN '7511'
      WHEN account_number BETWEEN '4500' AND '4599' THEN '7511'
      WHEN account_number BETWEEN '4700' AND '4899' THEN '7511'
      WHEN account_number BETWEEN '4600' AND '4699' THEN '7512'
      WHEN account_number BETWEEN '5000' AND '6999' THEN '7513'
      WHEN account_number BETWEEN '7000' AND '7699' THEN '7514'
      WHEN account_number BETWEEN '7700' AND '7739' THEN '7515'
      WHEN account_number BETWEEN '7750' AND '7789' THEN '7515'
      WHEN account_number BETWEEN '7800' AND '7899' THEN '7515'
      WHEN account_number BETWEEN '7740' AND '7749' THEN '7516'
      WHEN account_number BETWEEN '7790' AND '7799' THEN '7516'
      WHEN account_number BETWEEN '7900' AND '7999' THEN '7517'
      WHEN account_number BETWEEN '8000' AND '8099' THEN '7414'
      WHEN account_number BETWEEN '8100' AND '8199' THEN '7415'
      WHEN account_number BETWEEN '8200' AND '8269' THEN '7423'
      WHEN account_number BETWEEN '8270' AND '8299' THEN '7416'
      WHEN account_number BETWEEN '8300' AND '8399' THEN '7417'
      WHEN account_number BETWEEN '8400' AND '8499' THEN '7522'
      WHEN account_number BETWEEN '8500' AND '8599' THEN '7521'
      WHEN account_number BETWEEN '8811' AND '8811' THEN '7525'
      WHEN account_number BETWEEN '8819' AND '8819' THEN '7420'
      WHEN account_number BETWEEN '8820' AND '8820' THEN '7419'
      WHEN account_number BETWEEN '8830' AND '8830' THEN '7524'
      WHEN account_number BETWEEN '8850' AND '8859' THEN '7421'
      WHEN account_number BETWEEN '8840' AND '8840' THEN '7422'
      WHEN account_number BETWEEN '8860' AND '8899' THEN '7422'
      WHEN account_number BETWEEN '8900' AND '8989' THEN '7528'
      ELSE NULL
    END;

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
  IF p_entity_type = 'aktiebolag' THEN
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
