ALTER TABLE public.employees ADD CONSTRAINT zero_vacation_requires_no_tracking
  CHECK (vacation_days_per_year <> 0 OR vacation_rule = 'none') NOT VALID;
-- Existing legacy rows remain untouched, but all future writes enforce the rule.
NOTIFY pgrst, 'reload schema';
