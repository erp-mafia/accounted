-- Service accounts: a non-human principal a company owns, with a human
-- sponsor (building-blocks plan, Phase 1).
-- pg-test: tests/pg/service-accounts.pg.test.ts
--
-- WHY
-- ---
-- Agents and integrations act through API keys (gnubok_sk_, public.api_keys)
-- that belong to a person, so the audit trail says the person did it. A
-- company that runs an integration needs a principal of its own: the
-- behandlingshistorik (BFNAR 2013:2 p. 9.16) must be able to say "service
-- account X, sponsored by person Y, did this", and the integration must stop
-- the day its sponsor no longer answers for it.
--
-- WHAT
-- ----
-- 1. public.service_accounts: one company, a name, a REQUIRED sponsor who is
--    an owner or admin member of that company when the account is created,
--    created_by / created_at, and a soft revoke (revoked_at / revoked_by).
--    Rows are never deleted by the application (no DELETE grant, no delete
--    door); only the company cascade removes them. A row changes once: its
--    revocation, which is final.
-- 2. api_keys.service_account_id (nullable). A key of a service account keeps
--    user_id = the sponsor, so RLS and every path that reads api_keys.user_id
--    keep working, and company_id = the account's company. Both are fixed
--    when the key is minted; a key never moves between a person and a
--    service account.
-- 3. service_account_is_active(id): the one definition of "this account may
--    act": not revoked, its company not archived, and its sponsor still an
--    owner or admin member there. A service account can never have more
--    access than its sponsor: when the sponsor is demoted or removed the
--    account counts as suspended and its keys are refused.
-- 4. validate_and_increment_api_key (the one place every door verifies a
--    key): a service-account key is refused unless its account is active,
--    and it reaches exactly its account's company whatever api_key_companies
--    says. It returns two more columns, service_account_id and
--    service_account_name, which the application turns into the actor
--    'service_account' (migration 20261016120100 widens the actor CHECKs).
-- 5. service_account_key_refusal(hash): why a key the validation refused was
--    refused, when the reason is a suspended service account, so the doors
--    can answer a clear structured error instead of a bare 401.
-- 6. Revoking a service account revokes its keys (trigger), and the account's
--    lifecycle is written to audit_log with the acting credential.
-- 7. Write RPCs for the v1 doors (service_role only), each re-checking that
--    the acting user is an owner or admin and stamping the acting credential
--    into the gnubok.actor_* GUCs the audit triggers read:
--      create_service_account, revoke_service_account,
--      create_service_account_key, revoke_service_account_key.
--
-- ROLLING DEPLOY (validate_and_increment_api_key changes its RETURNS TABLE,
-- so it is dropped and re-created under the same name, as 20260928112724 did):
--   * new database, old code: the old code reads the columns it knows by
--     name and ignores the two new ones. No service account can exist before
--     the new code creates one, and a suspended account's key is refused by
--     the function itself (no row), so old code can never let one through.
--   * new code, old database: the row has no service_account_id; every key
--     is a person's key, as today. The refusal RPC is missing (PGRST202) and
--     the application answers the generic 401.
-- supabase db push runs the file as one transaction, so no caller sees the
-- function missing between the DROP and the CREATE. Grants are restated.

-- =============================================================================
-- 1. public.service_accounts
-- =============================================================================

-- Hot tables (journal_entries, api_keys, audit_log, ...): never queue every
-- write behind a long transaction. Fail the migration job instead and retry.
SELECT set_config('lock_timeout', '5s', true);

CREATE TABLE public.service_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name             text NOT NULL
    CONSTRAINT service_accounts_name_check
    CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 100),
  sponsor_user_id  uuid NOT NULL REFERENCES auth.users(id),
  created_by       uuid NOT NULL REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES auth.users(id),
  CONSTRAINT service_accounts_revoked_by_check CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

COMMENT ON TABLE public.service_accounts IS
  'A non-human principal a company owns (an integration or agent), with a human sponsor who answers for it. Its API keys (api_keys.service_account_id) act as the sponsor for RLS but are recorded as actor service_account. Revoked, never deleted.';
COMMENT ON COLUMN public.service_accounts.sponsor_user_id IS
  'The person who answers for the account: an owner or admin member of the company when the account was created. The account is suspended (its keys refused) while the sponsor is not an owner or admin member. Fixed for the life of the account.';
COMMENT ON COLUMN public.service_accounts.name IS
  'Shown as the actor label wherever the account acts (journal_entries.committed_actor_label, audit_log.actor_label). Unique among the company''s live accounts.';
COMMENT ON COLUMN public.service_accounts.revoked_at IS
  'Soft revoke: final, and it revokes every key of the account in the same transaction.';

CREATE INDEX idx_service_accounts_company_id ON public.service_accounts (company_id);
CREATE INDEX idx_service_accounts_sponsor_user_id ON public.service_accounts (sponsor_user_id);
-- Two live accounts of one company never share a name: the name is what the
-- behandlingshistorik shows as the actor.
CREATE UNIQUE INDEX service_accounts_live_name_key
  ON public.service_accounts (company_id, lower(name))
  WHERE revoked_at IS NULL;

ALTER TABLE public.service_accounts ENABLE ROW LEVEL SECURITY;

-- Company admins read their company's accounts; a sponsor reads the accounts
-- they answer for. Writes go only through the SECURITY DEFINER RPCs below
-- (service_role): no INSERT, UPDATE or DELETE policy.
CREATE POLICY service_accounts_select ON public.service_accounts
  FOR SELECT USING (
    company_id IN (SELECT public.user_company_ids())
    AND (public.user_is_company_admin(company_id) OR sponsor_user_id = auth.uid())
  );

GRANT SELECT ON TABLE public.service_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.service_accounts TO service_role;
-- no-grant: anon on public.service_accounts (company access principals; no public surface reads them)

-- =============================================================================
-- 2. api_keys.service_account_id
-- =============================================================================

-- CASCADE: a key without its account must never survive as a plain key of
-- the sponsor (it would then reach every company the sponsor belongs to).
ALTER TABLE public.api_keys
  ADD COLUMN service_account_id uuid REFERENCES public.service_accounts(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.api_keys.service_account_id IS
  'The service account this key belongs to, or NULL for a person''s key. Set when the key is minted (create_service_account_key) and never changed. user_id is then the account''s sponsor and company_id the account''s company.';

CREATE INDEX idx_api_keys_service_account_id
  ON public.api_keys (service_account_id)
  WHERE service_account_id IS NOT NULL;

-- =============================================================================
-- 3. service_account_is_active
-- =============================================================================

CREATE FUNCTION public.service_account_is_active(p_service_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.service_accounts sa
    JOIN public.companies c
      ON c.id = sa.company_id AND c.archived_at IS NULL
    JOIN public.company_members cm
      ON cm.company_id = sa.company_id AND cm.user_id = sa.sponsor_user_id
    WHERE sa.id = p_service_account_id
      AND sa.revoked_at IS NULL
      AND cm.role IN ('owner', 'admin')
  );
$$;

COMMENT ON FUNCTION public.service_account_is_active(uuid) IS
  'True when the service account may act: not revoked, its company not archived, and its sponsor an owner or admin member of that company. The one definition every key validation and mint reads.';

REVOKE ALL ON FUNCTION public.service_account_is_active(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_account_is_active(uuid) TO service_role;

-- =============================================================================
-- 4. Guards
-- =============================================================================

-- service_accounts: a new account is live and sponsored by an owner or admin
-- of its company; afterwards the only change is its revocation, once.
CREATE FUNCTION public.service_accounts_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
      RAISE EXCEPTION 'service_accounts: a new service account cannot be revoked'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.company_members cm
      JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
      WHERE cm.company_id = NEW.company_id
        AND cm.user_id = NEW.sponsor_user_id
        AND cm.role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'SERVICE_ACCOUNT_SPONSOR_INVALID: the sponsor must be an owner or admin member of the company'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'service_accounts: a revoked service account is final'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.sponsor_user_id IS DISTINCT FROM OLD.sponsor_user_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'service_accounts: the only change a service account takes is its revocation'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER service_accounts_guard
  BEFORE INSERT OR UPDATE ON public.service_accounts
  FOR EACH ROW EXECUTE FUNCTION public.service_accounts_guard();

-- api_keys: a service-account key is minted through create_service_account_key
-- only (never from a user session), belongs to the account's sponsor and
-- company, and keeps all three for life. A person's key never becomes one.
CREATE FUNCTION public.api_keys_guard_service_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_account public.service_accounts;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.service_account_id IS DISTINCT FROM OLD.service_account_id THEN
      RAISE EXCEPTION 'api_keys: service_account_id is fixed when the key is minted'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.service_account_id IS NOT NULL
       AND (NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
      RAISE EXCEPTION 'api_keys: a service-account key keeps its sponsor and company'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.service_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_jwt_role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'api_keys: service-account keys are minted only through the service-account API'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_account FROM public.service_accounts WHERE id = NEW.service_account_id;
  IF NOT FOUND OR v_account.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'api_keys: the service account is unknown or revoked'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.user_id IS DISTINCT FROM v_account.sponsor_user_id
     OR NEW.company_id IS DISTINCT FROM v_account.company_id THEN
    RAISE EXCEPTION 'api_keys: a service-account key belongs to its sponsor and its company'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.refresh_token_hash IS NOT NULL THEN
    RAISE EXCEPTION 'api_keys: a service-account key is never an OAuth connection'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER api_keys_guard_service_account
  BEFORE INSERT OR UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_keys_guard_service_account();

-- =============================================================================
-- 5. Revocation revokes the keys; the lifecycle lands in audit_log
-- =============================================================================

CREATE FUNCTION public.service_accounts_revoke_keys()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE public.api_keys
       SET revoked_at = NEW.revoked_at
     WHERE service_account_id = NEW.id
       AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER service_accounts_revoke_keys
  AFTER UPDATE ON public.service_accounts
  FOR EACH ROW EXECUTE FUNCTION public.service_accounts_revoke_keys();

-- write_audit_log() reads the acting user from the row's user_id, which this
-- table does not have: the creator acts on INSERT, the revoker on revocation.
-- Everything else is write_audit_log's shape, including the acting credential
-- from the gnubok.actor_* GUCs (an unset GUC reads as 'user').
CREATE FUNCTION public.audit_service_accounts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_desc    text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_user_id := NEW.created_by;
    v_desc := 'Created service account "' || NEW.name || '"';
  ELSE
    v_user_id := coalesce(NEW.revoked_by, auth.uid());
    v_desc := 'Revoked service account "' || NEW.name || '"';
  END IF;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, NEW.company_id, TG_OP, TG_TABLE_NAME, NEW.id, v_user_id,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW), v_desc,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  RETURN NULL;
END;
$$;

CREATE TRIGGER audit_service_accounts
  AFTER INSERT OR UPDATE ON public.service_accounts
  FOR EACH ROW EXECUTE FUNCTION public.audit_service_accounts();

-- =============================================================================
-- 6. validate_and_increment_api_key
-- =============================================================================
--
-- The body is copied VERBATIM from 20261007053848 (the latest definition) with
-- these changes and nothing else:
--   * the key's service_account_id is read with the row;
--   * a service-account key is handled in its own branch: refused (no row,
--     401 upstream, refined by service_account_key_refusal) unless
--     service_account_is_active() and its sponsor is the key's user; its
--     company is the account's company and its allowlist exactly that
--     company, whatever api_key_companies holds (the read-only level is
--     still read from its row there). The person-key branch below it is the
--     old body unchanged;
--   * service_account_id and service_account_name join the RETURNS TABLE and
--     every RETURN QUERY (NULL for a person's key).
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
  read_only_company_ids uuid[],
  service_account_id uuid,
  service_account_name text
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
  v_is_oauth boolean;
  v_service_account_id uuid;
  v_service_account_name text;
BEGIN
  -- Match the live key_hash, OR a previous (just-rotated) key_hash that is still
  -- inside its grace window. Both gated by revoked_at IS NULL.
  SELECT ak.id, ak.user_id, ak.company_id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode,
         ak.unattended_commit_limit, ak.refresh_token_hash IS NOT NULL, ak.service_account_id
  INTO   v_id, v_user_id, v_company_id, v_api_key_name,
         v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode,
         v_unattended_commit_limit, v_is_oauth, v_service_account_id
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

  IF v_service_account_id IS NOT NULL THEN
    -- A service account acts only while it is active (not revoked, company
    -- live, sponsor an owner or admin there) and only in its own company.
    -- Its sponsor is the key's user (api_keys_guard_service_account keeps it
    -- so); checked again here so a broken row fails closed.
    SELECT sa.company_id, sa.name
    INTO v_company_id, v_service_account_name
    FROM public.service_accounts sa
    WHERE sa.id = v_service_account_id
      AND sa.sponsor_user_id = v_user_id
      AND public.service_account_is_active(sa.id);

    IF NOT FOUND THEN
      RETURN;  -- suspended or revoked account: 401 upstream (see service_account_key_refusal)
    END IF;

    v_allowed_company_ids := ARRAY[v_company_id];
    v_read_only_company_ids := CASE
      WHEN EXISTS (
        SELECT 1
        FROM public.api_key_companies akc
        WHERE akc.api_key_id = v_id
          AND akc.company_id = v_company_id
          AND akc.access = 'read'
      ) THEN ARRAY[v_company_id]
    END;
  ELSE
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
    -- outside the allowlist, absent, or no longer a live membership (archived,
    -- or a company the user left), the first allowed company the user is
    -- still a live member of takes its place. Nothing left means the key
    -- reaches nothing: treated as an unknown key, like the membership block.
    IF v_allowed_company_ids IS NOT NULL
       AND (
         v_company_id IS NULL
         OR v_company_id <> ALL (v_allowed_company_ids)
         OR NOT EXISTS (
           SELECT 1
           FROM public.company_members cm
           JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
           WHERE cm.user_id = v_user_id
             AND cm.company_id = v_company_id
         )
       ) THEN
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
    -- An OAuth connection without allowlist rows is unbound instead of refused:
    -- validateApiKey's lazy bind attaches it to the user's active company, the
    -- one a reconnect would bind a new key to. It never answers with the
    -- company that is gone. A manual key still fails closed.
    IF v_company_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.company_members cm
      JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
      WHERE cm.user_id = v_user_id
        AND cm.company_id = v_company_id
    ) THEN
      IF NOT v_is_oauth OR v_allowed_company_ids IS NOT NULL THEN
        RETURN;  -- treated as an unknown key: 401 upstream
      END IF;

      UPDATE public.api_keys
         SET company_id = NULL
       WHERE id = v_id;
      v_company_id := NULL;
    END IF;
  END IF;

  -- Reset the rate-limit window if it is unset or older than one minute.
  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
       SET request_count = 1,
           rate_limit_window_start = now(),
           last_used_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids,
                        v_service_account_id, v_service_account_name;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids,
                        v_service_account_id, v_service_account_name;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids,
                      v_service_account_id, v_service_account_name;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;

-- =============================================================================
-- 7. service_account_key_refusal
-- =============================================================================
--
-- Called by the application only after validate_and_increment_api_key
-- answered no row, to tell a suspended service account from an unknown key.
-- Matches the same live hashes the validation does. Answers
-- 'SERVICE_ACCOUNT_SUSPENDED' or NULL (unknown, revoked or otherwise refused
-- key: the generic answer). Writes nothing and counts nothing.
CREATE FUNCTION public.service_account_key_refusal(p_key_hash text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT 'SERVICE_ACCOUNT_SUSPENDED'::text
  FROM public.api_keys ak
  WHERE ak.revoked_at IS NULL
    AND ak.service_account_id IS NOT NULL
    AND (
      ak.key_hash = p_key_hash
      OR (
        ak.previous_key_hash = p_key_hash
        AND ak.previous_key_expires_at IS NOT NULL
        AND ak.previous_key_expires_at > now()
      )
    )
    AND NOT public.service_account_is_active(ak.service_account_id)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.service_account_key_refusal(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_account_key_refusal(text) TO service_role;

-- =============================================================================
-- 8. Write RPCs (service_role only)
-- =============================================================================
--
-- Every one re-checks that the acting user is an owner or admin member of the
-- company (the v1 doors run as the service role, so RLS does not), and sets
-- the transaction-local gnubok.actor_type / gnubok.actor_label the audit
-- triggers read (the commit_journal_entry convention, 20260619120000), so the
-- behandlingshistorik names the credential that acted. Domain refusals raise
-- with a message that starts with the structured error code.

CREATE FUNCTION public.service_account_actor_is_admin(p_company_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.company_id = p_company_id
      AND cm.user_id = p_user_id
      AND cm.role IN ('owner', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION public.service_account_actor_is_admin(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_account_actor_is_admin(uuid, uuid) TO service_role;

CREATE FUNCTION public.create_service_account(
  p_company_id uuid,
  p_name text,
  p_sponsor_user_id uuid,
  p_created_by uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS public.service_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.service_accounts;
  v_live integer;
BEGIN
  IF NOT public.service_account_actor_is_admin(p_company_id, p_created_by) THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_ADMIN_REQUIRED: only an owner or admin may create a service account'
      USING ERRCODE = '42501';
  END IF;

  -- One creation at a time per company, so the cap below holds.
  PERFORM pg_advisory_xact_lock(hashtextextended('service-accounts:' || p_company_id::text, 0));

  SELECT count(*) INTO v_live
  FROM public.service_accounts
  WHERE company_id = p_company_id AND revoked_at IS NULL;
  IF v_live >= 25 THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_LIMIT: a company has at most 25 live service accounts'
      USING ERRCODE = '54000';
  END IF;

  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  INSERT INTO public.service_accounts (company_id, name, sponsor_user_id, created_by)
  VALUES (p_company_id, btrim(p_name), p_sponsor_user_id, p_created_by)
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_service_account(uuid, text, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_account(uuid, text, uuid, uuid, text, text) TO service_role;

-- Idempotent: revoking a revoked account answers it as it is. No row (NULL)
-- when the account is not the company's.
CREATE FUNCTION public.revoke_service_account(
  p_company_id uuid,
  p_service_account_id uuid,
  p_revoked_by uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS public.service_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.service_accounts;
BEGIN
  IF NOT public.service_account_actor_is_admin(p_company_id, p_revoked_by) THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_ADMIN_REQUIRED: only an owner or admin may revoke a service account'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row
  FROM public.service_accounts
  WHERE id = p_service_account_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_row.revoked_at IS NOT NULL THEN
    RETURN v_row;
  END IF;

  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  UPDATE public.service_accounts
     SET revoked_at = now(),
         revoked_by = p_revoked_by
   WHERE id = p_service_account_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_service_account(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_service_account(uuid, uuid, uuid, text, text) TO service_role;

-- Mint a key for an active account: user_id = the sponsor, company_id = the
-- account's company, one api_key_companies row for that company (write, or
-- read when p_read_only). At most 5 live keys per account (room to rotate).
-- The scopes are validated against the catalogue and capped by the
-- application (lib/service-accounts); the database stores what it is given.
CREATE FUNCTION public.create_service_account_key(
  p_company_id uuid,
  p_service_account_id uuid,
  p_key_hash text,
  p_key_prefix text,
  p_name text,
  p_scopes text[],
  p_mode text,
  p_read_only boolean,
  p_sod_acknowledged_at timestamptz,
  p_created_by uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account public.service_accounts;
  v_live integer;
  v_key_id uuid;
BEGIN
  IF NOT public.service_account_actor_is_admin(p_company_id, p_created_by) THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_ADMIN_REQUIRED: only an owner or admin may mint a service-account key'
      USING ERRCODE = '42501';
  END IF;
  IF p_scopes IS NULL OR cardinality(p_scopes) = 0 THEN
    RAISE EXCEPTION 'create_service_account_key: at least one scope is required'
      USING ERRCODE = '22023';
  END IF;

  -- The row lock serialises mints per account, so the key cap holds.
  SELECT * INTO v_account
  FROM public.service_accounts
  WHERE id = p_service_account_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_NOT_FOUND: no such service account in this company'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_account.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_REVOKED: the service account is revoked'
      USING ERRCODE = '55000';
  END IF;
  IF NOT public.service_account_is_active(v_account.id) THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_SUSPENDED: the sponsor is no longer an owner or admin of the company'
      USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_live
  FROM public.api_keys
  WHERE service_account_id = v_account.id AND revoked_at IS NULL;
  IF v_live >= 5 THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_KEY_LIMIT: a service account has at most 5 live keys'
      USING ERRCODE = '54000';
  END IF;

  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  INSERT INTO public.api_keys (
    user_id,
    company_id,
    key_hash,
    key_prefix,
    name,
    scopes,
    mode,
    service_account_id,
    sod_acknowledged_at,
    sod_acknowledged_by
  ) VALUES (
    v_account.sponsor_user_id,
    v_account.company_id,
    p_key_hash,
    p_key_prefix,
    COALESCE(nullif(btrim(p_name), ''), v_account.name),
    p_scopes,
    COALESCE(p_mode, 'live'),
    v_account.id,
    p_sod_acknowledged_at,
    CASE WHEN p_sod_acknowledged_at IS NULL THEN NULL ELSE p_created_by END
  )
  RETURNING id INTO v_key_id;

  INSERT INTO public.api_key_companies (api_key_id, company_id, access)
  VALUES (v_key_id, v_account.company_id, CASE WHEN p_read_only THEN 'read' ELSE 'write' END);

  RETURN v_key_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_service_account_key(uuid, uuid, text, text, text, text[], text, boolean, timestamptz, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_account_key(uuid, uuid, text, text, text, text[], text, boolean, timestamptz, uuid, text, text) TO service_role;

-- Revoke one key of an account. Idempotent: answers the key's revoked_at, or
-- NULL when the key is not one of this account's keys in this company.
CREATE FUNCTION public.revoke_service_account_key(
  p_company_id uuid,
  p_service_account_id uuid,
  p_api_key_id uuid,
  p_revoked_by uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revoked_at timestamptz;
BEGIN
  IF NOT public.service_account_actor_is_admin(p_company_id, p_revoked_by) THEN
    RAISE EXCEPTION 'SERVICE_ACCOUNT_ADMIN_REQUIRED: only an owner or admin may revoke a service-account key'
      USING ERRCODE = '42501';
  END IF;

  SELECT ak.revoked_at INTO v_revoked_at
  FROM public.api_keys ak
  WHERE ak.id = p_api_key_id
    AND ak.service_account_id = p_service_account_id
    AND ak.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_revoked_at IS NOT NULL THEN
    RETURN v_revoked_at;
  END IF;

  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  UPDATE public.api_keys
     SET revoked_at = now()
   WHERE id = p_api_key_id
  RETURNING revoked_at INTO v_revoked_at;

  RETURN v_revoked_at;
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_service_account_key(uuid, uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_service_account_key(uuid, uuid, uuid, uuid, text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
