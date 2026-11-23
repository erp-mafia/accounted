-- Validate the two checks 20261123141500 added NOT VALID on
-- chart_of_accounts.oss_country and oss_vat_rate.
--
-- VALIDATE CONSTRAINT reads every row once under a SHARE UPDATE EXCLUSIVE
-- lock, which blocks no reader and no writer of the kontoplan, only other
-- schema changes on the table. Done in a migration of its own so that read
-- does not run inside the transaction that holds the exclusive lock of the
-- ALTER TABLE before it. No row can fail: the columns are new, so every
-- existing row holds NULL in both, and the checks have bound every write
-- since they were added.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.chart_of_accounts
  VALIDATE CONSTRAINT chart_of_accounts_oss_country_check;

ALTER TABLE public.chart_of_accounts
  VALIDATE CONSTRAINT chart_of_accounts_oss_vat_rate_check;
