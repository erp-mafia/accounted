-- Backfill sru_code on seeded system accounts that were created without one
-- (#2517).
--
-- The seed_chart_of_accounts() versions in 20260304191528, 20260330130000 and
-- 20260513120100 inserted the seeded chart without sru_code; 20260516130000
-- put the column back. Companies seeded in between (created 2026-03-31 to
-- 2026-06-12 on prod: 652 companies, 21,840 rows over the 43 account numbers
-- below) kept NULL, and neither SRU repair since touched them:
-- 20260911120000 rewrote only rows still carrying an old code ("NULL stays
-- NULL"), and #2520 fills NULLs only in its newly covered ranges. A NULL
-- sru_code means the SIE export writes no #SRU record for the account
-- (lib/reports/sie-export.ts) and the kontoplan and GET /accounts show none.
-- The INK2 filing engine maps by account range and never read the column, so
-- no declaration was affected.
--
-- Target: exactly the code the current seed_chart_of_accounts() (defined in
-- 20260911120000) writes for the same account number, so these charts end up
-- identical to one seeded today. 2610 and 2612 are legacy seeded numbers the
-- current seed no longer creates; they take the 2600-2799 code (7369) from
-- the same table. #2520 (20260911160000) moves a row only when its sru_code
-- equals the 20260911120000 value inside one of its changed ranges, and none
-- of the codes below lies in a changed range, so this backfill is correct
-- whichever of the two runs first.
--
-- Predicate: seeded system accounts whose sru_code is still NULL. A code a
-- user set by hand is never NULL, so it is never touched; neither is any
-- account the user created (is_system_account = false). The seeded accounts
-- that are NULL on purpose are not in the list and stay NULL: enskild firma
-- equity 2010/2013/2018 (the NE-bilaga, not INK2) and ideell förening
-- 2067/2068/2069/2890 (INK3, not modelled).
--
-- Audited on purpose: audit_chart_of_accounts writes one audit_log row per
-- updated account, which is the behandlingshistorik entry for this kontoplan
-- change (BFNAR 2013:2 p. 9.16). The two larger SRU backfills of 2026-09-11
-- skipped audit because of their size (~330k rows); at 21,840 rows the trail
-- costs a few tens of MB and nothing justifies dropping it. The rows are
-- tagged actor_type 'system' with this migration as the label (the
-- 20260726120000 pattern), so they never read as something the company's
-- user did. Explicit transaction so the SET LOCALs hold for the UPDATE.
-- Re-running is a no-op: the rows it sets are no longer NULL.

BEGIN;

SET LOCAL gnubok.actor_type = 'system';
SET LOCAL gnubok.actor_label = 'migration 20260911190100 backfill_seeded_account_sru_codes';

UPDATE public.chart_of_accounts
SET sru_code = CASE account_number
      WHEN '1510' THEN '7251'
      WHEN '1910' THEN '7281'
      WHEN '1930' THEN '7281'
      WHEN '1940' THEN '7281'
      WHEN '2081' THEN '7301'
      WHEN '2091' THEN '7302'
      WHEN '2099' THEN '7302'
      WHEN '2440' THEN '7365'
      WHEN '2610' THEN '7369'
      WHEN '2611' THEN '7369'
      WHEN '2612' THEN '7369'
      WHEN '2621' THEN '7369'
      WHEN '2631' THEN '7369'
      WHEN '2641' THEN '7369'
      WHEN '2650' THEN '7369'
      WHEN '2710' THEN '7369'
      WHEN '2731' THEN '7369'
      WHEN '2893' THEN '7369'
      WHEN '3001' THEN '7410'
      WHEN '3002' THEN '7410'
      WHEN '3100' THEN '7410'
      WHEN '3900' THEN '7413'
      WHEN '3960' THEN '7413'
      WHEN '4000' THEN '7511'
      WHEN '5010' THEN '7513'
      WHEN '5410' THEN '7513'
      WHEN '5420' THEN '7513'
      WHEN '5460' THEN '7513'
      WHEN '5800' THEN '7513'
      WHEN '5910' THEN '7513'
      WHEN '6071' THEN '7513'
      WHEN '6110' THEN '7513'
      WHEN '6212' THEN '7513'
      WHEN '6230' THEN '7513'
      WHEN '6530' THEN '7513'
      WHEN '6570' THEN '7513'
      WHEN '6991' THEN '7513'
      WHEN '7010' THEN '7514'
      WHEN '7210' THEN '7514'
      WHEN '7510' THEN '7514'
      WHEN '7960' THEN '7517'
      WHEN '8310' THEN '7417'
      WHEN '8410' THEN '7522'
    END,
    updated_at = now()
WHERE is_system_account
  AND sru_code IS NULL
  AND account_number IN (
    '1510', '1910', '1930', '1940',
    '2081', '2091', '2099', '2440',
    '2610', '2611', '2612', '2621', '2631', '2641', '2650', '2710', '2731', '2893',
    '3001', '3002', '3100', '3900', '3960',
    '4000',
    '5010', '5410', '5420', '5460', '5800', '5910',
    '6071', '6110', '6212', '6230', '6530', '6570', '6991',
    '7010', '7210', '7510', '7960',
    '8310', '8410'
  );

COMMIT;
