-- Flag account 1081 (Pagaende projekt for immateriella anlaggningstillgangar)
-- as k2_excluded. Ongoing self-developed intangible projects are forbidden
-- under K2 (BFNAR 2016:10 punkt 10.4: egenupparbetade immateriella
-- anlaggningstillgangar far inte aktiveras), so the account is K3-only.
--
-- The account was missing from the k2_excluded backfill list in
-- 20260225103139_full_bas_2026.sql. The TS BAS reference
-- (lib/bookkeeping/bas-data/class-1-assets.ts) is updated in the same change;
-- this migration brings already-provisioned chart_of_accounts rows in line so
-- catalog filtering and future account syncs agree with the reference.
-- Metadata-only update: no balances, triggers, RPCs, or RLS involved.

UPDATE public.chart_of_accounts
SET k2_excluded = true, updated_at = now()
WHERE account_number = '1081'
  AND k2_excluded = false;
