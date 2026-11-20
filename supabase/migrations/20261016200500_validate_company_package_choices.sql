-- Validate the source CHECK added NOT VALID in 20261016200400.
-- Separate transaction: the scan runs without the ALTER's stronger lock. Every
-- existing row has source NULL, which the CHECK allows; nothing is rewritten.
-- pg-test: covered-by tests/pg/company-package-choices.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.company_capability_config
  VALIDATE CONSTRAINT company_capability_config_source_check;
