-- Migrations 20260806150000/160000 let trusted writers (service_role, or
-- no JWT claims at all: direct SQL, maintenance, pg tests) preserve a preset
-- committed_at on the draft-to-posted transition, which the seeding flows use
-- to backdate demo history. Nothing recorded that the transition timestamp was
-- overridden: BFNAR 2013:2 kap 8 wants behandlingshistorik showing who did
-- what, when. If a trusted-role connection is ever used against a live
-- company, there must be an audit row showing real vs. preset commit time.
-- (#1444)
--
-- Three pieces:
--   1. audit_log accepts action 'COMMITTED_AT_OVERRIDE'.
--   2. A SECURITY DEFINER helper writes the row. It cannot be a plain INSERT
--      inside the trigger: audit_log has RLS with no INSERT policy, and
--      service_role is not guaranteed BYPASSRLS everywhere the trigger runs
--      (the pg-test harness SET ROLE service_role has no such attribute).
--      EXECUTE is revoked from client roles so PostgREST cannot expose it as
--      an RPC for writing noise into the audit trail.
--   3. set_committed_at() calls the helper whenever it preserves a preset
--      value. The stamping branch is unchanged, byte for byte, from
--      20260806160000 (see that file's header for why 150000 and 160000 both
--      carry the same body).

-- ── 1. New audit action ──────────────────────────────────────────────────────

ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action = ANY (ARRAY[
    'INSERT','UPDATE','DELETE','COMMIT','REVERSE','CORRECT',
    'LOCK_PERIOD','CLOSE_PERIOD','DOCUMENT_DELETE_BLOCKED',
    'RETENTION_BLOCK','SECURITY_EVENT','INTEGRITY_FAILURE',
    'COMMITTED_AT_OVERRIDE'
  ]));

-- ── 2. Audit writer ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.log_committed_at_override(
  p_entry public.journal_entries,
  p_jwt_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- clock_timestamp(), not now(): the seeding flows post many entries inside
  -- one transaction, and now() would stamp every override with the
  -- transaction start instead of the moment it actually happened.
  v_wall_clock timestamptz := clock_timestamp();
BEGIN
  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  )
  VALUES (
    COALESCE(auth.uid(), p_entry.user_id),
    p_entry.company_id,
    'COMMITTED_AT_OVERRIDE',
    'journal_entries',
    p_entry.id,
    COALESCE(auth.uid(), p_entry.user_id),
    NULL,
    jsonb_build_object(
      'preset_committed_at', p_entry.committed_at,
      'wall_clock', v_wall_clock,
      'jwt_role', COALESCE(NULLIF(p_jwt_role, ''), 'none')
    ),
    format(
      'Preserved preset committed_at %s on draft-to-posted; wall clock %s (jwt role: %s)',
      p_entry.committed_at, v_wall_clock, COALESCE(NULLIF(p_jwt_role, ''), 'none')
    ),
    COALESCE(NULLIF(current_setting('gnubok.actor_type', true), ''), 'system'),
    NULLIF(current_setting('gnubok.actor_label', true), '')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_committed_at_override(public.journal_entries, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_committed_at_override(public.journal_entries, text) FROM anon;
REVOKE ALL ON FUNCTION public.log_committed_at_override(public.journal_entries, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.log_committed_at_override(public.journal_entries, text) TO service_role;

-- ── 3. set_committed_at v3: preserve AND log ────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_committed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_jwt_role text;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    v_jwt_role := coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      nullif(current_setting('request.jwt.claim.role', true), ''),
      ''
    );
    IF NEW.committed_at IS NULL
       OR NOT (v_jwt_role = '' OR v_jwt_role = 'service_role') THEN
      NEW.committed_at := now();
    ELSE
      -- Trusted writer keeps its preset value: durable trace of the override.
      PERFORM public.log_committed_at_override(NEW, v_jwt_role);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
