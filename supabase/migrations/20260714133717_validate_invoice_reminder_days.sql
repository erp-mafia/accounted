ALTER TABLE public.company_settings
  VALIDATE CONSTRAINT company_settings_reminder_days_check;

NOTIFY pgrst, 'reload schema';
