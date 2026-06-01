-- Migration: salary_worked_days_cost_center — optional cost-center tagging on
-- manually-entered worked days.
--
-- Why this exists: when entering worked hours via the salary calendar, users
-- want to attribute the time to a cost center (kostnadsställe) for later
-- reporting. This stores the dimension on the day record only — it does not
-- yet flow into salary line items or the booked journal entry.
--
-- Nullable + ON DELETE SET NULL: tagging is optional, and deactivating/removing
-- a cost center must not block deletion or orphan the worked day.

ALTER TABLE public.salary_worked_days
  ADD COLUMN cost_center_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL;

-- Tagged-day lookups (e.g. "all worked days for cost center X").
CREATE INDEX idx_salary_worked_days_cost_center
  ON public.salary_worked_days (cost_center_id)
  WHERE cost_center_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
