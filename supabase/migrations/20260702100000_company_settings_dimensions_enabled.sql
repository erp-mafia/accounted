-- Dimensions registry (PR2 of the dimensions plan — dev_docs/dimensions_implementation_plan.md §4)
--
-- Adds the per-company UI toggle for the kostnadsställe/projekt registry.
-- UI-visibility only, NEVER load-bearing for correctness: dimension data
-- written via API/MCP/SIE is always validated regardless of this flag, and
-- reports never consult it. Free tier by founder decision 2026-07-02 — no
-- entitlement gating anywhere in the dimensions feature.
--
-- pg-test: skip (plain column addition, no trigger/RPC/RLS)

ALTER TABLE public.company_settings
  ADD COLUMN dimensions_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.dimensions_enabled IS
  'UI-visibility toggle for kostnadsställen & projekt (dimensions registry, pickers, report filters). Never load-bearing for correctness — data written via API/MCP/SIE import is validated regardless. SIE import that finds dimensions may flip this on with a notice.';

NOTIFY pgrst, 'reload schema';
