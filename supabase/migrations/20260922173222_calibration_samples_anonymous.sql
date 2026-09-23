-- Retire the per-company data analysis consent flag and make the auto-booking
-- calibration corpus anonymous.
--
-- Background. data_analysis_opt_in (20260828120000, #1346) gated two things:
-- the continuous booking-outcome corpus, and founder-run evaluation runs that
-- re-ran a company's transaction texts and underlag through the model. The
-- consent gate existed because categorize_calibration_samples carried
-- company_id, which made every row a tenant's personal/business data.
--
-- That was circular. scripts/fit-categorize-calibration.ts reads exactly two
-- columns, confidence and was_correct; company_id was stored only so the
-- consent filter had something to filter on. Remove the identifier and the
-- corpus stops being tenant data, so no per-company consent is needed for it.
--
-- What changes here:
--   1. categorize_calibration_samples loses company_id and amount. What is
--      left (confidence, agreement, model_confidence, source, proposed and
--      booked account, was_correct, created_at) identifies no company and no
--      natural person: BAS account numbers and a model score.
--   2. Existing rows are deleted. All 23 were written before 20260828120000
--      and carry a company_id that this migration cannot anonymise in place
--      (the values are the identifier). They are not a usable fit corpus
--      anyway; the target is ~200.
--   3. RLS is rebuilt. The old policies scoped SELECT and INSERT by
--      company_id, which no longer exists. Inserts stay open to any
--      authenticated user (the route already requires auth, membership and a
--      non-sandbox company before it writes); reads are service-role only,
--      since a row belongs to no tenant and there is nothing for a tenant to
--      read back. Still append-only: no UPDATE or DELETE policy.
--   4. company_settings.data_analysis_opt_in is dropped along with the UI
--      toggle, lib/company/data-analysis.ts and its callers.
--
-- Evaluation runs (scripts/backtest-categorize.ts) no longer read live
-- customer books at all: they run on sandbox companies, or on companies named
-- explicitly by the operator under a written agreement. That is a script-side
-- change, not enforced here.
--
-- Cross-company use of the anonymised corpus is disclosed in the customer
-- agreement and the privacy policy (anonymised statistical data), replacing
-- the per-company toggle.
--
-- pg-test: tests/pg/categorize-calibration-samples.pg.test.ts (RLS rebuild)

-- 1 + 2. Anonymise the corpus. Delete first: the rows are only reachable by
-- the column being dropped, so ordering keeps the intent legible.
DELETE FROM public.categorize_calibration_samples;

DROP INDEX IF EXISTS public.idx_calib_samples_company_created;

DROP POLICY IF EXISTS "categorize_calibration_samples_select"
  ON public.categorize_calibration_samples;
DROP POLICY IF EXISTS "categorize_calibration_samples_insert"
  ON public.categorize_calibration_samples;

ALTER TABLE public.categorize_calibration_samples
  DROP COLUMN company_id,
  DROP COLUMN amount;

-- The fit job reads the newest samples first and nothing else.
CREATE INDEX idx_calib_samples_created
  ON public.categorize_calibration_samples (created_at DESC);

-- 3. Append-only, tenant-less. Write is allowed to any authenticated caller;
-- the route in front of it enforces auth, membership and the sandbox skip.
-- No SELECT policy: only the service role (the fit job) reads the corpus.
CREATE POLICY "categorize_calibration_samples_insert"
  ON public.categorize_calibration_samples
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

COMMENT ON TABLE public.categorize_calibration_samples IS
  'Anonymous auto-booking confidence telemetry: model score vs whether the proposed BAS account was the one booked. Carries no company_id and no free text, so it is not tenant data and needs no per-company consent. Append-only; read by the service role only.';

-- 4. The consent flag and its machinery are gone.
ALTER TABLE public.company_settings
  DROP COLUMN data_analysis_opt_in;

NOTIFY pgrst, 'reload schema';
