SELECT set_config('lock_timeout', '5s', true);

-- Each company's profile (Profiles and Suggestions, step 2).
-- pg-test: tests/pg/company-profile.pg.test.ts
--
-- A profile is a named starting point over the packages (src/lib/modules/
-- profiles.ts): which switchable packages a company starts with on. The
-- capabilities resolver reads it as the defaults beneath the company's own
-- package choices (src/lib/modules/capabilities.ts).
--
--   profile_id, profile_version
--     The profile the company has, at the version it was given: a new
--     version of a profile never changes a company that stored an older one.
--     NULL in both is "Standard (allt på)", every package on, which is what
--     every company that exists today keeps: no backfill, nothing changes on
--     screen for anyone.
--   suggested_profile_id, suggested_profile_version
--     The profile company creation derived from the onboarding answers (the
--     legal form). Recorded only: it switches nothing. Public signup keeps
--     profile_id NULL until the instance sets PROFILES_APPLY_ON_SIGNUP, and
--     a byrå's invite form preselects it for a client company.
--
-- On companies, not company_settings: the resolver's other company inputs
-- (jurisdiction, ledger_currency, entity_type) live on this row and are read
-- in the same query, every company has this row while a settings row can be
-- missing, and company_settings is patched by the generic settings routes,
-- where a profile change is not offered yet.
--
-- The id CHECKs list the ids of profiles.ts (a pg test keeps the two equal),
-- so adding a profile is a migration that widens them. Id and version are
-- written together or not at all; versions start at 1. Added NOT VALID and
-- validated in 20261016190100, in a separate transaction, so this file never
-- scans the table under the ALTER's lock.
--
-- Grants: companies keeps table-level privileges (no column-level grants),
-- so the columns are readable and writable exactly like the rest of the row;
-- the companies_update policy (company admins) and the CHECKs apply.

ALTER TABLE public.companies
  ADD COLUMN profile_id text,
  ADD COLUMN profile_version integer,
  ADD COLUMN suggested_profile_id text,
  ADD COLUMN suggested_profile_version integer,
  ADD CONSTRAINT companies_profile_id_check CHECK (profile_id IN (
    'sole-trader', 'limited-company-no-employees', 'limited-company-with-employees',
    'retail', 'association', 'standard'
  )) NOT VALID,
  ADD CONSTRAINT companies_profile_version_check CHECK (
    (profile_id IS NULL) = (profile_version IS NULL)
    AND (profile_version IS NULL OR profile_version >= 1)
  ) NOT VALID,
  ADD CONSTRAINT companies_suggested_profile_id_check CHECK (suggested_profile_id IN (
    'sole-trader', 'limited-company-no-employees', 'limited-company-with-employees',
    'retail', 'association', 'standard'
  )) NOT VALID,
  ADD CONSTRAINT companies_suggested_profile_version_check CHECK (
    (suggested_profile_id IS NULL) = (suggested_profile_version IS NULL)
    AND (suggested_profile_version IS NULL OR suggested_profile_version >= 1)
  ) NOT VALID;

COMMENT ON COLUMN public.companies.profile_id IS
  'The company''s profile (src/lib/modules/profiles.ts): which packages it starts with on. NULL is Standard (allt på), every package on.';
COMMENT ON COLUMN public.companies.profile_version IS
  'The version of profile_id the company was given; set together with profile_id.';
COMMENT ON COLUMN public.companies.suggested_profile_id IS
  'The profile company creation derived from the onboarding answers. Recorded only; profile_id decides.';
COMMENT ON COLUMN public.companies.suggested_profile_version IS
  'The version of suggested_profile_id; set together with it.';

NOTIFY pgrst, 'reload schema';
