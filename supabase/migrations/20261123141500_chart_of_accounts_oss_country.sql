-- The EU country an OSS account is for (unionsordningen).
--
-- The OSS declaration is made per country of consumption and VAT rate. A
-- webshop order row carries both, so the OSS underlag could split the orders
-- it books. A verifikat booked without an order (an invoice, a sale booked by
-- hand, an imported voucher) carries neither: the ledger had no country, and
-- such a verifikat was listed outside the underlag.
--
-- Companies that book OSS without an order feed keep one sales account per
-- country and rate, and usually one output VAT account per country. The
-- account is then the place that says the country:
--
--   oss_country   the other EU country (ISO 3166-1 alpha-2) the account is
--                 for. On a class 3 account it places the sale; on a 26xx
--                 account it says the account holds OSS output VAT for that
--                 country.
--   oss_vat_rate  that country's VAT rate in percent (19.00, 25.50) for a
--                 class 3 account. A VAT account takes none: its VAT follows
--                 the sale it is booked with.
--
-- NULL on both keeps today's behaviour. The checks rest on the account's
-- class and number only, which never change on a row, so no later update of
-- the VAT code can trip them; the reader asks for VAT code OSS as well
-- (lib/webshop-orders/oss-underlag.ts). Membership of the EU is checked in
-- lib/vat/oss-accounts.ts, where the list of member states lives. 2650
-- (momsredovisning) nets the Swedish declaration and never holds OSS VAT.
--
-- chart_of_accounts is read on almost every request and holds over a million
-- rows. Nothing here reads the table: a nullable column without a default is
-- a catalogue change, and the checks are added NOT VALID, which binds every
-- new and changed row at once and leaves the existing rows (all NULL in the
-- new columns) to 20261123141510, where validating them blocks no reader and
-- no writer. The lock this file needs is exclusive but momentary; if a long
-- transaction holds the table, fail the migration job after three seconds
-- instead of queueing every read of the kontoplan behind it.
SELECT set_config('lock_timeout', '3s', true);

ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS oss_country text;

ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS oss_vat_rate numeric(5,2);

ALTER TABLE public.chart_of_accounts
  DROP CONSTRAINT IF EXISTS chart_of_accounts_oss_country_check;
ALTER TABLE public.chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_oss_country_check
  CHECK (
    oss_country IS NULL
    OR (
      oss_country ~ '^[A-Z]{2}$'
      AND oss_country <> 'SE'
      AND (
        (account_class = 3 AND oss_vat_rate IS NOT NULL)
        OR (account_number ~ '^26[0-9]{2}$' AND account_number <> '2650')
      )
    )
  ) NOT VALID;

ALTER TABLE public.chart_of_accounts
  DROP CONSTRAINT IF EXISTS chart_of_accounts_oss_vat_rate_check;
ALTER TABLE public.chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_oss_vat_rate_check
  CHECK (
    oss_vat_rate IS NULL
    OR (
      oss_country IS NOT NULL
      AND account_class = 3
      AND oss_vat_rate > 0
      AND oss_vat_rate < 100
    )
  ) NOT VALID;

COMMENT ON COLUMN public.chart_of_accounts.oss_country IS
  'OSS (unionsordningen): the other EU country this account is for, ISO 3166-1 alpha-2. A class 3 account places its sales there in the OSS underlag; a 26xx account holds OSS output VAT for it. NULL: the account names no country.';
COMMENT ON COLUMN public.chart_of_accounts.oss_vat_rate IS
  'OSS (unionsordningen): the VAT rate in percent of the country in oss_country, for a class 3 account. NULL without a country and on VAT accounts.';

NOTIFY pgrst, 'reload schema';
