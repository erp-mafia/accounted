-- Pin each company's country and ledger currency as columns.
--
-- Today every company is Swedish and keeps its books in SEK: BFL, BAS, the
-- VAT boxes, payroll and every report assume it. That assumption lived only
-- in code. These two columns state it per company, so the capabilities
-- resolver (src/lib/modules/capabilities.ts) can answer "is this module
-- supported for this company" from data instead of from a constant, and the
-- API can publish the answer.
--
--   jurisdiction     ISO 3166-1 alpha-2 country whose law the books follow.
--   ledger_currency  ISO 4217 currency the ledger is kept in (the product
--                    keeps every ledger in SEK).
--
-- The CHECKs are deliberately as narrow as the product: only 'SE' and 'SEK'
-- are accepted until a country pack exists. Widening either one is a
-- deliberate migration, never a default that slips in through an insert.
-- Nothing reads them to decide anything yet except the capabilities resolver.
--
-- Grants: companies keeps table-level privileges (it predates
-- 20260929220000_own_default_privileges and has no column-level grants), so
-- the new columns are readable and writable exactly like the rest of the row;
-- the CHECKs refuse any other value from every role. NOT NULL with a constant
-- DEFAULT fills every existing row without a table rewrite.

-- companies is read on nearly every request: never queue behind a long
-- transaction holding a lock on it. Fail the migration job instead and retry.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.companies
  ADD COLUMN jurisdiction text NOT NULL DEFAULT 'SE'
    CONSTRAINT companies_jurisdiction_check CHECK (jurisdiction = 'SE'),
  ADD COLUMN ledger_currency text NOT NULL DEFAULT 'SEK'
    CONSTRAINT companies_ledger_currency_check CHECK (ledger_currency = 'SEK');

COMMENT ON COLUMN public.companies.jurisdiction IS
  'ISO 3166-1 alpha-2 country whose accounting law the books follow. Only SE until a country pack exists; widening the CHECK is a deliberate migration.';
COMMENT ON COLUMN public.companies.ledger_currency IS
  'ISO 4217 currency the ledger is kept in. Only SEK until a country pack exists; widening the CHECK is a deliberate migration.';

NOTIFY pgrst, 'reload schema';
