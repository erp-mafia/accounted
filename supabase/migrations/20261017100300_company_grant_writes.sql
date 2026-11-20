-- The writes of a company grant: create, revoke, pause all, mark reviewed.
-- Every change is a dated line in behandlingshistorik (BFNAR 2013:2 p. 9.16):
-- each function writes its own audit_log row in the same transaction.
--
-- 1. create_company_grant: what the approved create_grant operation runs
--    (src/lib/pending-operations/commit.ts, through the service role). Re-
--    checks that the deciding user is an owner or admin, that the decision
--    was made by that person approving in the app (p_actor_type 'user'
--    exactly: never a key, an OAuth connector, the in-app assistant or a
--    service account, so no agent accepts its own authority), that the
--    counterparty has an identity, that the business account is active in the company's chart,
--    and that a named credential belongs to the company. A rule that already
--    has an active version is superseded in the same transaction (the old
--    version revoked as 'superseded', the new one version + 1). service_role
--    only.
--
-- 2. revoke_company_grant: what the approved revoke_grant operation runs.
--    Same owner-or-admin check; a revoked grant stays revoked (a second
--    revoke changes nothing). Answers the postings the grant let through, so
--    the person who revokes sees what to look at. service_role only.
--
-- 3. set_company_grants_paused: the company's kill switch, flipped by an
--    owner or admin on their own session (POST /api/grants/pause), effective
--    at once for every grant. authenticated only, guarded by
--    user_is_company_admin.
--
-- 4. mark_company_grant_uses_reviewed: a member who may write marks the
--    postings shown under "Bokfört enligt regel" as reviewed. authenticated
--    only, guarded by membership with a writing role.
--
-- pg-test: tests/pg/company-grants.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. create_company_grant
-- =============================================================================

CREATE FUNCTION public.create_company_grant(
  p_company_id uuid,
  p_decided_by uuid,
  p_actor_type text,
  p_actor_label text,
  p_pending_operation_id uuid,
  p_operation_type text,
  p_counterparty_key text,
  p_counterparty_label text,
  p_direction text,
  p_category text,
  p_vat_treatment text,
  p_reverse_charge_kind text,
  p_account_number text,
  p_line_accounts text[],
  p_amount_limit_sek numeric,
  p_monthly_limit_sek numeric DEFAULT NULL,
  p_credential_scope text DEFAULT 'any',
  p_credential_id uuid DEFAULT NULL,
  p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.company_grants;
  v_new public.company_grants;
  v_version integer;
  v_actor_type text;
  v_lines text[];
BEGIN
  IF p_decided_by IS NULL OR NOT public.service_account_actor_is_admin(p_company_id, p_decided_by) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_ADMIN_REQUIRED');
  END IF;
  -- Accepting a grant is a person's decision in the app: an agent never
  -- accepts its own authority, whichever credential relays it (api_key,
  -- mcp_oauth, agent_chat, service_account) and a missing actor alike.
  IF p_actor_type IS DISTINCT FROM 'user' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_NEEDS_PERSON');
  END IF;
  IF p_operation_type IS DISTINCT FROM 'categorize_transaction' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'operation_type');
  END IF;
  -- The key must be one grant_counterparty_key can produce: a bank text that
  -- names someone, not only a payment rail.
  IF p_counterparty_key IS NULL OR public.grant_counterparty_key(p_counterparty_key, NULL, NULL) IS DISTINCT FROM p_counterparty_key THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_UNKNOWN_COUNTERPARTY');
  END IF;
  IF p_account_number IS NULL OR p_account_number !~ '^[0-9]{4}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'account_number');
  END IF;
  SELECT array_agg(DISTINCT a ORDER BY a) INTO v_lines FROM unnest(coalesce(p_line_accounts, ARRAY[]::text[])) AS a;
  IF v_lines IS NULL OR EXISTS (SELECT 1 FROM unnest(v_lines) AS a WHERE a !~ '^[0-9]{4}$')
     OR NOT (p_account_number = ANY (v_lines)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'line_accounts');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chart_of_accounts
                  WHERE company_id = p_company_id AND account_number = p_account_number AND is_active) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_ACCOUNT_INACTIVE', 'account_number', p_account_number);
  END IF;
  IF p_credential_scope = 'api_key' THEN
    IF p_credential_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.api_keys k
       WHERE k.id = p_credential_id AND k.revoked_at IS NULL
         AND (k.company_id = p_company_id
              OR (k.service_account_id IS NULL AND EXISTS (
                    SELECT 1 FROM public.company_members cm
                     WHERE cm.company_id = p_company_id AND cm.user_id = k.user_id)))) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_CREDENTIAL_UNKNOWN');
    END IF;
  ELSIF p_credential_scope = 'service_account' THEN
    IF p_credential_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.service_accounts s
       WHERE s.id = p_credential_id AND s.company_id = p_company_id AND s.revoked_at IS NULL) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_CREDENTIAL_UNKNOWN');
    END IF;
  ELSIF p_credential_scope IS DISTINCT FROM 'any' OR p_credential_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'credential');
  END IF;

  v_actor_type := CASE
    WHEN p_actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account') THEN p_actor_type
    ELSE 'user'
  END;

  -- One decision per rule at a time: the supersede read and the insert see the same state.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'company-grant:' || p_company_id::text || ':' || p_operation_type || ':' || p_counterparty_key, 0));

  SELECT * INTO v_old
    FROM public.company_grants
   WHERE company_id = p_company_id AND operation_type = p_operation_type
     AND counterparty_key = p_counterparty_key AND revoked_at IS NULL
   FOR UPDATE;

  SELECT coalesce(max(version), 0) + 1 INTO v_version
    FROM public.company_grants
   WHERE company_id = p_company_id AND operation_type = p_operation_type AND counterparty_key = p_counterparty_key;

  IF v_old.id IS NOT NULL THEN
    UPDATE public.company_grants
       SET revoked_at = now(), revoked_by = p_decided_by, revoked_reason = 'superseded',
           revoked_pending_operation_id = p_pending_operation_id
     WHERE id = v_old.id;
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                  description, actor_type, actor_label)
    SELECT p_decided_by, p_company_id, 'UPDATE', 'company_grants', g.id, p_decided_by, to_jsonb(v_old), to_jsonb(g),
           'Grant superseded by version ' || v_version || ': ' || g.counterparty_label,
           v_actor_type, nullif(left(p_actor_label, 200), '')
      FROM public.company_grants g WHERE g.id = v_old.id;
  END IF;

  INSERT INTO public.company_grants (
    company_id, operation_type, counterparty_key, counterparty_label, version, direction, category, vat_treatment,
    reverse_charge_kind, account_number, line_accounts, amount_limit_sek, monthly_limit_sek, credential_scope,
    credential_id, accepted_by, accepted_actor_type, accepted_actor_label, pending_operation_id, evidence
  )
  VALUES (
    p_company_id, p_operation_type, p_counterparty_key, left(coalesce(nullif(btrim(p_counterparty_label), ''), p_counterparty_key), 200),
    v_version, p_direction, p_category, p_vat_treatment, p_reverse_charge_kind, p_account_number, v_lines,
    round(p_amount_limit_sek, 2), round(p_monthly_limit_sek, 2), coalesce(p_credential_scope, 'any'), p_credential_id,
    p_decided_by, v_actor_type, nullif(left(p_actor_label, 200), ''), p_pending_operation_id, coalesce(p_evidence, '{}'::jsonb)
  )
  RETURNING * INTO v_new;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                description, actor_type, actor_label)
  VALUES (
    p_decided_by, p_company_id, 'INSERT', 'company_grants', v_new.id, p_decided_by, NULL, to_jsonb(v_new),
    'Grant created: ' || v_new.counterparty_label || ', up to ' || v_new.amount_limit_sek || ' SEK',
    v_actor_type, nullif(left(p_actor_label, 200), '')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'grant_id', v_new.id,
    'version', v_new.version,
    'superseded_grant_id', v_old.id,
    'valid_from', v_new.valid_from,
    'accepted_at', v_new.accepted_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_company_grant(uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text, text[], numeric, numeric, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_company_grant(uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text, text[], numeric, numeric, text, uuid, jsonb)
  TO service_role;

-- =============================================================================
-- 2. revoke_company_grant
-- =============================================================================

CREATE FUNCTION public.revoke_company_grant(
  p_company_id uuid,
  p_grant_id uuid,
  p_decided_by uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL,
  p_pending_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.company_grants;
  v_new public.company_grants;
  v_actor_type text;
  v_postings jsonb;
  v_count integer;
BEGIN
  IF p_decided_by IS NULL OR NOT public.service_account_actor_is_admin(p_company_id, p_decided_by) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_ADMIN_REQUIRED');
  END IF;

  SELECT * INTO v_old FROM public.company_grants WHERE id = p_grant_id AND company_id = p_company_id FOR UPDATE;
  IF v_old.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_NOT_FOUND');
  END IF;

  v_actor_type := CASE
    WHEN p_actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account') THEN p_actor_type
    ELSE 'user'
  END;

  IF v_old.revoked_at IS NULL THEN
    UPDATE public.company_grants
       SET revoked_at = now(), revoked_by = p_decided_by, revoked_reason = 'revoked',
           revoked_pending_operation_id = p_pending_operation_id
     WHERE id = v_old.id
    RETURNING * INTO v_new;

    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                  description, actor_type, actor_label)
    VALUES (
      p_decided_by, p_company_id, 'UPDATE', 'company_grants', v_new.id, p_decided_by, to_jsonb(v_old), to_jsonb(v_new),
      'Grant revoked: ' || v_new.counterparty_label, v_actor_type, nullif(left(p_actor_label, 200), '')
    );
  ELSE
    v_new := v_old;
  END IF;

  -- What the grant let through: every committed use, newest first (at most 500 listed).
  SELECT count(*) INTO v_count FROM public.company_grant_uses u WHERE u.grant_id = v_old.id AND u.status = 'committed';
  SELECT coalesce(jsonb_agg(p ORDER BY p->>'committed_at' DESC), '[]'::jsonb) INTO v_postings
    FROM (
      SELECT jsonb_build_object(
               'use_id', u.id,
               'journal_entry_id', u.journal_entry_id,
               'transaction_id', u.transaction_id,
               'voucher', CASE WHEN je.voucher_number IS NULL THEN NULL ELSE coalesce(je.voucher_series, '') || je.voucher_number END,
               'entry_status', je.status,
               'entry_date', u.entry_date,
               'amount_sek', u.amount_sek,
               'committed_at', u.committed_at,
               'reviewed_at', u.reviewed_at
             ) AS p
        FROM public.company_grant_uses u
        LEFT JOIN public.journal_entries je ON je.id = u.journal_entry_id
       WHERE u.grant_id = v_old.id AND u.status = 'committed'
       ORDER BY u.committed_at DESC
       LIMIT 500
    ) s;

  RETURN jsonb_build_object(
    'ok', true,
    'unchanged', v_old.revoked_at IS NOT NULL,
    'grant_id', v_new.id,
    'version', v_new.version,
    'counterparty_label', v_new.counterparty_label,
    'revoked_at', v_new.revoked_at,
    'revoked_reason', v_new.revoked_reason,
    'postings_count', v_count,
    'postings', v_postings
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_company_grant(uuid, uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_company_grant(uuid, uuid, uuid, text, text, uuid) TO service_role;

-- =============================================================================
-- 3. set_company_grants_paused: the kill switch
-- =============================================================================

CREATE FUNCTION public.set_company_grants_paused(p_company_id uuid, p_paused boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_old public.company_grant_settings;
  v_new public.company_grant_settings;
BEGIN
  IF p_paused IS NULL THEN
    RAISE EXCEPTION 'set_company_grants_paused: p_paused is required' USING ERRCODE = '22023';
  END IF;
  IF v_user IS NULL OR NOT public.user_is_company_admin(p_company_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_ADMIN_REQUIRED');
  END IF;

  SELECT * INTO v_old FROM public.company_grant_settings WHERE company_id = p_company_id FOR UPDATE;
  IF coalesce(v_old.paused, false) = p_paused THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'paused', p_paused);
  END IF;

  INSERT INTO public.company_grant_settings (company_id, paused, decided_by, decided_at)
  VALUES (p_company_id, p_paused, v_user, now())
  ON CONFLICT (company_id) DO UPDATE
     SET paused = EXCLUDED.paused, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at
  RETURNING * INTO v_new;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                description, actor_type)
  VALUES (
    v_user, p_company_id, CASE WHEN v_old.company_id IS NULL THEN 'INSERT' ELSE 'UPDATE' END,
    'company_grant_settings', p_company_id, v_user,
    CASE WHEN v_old.company_id IS NULL THEN NULL ELSE to_jsonb(v_old) END, to_jsonb(v_new),
    CASE WHEN p_paused THEN 'All grants paused' ELSE 'Grants resumed' END,
    'user'
  );

  RETURN jsonb_build_object('ok', true, 'unchanged', false, 'paused', p_paused, 'decided_at', v_new.decided_at);
END;
$$;

REVOKE ALL ON FUNCTION public.set_company_grants_paused(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_company_grants_paused(uuid, boolean) TO authenticated;

-- =============================================================================
-- 4. mark_company_grant_uses_reviewed
-- =============================================================================

CREATE FUNCTION public.mark_company_grant_uses_reviewed(p_company_id uuid, p_use_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members cm
     WHERE cm.company_id = p_company_id AND cm.user_id = v_user AND cm.role IN ('owner', 'admin', 'member')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_REVIEW_FORBIDDEN');
  END IF;
  IF p_use_ids IS NULL OR cardinality(p_use_ids) = 0 OR cardinality(p_use_ids) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'use_ids');
  END IF;

  UPDATE public.company_grant_uses
     SET reviewed_at = now(), reviewed_by = v_user
   WHERE company_id = p_company_id AND id = ANY (p_use_ids) AND status <> 'released' AND reviewed_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'reviewed', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_company_grant_uses_reviewed(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_company_grant_uses_reviewed(uuid, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
