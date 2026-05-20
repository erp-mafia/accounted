-- Migration: agent_profiles — one composed agent per company
--
-- An agent_profile is the persistent identity of a company's specialized
-- accountant. It records:
--
--   * Which atoms the composer loaded (horizontal/vertical/modifier IDs into
--     agent_atom_registry). These drive every chat turn's system prompt.
--   * A short Swedish profile_summary (≤120 words) shown to the user during
--     verification and reused in the per-user cache block.
--   * source_signals: snapshot of what the composer saw at composition time
--     (TIC fields, SIE top accounts, banking top counterparties) — so the
--     selection is reconstructable even if upstream data changes.
--   * field_overrides: user-edited fields with timestamps. On recomposition,
--     overrides are respected; staleness surfacing is deferred (see plan §6).
--   * trust_per_tool: per-MCP-tool auto-approval policy. Data only for v0;
--     management UI lives post-POC (plan §12).
--
-- One profile per company is enforced by UNIQUE (company_id). RLS lets
-- members read/update; only service role (composer) inserts.
--
-- See dev_docs/specialized-agent-plan.md §5 (data model), §6 (composer),
-- §10 (caching), §12 (trust settings).

CREATE TABLE public.agent_profiles (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id           uuid NOT NULL UNIQUE REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Atom loadout. Arrays of atom registry IDs (e.g. 'horizontal/swedish-vat').
  -- Foreign keys to the registry are intentionally not declared — the registry
  -- is shipped, atoms come and go in versions, and we want a profile to keep
  -- pointing at a renamed atom rather than block writes.
  horizontal_atoms     text[] NOT NULL DEFAULT '{}',
  vertical_atoms       text[] NOT NULL DEFAULT '{}',
  modifier_atoms       text[] NOT NULL DEFAULT '{}',

  profile_summary      text,

  -- What the composer saw. Free-form JSON: { tic: {...}, sie_summary: {...},
  -- banking_summary: {...}, atom_index_version: N }.
  source_signals       jsonb NOT NULL DEFAULT '{}',

  -- User-edited fields. Shape: { "<field>": { "value": <any>, "overridden_at": "<iso>" } }.
  -- Used during recomposition to respect prior user judgments.
  field_overrides      jsonb NOT NULL DEFAULT '{}',

  -- Composition provenance.
  composed_at          timestamptz NOT NULL DEFAULT now(),
  composer_model       text,
  composer_version     integer NOT NULL DEFAULT 1,

  -- User verification of the inferred profile.
  verified_at          timestamptz,
  verified_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Per-tool auto-approval policy. Shape:
  --   { "<mcp_tool_name>": { "auto_approve_risk": "low"|"medium"|null } }
  -- `null` or missing => no auto-approval. high-risk is never auto-approvable
  -- (legally enforced by the loop, not by this column).
  trust_per_tool       jsonb NOT NULL DEFAULT '{}',

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_profiles_company ON public.agent_profiles (company_id);

CREATE TRIGGER agent_profiles_updated_at
  BEFORE UPDATE ON public.agent_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE public.agent_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_profiles_select"
  ON public.agent_profiles
  FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "agent_profiles_update"
  ON public.agent_profiles
  FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()));

-- No INSERT / DELETE policies for authenticated users. The composer writes
-- via service role on signup / rebuild. Deletes propagate from companies.

NOTIFY pgrst, 'reload schema';
