-- Vacation category per payslip line (cutover track of #2729).
-- pg-test: supabase/migrations/__tests__/employee-opening-balances-categories.pg.test.ts
--
-- A vacation line (item_type = 'vacation', quantity = days) says WHICH pool
-- the days come from, in the same five categories Fortnox and Azets use:
--   paid        Betalda: this year's paid days (the default when NULL)
--   extra_paid  Extra betalda: paid days above the statutory entitlement
--   saved       Sparade: sparade dagar, optionally from a named origin year
--               (vacation_saved_year); the ledger takes the oldest year first
--               when the year is omitted
--   unpaid      Obetalda: unpaid days (Semesterlagen 8 §)
--   advance     Förskott: förskottssemester
-- One enum column per line, not a movements array: a payslip line is
-- already one dated, quantified withdrawal.
--
-- The CHECKs mirror validateVacationCategoryLine (lib/salary/vacation-
-- category.ts): a category only on a vacation line, a saved year only
-- with category 'saved' and only as a four-digit year. Added NOT VALID and
-- validated in 20260919130200 (same split as 20260919120200 / 120300);
-- every existing row is NULL on both columns and passes.

ALTER TABLE public.salary_line_items
  ADD COLUMN IF NOT EXISTS vacation_category text,
  ADD COLUMN IF NOT EXISTS vacation_saved_year text;

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT IF EXISTS salary_line_items_vacation_category_check;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_vacation_category_check
  CHECK (
    vacation_category IS NULL
    OR (
      item_type = 'vacation'
      AND vacation_category IN ('paid', 'extra_paid', 'saved', 'unpaid', 'advance')
    )
  )
  NOT VALID;

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT IF EXISTS salary_line_items_vacation_saved_year_check;

-- vacation_category is nullable, so the comparison must be NULL-safe: a bare
-- `vacation_category = 'saved'` is NULL when the category is NULL, and a
-- NULL CHECK result passes. `IS NOT DISTINCT FROM` yields false instead.
ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_vacation_saved_year_check
  CHECK (
    vacation_saved_year IS NULL
    OR (
      vacation_category IS NOT DISTINCT FROM 'saved'
      AND vacation_saved_year ~ '^[0-9]{4}$'
    )
  )
  NOT VALID;

COMMENT ON COLUMN public.salary_line_items.vacation_category IS
  'Which vacation pool a vacation line draws from: paid (default when NULL), extra_paid, saved, unpaid or advance. Only on item_type = vacation.';
COMMENT ON COLUMN public.salary_line_items.vacation_saved_year IS
  'Origin year (YYYY) of the sparade dagar a saved vacation line consumes. Only with vacation_category = saved; omitted = oldest year first.';

NOTIFY pgrst, 'reload schema';
