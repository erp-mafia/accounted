-- AGI deadline gating: employer registration, not salary payments (issue #1028).
--
-- A company registered as arbetsgivare must file an arbetsgivardeklaration
-- every month, including months with no salaries (nil declaration), per
-- SFL 26 kap. 3 §. Only sasongsregistrerade employers are exempt for nil
-- months (and still owe a December nil declaration when nothing was paid all
-- year). "Pays salaries" was the wrong predicate: companies actively running
-- payroll with the flag off received no AGI reminders (each missed monthly
-- filing risks a forseningsavgift), while flagged-but-inactive companies were
-- over-reminded.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS employer_registered boolean,
  ADD COLUMN IF NOT EXISTS employer_seasonal boolean NOT NULL DEFAULT false;

-- Companies that attested paying salaries are employers.
UPDATE public.company_settings
SET employer_registered = true
WHERE pays_salaries = true
  AND employer_registered IS DISTINCT FROM true;

-- Companies with payroll runs in the app are employers regardless of the old
-- flag: paying out salary obliges registration (SFL 7 kap. 1 §) and monthly
-- AGI (SFL 26 kap. 2 §). A wrong reminder is dismissible; a missed statutory
-- filing costs money.
UPDATE public.company_settings cs
SET employer_registered = true
FROM (SELECT DISTINCT company_id FROM public.salary_runs) sr
WHERE sr.company_id = cs.company_id
  AND cs.employer_registered IS DISTINCT FROM true;

NOTIFY pgrst, 'reload schema';
