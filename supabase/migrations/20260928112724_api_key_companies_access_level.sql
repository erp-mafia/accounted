-- Per-company access level on the per-key company allowlist.
-- pg-test: tests/pg/api-key-company-access.pg.test.ts
--
-- api_key_companies (20260928112721) says WHICH companies a key reaches. It
-- could not say HOW: a connection that reached a company could do there
-- whatever its scopes allowed. A user connecting one agent to several
-- companies wants to let it book in some of them and only look in others
-- (a byrå's own books versus a client it only reviews, or a company where
-- the user wants every change to go through the web app). The scopes are
-- one set per key, so "write here, read there" had no representation.
--
-- This migration adds that representation as one column on the allowlist
-- row: access = 'write' (the scopes apply as granted, today's behaviour) or
-- 'read' (only read scopes apply in that company). Enforcement stays where
-- the membership and viewer gates already are (the MCP company routing and
-- the v1 REST wrapper), fed by validate_and_increment_api_key, which now
-- returns the read-only subset next to the allowlist. The effective right in
-- a company is the intersection of three things, each of which can only
-- narrow: the key's scopes, the company's access level, and the user's role.
--
-- An unrestricted key (no rows) has no per-company levels: it is "every
-- company, scopes as granted". A key that should only read somewhere is by
-- definition restricted, so read-only ids must always sit inside a non-empty
-- allowlist; both functions below refuse anything else.
--
-- Nothing here changes an existing key: the column defaults to 'write', the
-- table only exists on branches that carry 20260928112721, and every
-- existing row keeps the reach it had.

-- 1. The column ---------------------------------------------------------------

ALTER TABLE public.api_key_companies
  ADD COLUMN access text NOT NULL DEFAULT 'write'
    CONSTRAINT api_key_companies_access_check CHECK (access IN ('read', 'write'));

COMMENT ON COLUMN public.api_key_companies.access IS
  'What the key may do in this company: write = the key''s scopes apply as granted; read = only read scopes apply (every write, approve, manage and signoff scope is refused there). Always further capped by the user''s role in the company.';

COMMENT ON TABLE public.api_key_companies IS
  'Optional per-key company allowlist. No rows for a key: the key reaches every non-archived company its user is a member of (follows future memberships) with its scopes as granted. One or more rows: the key reaches only those companies, intersected with live membership at every call, and each row''s access (read | write) caps what the key may do there. The allowlist never widens access. Service role only; read by validate_and_increment_api_key.';

-- 2. validate_and_increment_api_key: also return the read-only subset --------
--
-- The body below is copied VERBATIM from 20260928112721 (the latest
-- definition) with exactly one change: read_only_company_ids uuid[] joins
-- the RETURNS TABLE, computed in the same statement as allowed_company_ids.
-- NULL when the key has no read-only rows (always NULL for an unrestricted
-- key), else the read-only ids in the allowlist's order. Returned in all
-- three RETURN QUERY branches. The default-company swap, the membership
-- block and the rate limiting are unchanged: a read-only company is still a
-- reachable company and may be the key's default.
--
-- The return type changes, so the function is dropped and re-created (CREATE
-- OR REPLACE cannot change a RETURNS TABLE), as 20260928112721 did.
DROP FUNCTION IF EXISTS public.validate_and_increment_api_key(text);

CREATE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(
  user_id uuid,
  company_id uuid,
  api_key_id uuid,
  api_key_name text,
  rate_limited boolean,
  scopes text[],
  mode text,
  unattended_commit_limit numeric,
  allowed_company_ids uuid[],
  read_only_company_ids uuid[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_user_id uuid;
  v_company_id uuid;
  v_api_key_name text;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
  v_scopes text[];
  v_mode text;
  v_unattended_commit_limit numeric;
  v_allowed_company_ids uuid[];
  v_read_only_company_ids uuid[];
BEGIN
  -- Match the live key_hash, OR a previous (just-rotated) key_hash that is still
  -- inside its grace window. Both gated by revoked_at IS NULL.
  SELECT ak.id, ak.user_id, ak.company_id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode,
         ak.unattended_commit_limit
  INTO   v_id, v_user_id, v_company_id, v_api_key_name,
         v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode,
         v_unattended_commit_limit
  FROM public.api_keys ak
  WHERE ak.revoked_at IS NULL
    AND (
      ak.key_hash = p_key_hash
      OR (
        ak.previous_key_hash = p_key_hash
        AND ak.previous_key_expires_at IS NOT NULL
        AND ak.previous_key_expires_at > now()
      )
    )
  FOR UPDATE;

  IF v_id IS NULL THEN
    RETURN;  -- no live match (incl. expired grace): caller returns 401, as before
  END IF;

  -- Per-key company allowlist: NULL when the key has no rows (every
  -- membership is reachable), else the listed ids in creation order. The
  -- read-only subset rides the same scan: NULL when no row is read-only.
  SELECT array_agg(akc.company_id ORDER BY akc.created_at, akc.company_id),
         array_agg(akc.company_id ORDER BY akc.created_at, akc.company_id)
           FILTER (WHERE akc.access = 'read')
  INTO v_allowed_company_ids, v_read_only_company_ids
  FROM public.api_key_companies akc
  WHERE akc.api_key_id = v_id;

  -- A restricted key's default must be reachable: when the stored default is
  -- outside the allowlist (or absent), the first allowed company the user is
  -- still a live member of takes its place. Nothing left means the key
  -- reaches nothing: treated as an unknown key, like the membership block.
  IF v_allowed_company_ids IS NOT NULL
     AND (v_company_id IS NULL OR v_company_id <> ALL (v_allowed_company_ids)) THEN
    SELECT akc.company_id
    INTO v_company_id
    FROM public.api_key_companies akc
    JOIN public.company_members cm
      ON cm.company_id = akc.company_id AND cm.user_id = v_user_id
    JOIN public.companies c
      ON c.id = akc.company_id AND c.archived_at IS NULL
    WHERE akc.api_key_id = v_id
    ORDER BY akc.created_at, akc.company_id
    LIMIT 1;

    IF v_company_id IS NULL THEN
      RETURN;  -- allowlist names no company the user still belongs to: 401 upstream
    END IF;
  END IF;

  -- A key outlives neither the membership it was minted under nor the company
  -- itself. Company-less keys (OAuth lazy bind) have nothing to check yet.
  IF v_company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = v_user_id
      AND cm.company_id = v_company_id
  ) THEN
    RETURN;  -- treated as an unknown key: 401 upstream
  END IF;

  -- Reset the rate-limit window if it is unset or older than one minute.
  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
       SET request_count = 1,
           rate_limit_window_start = now(),
           last_used_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;

-- 3. create_api_key_with_allowlist: read-only companies in the same transaction
--
-- Same function as 20260928112722 with one new trailing parameter,
-- p_read_only_company_ids (DEFAULT NULL, so a call that names only the old
-- thirteen parameters behaves exactly as before: every allowed company at
-- write). The levels are written with the allowlist rows in the one
-- transaction the function already is: a key whose rows landed at the
-- default 'write' before a second request narrowed them would, for that
-- window, reach further than the user chose.
--
-- Rules for the new parameter (NULL elements dropped, duplicates collapsed):
--   - empty or NULL: no read-only company;
--   - otherwise the key must be restricted (a non-empty p_company_ids) and
--     every read-only id must be one of its allowed companies. An
--     unrestricted key has no rows to carry a level, and a read-only id
--     outside the allowlist would silently mean nothing; both are refused
--     rather than dropped, so a caller bug surfaces instead of minting a key
--     that writes where the user chose read.
--
-- The old thirteen-parameter function is dropped first: PostgREST resolves
-- functions by argument names, and two candidates that both accept the old
-- names would make every existing call ambiguous.
DROP FUNCTION IF EXISTS public.create_api_key_with_allowlist(
  uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[]
);

CREATE FUNCTION public.create_api_key_with_allowlist(
  p_user_id uuid,
  p_company_id uuid,
  p_key_hash text,
  p_key_prefix text,
  p_name text,
  p_scopes text[],
  p_mode text,
  p_client text,
  p_refresh_token_hash text,
  p_sod_acknowledged_at timestamptz,
  p_sod_acknowledged_by uuid,
  p_unattended_commit_limit numeric,
  p_company_ids uuid[],
  p_read_only_company_ids uuid[] DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_ids uuid[];
  v_read_only_ids uuid[];
  v_not_member uuid[];
  v_outside uuid[];
  v_key_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'create_api_key_with_allowlist: p_user_id is required'
      USING ERRCODE = '22004';
  END IF;

  -- Normalise the allowlist: drop NULL elements, collapse duplicates, keep
  -- first-occurrence order. Nothing left means unrestricted.
  SELECT array_agg(d.cid ORDER BY d.first_ord)
  INTO v_company_ids
  FROM (
    SELECT u.cid, min(u.ord) AS first_ord
    FROM unnest(p_company_ids) WITH ORDINALITY AS u(cid, ord)
    WHERE u.cid IS NOT NULL
    GROUP BY u.cid
  ) AS d;

  -- Normalise the read-only set the same way. Nothing left means none.
  SELECT array_agg(DISTINCT r.cid)
  INTO v_read_only_ids
  FROM unnest(p_read_only_company_ids) AS r(cid)
  WHERE r.cid IS NOT NULL;

  IF v_read_only_ids IS NOT NULL THEN
    IF v_company_ids IS NULL THEN
      RAISE EXCEPTION 'create_api_key_with_allowlist: read-only companies require a company allowlist'
        USING ERRCODE = '23514';
    END IF;

    SELECT array_agg(r.cid ORDER BY r.cid)
    INTO v_outside
    FROM unnest(v_read_only_ids) AS r(cid)
    WHERE r.cid <> ALL (v_company_ids);
    IF v_outside IS NOT NULL THEN
      RAISE EXCEPTION 'create_api_key_with_allowlist: read-only companies % are not in the allowlist',
        v_outside
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_company_ids IS NOT NULL THEN
    -- Every allowed company is a live membership of the key's user.
    SELECT array_agg(a.cid ORDER BY a.cid)
    INTO v_not_member
    FROM unnest(v_company_ids) AS a(cid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.company_members cm
      JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
      WHERE cm.user_id = p_user_id
        AND cm.company_id = a.cid
    );
    IF v_not_member IS NOT NULL THEN
      RAISE EXCEPTION 'create_api_key_with_allowlist: user % is not a live member of company %',
        p_user_id, v_not_member
        USING ERRCODE = '42501';
    END IF;

    -- The default company must be inside the allowlist.
    IF p_company_id IS NULL OR p_company_id <> ALL (v_company_ids) THEN
      RAISE EXCEPTION 'create_api_key_with_allowlist: default company % is not in the allowlist',
        p_company_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.api_keys (
    user_id,
    company_id,
    key_hash,
    key_prefix,
    name,
    scopes,
    mode,
    client,
    refresh_token_hash,
    sod_acknowledged_at,
    sod_acknowledged_by,
    unattended_commit_limit
  ) VALUES (
    p_user_id,
    p_company_id,
    p_key_hash,
    p_key_prefix,
    COALESCE(p_name, 'Unnamed key'),
    p_scopes,
    COALESCE(p_mode, 'live'),
    p_client,
    p_refresh_token_hash,
    p_sod_acknowledged_at,
    p_sod_acknowledged_by,
    p_unattended_commit_limit
  )
  RETURNING id INTO v_key_id;

  IF v_company_ids IS NOT NULL THEN
    INSERT INTO public.api_key_companies (api_key_id, company_id, access)
    SELECT v_key_id,
           a.cid,
           CASE WHEN a.cid = ANY (COALESCE(v_read_only_ids, '{}'::uuid[])) THEN 'read' ELSE 'write' END
    FROM unnest(v_company_ids) WITH ORDINALITY AS a(cid, ord)
    ORDER BY a.ord;
  END IF;

  RETURN v_key_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_api_key_with_allowlist(
  uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[], uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_api_key_with_allowlist(
  uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[], uuid[]
) TO service_role;

-- 4. replace_api_key_allowlist: levels replaced with the set -----------------
--
-- Same function as 20260928112722 with one new trailing parameter,
-- p_read_only_company_ids (DEFAULT NULL). Its two states differ on purpose:
--
--   NULL   keep: companies that stay in the allowlist keep the level they
--          have, newly added companies get 'write'. This is what a caller
--          that knows nothing about levels (the two-parameter call) always
--          meant, and it can never turn an existing 'read' into 'write'.
--   array  set: the listed companies become 'read', every other allowed
--          company 'write'. An empty array is an explicit "no read-only
--          company", the only way to lift a read-only level.
--
-- Making a key unrestricted (p_company_ids NULL or empty) removes every row
-- and with it every level, which widens each read-only company to the key's
-- full scopes. That is refused unless the caller says so explicitly with an
-- empty p_read_only_company_ids: a caller that sends "all companies" without
-- knowing a level existed must not lift it by accident. Read-only ids with
-- an unrestricted key, or outside the new allowlist, are refused as in
-- create_api_key_with_allowlist.
--
-- The key row lock, the revoked-key refusal and the membership backstop are
-- unchanged. The old two-parameter function is dropped first for the same
-- PostgREST reason as above.
DROP FUNCTION IF EXISTS public.replace_api_key_allowlist(uuid, uuid[]);

CREATE FUNCTION public.replace_api_key_allowlist(
  p_api_key_id uuid,
  p_company_ids uuid[],
  p_read_only_company_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_company_ids uuid[];
  v_read_only_ids uuid[];
  v_not_member uuid[];
  v_outside uuid[];
  v_count integer;
BEGIN
  SELECT ak.user_id
  INTO v_user_id
  FROM public.api_keys ak
  WHERE ak.id = p_api_key_id
    AND ak.revoked_at IS NULL
  FOR UPDATE;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'replace_api_key_allowlist: api key % does not exist or is revoked',
      p_api_key_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT array_agg(d.cid ORDER BY d.first_ord)
  INTO v_company_ids
  FROM (
    SELECT u.cid, min(u.ord) AS first_ord
    FROM unnest(p_company_ids) WITH ORDINALITY AS u(cid, ord)
    WHERE u.cid IS NOT NULL
    GROUP BY u.cid
  ) AS d;

  -- NULL here also for an explicit empty array; p_read_only_company_ids
  -- itself still tells "keep" (NULL) from "none" (empty array) below.
  SELECT array_agg(DISTINCT r.cid)
  INTO v_read_only_ids
  FROM unnest(p_read_only_company_ids) AS r(cid)
  WHERE r.cid IS NOT NULL;

  IF v_company_ids IS NULL THEN
    IF v_read_only_ids IS NOT NULL THEN
      RAISE EXCEPTION 'replace_api_key_allowlist: read-only companies require a company allowlist'
        USING ERRCODE = '23514';
    END IF;
    IF p_read_only_company_ids IS NULL AND EXISTS (
      SELECT 1
      FROM public.api_key_companies akc
      WHERE akc.api_key_id = p_api_key_id
        AND akc.access = 'read'
    ) THEN
      RAISE EXCEPTION 'replace_api_key_allowlist: api key % has read-only companies; making it unrestricted grants write access there. Pass an empty p_read_only_company_ids to confirm',
        p_api_key_id
        USING ERRCODE = '23514';
    END IF;
    DELETE FROM public.api_key_companies WHERE api_key_id = p_api_key_id;
    RETURN 0;
  END IF;

  SELECT array_agg(a.cid ORDER BY a.cid)
  INTO v_not_member
  FROM unnest(v_company_ids) AS a(cid)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = v_user_id
      AND cm.company_id = a.cid
  );
  IF v_not_member IS NOT NULL THEN
    RAISE EXCEPTION 'replace_api_key_allowlist: user % is not a live member of company %',
      v_user_id, v_not_member
      USING ERRCODE = '42501';
  END IF;

  IF v_read_only_ids IS NOT NULL THEN
    SELECT array_agg(r.cid ORDER BY r.cid)
    INTO v_outside
    FROM unnest(v_read_only_ids) AS r(cid)
    WHERE r.cid <> ALL (v_company_ids);
    IF v_outside IS NOT NULL THEN
      RAISE EXCEPTION 'replace_api_key_allowlist: read-only companies % are not in the allowlist',
        v_outside
        USING ERRCODE = '23514';
    END IF;
  END IF;

  DELETE FROM public.api_key_companies
  WHERE api_key_id = p_api_key_id
    AND company_id <> ALL (v_company_ids);

  IF p_read_only_company_ids IS NULL THEN
    -- Keep: existing rows keep their level, new rows take the column default.
    INSERT INTO public.api_key_companies (api_key_id, company_id)
    SELECT p_api_key_id, a.cid
    FROM unnest(v_company_ids) WITH ORDINALITY AS a(cid, ord)
    ORDER BY a.ord
    ON CONFLICT (api_key_id, company_id) DO NOTHING;
  ELSE
    -- Set: every allowed company gets exactly the level the caller sent.
    INSERT INTO public.api_key_companies (api_key_id, company_id, access)
    SELECT p_api_key_id,
           a.cid,
           CASE WHEN a.cid = ANY (COALESCE(v_read_only_ids, '{}'::uuid[])) THEN 'read' ELSE 'write' END
    FROM unnest(v_company_ids) WITH ORDINALITY AS a(cid, ord)
    ORDER BY a.ord
    ON CONFLICT (api_key_id, company_id) DO UPDATE SET access = EXCLUDED.access;
  END IF;

  SELECT count(*)::integer
  INTO v_count
  FROM public.api_key_companies
  WHERE api_key_id = p_api_key_id;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_api_key_allowlist(uuid, uuid[], uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_api_key_allowlist(uuid, uuid[], uuid[])
  TO service_role;

NOTIFY pgrst, 'reload schema';
