-- Validate customers_individual_no_org_number, added NOT VALID in
-- 20261118131500, where every row already satisfies it. Kept separate so the
-- scan runs under the weaker lock (the split of 20261023142500 /
-- 20261023142600).
-- pg-test: covered-by tests/pg/customers-individual-no-org-number.pg.test.ts
--
-- Production holds no violating row (2026-11-18), so the constraint is
-- validated there. A self-hosted database can still hold some: the repair
-- needs the encryption key, and it leaves a number that is not a personnummer
-- for a person to decide. There the constraint stays NOT VALID, which still
-- refuses every new write. A plain VALIDATE would fail on those rows and stop
-- every later migration on that database.

SELECT set_config('lock_timeout', '5s', true);

DO $$
DECLARE
  v_rows bigint;
BEGIN
  SELECT count(*) INTO v_rows
  FROM public.customers
  WHERE customer_type = 'individual' AND btrim(coalesce(org_number, ''), E' \t\n\r') <> '';

  IF v_rows = 0 THEN
    ALTER TABLE public.customers VALIDATE CONSTRAINT customers_individual_no_org_number;
  ELSE
    RAISE NOTICE 'customers_individual_no_org_number stays NOT VALID: % individual customer cards still hold an org number', v_rows;
  END IF;
END
$$;
