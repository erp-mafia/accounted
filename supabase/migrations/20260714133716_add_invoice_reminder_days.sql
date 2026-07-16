-- Per-company schedule for the three automatic customer invoice reminders.
-- Defaults preserve the existing 15, 30, and 45 days overdue behavior.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS reminder_days_level_1 SMALLINT NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS reminder_days_level_2 SMALLINT NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS reminder_days_level_3 SMALLINT NOT NULL DEFAULT 45;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_reminder_days_check
  CHECK (
    reminder_days_level_1 BETWEEN 1 AND 365
    AND reminder_days_level_2 BETWEEN 1 AND 365
    AND reminder_days_level_3 BETWEEN 1 AND 365
    AND reminder_days_level_1 < reminder_days_level_2
    AND reminder_days_level_2 < reminder_days_level_3
  ) NOT VALID;

COMMENT ON COLUMN public.company_settings.reminder_days_level_1
  IS 'Days overdue before the first automatic customer invoice reminder.';
COMMENT ON COLUMN public.company_settings.reminder_days_level_2
  IS 'Days overdue before the second automatic customer invoice reminder.';
COMMENT ON COLUMN public.company_settings.reminder_days_level_3
  IS 'Days overdue before the final automatic customer invoice reminder.';

NOTIFY pgrst, 'reload schema';
