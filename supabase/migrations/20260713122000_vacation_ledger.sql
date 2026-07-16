-- Migration: vacation balance ledger + year closures (payroll gap-closure
-- Phase 3: semesterberedning/semesterårsavslut).
--
-- Why this exists: vacation liability has been COMPUTED from booked salary
-- runs (per-run accrual summed by lib/reports/vacation-liability.ts) and
-- sparade dagar was a single cumulative field on employees. That breaks at
-- every intjänandeår boundary: no persisted per-year balance, no 5-year
-- sparade-dagar tracking (Semesterlagen 18 §), no year-close.
--
-- employee_vacation_balances: one row per (company, employee, vacation year).
-- DAYS ONLY: the SEK side stays derived (2920/2940 are booked per run plus
-- the cutover opening term); persisting a parallel SEK column would create a
-- reconciliation obligation with zero new information.
--
-- The ledger is RECOMPUTED from booked runs on every book/correct (not
-- incremented): idempotent, self-healing, and corrections need no special
-- casing.
--
-- vacation_year_closures: audit anchor for the year-close workflow. The
-- frozen report is räkenskapsinformation (BFL 7 kap: it justifies the
-- adjustment verifikation), so there is deliberately NO DELETE policy.

CREATE TABLE public.employee_vacation_balances (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id         UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  -- First day of the vacation year: Jan 1 (calendar basis) or Apr 1
  -- (statutory basis), per company_settings.salary_vacation_year_basis.
  vacation_year_start DATE NOT NULL,
  -- Betalda dagar available this year (entitlement, or the cutover import).
  entitled_days       NUMERIC NOT NULL DEFAULT 0 CHECK (entitled_days >= 0),
  -- Intjänade toward NEXT year (statutory Apr-Mar basis only; for
  -- sammanfallande calendar years intjänande and uttag coincide and this
  -- stays 0).
  accrued_days        NUMERIC NOT NULL DEFAULT 0 CHECK (accrued_days >= 0),
  taken_days          NUMERIC NOT NULL DEFAULT 0 CHECK (taken_days >= 0),
  -- Sparade dagar keyed by origin year, e.g. {"2024": 5}: same
  -- representation as employee_opening_balances.vacation_saved_days_by_year.
  saved_days          JSONB NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(saved_days) = 'object'),
  -- Days that exceeded the 5-year saving limit at close: must be paid out
  -- as semesterersättning via a normal salary run.
  forced_payout_days  NUMERIC NOT NULL DEFAULT 0 CHECK (forced_payout_days >= 0),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_id, vacation_year_start)
);

CREATE INDEX idx_employee_vacation_balances_employee
  ON public.employee_vacation_balances (employee_id, vacation_year_start);

ALTER TABLE public.employee_vacation_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "employee_vacation_balances_select" ON public.employee_vacation_balances
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "employee_vacation_balances_insert" ON public.employee_vacation_balances
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "employee_vacation_balances_update" ON public.employee_vacation_balances
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "employee_vacation_balances_delete" ON public.employee_vacation_balances
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER employee_vacation_balances_updated_at
  BEFORE UPDATE ON public.employee_vacation_balances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.vacation_year_closures (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vacation_year_start DATE NOT NULL,
  closed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by           UUID REFERENCES auth.users(id),
  -- The drift-adjustment verifikation, when one was booked (|drift| > 1 kr).
  adjustment_entry_id UUID REFERENCES journal_entries(id),
  -- Frozen close report (per-employee transitions + SEK reconcile): the
  -- underlag for the adjustment entry, retained 7 years per BFL 7 kap.
  report              JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, vacation_year_start)
);

ALTER TABLE public.vacation_year_closures ENABLE ROW LEVEL SECURITY;

-- No DELETE policy: closures are audit artifacts. Reopening a year is a
-- future explicit feature, not a row delete.
CREATE POLICY "vacation_year_closures_select" ON public.vacation_year_closures
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "vacation_year_closures_insert" ON public.vacation_year_closures
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "vacation_year_closures_update" ON public.vacation_year_closures
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

-- Vacation year basis: sammanfallande calendar year (the small-company norm)
-- or the statutory Apr 1 - Mar 31 split per Semesterlagen 3 §.
ALTER TABLE public.company_settings
  ADD COLUMN salary_vacation_year_basis TEXT NOT NULL DEFAULT 'calendar'
    CHECK (salary_vacation_year_basis IN ('calendar', 'statutory_apr_mar'));

NOTIFY pgrst, 'reload schema';
