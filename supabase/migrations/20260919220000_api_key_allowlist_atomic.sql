-- Atomic API-key creation and allowlist replacement.
-- pg-test: tests/pg/api-key-allowlist-atomic.pg.test.ts
--
-- Finding (security scan on the per-key company allowlist, PR #2753): the
-- allowlist writes were not atomic with key creation or with allowlist
-- replacement. The OAuth token endpoint and the settings key-creation route
-- inserted the api_keys row, then the api_key_companies rows, and revoked the
-- key when the second insert failed. The settings PATCH route replaced an
-- allowlist by upserting the new rows and then deleting the rest. Each of
-- those is two PostgREST requests, so a failure (or a crash) between them
-- leaves the wrong state behind:
--   create:  a key with no allowlist rows, which by the table's semantics
--            reaches EVERY company its user belongs to, wider than consented;
--            the compensating revoke is itself a request that can fail;
--   replace: the union of the old and the new set, wider than either.
--
-- Why an RPC: PostgREST runs one statement per request, so two table writes
-- cannot share a transaction from the application, and a compensating write
-- is not a transaction. A plpgsql function body is one transaction: either
-- the key row and its allowlist rows both exist, or neither does; either the
-- new set replaced the old one, or the old one is untouched.
--
-- Both functions are SECURITY DEFINER and service_role only, like
-- validate_and_increment_api_key (20260919210000) and rotate_mcp_refresh_token
-- (20260902090000 section 3): api_key_companies has no policies and the
-- routes that call these already run the service client. The membership rule
-- the routes pre-check (every allowed company is a live membership of the
-- key's user) is repeated inside as the backstop; a key that reaches a
-- company its user cannot is refused here whatever the caller sent. The
-- admin gate the api_keys_insert policy enforced for JWT sessions is NOT
-- repeated here: the OAuth token endpoint mints role-capped keys for every
-- role (a viewer gets a read-only key), so create_api_key_with_allowlist
-- takes any user; the settings route keeps its owner/admin check in code.

-- 1. create_api_key_with_allowlist ------------------------------------------
--
-- Inserts the api_keys row and, for a restricted key, one api_key_companies
-- row per allowed company, in one transaction. Returns the new key id.
--
-- p_company_ids NULL or empty: unrestricted (no allowlist rows). Otherwise
-- every id must be a non-archived company the user is a live member of, and
-- p_company_id (the key's default company) must be one of them: a default
-- outside the allowlist would be a key that reaches more than consented.
-- Duplicates collapse; first-occurrence order is kept for the inserts.
--
-- p_name and p_mode NULL take the column defaults ('Unnamed key', 'live');
-- rate_limit_rpm and request_count are never passed and keep theirs. The
-- sod_acknowledged_at / sod_acknowledged_by pair is passed through as given
-- and checked by api_keys_sod_ack_paired.
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
  p_company_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_ids uuid[];
  v_not_member uuid[];
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
    INSERT INTO public.api_key_companies (api_key_id, company_id)
    SELECT v_key_id, a.cid
    FROM unnest(v_company_ids) WITH ORDINALITY AS a(cid, ord)
    ORDER BY a.ord;
  END IF;

  RETURN v_key_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_api_key_with_allowlist(
  uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_api_key_with_allowlist(
  uuid, uuid, text, text, text, text[], text, text, text, timestamptz, uuid, numeric, uuid[]
) TO service_role;

-- 2. replace_api_key_allowlist -----------------------------------------------
--
-- Replaces a key's allowlist as a set, in one transaction: rows outside the
-- new list are deleted and missing ones inserted, so the key is never at the
-- union of old and new. p_company_ids NULL or empty deletes every row (the
-- key becomes unrestricted). Returns the number of allowlist rows the key has
-- after the call.
--
-- The key row is locked FOR UPDATE for the duration so two concurrent
-- replacements serialise. A key that does not exist or is revoked raises:
-- editing a revoked key's reach reads as re-enabling it, and it does not.
-- Membership is validated against the key's own user (api_keys.user_id),
-- never against the caller: the caller is the service role.
CREATE FUNCTION public.replace_api_key_allowlist(
  p_api_key_id uuid,
  p_company_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_company_ids uuid[];
  v_not_member uuid[];
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

  IF v_company_ids IS NULL THEN
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

  DELETE FROM public.api_key_companies
  WHERE api_key_id = p_api_key_id
    AND company_id <> ALL (v_company_ids);

  INSERT INTO public.api_key_companies (api_key_id, company_id)
  SELECT p_api_key_id, a.cid
  FROM unnest(v_company_ids) WITH ORDINALITY AS a(cid, ord)
  ORDER BY a.ord
  ON CONFLICT (api_key_id, company_id) DO NOTHING;

  SELECT count(*)::integer
  INTO v_count
  FROM public.api_key_companies
  WHERE api_key_id = p_api_key_id;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replace_api_key_allowlist(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_api_key_allowlist(uuid, uuid[])
  TO service_role;

NOTIFY pgrst, 'reload schema';
