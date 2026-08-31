-- Per-company editable reminder email texts per reminder level (1-3).
-- NULL column / missing keys / whitespace-only values fall back to the
-- defaults in lib/email/reminder-templates.ts (REMINDER_EMAIL_DEFAULT_TEXTS);
-- only diffs from the defaults are stored (prefill-override convention).
-- TEXT only: reminder fee and interest math live in the reminder processor
-- and are not configurable here (Lag 1981:739 caps the paminnelseavgift at
-- 60 kr; no per-step fee logic exists or is added).
-- Length limits are enforced by UpdateSettingsSchema (the only write path);
-- mirrors the invoice_email_texts precedent (20260703091000).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS reminder_text_overrides JSONB NULL;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_reminder_text_overrides_object;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_reminder_text_overrides_object
  CHECK (reminder_text_overrides IS NULL OR jsonb_typeof(reminder_text_overrides) = 'object');

COMMENT ON COLUMN public.company_settings.reminder_text_overrides IS
  'Overrides for reminder emails: { level_1?: { subject?, body? }, level_2?: {...}, level_3?: {...} }. Placeholders {fakturanummer} {kundnamn} {förnamn} {företag} {fakturadatum} {förfallodatum} {belopp} {dagar} are substituted at send time by lib/email/reminder-templates.ts. NULL / missing / whitespace-only fields fall back to the hardcoded defaults. Text only; never affects fee or interest math.';

NOTIFY pgrst, 'reload schema';
