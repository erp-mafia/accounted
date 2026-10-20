SELECT set_config('lock_timeout', '5s', true);

-- Validate the byra_client_number CHECK added NOT VALID in 20261020083700.
-- pg-test: covered-by tests/pg/byra-client-number.pg.test.ts
--
-- Separate transaction: the preceding ALTER held its lock only for the
-- catalog change, and VALIDATE CONSTRAINT here takes SHARE UPDATE EXCLUSIVE,
-- which lets reads and writes continue while it scans. Every existing row
-- has NULL in the new column, so every row passes; nothing is rewritten.

ALTER TABLE public.companies
  VALIDATE CONSTRAINT companies_byra_client_number_check;
