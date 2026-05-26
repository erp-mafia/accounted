-- Migration: agent_atom_registry — add `body` (DB-inline SKILL.md content) + `mcp_exposed` (curation switch)
--
-- Skill bodies were read from disk at runtime (readFile(process.cwd() + body_path)).
-- On Vercel (our primary target) the dynamic path is never traced into the lambda,
-- and on Docker .claude/ is excluded from the image — so atom bodies loaded EMPTY in
-- production (the read throws and the atom is silently skipped). Move the body into
-- the DB so runtime reads it from the row instead of disk; this works identically on
-- Vercel, Docker, and self-hosted with no file-tracing config or .dockerignore surgery.
--
-- `body` is nullable here so the column-add is non-breaking; it is populated by a
-- generated seed migration (scripts/generate-skill-bodies.ts) that ships the SKILL.md
-- content. Readers fall back to the on-disk file when `body` IS NULL (dev convenience
-- before seeding). `body_path` stays as a provenance/debug field and the dev anchor.
--
-- `mcp_exposed` gates which atoms the MCP server surfaces as loadable skills
-- (gnubok_list_skills / gnubok_load_skill). Defaults true — an explicit, queryable
-- kill-switch so a non-end-user atom can be hidden from Claude without deleting the row.
-- The in-app composer queries the registry directly and is NOT gated by this column.
--
-- No new RLS policy: the existing "agent_atom_registry_select_authenticated" SELECT
-- TO authenticated USING (true) already covers the new columns; writes remain
-- service-role only. No new trigger: updated_at already fires from
-- agent_atom_registry_updated_at (migration 20260517200000).

ALTER TABLE public.agent_atom_registry
  ADD COLUMN IF NOT EXISTS body text,
  ADD COLUMN IF NOT EXISTS mcp_exposed boolean NOT NULL DEFAULT true;

NOTIFY pgrst, 'reload schema';
