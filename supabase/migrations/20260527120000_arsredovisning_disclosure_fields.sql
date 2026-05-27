-- arsredovisning_narratives: add six disclosure fields so the K2/K3 note
-- builder can emit statutorily-required notes that aren't derivable from
-- journal data alone.
--
-- ÅRL 5:13 § -- långfristiga skulder förfallande efter mer än fem år.
-- ÅRL 5:14 § -- ställda säkerheter.
-- ÅRL 5:15 § -- eventualförpliktelser.
-- BFNAR 2016:10 kap. 19 / BFNAR 2012:1 kap. 8 -- koncernförhållanden
--   (moderföretagets namn, organisationsnummer, säte).
--
-- All six are per-fiscal-period (one row per period via the existing
-- composite UNIQUE on (company_id, fiscal_period_id)). The columns are
-- nullable so an unfilled disclosure falls back to the boilerplate
-- ("Inga skulder förfaller efter mer än fem år.", "Inga." for säkerheter
-- and eventualförpliktelser, omitted koncernnot when name is null).

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN long_term_debt_over_five_years NUMERIC(15, 2)
    CHECK (long_term_debt_over_five_years IS NULL OR long_term_debt_over_five_years >= 0),
  ADD COLUMN securities_pledged TEXT
    CHECK (securities_pledged IS NULL OR length(securities_pledged) <= 4000),
  ADD COLUMN contingent_liabilities TEXT
    CHECK (contingent_liabilities IS NULL OR length(contingent_liabilities) <= 4000),
  ADD COLUMN parent_company_name TEXT
    CHECK (parent_company_name IS NULL OR length(parent_company_name) <= 200),
  ADD COLUMN parent_company_org_number TEXT
    CHECK (parent_company_org_number IS NULL OR length(parent_company_org_number) <= 20),
  ADD COLUMN parent_company_city TEXT
    CHECK (parent_company_city IS NULL OR length(parent_company_city) <= 100);

NOTIFY pgrst, 'reload schema';
