-- Migration: interval_months on recurring_invoice_schedules
--
-- User request: recurring invoice schedules on quarterly, half-yearly, or
-- yearly cadence, "simplest via some form of month interval". The schedule
-- keeps day_of_month as the day anchor and next_run_date as the month anchor;
-- interval_months is how many months the cron advances next_run_date after a
-- successful run (and per step when rolling a missed schedule forward, so a
-- quarterly schedule keeps its Jan/Apr/Jul/Oct phase).
--
-- 1 = monthly (existing behavior, default so all existing rows are
-- unchanged), 3 = quarterly, 6 = half-yearly, 12 = yearly. The UI offers
-- those four presets; the API accepts any 1-12 (e.g. every 2 months).

ALTER TABLE public.recurring_invoice_schedules
  ADD COLUMN interval_months SMALLINT NOT NULL DEFAULT 1
    CHECK (interval_months BETWEEN 1 AND 12);

NOTIFY pgrst, 'reload schema';
