-- Validate the parties origin CHECK re-added NOT VALID in 20261118150000.
-- Separate transaction, as in 20261029210100: VALIDATE CONSTRAINT only reads
-- the rows under a lighter lock; nothing is rewritten. Every row already
-- satisfies it: the list is the one the table held before.
-- pg-test: covered-by tests/pg/bolaget-registers.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.parties
  VALIDATE CONSTRAINT parties_origin_check;
