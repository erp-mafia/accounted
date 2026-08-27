-- Migration: invite-only signup for white-label brand domains
--
-- A brand domain belongs to the partner's people: only whitelisted or invited
-- users may create an account on it; everyone else is sent to the canonical
-- signup (founder decision 2026-08-27). Three pieces:
--
--   1. brands.signup_mode: 'open' (default, byte-identical behavior) or
--      'invite_only'. Flipping a brand to invite_only arms the server-side
--      signup gate (lib/auth/brand-signup-gate.ts) on that brand's domain.
--   2. brand_signup_allowlist: the emails allowed to self-signup on an
--      invite_only brand domain. Company invites bypass the list (the invite
--      itself is the authorization); the list only governs cold signups.
--   3. create_company_for_brand_signup: service-role RPC that lets an
--      allowlisted user's onboarding-created company attach to the brand's
--      byrå team. Without this the company would have team_id NULL, and the
--      home-domain rule (WL-01) would home it on the canonical domain,
--      invisible on the very brand domain the user signed up on. The WL-15
--      owner/admin gate does not apply here by design: the allowlist entry is
--      the byrå's standing authorization for this signup, recorded by a byrå
--      owner/admin (or ops) when the email was added.

-- =============================================================================
-- 1. brands.signup_mode
-- =============================================================================

ALTER TABLE public.brands
  ADD COLUMN signup_mode text NOT NULL DEFAULT 'open';

ALTER TABLE public.brands
  ADD CONSTRAINT brands_signup_mode_check
    CHECK (signup_mode IN ('open', 'invite_only'));

COMMENT ON COLUMN public.brands.signup_mode IS
  'open: anyone may self-signup on this brand domain (default, canonical '
  'behavior). invite_only: cold signups require a brand_signup_allowlist '
  'entry; company invites bypass the list. Enforced server-side in '
  'lib/auth/brand-signup-gate.ts on every signup path (email, BankID, '
  'Google).';

-- =============================================================================
-- 2. brand_signup_allowlist
-- =============================================================================

CREATE TABLE public.brand_signup_allowlist (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id   uuid NOT NULL REFERENCES public.brands(id) ON DELETE CASCADE,

  -- Stored lowercase so matching is one indexed equality; the CHECK makes a
  -- mixed-case insert an error instead of a silent never-matching row.
  email      text NOT NULL,

  -- Free-text label for the byrå ("VD Nya Kunden AB"), never load-bearing.
  note       text,

  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brand_signup_allowlist_email_lowercase
    CHECK (email = lower(email)),
  CONSTRAINT brand_signup_allowlist_email_format
    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT brand_signup_allowlist_unique_email
    UNIQUE (brand_id, email)
);

COMMENT ON TABLE public.brand_signup_allowlist IS
  'Emails allowed to self-signup on an invite_only brand domain. The list '
  'governs only cold signups: a pending company invite bypasses it because '
  'the invite itself is the authorization. Managed by the brand''s byrå team '
  '(owner/admin) via the cockpit, and by ops via the service role.';

CREATE INDEX idx_brand_signup_allowlist_brand_email
  ON public.brand_signup_allowlist (brand_id, email);

-- =============================================================================
-- RLS: the brand's byrå team reads its own list; owner/admin write it.
-- The signup gate itself runs with the service role (the visitor is
-- anonymous at signup time) and bypasses RLS by design.
-- =============================================================================

ALTER TABLE public.brand_signup_allowlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "brand_signup_allowlist_select" ON public.brand_signup_allowlist
  FOR SELECT USING (
    brand_id IN (
      SELECT b.id FROM public.brands b
      WHERE b.team_id IN (SELECT public.user_team_ids())
    )
  );

-- Writes are owner/admin only: adding an email is a commercial act (the
-- signup it authorizes creates a client company on the byrå's invoice via
-- create_company_for_brand_signup), same bar as WL-15 client creation.
CREATE POLICY "brand_signup_allowlist_insert" ON public.brand_signup_allowlist
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.brands b
      JOIN public.team_members tm ON tm.team_id = b.team_id
      WHERE b.id = brand_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'admin')
    )
  );

CREATE POLICY "brand_signup_allowlist_delete" ON public.brand_signup_allowlist
  FOR DELETE USING (
    EXISTS (
      SELECT 1
      FROM public.brands b
      JOIN public.team_members tm ON tm.team_id = b.team_id
      WHERE b.id = brand_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'admin')
    )
  );

-- =============================================================================
-- 3. create_company_for_brand_signup
--
-- Body mirrors create_company_for_user (20260826130600) step for step, with
-- the team-membership gate replaced by an allowlist gate: the owner must be
-- on the brand's signup allowlist, and the company attaches to the brand's
-- team. Callable by service_role ONLY; the calling server action
-- (lib/company/actions.ts) has already verified the request host is the
-- brand's domain.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_company_for_brand_signup(
  p_user_id uuid,
  p_name text,
  p_entity_type text,
  p_brand_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_team_id uuid;
  v_email text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  IF p_brand_id IS NULL THEN
    RAISE EXCEPTION 'p_brand_id is required';
  END IF;

  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = p_user_id;
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'Unknown user %', p_user_id
      USING ERRCODE = '23503'; -- foreign_key_violation
  END IF;

  IF p_entity_type NOT IN ('enskild_firma', 'aktiebolag') THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'p_name is required';
  END IF;

  SELECT b.team_id INTO v_team_id FROM public.brands b WHERE b.id = p_brand_id;
  IF v_team_id IS NULL THEN
    RAISE EXCEPTION 'Unknown brand %', p_brand_id
      USING ERRCODE = '23503'; -- foreign_key_violation
  END IF;

  -- The allowlist entry IS the authorization: it was recorded by a byrå
  -- owner/admin (RLS above) or ops, standing in for the WL-15 admin gate.
  IF NOT EXISTS (
    SELECT 1
    FROM public.brand_signup_allowlist a
    WHERE a.brand_id = p_brand_id
      AND a.email = v_email
  ) THEN
    RAISE EXCEPTION 'User % is not on the signup allowlist for brand %', p_user_id, p_brand_id
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by, team_id)
  VALUES (btrim(p_name), p_entity_type, p_user_id, v_team_id)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, p_user_id, 'owner');

  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  )
  VALUES (
    v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  )
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  INSERT INTO public.user_preferences (user_id, active_company_id)
  VALUES (p_user_id, v_company_id)
  ON CONFLICT (user_id)
  DO UPDATE SET active_company_id = EXCLUDED.active_company_id;

  PERFORM public.sync_team_to_company(v_company_id, v_team_id);

  RETURN v_company_id;
END;
$$;

-- Service role only. PostgREST exposes functions to every role by default
-- (PUBLIC grant), so revoke first, then grant the one role that may call it.
REVOKE ALL ON FUNCTION public.create_company_for_brand_signup(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_company_for_brand_signup(uuid, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_company_for_brand_signup(uuid, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_company_for_brand_signup(uuid, text, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
