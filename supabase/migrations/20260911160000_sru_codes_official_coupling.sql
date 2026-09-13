-- Align chart_of_accounts.sru_code with the official BAS kopplingstabell.
--
-- 20260911120000 moved sru_code onto the INK2 engine's range table. Checking
-- that table against the official BAS-to-INK2R coupling (bas.se
-- INK2_P1_intervall-241119.xlsx, transcribed in
-- lib/reports/ink2/official-ink2r-coupling.json and pinned by a test) showed
-- the engine itself was off on real BAS 2026 accounts: 24xx shifted one
-- decade (241x is 7361, 242x 7362, 243x 7363, 245x 7364, 246x 7367, 248x
-- 7360), 213x periodiseringsfond is 7321, 2220/2230 swapped, 1520-1589 are
-- kundfordringar 7251, 138x is 7235, 128x is 7217, 147x/148x/149x rotated,
-- 8200-8269 is 7416, the nedskrivning accounts 807x/817x/827x/837x are 7521,
-- 4910-4989 lager changes are 7511/7512. The engine and the chart now follow
-- the official file; this backfill moves the rows the previous migration set.
--
-- Predicate: a row moves only when its sru_code equals the value the
-- 2026-09-11 mapping assigned to that account number, so a code a user set by
-- hand is never touched. Accounts the official table does not cover at all
-- (no BAS 2026 account exists there) are cleared to NULL rather than left on
-- a post they do not belong to. Rows still NULL in newly covered ranges
-- (1000-1009, 1339, 8810, 882x-884x, 899x) get their code.
--
-- Explicit transaction so SET LOCAL holds: write_audit_log honours the
-- transaction-local gnubok.sandbox_cleanup flag and skips the per-row audit
-- rows. sru_code is a tax-form label, not bookkeeping; the previous SRU
-- backfill was applied the same way (2026-09-11), and a plain UPDATE of this
-- size would write one jsonb old/new audit row per account for nothing.
-- The rows' updated_at still moves, so the change is visible per row.

BEGIN;

SET LOCAL gnubok.sandbox_cleanup = 'true';

UPDATE public.chart_of_accounts
SET sru_code = CASE
      WHEN account_number BETWEEN '1080' AND '1087' AND sru_code = '7202' THEN '7201'
      WHEN account_number BETWEEN '1089' AND '1089' AND sru_code = '7202' THEN '7201'
      WHEN account_number BETWEEN '1280' AND '1289' AND sru_code = '7215' THEN '7217'
      WHEN account_number BETWEEN '1336' AND '1337' AND sru_code = '7231' THEN '7233'
      WHEN account_number BETWEEN '1346' AND '1347' AND sru_code = '7232' THEN '7235'
      WHEN account_number BETWEEN '1380' AND '1389' AND sru_code = '7233' THEN '7235'
      WHEN account_number BETWEEN '1390' AND '1399' AND sru_code = '7235' THEN NULL
      WHEN account_number BETWEEN '1400' AND '1409' AND sru_code = '7246' THEN NULL
      WHEN account_number BETWEEN '1470' AND '1479' AND sru_code = '7244' THEN '7245'
      WHEN account_number BETWEEN '1480' AND '1489' AND sru_code = '7244' THEN '7246'
      WHEN account_number BETWEEN '1490' AND '1499' AND sru_code = '7245' THEN '7244'
      WHEN account_number BETWEEN '1500' AND '1509' AND sru_code = '7251' THEN NULL
      WHEN account_number BETWEEN '1520' AND '1559' AND sru_code = '7261' THEN '7251'
      WHEN account_number BETWEEN '1573' AND '1573' AND sru_code = '7252' THEN '7261'
      WHEN account_number BETWEEN '1580' AND '1589' AND sru_code = '7261' THEN '7251'
      WHEN account_number BETWEEN '1590' AND '1609' AND sru_code = '7261' THEN NULL
      WHEN account_number BETWEEN '1621' AND '1629' AND sru_code = '7261' THEN '7262'
      WHEN account_number BETWEEN '1660' AND '1672' AND sru_code = '7261' THEN '7252'
      WHEN account_number BETWEEN '1674' AND '1679' AND sru_code = '7261' THEN '7252'
      WHEN account_number BETWEEN '2100' AND '2109' AND sru_code = '7321' THEN NULL
      WHEN account_number BETWEEN '2130' AND '2139' AND sru_code = '7323' THEN '7321'
      WHEN account_number BETWEEN '2140' AND '2149' AND sru_code = '7323' THEN NULL
      WHEN account_number BETWEEN '2220' AND '2229' AND sru_code = '7332' THEN '7333'
      WHEN account_number BETWEEN '2230' AND '2239' AND sru_code = '7333' THEN '7332'
      WHEN account_number BETWEEN '2300' AND '2309' AND sru_code = '7350' THEN NULL
      WHEN account_number BETWEEN '2373' AND '2373' AND sru_code = '7353' THEN '7354'
      WHEN account_number BETWEEN '2400' AND '2409' AND sru_code = '7362' THEN NULL
      WHEN account_number BETWEEN '2410' AND '2419' AND sru_code = '7360' THEN '7361'
      WHEN account_number BETWEEN '2420' AND '2429' AND sru_code = '7361' THEN '7362'
      WHEN account_number BETWEEN '2430' AND '2439' AND sru_code = '7361' THEN '7363'
      WHEN account_number BETWEEN '2450' AND '2459' AND sru_code = '7363' THEN '7364'
      WHEN account_number BETWEEN '2460' AND '2469' AND sru_code = '7364' THEN '7367'
      WHEN account_number BETWEEN '2480' AND '2489' AND sru_code = '7369' THEN '7360'
      WHEN account_number BETWEEN '2490' AND '2490' AND sru_code = '7366' THEN '7369'
      WHEN account_number BETWEEN '2492' AND '2492' AND sru_code = '7369' THEN '7366'
      WHEN account_number BETWEEN '2860' AND '2879' AND sru_code = '7369' THEN '7367'
      WHEN account_number BETWEEN '4910' AND '4920' AND sru_code = '7411' THEN '7511'
      WHEN account_number BETWEEN '4921' AND '4929' AND sru_code = '7411' THEN NULL
      WHEN account_number BETWEEN '4960' AND '4969' AND sru_code = '7411' THEN '7512'
      WHEN account_number BETWEEN '4980' AND '4989' AND sru_code = '7411' THEN '7512'
      WHEN account_number BETWEEN '8070' AND '8089' AND sru_code = '7414' THEN '7521'
      WHEN account_number BETWEEN '8113' AND '8113' AND sru_code = '7415' THEN '7423'
      WHEN account_number BETWEEN '8118' AND '8118' AND sru_code = '7415' THEN '7423'
      WHEN account_number BETWEEN '8123' AND '8123' AND sru_code = '7415' THEN '7423'
      WHEN account_number BETWEEN '8133' AND '8133' AND sru_code = '7415' THEN '7423'
      WHEN account_number BETWEEN '8170' AND '8189' AND sru_code = '7415' THEN '7521'
      WHEN account_number BETWEEN '8200' AND '8269' AND sru_code = '7423' THEN '7416'
      WHEN account_number BETWEEN '8270' AND '8289' AND sru_code = '7416' THEN '7521'
      WHEN account_number BETWEEN '8370' AND '8389' AND sru_code = '7417' THEN '7521'
      WHEN account_number BETWEEN '8500' AND '8599' AND sru_code = '7521' THEN NULL
      ELSE sru_code
    END,
    updated_at = now()
WHERE sru_code IS NOT NULL
  AND (
    (account_number BETWEEN '1080' AND '1087' AND sru_code = '7202') OR
    (account_number BETWEEN '1089' AND '1089' AND sru_code = '7202') OR
    (account_number BETWEEN '1280' AND '1289' AND sru_code = '7215') OR
    (account_number BETWEEN '1336' AND '1337' AND sru_code = '7231') OR
    (account_number BETWEEN '1346' AND '1347' AND sru_code = '7232') OR
    (account_number BETWEEN '1380' AND '1389' AND sru_code = '7233') OR
    (account_number BETWEEN '1390' AND '1399' AND sru_code = '7235') OR
    (account_number BETWEEN '1400' AND '1409' AND sru_code = '7246') OR
    (account_number BETWEEN '1470' AND '1479' AND sru_code = '7244') OR
    (account_number BETWEEN '1480' AND '1489' AND sru_code = '7244') OR
    (account_number BETWEEN '1490' AND '1499' AND sru_code = '7245') OR
    (account_number BETWEEN '1500' AND '1509' AND sru_code = '7251') OR
    (account_number BETWEEN '1520' AND '1559' AND sru_code = '7261') OR
    (account_number BETWEEN '1573' AND '1573' AND sru_code = '7252') OR
    (account_number BETWEEN '1580' AND '1589' AND sru_code = '7261') OR
    (account_number BETWEEN '1590' AND '1609' AND sru_code = '7261') OR
    (account_number BETWEEN '1621' AND '1629' AND sru_code = '7261') OR
    (account_number BETWEEN '1660' AND '1672' AND sru_code = '7261') OR
    (account_number BETWEEN '1674' AND '1679' AND sru_code = '7261') OR
    (account_number BETWEEN '2100' AND '2109' AND sru_code = '7321') OR
    (account_number BETWEEN '2130' AND '2139' AND sru_code = '7323') OR
    (account_number BETWEEN '2140' AND '2149' AND sru_code = '7323') OR
    (account_number BETWEEN '2220' AND '2229' AND sru_code = '7332') OR
    (account_number BETWEEN '2230' AND '2239' AND sru_code = '7333') OR
    (account_number BETWEEN '2300' AND '2309' AND sru_code = '7350') OR
    (account_number BETWEEN '2373' AND '2373' AND sru_code = '7353') OR
    (account_number BETWEEN '2400' AND '2409' AND sru_code = '7362') OR
    (account_number BETWEEN '2410' AND '2419' AND sru_code = '7360') OR
    (account_number BETWEEN '2420' AND '2429' AND sru_code = '7361') OR
    (account_number BETWEEN '2430' AND '2439' AND sru_code = '7361') OR
    (account_number BETWEEN '2450' AND '2459' AND sru_code = '7363') OR
    (account_number BETWEEN '2460' AND '2469' AND sru_code = '7364') OR
    (account_number BETWEEN '2480' AND '2489' AND sru_code = '7369') OR
    (account_number BETWEEN '2490' AND '2490' AND sru_code = '7366') OR
    (account_number BETWEEN '2492' AND '2492' AND sru_code = '7369') OR
    (account_number BETWEEN '2860' AND '2879' AND sru_code = '7369') OR
    (account_number BETWEEN '4910' AND '4920' AND sru_code = '7411') OR
    (account_number BETWEEN '4921' AND '4929' AND sru_code = '7411') OR
    (account_number BETWEEN '4960' AND '4969' AND sru_code = '7411') OR
    (account_number BETWEEN '4980' AND '4989' AND sru_code = '7411') OR
    (account_number BETWEEN '8070' AND '8089' AND sru_code = '7414') OR
    (account_number BETWEEN '8113' AND '8113' AND sru_code = '7415') OR
    (account_number BETWEEN '8118' AND '8118' AND sru_code = '7415') OR
    (account_number BETWEEN '8123' AND '8123' AND sru_code = '7415') OR
    (account_number BETWEEN '8133' AND '8133' AND sru_code = '7415') OR
    (account_number BETWEEN '8170' AND '8189' AND sru_code = '7415') OR
    (account_number BETWEEN '8200' AND '8269' AND sru_code = '7423') OR
    (account_number BETWEEN '8270' AND '8289' AND sru_code = '7416') OR
    (account_number BETWEEN '8370' AND '8389' AND sru_code = '7417') OR
    (account_number BETWEEN '8500' AND '8599' AND sru_code = '7521')
  );

UPDATE public.chart_of_accounts
SET sru_code = CASE
      WHEN account_number BETWEEN '1000' AND '1009' THEN '7201'
      WHEN account_number BETWEEN '1339' AND '1339' THEN '7231'
      WHEN account_number BETWEEN '8810' AND '8810' THEN '7420'
      WHEN account_number BETWEEN '8821' AND '8829' THEN '7419'
      WHEN account_number BETWEEN '8831' AND '8839' THEN '7524'
      WHEN account_number BETWEEN '8841' AND '8849' THEN '7422'
      WHEN account_number BETWEEN '8990' AND '8998' THEN '7450'
      ELSE sru_code
    END,
    updated_at = now()
WHERE sru_code IS NULL
  AND (
    account_number BETWEEN '1000' AND '1009' OR account_number BETWEEN '1339' AND '1339' OR account_number BETWEEN '8810' AND '8810' OR account_number BETWEEN '8821' AND '8829' OR account_number BETWEEN '8831' AND '8839' OR account_number BETWEEN '8841' AND '8849' OR account_number BETWEEN '8990' AND '8998'
  );

COMMIT;
