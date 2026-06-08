-- API keys: segregation-of-duties acknowledgement + agent:write scope grandfathering
--
-- Part 1 — SoD acknowledgement columns
-- When a key is minted with both a staging write scope AND
-- pending_operations:approve, the create route warns and requires an explicit
-- acknowledgement (warn + confirm, not block). We record who acknowledged the
-- combined risk and when, so the acceptance is auditable (ISO 27001:2022
-- A.5.3 segregation of duties / SOC 2 CC6.1; BFNAR 2013:2 behandlingshistorik).
--
-- DELIBERATE DESIGN: this is a SELF-attestation — sod_acknowledged_by is the
-- creating user, not a second approver. The product serves enskilda firmor
-- where a second person frequently does not exist, and the claude.ai chat
-- approval flow legitimately requires stage+approve on one credential. The
-- control objective is informed consent + an auditable record, not dual
-- control; hard blocking was considered and rejected (see PR #681).
--
-- Part 2 — agent:write grandfathering
-- The memory tools gnubok_remember_fact / gnubok_forget_fact were previously
-- UNMAPPED in TOOL_SCOPE_MAP, which meant they were callable by ANY
-- authenticated key (tools omitted from the map are unscoped). This migration
-- introduces the agent:write scope and maps those two tools to it. Mapping a
-- previously-unscoped tool would silently break every existing key that relies
-- on the old "callable by any key" behaviour. To preserve that behaviour we
-- grandfather agent:write onto all existing non-revoked keys that already have
-- an explicit scope list. New keys must opt in to agent:write explicitly.
--
-- Reference (verified against supabase/migrations/20260320120000_api_keys.sql):
--   public.api_keys.scopes     text[]       (NULL = legacy full/default access)
--   public.api_keys.revoked_at timestamptz  (NULL = active key)

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS sod_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS sod_acknowledged_by uuid REFERENCES auth.users(id);

-- The acknowledgement is only auditable as a pair (WHO accepted WHEN) — enforce
-- both-or-neither at the DB layer so a partial write can never silently pass.
ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_sod_ack_paired;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_sod_ack_paired
    CHECK ((sod_acknowledged_at IS NULL) = (sod_acknowledged_by IS NULL));

-- Grandfather agent:write onto existing non-revoked keys that already carry an
-- explicit scope list. Keys with NULL scopes are intentionally left NULL —
-- pinning them to a materialized list would freeze their dynamic
-- DEFAULT_SCOPES fallback semantics. NOTE the trade-off: validateApiKey
-- resolves NULL scopes to DEFAULT_SCOPES (which deliberately excludes
-- agent:write), so an active NULL-scope key that called the previously
-- unscoped memory tools WILL lose that ability. The WARNING below makes any
-- such keys visible at apply time; if it fires on a live environment, decide
-- per key (re-mint with explicit scopes, or accept the tightening — memory
-- writes were never an intended legacy-key capability).
DO $$
DECLARE
  v_null_scope_keys integer;
BEGIN
  SELECT count(*) INTO v_null_scope_keys
  FROM public.api_keys
  WHERE revoked_at IS NULL AND scopes IS NULL;

  IF v_null_scope_keys > 0 THEN
    RAISE WARNING
      'agent:write grandfathering skipped % active NULL-scope key(s). These fall back to DEFAULT_SCOPES (no agent:write) and lose access to gnubok_remember_fact/gnubok_forget_fact. Review them: SELECT id, name, created_at FROM api_keys WHERE revoked_at IS NULL AND scopes IS NULL;',
      v_null_scope_keys;
  END IF;
END
$$;

UPDATE public.api_keys
SET scopes = array_append(scopes, 'agent:write')
WHERE revoked_at IS NULL
  AND scopes IS NOT NULL
  AND NOT ('agent:write' = ANY(scopes));

NOTIFY pgrst, 'reload schema';
