-- Migration: the skattekonto penalty rule sorts ahead of the tax rules
--
-- Why this exists: Skatteverket names the tax a penalty belongs to in the
-- row's text: "Förs.avgift moms/arbetsgivardeklaration", "Skattetillägg moms
-- jul", "Skattetillägg arbetsgivaravgift mars". The seed rules
-- (20260519100000) are walked by priority and the first substring wins, so
-- the moms rule (priority 20, 2650) caught "Förs.avgift
-- moms/arbetsgivardeklaration" before the penalty rule (priority 25, 6992)
-- was tried, and the penalty pattern 'förseningsavgift' never matches
-- Skatteverket's abbreviation "Förs.avgift" anyway. The late fee was booked
-- Debit 2650 / Credit 1630: the redovisningskonto for moms carried a cost no
-- VAT period ever clears, and the non-deductible fee never reached 6992.
--
-- The penalty seed moves to priority 15: ahead of the tax seeds (20), behind
-- the in- and utbetalning seeds (10) and the rot/rut kvittning (5). It also
-- gets the abbreviation 'förs.avgift'. Only a text carrying a penalty word
-- matches it, so a plain tax row ("Moms jul", "Arbetsgivaravgift sept",
-- "Skönsbeskattning moms sept") keeps its rule.
--
-- Scope: system seed only (company_id IS NULL); no company has a rule of its
-- own. Rows already booked against 2650 are not repaired here: posted
-- verifikat are corrected by rättelse, never by a migration.

UPDATE public.skattekonto_rules
SET priority = 15,
    pattern = 'skattetillägg,förseningsavgift,förs.avgift',
    updated_at = now()
WHERE company_id IS NULL
  AND pattern = 'skattetillägg,förseningsavgift';

NOTIFY pgrst, 'reload schema';
