-- Migration: idempotency keys are claimed before the write runs.
--
-- Why: until now a key's row was stored only after the write finished, so
-- two requests carrying the same key that overlapped both ran. A stateless
-- MCP client resends a call on any broken stream, and a v1 client retries on
-- a timeout, so overlapping repeats are ordinary traffic; in a ledger the
-- second run is a second verifikat.
--
-- Now a request claims its key first, through claim_idempotency_key(), which
-- takes an advisory lock on the key and then answers in one call:
--   replay       a completed row with the same request hash: return it
--   reuse        a live row with another request hash: 409 IDEMPOTENCY_KEY_REUSE
--   in_progress  a live claim with the same hash: the same write is running
--                right now (409 IDEMPOTENCY_KEY_IN_PROGRESS, retry later)
--   claimed      no live row: this request now holds the key
-- On success the app turns its claim into the stored response (state
-- completed, response, expires_at 24 h out). On a failure it deletes the
-- claim, so a retry runs again: failures are still never stored.
--
-- Abandoned claims: a claim's expires_at is the claim time plus the TTL the
-- app passes (IDEMPOTENCY_CLAIM_TTL_SECONDS in src/lib/api/idempotency.ts:
-- longer than the longest request that can hold one). A row past expires_at
-- is dead whatever its state, and the next claim for the key deletes it and
-- takes the key in the same locked call. So a claim whose request was killed
-- (function timeout, crash) frees itself without a cron; the existing 24 h
-- cleanup cron (/api/idempotency/cleanup/cron) still sweeps what nobody
-- reclaims.
--
-- Company creation: a company create has no company until it runs, so its
-- claim carries company_id NULL and is scoped per (user, scope, key), as the
-- lookup already was; completing it writes the created company's id. Every
-- other row still needs a company (idempotency_keys_company_id_not_null), so
-- a stored response stays scoped per (user, company, key) and can never be
-- replayed into another company.

-- 1. Claim state. Existing rows, and inserts that do not name a state (MCP
--    staging still inserts its response after the write), are completed
--    responses.
ALTER TABLE public.idempotency_keys
  ADD COLUMN state text NOT NULL DEFAULT 'completed'
    CONSTRAINT idempotency_keys_state_check CHECK (state IN ('in_progress', 'completed'));

-- 2. A claim has no response yet, and a company-create claim no company.
ALTER TABLE public.idempotency_keys ALTER COLUMN response_status DROP NOT NULL;
ALTER TABLE public.idempotency_keys ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE public.idempotency_keys
  ADD CONSTRAINT idempotency_keys_response_matches_state
    CHECK ((state = 'completed') = (response_status IS NOT NULL)),
  ADD CONSTRAINT idempotency_keys_company_id_not_null
    CHECK (company_id IS NOT NULL OR (state = 'in_progress' AND scope = 'company_create'));

-- 3. At most one company-create claim in flight per user and key. The
--    advisory lock in claim_idempotency_key already serialises claims; this
--    holds the invariant even if a caller ever ran it under a stricter
--    isolation level, where a waiting claim could miss the row the first one
--    inserted. (Company-scoped rows have the unique index on
--    (user_id, company_id, key) from 20260504100000.)
CREATE UNIQUE INDEX idx_idempotency_keys_company_create_claim
  ON public.idempotency_keys (user_id, scope, key)
  WHERE company_id IS NULL;

-- 4. The claim.
CREATE OR REPLACE FUNCTION public.claim_idempotency_key(
  p_user_id           uuid,
  p_company_id        uuid,
  p_scope             text,
  p_key               text,
  p_request_hash      text,
  p_claim_ttl_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row      public.idempotency_keys%ROWTYPE;
  v_claim_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_scope IS NULL OR p_request_hash IS NULL OR coalesce(btrim(p_key), '') = '' THEN
    RAISE EXCEPTION 'claim_idempotency_key: user, scope, key and request hash are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Tenancy: a key is scoped to (user, company). Only a company create, which
  -- has no company yet, is claimed per (user, scope).
  IF p_company_id IS NULL AND p_scope <> 'company_create' THEN
    RAISE EXCEPTION 'claim_idempotency_key: scope % needs a company', p_scope
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_claim_ttl_seconds IS NULL OR p_claim_ttl_seconds < 1 OR p_claim_ttl_seconds > 86400 THEN
    RAISE EXCEPTION 'claim_idempotency_key: p_claim_ttl_seconds must be in [1, 86400]; got %', p_claim_ttl_seconds
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One claim decision at a time per key: a concurrent call with the same key
  -- waits here until this transaction ends, and its next statement then sees
  -- the row this one wrote. Released at commit or rollback.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'idempotency_keys:' || p_user_id::text || ':' || coalesce(p_company_id::text, p_scope) || ':' || p_key,
    0
  ));

  IF p_company_id IS NOT NULL THEN
    SELECT * INTO v_row
      FROM public.idempotency_keys
     WHERE user_id = p_user_id
       AND company_id = p_company_id
       AND key = p_key
       AND expires_at > now();
  ELSE
    SELECT * INTO v_row
      FROM public.idempotency_keys
     WHERE user_id = p_user_id
       AND scope = p_scope
       AND key = p_key
       AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  IF FOUND THEN
    IF v_row.request_hash IS DISTINCT FROM p_request_hash THEN
      RETURN jsonb_build_object('outcome', 'reuse');
    END IF;
    IF v_row.state = 'completed' THEN
      RETURN jsonb_build_object(
        'outcome', 'replay',
        'response_status', v_row.response_status,
        'response_body', v_row.response_body
      );
    END IF;
    RETURN jsonb_build_object('outcome', 'in_progress');
  END IF;

  -- No live row: take the key. A dead row for it (a claim past its TTL, a
  -- response past its 24 h) gives way.
  IF p_company_id IS NOT NULL THEN
    DELETE FROM public.idempotency_keys
     WHERE user_id = p_user_id
       AND company_id = p_company_id
       AND key = p_key
       AND expires_at <= now();
  ELSE
    DELETE FROM public.idempotency_keys
     WHERE user_id = p_user_id
       AND scope = p_scope
       AND key = p_key
       AND company_id IS NULL
       AND expires_at <= now();
  END IF;

  INSERT INTO public.idempotency_keys (user_id, company_id, key, request_hash, scope, state, expires_at)
  VALUES (
    p_user_id,
    p_company_id,
    p_key,
    p_request_hash,
    p_scope,
    'in_progress',
    now() + make_interval(secs => p_claim_ttl_seconds)
  )
  RETURNING id INTO v_claim_id;

  RETURN jsonb_build_object('outcome', 'claimed', 'claim_id', v_claim_id);
END;
$$;

COMMENT ON FUNCTION public.claim_idempotency_key(uuid, uuid, text, text, text, integer) IS
  'Claims an idempotency key before the write it guards runs: replay, reuse, in_progress or claimed. '
  'Service role only (API-key and MCP paths); see src/lib/api/idempotency.ts.';

-- SECURITY DEFINER and it takes the user id as an argument, so only the
-- server may call it: the v1 and MCP paths run as the service role.
REVOKE ALL ON FUNCTION public.claim_idempotency_key(uuid, uuid, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_idempotency_key(uuid, uuid, text, text, text, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
