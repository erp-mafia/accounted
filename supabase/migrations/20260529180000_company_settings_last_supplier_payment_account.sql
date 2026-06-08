-- Remember the last BAS account a user picked when paying a supplier invoice,
-- so the next mark-paid dialog can default to it instead of forcing the user
-- to re-pick 1930 / 1940 / 2018 / 2893 each time.
--
-- Free-text TEXT column — the existing chart_of_accounts CHECK constraint
-- (4 ASCII digits per BAS standard) is enforced upstream by the Zod schema
-- (accountNumber primitive in lib/api/schemas.ts).

ALTER TABLE company_settings
  ADD COLUMN last_supplier_payment_account TEXT;

NOTIFY pgrst, 'reload schema';
