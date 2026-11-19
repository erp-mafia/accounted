SELECT set_config('lock_timeout', '5s', true);

-- Validate the profile CHECKs added NOT VALID in 20261016190000.
-- pg-test: covered-by tests/pg/company-profile.pg.test.ts
--
-- Separate transaction: the preceding ALTER held its lock only for the
-- catalog change, and VALIDATE CONSTRAINT here takes SHARE UPDATE EXCLUSIVE,
-- which lets reads and writes continue while it scans. Every existing row
-- has NULL in all four columns, so every row passes; nothing is rewritten.

ALTER TABLE public.companies
  VALIDATE CONSTRAINT companies_profile_id_check;
ALTER TABLE public.companies
  VALIDATE CONSTRAINT companies_profile_version_check;
ALTER TABLE public.companies
  VALIDATE CONSTRAINT companies_suggested_profile_id_check;
ALTER TABLE public.companies
  VALIDATE CONSTRAINT companies_suggested_profile_version_check;
