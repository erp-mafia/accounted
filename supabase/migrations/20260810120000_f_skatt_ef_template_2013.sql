-- "Preliminär F-skatt (EF)" booked Debit 2012 / Credit 1630. Account 2012
-- "Avräkning för skatter och avgifter" was added to BAS_REFERENCE in #1388 on
-- the strength of the swedish-year-end-closing skill alone; the primary-source
-- check (#1409, bas.se BAS 2026 v2) shows the official kontoplan has no 2012:
-- the enskild firma equity block is 2010, 2011, 2013, 2017, 2018, 2019, and
-- "Avräkning för skatter och avgifter (skattekonto)" is 1630/1640 (asset) and
-- 2850 (liability). 2012 is a program convention (Visma, Bokio, Björn Lundén),
-- not standard BAS, so the reference drops it and the template moves to 2013
-- "Övriga egna uttag": owner taxes paid by an enskild firma are an eget uttag.
--
-- Scope: every enskild_firma template row still carrying a 2012 line, i.e. the
-- seeded system row plus any clone of it. Charts that already had 2012
-- backfilled keep the account and its history; only future template use moves
-- to 2013. account-backfill seeds 2013 on demand (it is standard BAS), so the
-- template works for charts that lack it.

UPDATE public.booking_template_library
SET lines = (
  SELECT jsonb_agg(
    CASE
      WHEN line->>'account' = '2012' THEN jsonb_set(line, '{account}', '"2013"')
      ELSE line
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(lines) WITH ORDINALITY AS t(line, ord)
)
WHERE entity_type = 'enskild_firma'
  AND lines @> '[{"account": "2012"}]';
