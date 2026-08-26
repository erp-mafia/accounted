-- Align skattekonto_rules with the 2012 -> 2013 EF account decision.
--
-- 20260810120000 established that account 2012 is not standard BAS (bas.se
-- BAS 2026 v2 has no 2012; owner taxes paid by an enskild firma are an eget
-- uttag on 2013 "Övriga egna uttag") and migrated booking_template_library
-- accordingly. The skattekonto_rules seed from 20260519100000 was missed:
-- its "Preliminär skatt" rule still books EF F-skatt against 2012. That rule
-- fires for every EF skattekonto booking (API-synced and file-imported), so
-- bring it onto 2013 too. Covers the NULL-company system row plus any
-- per-company clones.

UPDATE public.skattekonto_rules
SET counter_account_ef = '2013'
WHERE counter_account_ef = '2012';
