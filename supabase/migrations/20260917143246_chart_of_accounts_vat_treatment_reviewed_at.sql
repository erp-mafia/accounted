-- Record that an account's VAT handling was SETTLED, separately from what it
-- was settled to.
--
-- chart_of_accounts.default_vat_treatment is nullable, and NULL has carried two
-- meanings nothing could tell apart: "nobody has taken a position on this
-- account" and "someone took a position, and it is that this account has no VAT
-- handling". The import's review list spares an account it considers settled by
-- reading the treatment itself (lib/import/account-vat-treatment.ts), so an
-- answer of "Använd BAS-standard / Ingen" was indistinguishable from never
-- having been asked, and came back on the next import. Observed on a real
-- two-year Spiris import: 13 of the 16 rows the 2022 file raised were accounts
-- answered that way during 2021 (issue #2700). Import 2023 and the same 13
-- return, while the list only ever shrinks for accounts that end up WITH a
-- treatment.
--
-- The conflation is between decided and undecided, not between has-a-treatment
-- and has-none, so this records the former rather than widening the latter into
-- a sentinel member. AccountVatTreatment stays a domain concept, and every
-- consumer of it (resolveVatTreatmentRuta, defaultRateForVatTreatment, the
-- declaration's dynamic path, the MCP tools, the account editor) is untouched:
-- the only reader of this column is the import's short-circuit.
--
-- A timestamp rather than a boolean, because "when was this decided" is the
-- question an auditor asks about a setting that steers a momsdeklaration, and
-- IS NOT NULL is the same test a boolean would give.
--
-- NO BACKFILL, deliberately. An account settled to a real treatment before this
-- column existed is still recognised, because the reader accepts either signal:
-- a non-null treatment OR this timestamp. The rows this cannot rescue are the
-- ones already answered "none", which are exactly the rows we cannot tell from
-- never-asked, since that is the bug. They are asked once more and stick from
-- then on. Inventing a backfill would mean guessing which nulls were answers.
--
-- pg-test: skip (a nullable column with no constraint, trigger, RLS policy or
-- default; chart_of_accounts RLS already covers it and is unchanged)

ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS vat_treatment_reviewed_at timestamptz;

COMMENT ON COLUMN public.chart_of_accounts.vat_treatment_reviewed_at IS
  'When a person last settled this account''s VAT handling in the import review list. NULL = never settled. Distinguishes a deliberate "no VAT treatment" from "not yet asked", which default_vat_treatment alone cannot (issue #2700).';

NOTIFY pgrst, 'reload schema';
