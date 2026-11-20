-- K3 årsredovisning for a mindre aktiebolag: what the user answers and types
-- for the disclosure matrix, the equity specification and the K3 scope
-- checks (src/lib/bokslut/arsredovisning/disclosures/).
--
-- arsredovisning_narratives (per räkenskapsår, next to the other narrative
-- fields):
--   disclosure_answers: per requirement id of the matrix, the user's answer:
--     { "<id>": { "applies": bool|null, "text": str|null, "choice": str|null,
--                 "confirmed": bool } }. '{}' is "nothing answered".
--   equity_movement_overrides: the user's classification of a verifikat the
--     equity specification cannot classify from the ledger (a correction or
--     a retroactive change booked to balanserat resultat):
--     { "<journal_entry_id>": "<EquityMovementKind>" }.
--   equity_statement_separate: print the specification of changes in equity
--     as a statement of its own instead of in förvaltningsberättelsen (K3
--     3.10 allows both).
-- The app validates ids, kinds and lengths (workflow-schemas.ts); the CHECKs
-- bound the shape and the size, as for note_overrides.
--
-- annual_report_profiles (the scope facts per räkenskapsår):
--   previous_year_framework: the framework the previous årsredovisning was
--     prepared under, when Accounted cannot tell (the year was kept in
--     another system, or its framework here is only the backfilled default):
--     k2, k3, or none (no previous årsredovisning). A first K3 year after K2
--     is not supported yet (AR-K3-FIRST-YEAR-UNSUPPORTED).
--   has_other_temporary_differences: whether the company has temporary
--     differences other than obeskattade reserver (K3 29), which Accounted's
--     K3 document does not account for yet
--     (AR-K3-TEMPORARY-DIFFERENCES-UNSUPPORTED). Null means unanswered.
--
-- New columns on existing tables: their company-scoped RLS policies already
-- cover them; no policy, trigger or RPC changes.
-- pg-test: skip (columns with CHECK constraints only; no trigger, RPC or RLS change)

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN disclosure_answers JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (
      jsonb_typeof(disclosure_answers) = 'object'
      AND octet_length(disclosure_answers::text) <= 200000
    ),
  ADD COLUMN equity_movement_overrides JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (
      jsonb_typeof(equity_movement_overrides) = 'object'
      AND octet_length(equity_movement_overrides::text) <= 64000
    ),
  ADD COLUMN equity_statement_separate BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.arsredovisning_narratives.disclosure_answers IS
  'K3 disclosure matrix answers per requirement id: applies, text, choice, confirmed (lib/bokslut/arsredovisning/disclosures).';
COMMENT ON COLUMN public.arsredovisning_narratives.equity_movement_overrides IS
  'Classification of equity verifikat the ledger cannot classify, by journal entry id (equity-specification.ts).';
COMMENT ON COLUMN public.arsredovisning_narratives.equity_statement_separate IS
  'Print the specification of changes in equity as its own statement instead of in förvaltningsberättelsen (K3 3.10).';

ALTER TABLE public.annual_report_profiles
  ADD COLUMN previous_year_framework TEXT
    CHECK (previous_year_framework IN ('k2', 'k3', 'none')),
  ADD COLUMN has_other_temporary_differences BOOLEAN;

COMMENT ON COLUMN public.annual_report_profiles.previous_year_framework IS
  'Framework of the previous årsredovisning when Accounted cannot tell (k2, k3, none). Drives the K3 first-year check.';
COMMENT ON COLUMN public.annual_report_profiles.has_other_temporary_differences IS
  'Temporary differences other than obeskattade reserver (K3 29). Null = unanswered.';

NOTIFY pgrst, 'reload schema';
