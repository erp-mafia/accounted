-- Per-user UI state bag (UI migration PR 2, dev_docs/ui_migration_plan.md).
-- Holds client-driven interface preferences that should follow the user
-- across devices: sidebar collapse (nav_collapsed), nav fold state
-- (nav_folds.register / nav_folds.bokslut), and later the split-button
-- last-used create modes (create_mode.*, plan PR 3/4).
--
-- Deliberately one jsonb column instead of per-preference columns: these
-- values are cosmetic, never load-bearing, and never queried server-side
-- except to echo back to the client. Existing RLS on user_preferences
-- (select/insert/update own row) covers it; no policy changes.

ALTER TABLE public.user_preferences
  ADD COLUMN IF NOT EXISTS ui_state jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.user_preferences.ui_state IS
  'Client-driven UI preferences (nav collapse/fold state, last-used create modes). Cosmetic only, never authoritative for business logic.';
