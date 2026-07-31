-- Add a 'product' tier to agent_atom_registry.
--
-- The three existing tiers are all accounting-domain knowledge: horizontal
-- (Swedish regulatory, always active), vertical (industry, composer-selected),
-- modifier (company situation, composer-selected). None of them can hold
-- knowledge about Accounted's own features, so the in-app assistant had no
-- source to answer product questions from ("when do I pick Kostnad vs
-- Betalning on a template line?": reported by a user 2026-07-30, and the
-- assistant did not know either).
--
-- 'product' atoms describe how Accounted itself works. Like horizontal atoms
-- they apply to every company (always active, no composer selection); the
-- composer ignores them entirely (it filters for the specific tiers it
-- assigns), so agent_profiles are unaffected.
--
-- Authored in .claude/skills/product/<slug>/SKILL.md and seeded by the
-- generated seed migration that follows this one; this migration must run
-- first or that INSERT violates the CHECK.

-- The original CHECK was declared inline on the column (20260517200000), so
-- its name is the Postgres auto-name for a column check. Drop by discovering
-- the actual check constraint(s) on the tier column instead of hardcoding the
-- name: if the name were wrong, DROP IF EXISTS would silently no-op and the
-- surviving constraint would fail the seed INSERT that follows this migration.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.agent_atom_registry'::regclass
      AND con.contype = 'c'
      AND EXISTS (
        SELECT 1
        FROM unnest(con.conkey) AS k(attnum)
        JOIN pg_attribute a
          ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        WHERE a.attname = 'tier'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.agent_atom_registry DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.agent_atom_registry
  ADD CONSTRAINT agent_atom_registry_tier_check
  CHECK (tier IN ('horizontal', 'vertical', 'modifier', 'product'));

NOTIFY pgrst, 'reload schema';
