-- Add per-user UI language preference.
--
-- Stored on user_preferences (per-user-global, like active_company_id) rather
-- than on companies, so a consultant managing multiple companies keeps their
-- UI language regardless of which company is active.
--
-- Constraint enforces the two supported locales. Adding more is a follow-up
-- migration so we never end up with an orphan 'de' or 'fr' value the app
-- doesn't have translations for.

ALTER TABLE public.user_preferences
  ADD COLUMN locale TEXT NOT NULL DEFAULT 'sv'
  CHECK (locale IN ('sv', 'en'));

NOTIFY pgrst, 'reload schema';
