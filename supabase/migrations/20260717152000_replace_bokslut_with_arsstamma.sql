-- Remove the non-statutory 'bokslut' deadline (issue #1028).
--
-- The "3 months after FY end" bokslut deadline had no legal basis (the
-- statutory anchors for AB are the arsstamma within 6 months, ABL 7 kap.
-- 10 §, and the Bolagsverket filing within 7 months, ARL 8 kap.), and its
-- non-calendar-FY date math was off by one month (a May-start FY produced
-- 31 Aug instead of 31 Jul; a Nov-start FY produced "Feb 31" which rolled
-- into March). The generator now produces an 'arsstamma' deadline instead;
-- the daily backfill cron creates those rows on its next run.
--
-- Completed rows are kept for history; pending rows are template noise.
DELETE FROM public.deadlines
WHERE source = 'system'
  AND tax_deadline_type = 'bokslut'
  AND is_completed = false;
