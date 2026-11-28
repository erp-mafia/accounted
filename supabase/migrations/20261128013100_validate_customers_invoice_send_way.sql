-- Validate customers_invoice_send_way_check, added NOT VALID in
-- 20261128013000. Kept separate so the scan runs under the weaker lock (the
-- split of 20261118131500 / 20261118131600). Every row holds NULL in the new
-- column, which the CHECK accepts, so the validation cannot fail.
-- pg-test: covered-by tests/pg/customer-invoice-send-way.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.customers VALIDATE CONSTRAINT customers_invoice_send_way_check;
