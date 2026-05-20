-- Verification queries for the BAS96 -> BAS2025 remap on CeSu Invest AB.
-- Run each block separately in the Supabase SQL editor, or all together
-- and click through the result tabs.

-- ────────────────────────────────────────────────────────────────
-- 1. No leftover __mig__ rows? (should return 0)
-- ────────────────────────────────────────────────────────────────
SELECT COUNT(*) AS mig_rows_remaining
FROM public.chart_of_accounts coa
JOIN public.companies c ON c.id = coa.company_id
WHERE c.name = 'CeSu Invest AB'
  AND LEFT(coa.account_number, 7) = '__mig__';

-- ────────────────────────────────────────────────────────────────
-- 2. No leftover BAS96 numbers in chart_of_accounts? (should return 0)
-- ────────────────────────────────────────────────────────────────
SELECT coa.account_number, coa.account_name
FROM public.chart_of_accounts coa
JOIN public.companies c ON c.id = coa.company_id
WHERE c.name = 'CeSu Invest AB'
  AND coa.account_number IN (
    '1040','1050','1051','1052','1053','1055','1056','1060','1061',
    '1210','1623','1624','1625','1626','1627','1628','1629',
    '1631','1632','2210','2211','2330','2480','2510','2690',
    '2864','2991','2992','2997','2999'
  );
-- (Note: 1360 and 1630 are intentionally OMITTED here because they exist
--  as legitimate BAS2025 targets after the remap.)

-- ────────────────────────────────────────────────────────────────
-- 3. No leftover BAS96 numbers in journal_entry_lines? (should return 0)
-- ────────────────────────────────────────────────────────────────
SELECT l.account_number, COUNT(*) AS line_count
FROM public.journal_entry_lines l
JOIN public.journal_entries je ON je.id = l.journal_entry_id
JOIN public.companies c ON c.id = je.company_id
WHERE c.name = 'CeSu Invest AB'
  AND l.account_number IN (
    '1040','1050','1051','1052','1053','1055','1056','1060','1061',
    '1210','1623','1624','1625','1626','1627','1628','1629',
    '1631','1632','2210','2211','2330','2480','2510','2690',
    '2864','2991','2992','2997','2999'
  )
GROUP BY l.account_number;

-- ────────────────────────────────────────────────────────────────
-- 4. account_id <-> account_number consistency on every line.
-- Should return 0 -- every line's account_number must match the
-- chart_of_accounts row it points to.
-- ────────────────────────────────────────────────────────────────
SELECT COUNT(*) AS mismatched_lines
FROM public.journal_entry_lines l
JOIN public.journal_entries je ON je.id = l.journal_entry_id
JOIN public.companies c ON c.id = je.company_id
JOIN public.chart_of_accounts coa ON coa.id = l.account_id
WHERE c.name = 'CeSu Invest AB'
  AND coa.account_number <> l.account_number;

-- ────────────────────────────────────────────────────────────────
-- 5. Grand totals -- debits = credits and look plausible.
-- ────────────────────────────────────────────────────────────────
SELECT
  SUM(l.debit_amount)  AS total_debit,
  SUM(l.credit_amount) AS total_credit,
  SUM(l.debit_amount) - SUM(l.credit_amount) AS debit_minus_credit
FROM public.journal_entry_lines l
JOIN public.journal_entries je ON je.id = l.journal_entry_id
JOIN public.companies c ON c.id = je.company_id
WHERE c.name = 'CeSu Invest AB';

-- ────────────────────────────────────────────────────────────────
-- 6. Per-account breakdown (post-remap) — spot-check the BAS2025 numbers.
-- ────────────────────────────────────────────────────────────────
SELECT
  coa.account_number,
  coa.account_name,
  COALESCE(SUM(l.debit_amount), 0)  AS debit_sum,
  COALESCE(SUM(l.credit_amount), 0) AS credit_sum,
  COUNT(l.id)                        AS line_count
FROM public.chart_of_accounts coa
JOIN public.companies c ON c.id = coa.company_id
LEFT JOIN public.journal_entry_lines l ON l.account_id = coa.id
WHERE c.name = 'CeSu Invest AB'
  AND coa.account_number IN (
    '1311','1330','1350','1351','1352','1353','1354','1355','1356',
    '1360','1361','1385','1386','1510','1630','1760',
    '1930','1940','1941','1942','1943','1944',
    '2081','2086','2091','2099','2126','2650','2710','2890','2941'
  )
GROUP BY coa.account_number, coa.account_name
ORDER BY coa.account_number;

-- ────────────────────────────────────────────────────────────────
-- 7. Summary headcount: chart_of_accounts for CeSu Invest AB.
-- ────────────────────────────────────────────────────────────────
SELECT
  COUNT(*)                                                       AS total_accounts,
  COUNT(*) FILTER (WHERE account_class = 1)                      AS class_1_assets,
  COUNT(*) FILTER (WHERE account_class = 2)                      AS class_2_eq_liab,
  COUNT(*) FILTER (WHERE LEFT(account_number, 7) = '__mig__')    AS migration_leftovers
FROM public.chart_of_accounts coa
JOIN public.companies c ON c.id = coa.company_id
WHERE c.name = 'CeSu Invest AB';
