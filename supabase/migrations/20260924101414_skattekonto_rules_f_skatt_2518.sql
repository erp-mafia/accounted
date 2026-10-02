-- Book an aktiebolag's debiterad preliminärskatt on 2518, not on 2510.
--
-- 2510 Skatteskulder is the summary account for the whole 25-group. BAS gives
-- the preliminary tax its own account, 2518 Betald F-skatt, which carries a
-- debit balance through the year; at bokslut the computed tax is booked
-- 8910 / 2512 Beräknad inkomstskatt and 2518 is netted against 2512/2510.
-- Booking the running charges straight onto 2510 collapses that into one
-- saldo and loses the distinction the group exists to express: what has been
-- paid versus what is owed. The year-end netting then has nothing to net.
--
-- Only the aktiebolag column moves. counter_account_ef stays 2013: an enskild
-- firma books no tax liability at all, the owner's F-skatt is an eget uttag
-- (see 20260817120100, which moved that column off the non-BAS 2012).
--
-- Existing verifikat are untouched. A posted entry on 2510 is corrected the
-- way BFL 5 kap 5 § allows, per entry, never by a data migration.
--
-- System rows only (company_id IS NULL). No UI, API or MCP path writes
-- company-scoped skattekonto_rules; such a row can only come from a direct
-- insert, and this migration leaves any such row as it is. Rule matching lives
-- in src/extensions/general/skatteverket/lib/skattekonto-booking.ts.

UPDATE public.skattekonto_rules
SET counter_account = '2518'
WHERE company_id IS NULL
  AND counter_account = '2510'
  AND pattern LIKE '%preliminärskatt%';
