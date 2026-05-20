-- Migration: agent_atom_registry — catalog of skill atoms (horizontal/vertical/modifier)
--
-- The specialized accountant agent is composed of a tiered set of "atoms":
--   * horizontal — regulatory skills shared by every Swedish company
--                  (swedish-vat, swedish-payroll, swedish-year-end-closing, …)
--   * vertical   — industry-specific knowledge (konsult-it, restaurang-cafe,
--                  e-handel, bygg-hantverk, …)
--   * modifier   — cross-cutting attributes (single-shareholder-ab-fmb,
--                  enskild-firma, small-employer, …)
--
-- The composer (Opus 4.7) picks an atom set per company at signup and on
-- recomposition. The registry is the index it queries; the bodies live in
-- .claude/skills/ on disk and are loaded into the system prompt at runtime.
--
-- The catalog is globally readable to authenticated users (every agent
-- invocation needs the metadata) but only writable via service role —
-- atoms ship with the application, not authored per-tenant.
--
-- See dev_docs/specialized-agent-plan.md §4 (atom library) and §5 (data model).

CREATE TABLE public.agent_atom_registry (
  id                text PRIMARY KEY,
  -- Stable identifier shaped as "<tier>/<slug>" (e.g. "horizontal/swedish-vat",
  -- "vertical/konsult-it", "modifier/single-shareholder-ab-fmb").
  tier              text NOT NULL CHECK (tier IN ('horizontal', 'vertical', 'modifier')),
  title             text NOT NULL,
  description       text NOT NULL,
  -- SNI prefixes the atom is relevant for. Used by the composer as a coarse
  -- routing signal for vertical atoms (matched against TIC sniCodes).
  -- Empty array for horizontal and most modifier atoms.
  sni_prefixes      text[] NOT NULL DEFAULT '{}',
  -- Free-form trigger signals the composer uses (counterparty regex hints,
  -- BAS account patterns, employee-range hints, …). Schema is intentionally
  -- open — atoms evolve faster than migrations.
  trigger_signals   jsonb NOT NULL DEFAULT '{}',
  -- Baseline token estimate for the atom body. Used for budget computation
  -- before assembling the system prompt. Re-measured per model — Opus 4.7
  -- tokenizer may inflate Swedish text up to ~35%.
  estimated_tokens  integer NOT NULL DEFAULT 0,
  -- Filesystem path (relative to repo root) to the SKILL.md body.
  body_path         text NOT NULL,
  -- Atom version. Editing a SKILL.md bumps this; readers route by version
  -- so cache prefixes survive coordinated rollouts.
  version           integer NOT NULL DEFAULT 1,
  is_active         boolean NOT NULL DEFAULT true,
  schema_version    integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_atom_registry_tier_active
  ON public.agent_atom_registry (tier, is_active);

-- GIN index for SNI prefix matching during composition.
CREATE INDEX idx_agent_atom_registry_sni_prefixes
  ON public.agent_atom_registry USING GIN (sni_prefixes);

CREATE TRIGGER agent_atom_registry_updated_at
  BEFORE UPDATE ON public.agent_atom_registry
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- RLS: read-only for authenticated users; service role writes
-- =============================================================================

ALTER TABLE public.agent_atom_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_atom_registry_select_authenticated"
  ON public.agent_atom_registry
  FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT / UPDATE / DELETE policies for authenticated users.
-- Atoms ship with the application via seed migrations or admin tooling that
-- uses the service role.

NOTIFY pgrst, 'reload schema';
