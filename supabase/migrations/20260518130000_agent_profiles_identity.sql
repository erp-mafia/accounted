-- Migration: agent_profiles.display_name + avatar_id
--
-- Lets the user name their agent and pick an avatar during Phase B review.
-- The floating FAB and chat surfaces use these to feel personal — "Fråga
-- Anna" instead of the generic "Fråga min revisor".
--
-- Both columns are nullable. The agent UI falls back to:
--   * display_name → "min revisor"
--   * avatar_id    → generic Sparkles glyph
--
-- avatar_id is a free-form text key (e.g. "notionists-1") into the static
-- AVATAR_OPTIONS registry in components/agent/avatars.ts. No FK because the
-- registry lives in code — renaming a key means a one-time backfill, not a
-- schema migration.

ALTER TABLE public.agent_profiles
  ADD COLUMN display_name text,
  ADD COLUMN avatar_id    text;

NOTIFY pgrst, 'reload schema';
