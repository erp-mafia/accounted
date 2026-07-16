-- Migration: employee_opening_balances — payroll cutover state (Phase 2 of
-- the payroll gap-closure plan).
--
-- Why this exists: a company switching to Accounted mid-year brings per-
-- employee state that the calculation engine otherwise derives from booked
-- salary runs it does not have:
--   * YTD gross/tax/net for the cutover year (payslip display continuity;
--     AGI is per-run and the youth/växa avgifter caps are per-month, so YTD
--     never affects calculations: verified in run-calculation.ts).
--   * Vacation balances: paid days remaining this year + sparade dagar per
--     origin year (Semesterlagen 5-year rule) + the SEK semesterlöneskuld
--     that arrived via SIE opening balances on 2920/2940 (we never book it;
--     it feeds the vacation-liability report as an opening term).
--   * Karens periods in the prior 12 months NOT represented by imported
--     salary_absence_days rows, for allmänt högriskskydd counting
--     (Sjuklönelagen 11 §: karensavdrag suppressed from the 11th period).
--     Ongoing sick cases themselves need NO field here: importing the
--     pre-cutover per-day rows via the absence API reconstructs segments,
--     återinsjuknande, and karens-already-taken exactly.
--
-- One row per (company, employee). Editable until the employee appears in a
-- BOOKED salary run; the lock is DERIVED (trigger below), not a flag, so it
-- self-unlocks if the only booked run is corrected (status -> 'corrected'),
-- which is exactly when re-editing opening balances is legitimate again.

CREATE TABLE public.employee_opening_balances (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- First day of the month the FIRST Accounted-run period starts. YTD merge
  -- in the engine only applies to runs in the same year, on or after this.
  cutover_date  DATE NOT NULL,

  -- YTD accumulators for the cutover year (SEK).
  ytd_gross     NUMERIC NOT NULL DEFAULT 0 CHECK (ytd_gross >= 0),
  ytd_tax       NUMERIC NOT NULL DEFAULT 0 CHECK (ytd_tax >= 0),
  ytd_net       NUMERIC NOT NULL DEFAULT 0 CHECK (ytd_net >= 0),

  -- Vacation state at cutover.
  vacation_paid_days_remaining NUMERIC NOT NULL DEFAULT 0
    CHECK (vacation_paid_days_remaining >= 0 AND vacation_paid_days_remaining <= 40),
  -- Sparade dagar keyed by origin year, e.g. {"2024": 5, "2023": 3}.
  -- Semesterlagen: days may be saved max 5 years; Zod validates keys in
  -- [cutover_year - 5, cutover_year - 1] and values 0-40 app-side.
  vacation_saved_days_by_year JSONB NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(vacation_saved_days_by_year) = 'object'),

  -- Opening semesterlöneskuld in SEK. NOT booked by Accounted: the 2920/2940
  -- balances arrived via SIE opening balances. Feeds the vacation-liability
  -- report as an opening term only.
  opening_semester_liability          NUMERIC NOT NULL DEFAULT 0
    CHECK (opening_semester_liability >= 0),
  opening_semester_liability_avgifter NUMERIC NOT NULL DEFAULT 0
    CHECK (opening_semester_liability_avgifter >= 0),

  -- Karens periods in the 12 months before cutover not covered by imported
  -- absence rows (högriskskydd cap is 10 per rolling 12 months).
  karens_periods_adjustment INTEGER NOT NULL DEFAULT 0
    CHECK (karens_periods_adjustment >= 0 AND karens_periods_adjustment <= 10),

  created_by  UUID REFERENCES auth.users(id),
  updated_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (company_id, employee_id),
  -- YTD tax can never exceed gross (net CAN differ from gross - tax because
  -- of net deductions, so no equality constraint there).
  CHECK (ytd_tax <= ytd_gross)
);

-- The UNIQUE constraint doubles as the (company_id, employee_id) index; add
-- the employee-first path for engine batch loads keyed by employee ids.
CREATE INDEX idx_employee_opening_balances_employee
  ON public.employee_opening_balances (employee_id);

ALTER TABLE public.employee_opening_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_opening_balances_select" ON public.employee_opening_balances
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "employee_opening_balances_insert" ON public.employee_opening_balances
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "employee_opening_balances_update" ON public.employee_opening_balances
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "employee_opening_balances_delete" ON public.employee_opening_balances
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER employee_opening_balances_updated_at
  BEFORE UPDATE ON public.employee_opening_balances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Lock guard: opening balances are editable until the employee has a BOOKED
-- salary run. Derived (no flag) so it cannot drift and self-unlocks when the
-- only booked run is corrected. The route layer surfaces a clean 409
-- (OPENING_BALANCES_LOCKED) before this trigger fires; the trigger is the
-- all-paths backstop (service-role writes, future surfaces).
CREATE OR REPLACE FUNCTION public.enforce_opening_balances_lock()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.salary_run_employees sre
    JOIN public.salary_runs sr ON sr.id = sre.salary_run_id
    WHERE sre.employee_id = NEW.employee_id
      AND sre.company_id = NEW.company_id
      AND sr.status = 'booked'
  ) THEN
    RAISE EXCEPTION
      'Ingående saldon är låsta: den anställda har en bokförd lönekörning.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_opening_balances_lock
  BEFORE INSERT OR UPDATE ON public.employee_opening_balances
  FOR EACH ROW EXECUTE FUNCTION public.enforce_opening_balances_lock();

NOTIFY pgrst, 'reload schema';
