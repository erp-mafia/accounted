-- Atomic per-user claim for login-email change requests.
--
-- POST /api/account/email must not re-issue GoTrue's confirmation tokens
-- while a change to the same address is still fresh: every re-issue voids
-- the links the user is about to click (the "link invalid" loop of
-- 2026-09-02). The route reads GoTrue's pending state first, but two
-- concurrent requests (a double submit from two tabs, or a retried fetch)
-- can both read "nothing pending" and both call updateUser. This table is
-- the cross-instance gate: one row per user, claimed with a single
-- INSERT ... ON CONFLICT DO UPDATE whose row lock serialises concurrent
-- claimers, so exactly one caller proceeds per address per window.
--
-- Account-level (no company_id): the login e-mail belongs to the auth user.
-- Not räkenskapsinformation; classified as infrastructure in
-- lib/reports/full-archive-export.ts. Rows go with the user (ON DELETE
-- CASCADE) and hold only the address the user typed.

CREATE TABLE public.email_change_requests (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  target_email text NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.email_change_requests IS
  'Per-user claim for an in-flight login-email change. Written only through claim_email_change_request / release_email_change_request; gates POST /api/account/email so concurrent requests cannot re-issue confirmation tokens.';

-- No policies on purpose: nothing reads or writes this table except the two
-- SECURITY DEFINER functions below, which key every statement on auth.uid().
ALTER TABLE public.email_change_requests ENABLE ROW LEVEL SECURITY;

-- Returns true when the caller now holds the claim for p_email and may call
-- GoTrue; false when another request claimed the same address less than
-- p_window_seconds ago (the caller must answer "already pending" and send
-- nothing). A different address always wins the claim: the user changed
-- their mind, and GoTrue restarts the change for the new address anyway.
CREATE OR REPLACE FUNCTION public.claim_email_change_request(
  p_email text,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_won boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'claim_email_change_request requires an authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_email IS NULL OR length(btrim(p_email)) = 0 THEN
    RAISE EXCEPTION 'claim_email_change_request requires an address'
      USING ERRCODE = '22023';
  END IF;
  IF p_window_seconds IS NULL OR p_window_seconds <= 0 THEN
    RAISE EXCEPTION 'claim_email_change_request requires a positive window'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.email_change_requests (user_id, target_email, claimed_at)
  VALUES (v_uid, lower(btrim(p_email)), now())
  ON CONFLICT (user_id) DO UPDATE
    SET target_email = EXCLUDED.target_email,
        claimed_at = now()
    WHERE public.email_change_requests.target_email <> EXCLUDED.target_email
       OR public.email_change_requests.claimed_at
            < now() - make_interval(secs => p_window_seconds)
  RETURNING true INTO v_won;

  RETURN COALESCE(v_won, false);
END;
$$;

-- Drops the caller's claim so a failed GoTrue call (AAL2 refusal, address
-- already registered, network) does not lock the user out of retrying for
-- the whole window.
CREATE OR REPLACE FUNCTION public.release_email_change_request()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'release_email_change_request requires an authenticated user'
      USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.email_change_requests WHERE user_id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.claim_email_change_request(text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_email_change_request() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_email_change_request(text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_email_change_request() TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
