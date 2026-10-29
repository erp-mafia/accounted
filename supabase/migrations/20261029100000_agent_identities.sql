-- Agent identities: a named agent with one human sponsor (rights wave 1).
-- pg-test: tests/pg/agent-identities.pg.test.ts
--
-- WHY
-- ---
-- An agent is today only an api_keys row. A connector such as Claude mints a
-- new key on every reconnect, so one agent is many unrelated rows, and there
-- is nothing a person can point at to say "this agent, acting for me". This
-- migration adds that thing: a named agent identity with exactly one human
-- sponsor. Attribution can then say "Claude for Jonas Ek", the sponsor can
-- pause the agent, and later waves can hang mandates on it.
--
-- public.agents already exists (the provenance registry of 20260914200000,
-- read by company_facts.asserted_by_agent_id). It is a different thing and is
-- not touched: the new table is agent_identities and the new foreign keys are
-- named agent_identity_id.
--
-- WHAT
-- ----
-- 1. public.agent_identities: sponsor, kind (connector, api_key,
--    service_account, assistant, routine), the OAuth client for a connector,
--    a display name, the service account for a service account's identity,
--    paused_at / paused_by, revoked_at. At most one live connector per
--    (sponsor, client) and one live assistant per sponsor. The sponsor reads
--    their own identities; nobody writes them from a session.
-- 2. api_keys.agent_identity_id, set by a BEFORE INSERT trigger when the key
--    is minted (find-or-create):
--      * a service account's key -> the account's identity;
--      * an OAuth connector key -> the live connector identity of
--        (user, client), so every reconnect lands on the same agent;
--      * any other key -> a new 'api_key' identity named after the key.
--    A user session can never set or change it (only the foreign key's own
--    SET NULL, once a deleted service account took its identity along).
-- 3. A service account gets its identity when it is created, and the
--    identity is revoked with it. An 'api_key' identity is revoked with its
--    key. A connector identity stays live when its keys are revoked: a
--    reconnect attaches to it again, so a pause outlives a reconnect.
-- 4. Backfill of every existing key, live and revoked, with the same grouping
--    (backfill_agent_identities, run once here). An identity whose keys are
--    all revoked is revoked at the latest key revocation; a service account's
--    identity follows the account.
-- 5. validate_and_increment_api_key refuses a key whose identity is paused
--    (no row, nothing counted) and returns agent_identity_id and client.
--    api_key_refusal(hash) tells the application why a key was refused:
--    AGENT_PAUSED or SERVICE_ACCOUNT_SUSPENDED (403 upstream), else NULL.
-- 6. rotate_mcp_refresh_token answers 'paused' for a paused identity instead
--    of rotating, so a refresh cannot run while the agent is paused.
-- 7. pause_agent_identity / resume_agent_identity: the sponsor only (this
--    wave). A pause also cancels the agent's in-flight MCP tasks.
--
-- ROLLING DEPLOY (validate_and_increment_api_key changes its RETURNS TABLE,
-- so it is dropped and re-created under the same name, as 20261016120000 did):
--   * new database, old code: the old code reads the columns it knows by
--     name and ignores agent_identity_id and client. A paused key gets no row,
--     so the old code answers the generic 401 and the pause still holds. The
--     old code calls service_account_key_refusal, which is unchanged. A
--     refresh of a paused identity answers 'paused', which the old token
--     route treats like any unknown outcome: invalid_grant.
--   * new code, old database: the row has no agent_identity_id or client
--     (read as null); api_key_refusal is missing (PGRST202) and the refusal
--     falls back to the generic 401; the agent_identities lookup in the token
--     route fails and is skipped. Nothing can be paused before the migration.
-- supabase db push runs the file as one transaction, so no caller sees the
-- function missing between the DROP and the CREATE. Grants are restated.

-- Hot table (api_keys): never queue every request behind a long transaction.
-- Fail the migration job instead and retry.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. public.agent_identities
-- =============================================================================

CREATE TABLE public.agent_identities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- CASCADE: the identity goes with its sponsor's account, as the keys do
  -- (api_keys.user_id ON DELETE CASCADE). Account deletion and sandbox
  -- teardown both end in DELETE FROM auth.users.
  sponsor_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind               text NOT NULL
    CONSTRAINT agent_identities_kind_check
    CHECK (kind IN ('connector', 'api_key', 'service_account', 'assistant', 'routine')),
  client             text,
  display_name       text NOT NULL
    CONSTRAINT agent_identities_display_name_check
    CHECK (btrim(display_name) <> ''),
  -- CASCADE: an account is removed only with its company, and its keys go
  -- with it (api_keys.service_account_id ON DELETE CASCADE).
  service_account_id uuid UNIQUE REFERENCES public.service_accounts(id) ON DELETE CASCADE,
  paused_at          timestamptz,
  paused_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_identities_service_account_check
    CHECK ((kind = 'service_account') = (service_account_id IS NOT NULL)),
  CONSTRAINT agent_identities_paused_by_check
    CHECK (paused_by IS NULL OR paused_at IS NOT NULL)
);

COMMENT ON TABLE public.agent_identities IS
  'A named agent with one human sponsor who answers for it: an OAuth connector (one per sponsor and client, every reconnect attaches to it), a manual API key, a service account, and later the assistant and routines. api_keys.agent_identity_id links each key to it. Written only by SECURITY DEFINER functions; never deleted by the application, only with its sponsor''s account.';
COMMENT ON COLUMN public.agent_identities.sponsor_user_id IS
  'The person the agent acts for and who answers for it: the key''s user, or the service account''s sponsor. Fixed for the life of the identity.';
COMMENT ON COLUMN public.agent_identities.client IS
  'For a connector: the api_keys.client value of its keys (a built-in provider such as claude, or registered:<oauth_client_registrations.id>), NULL for OAuth keys older than that column. Part of the connector''s identity.';
COMMENT ON COLUMN public.agent_identities.display_name IS
  'What attribution shows for the agent: the client''s name for a connector, the key''s name for a manual key, the account''s name for a service account.';
COMMENT ON COLUMN public.agent_identities.paused_at IS
  'Set while the sponsor has paused the agent: every key of the identity is refused (403 AGENT_PAUSED) and its refresh tokens do not rotate. pause_agent_identity / resume_agent_identity only.';
COMMENT ON COLUMN public.agent_identities.revoked_at IS
  'Final. A connector identity is revoked only by the backfill (all its keys were revoked); a manual key''s identity with its key; a service account''s identity with the account.';

CREATE INDEX idx_agent_identities_sponsor_user_id ON public.agent_identities (sponsor_user_id);
-- One live connector per sponsor and client. coalesce: OAuth keys older than
-- api_keys.client have no client, and they are one connector too.
CREATE UNIQUE INDEX agent_identities_live_connector_key
  ON public.agent_identities (sponsor_user_id, (coalesce(client, '')))
  WHERE kind = 'connector' AND revoked_at IS NULL;
-- One live assistant per sponsor (created by a later wave).
CREATE UNIQUE INDEX agent_identities_live_assistant_key
  ON public.agent_identities (sponsor_user_id)
  WHERE kind = 'assistant' AND revoked_at IS NULL;

ALTER TABLE public.agent_identities ENABLE ROW LEVEL SECURITY;

-- The sponsor reads the agents they answer for. Writes go only through the
-- SECURITY DEFINER functions below: no INSERT, UPDATE or DELETE policy.
CREATE POLICY agent_identities_select ON public.agent_identities
  FOR SELECT USING (sponsor_user_id = (SELECT auth.uid()));

GRANT SELECT ON TABLE public.agent_identities TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.agent_identities TO service_role;
-- no-grant: anon on public.agent_identities (a person's agents; no public surface reads them)

CREATE TRIGGER set_updated_at_agent_identities
  BEFORE UPDATE ON public.agent_identities
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- No audit trigger: an identity belongs to a person, not a company, so a
-- write_audit_log row would carry no company and reach no company's
-- behandlingshistorik. paused_at / paused_by record the current pause; the
-- keys' own audit rows keep naming the credential that acted.

-- Who an identity is never changes: sponsor, kind, client and service
-- account are fixed, and a revocation is final. The display name, the pause
-- and the revocation are the only changes.
CREATE FUNCTION public.agent_identities_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.sponsor_user_id IS DISTINCT FROM OLD.sponsor_user_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.client IS DISTINCT FROM OLD.client
     OR NEW.service_account_id IS DISTINCT FROM OLD.service_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent_identities: sponsor, kind, client and service account are fixed'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'agent_identities: a revoked agent identity is final'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_identities_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER agent_identities_guard
  BEFORE UPDATE ON public.agent_identities
  FOR EACH ROW EXECUTE FUNCTION public.agent_identities_guard();

-- =============================================================================
-- 2. api_keys.agent_identity_id
-- =============================================================================

ALTER TABLE public.api_keys
  ADD COLUMN agent_identity_id uuid REFERENCES public.agent_identities(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.api_keys.agent_identity_id IS
  'The agent this key belongs to (public.agent_identities). Set by the database when the key is minted (api_keys_set_agent_identity) and never changed from a user session. A key whose identity is paused is refused.';

CREATE INDEX idx_api_keys_agent_identity_id
  ON public.api_keys (agent_identity_id)
  WHERE agent_identity_id IS NOT NULL;

-- =============================================================================
-- 3. Find-or-create
-- =============================================================================

-- The display name of a connector. The built-in providers mirror
-- oauthActorLabel (src/lib/agent-skills/provenance.ts) and BuiltInProvider
-- (src/lib/auth/oauth-allowlist.ts) without the vendor suffix, so attribution
-- reads "Claude for <sponsor>". A registered client is named by its
-- registration. Anything else is a generic AI connection.
CREATE FUNCTION public.agent_identity_connector_name(p_client text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  IF p_client = 'claude' THEN
    RETURN 'Claude';
  ELSIF p_client = 'chatgpt' THEN
    RETURN 'ChatGPT';
  ELSIF p_client = 'grok' THEN
    RETURN 'Grok';
  ELSIF p_client = 'gemini' THEN
    RETURN 'Gemini';
  ELSIF p_client IN ('cursor', 'cursor_deeplink') THEN
    RETURN 'Cursor';
  ELSIF p_client ~ '^registered:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    SELECT nullif(btrim(r.client_name), '')
      INTO v_name
      FROM public.oauth_client_registrations r
     WHERE r.id = substr(p_client, length('registered:') + 1)::uuid;
    RETURN coalesce(v_name, 'AI-anslutning');
  END IF;
  RETURN 'AI-anslutning';
END;
$$;

REVOKE ALL ON FUNCTION public.agent_identity_connector_name(text) FROM PUBLIC, anon, authenticated;

-- Is this key an OAuth connector key? The token route names every key it
-- mints OAUTH_MCP_KEY_NAME (src/lib/auth/api-keys.ts) and gives it a refresh
-- token in the same insert; the manual route refuses that name and a user
-- session cannot set refresh-token material (api_keys_guard_jwt_writes).
-- Either marker counts, so an OAuth key from before refresh tokens, or one
-- whose name was edited, is still a connector key. A service account's key
-- never is.
CREATE FUNCTION public.api_key_is_connector(
  p_name text,
  p_refresh_token_hash text,
  p_service_account_id uuid
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_service_account_id IS NULL
     AND (p_name IS NOT DISTINCT FROM 'MCP-klient (OAuth)' OR p_refresh_token_hash IS NOT NULL);
$$;

REVOKE ALL ON FUNCTION public.api_key_is_connector(text, text, uuid) FROM PUBLIC, anon, authenticated;

-- The identity a new key belongs to, created when it does not exist yet.
-- Concurrent mints of one connector meet on the partial unique index: the
-- loser's insert does nothing and it reads the winner's row.
CREATE FUNCTION public.agent_identity_for_key(
  p_user_id uuid,
  p_name text,
  p_client text,
  p_is_connector boolean,
  p_service_account_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_account public.service_accounts;
BEGIN
  IF p_service_account_id IS NOT NULL THEN
    SELECT ai.id INTO v_id
      FROM public.agent_identities ai
     WHERE ai.service_account_id = p_service_account_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;

    SELECT * INTO v_account FROM public.service_accounts WHERE id = p_service_account_id;
    IF NOT FOUND THEN
      RETURN NULL;  -- the key's own foreign key refuses it
    END IF;

    INSERT INTO public.agent_identities (sponsor_user_id, kind, display_name, service_account_id, revoked_at)
    VALUES (v_account.sponsor_user_id, 'service_account', v_account.name, v_account.id, v_account.revoked_at)
    ON CONFLICT (service_account_id) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT ai.id INTO v_id
        FROM public.agent_identities ai
       WHERE ai.service_account_id = p_service_account_id;
    END IF;
    RETURN v_id;
  END IF;

  IF p_is_connector THEN
    SELECT ai.id INTO v_id
      FROM public.agent_identities ai
     WHERE ai.kind = 'connector'
       AND ai.revoked_at IS NULL
       AND ai.sponsor_user_id = p_user_id
       AND coalesce(ai.client, '') = coalesce(p_client, '');
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;

    INSERT INTO public.agent_identities (sponsor_user_id, kind, client, display_name)
    VALUES (p_user_id, 'connector', p_client, public.agent_identity_connector_name(p_client))
    ON CONFLICT (sponsor_user_id, (coalesce(client, '')))
      WHERE kind = 'connector' AND revoked_at IS NULL
      DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT ai.id INTO v_id
        FROM public.agent_identities ai
       WHERE ai.kind = 'connector'
         AND ai.revoked_at IS NULL
         AND ai.sponsor_user_id = p_user_id
         AND coalesce(ai.client, '') = coalesce(p_client, '');
    END IF;
    RETURN v_id;
  END IF;

  INSERT INTO public.agent_identities (sponsor_user_id, kind, client, display_name)
  VALUES (p_user_id, 'api_key', p_client, coalesce(nullif(btrim(p_name), ''), 'API-nyckel'))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_identity_for_key(uuid, text, text, boolean, uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 4. Triggers: keys attach, identities follow their account and key
-- =============================================================================

-- BEFORE INSERT: attach the new key to its identity. An identity given by
-- the caller is accepted only outside a user session and only when it is the
-- key's own (same sponsor, same service account, live).
-- BEFORE UPDATE OF agent_identity_id: never from a user session, except the
-- foreign key's SET NULL once the identity is deleted. The column list keeps
-- this off the per-request path (validate_and_increment_api_key updates the
-- counters on every call).
-- Named so it fires after api_keys_guard_jwt_writes and
-- api_keys_guard_service_account (BEFORE triggers fire in name order): a key
-- those refuse never creates an identity.
CREATE FUNCTION public.api_keys_set_agent_identity()
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
  v_identity public.agent_identities;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The one change a session may cause is the foreign key's own SET NULL,
    -- after the identity is gone (a service account deleted with its
    -- company carries its identity with it).
    IF NEW.agent_identity_id IS DISTINCT FROM OLD.agent_identity_id
       AND v_jwt_role IN ('anon', 'authenticated')
       AND NOT (
         NEW.agent_identity_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.agent_identities WHERE id = OLD.agent_identity_id)
       ) THEN
      RAISE EXCEPTION 'api_keys: agent_identity_id is set by the database, never from a user session'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.agent_identity_id IS NOT NULL THEN
    IF v_jwt_role IN ('anon', 'authenticated') THEN
      RAISE EXCEPTION 'api_keys: agent_identity_id is set by the database, never from a user session'
        USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_identity FROM public.agent_identities WHERE id = NEW.agent_identity_id;
    IF NOT FOUND
       OR v_identity.revoked_at IS NOT NULL
       OR v_identity.sponsor_user_id IS DISTINCT FROM NEW.user_id
       OR v_identity.service_account_id IS DISTINCT FROM NEW.service_account_id THEN
      RAISE EXCEPTION 'api_keys: a key belongs to a live agent identity of its own user'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  NEW.agent_identity_id := public.agent_identity_for_key(
    NEW.user_id,
    NEW.name,
    NEW.client,
    public.api_key_is_connector(NEW.name, NEW.refresh_token_hash, NEW.service_account_id),
    NEW.service_account_id
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.api_keys_set_agent_identity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER api_keys_set_agent_identity
  BEFORE INSERT OR UPDATE OF agent_identity_id ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_keys_set_agent_identity();

-- A manual key's identity is the key: it is revoked with it, unless another
-- live key was given the same identity explicitly. Connector identities stay
-- live (see the header), service account identities follow the account.
CREATE FUNCTION public.api_keys_revoke_agent_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.revoked_at IS NULL
     AND NEW.revoked_at IS NOT NULL
     AND NEW.agent_identity_id IS NOT NULL THEN
    UPDATE public.agent_identities ai
       SET revoked_at = NEW.revoked_at
     WHERE ai.id = NEW.agent_identity_id
       AND ai.kind = 'api_key'
       AND ai.revoked_at IS NULL
       AND NOT EXISTS (
         SELECT 1
           FROM public.api_keys ak
          WHERE ak.agent_identity_id = ai.id
            AND ak.revoked_at IS NULL
            AND ak.id <> NEW.id
       );
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.api_keys_revoke_agent_identity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER api_keys_revoke_agent_identity
  AFTER UPDATE OF revoked_at ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_keys_revoke_agent_identity();

-- A service account has its identity from the moment it exists, and loses it
-- when it is revoked (final, like the account's revocation).
CREATE FUNCTION public.service_accounts_agent_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.agent_identities (sponsor_user_id, kind, display_name, service_account_id, revoked_at)
    VALUES (NEW.sponsor_user_id, 'service_account', NEW.name, NEW.id, NEW.revoked_at)
    ON CONFLICT (service_account_id) DO NOTHING;
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    UPDATE public.agent_identities
       SET revoked_at = NEW.revoked_at
     WHERE service_account_id = NEW.id
       AND revoked_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.service_accounts_agent_identity() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER service_accounts_agent_identity
  AFTER INSERT OR UPDATE OF revoked_at ON public.service_accounts
  FOR EACH ROW EXECUTE FUNCTION public.service_accounts_agent_identity();

-- =============================================================================
-- 5. Backfill: every existing key, live and revoked
-- =============================================================================
--
-- Same grouping as the trigger, so the history maps onto the identities a
-- key minted today would get. A function, run once below, so the pg-real
-- test exercises this exact code; nobody but the migration role may run it.
-- Idempotent: every step skips keys that already have an identity and
-- service accounts that already have one, and only a connector this run
-- created is revoked for having no live key (a connector the trigger made
-- stays live when its keys are revoked, see the header).
--
-- The key updates are configuration plumbing written by the migration, not a
-- change anyone made to a key: the audit and updated_at triggers are held off
-- for them, so the behandlingshistorik does not gain one "Updated api_keys"
-- row per key and every key's updated_at keeps its real date. In the
-- migration, ADD COLUMN above already holds the ACCESS EXCLUSIVE lock that
-- DISABLE TRIGGER needs. Each is guarded by name, so a database where either
-- trigger drifted away still runs the backfill instead of failing.
CREATE FUNCTION public.backfill_agent_identities()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_has_audit boolean := EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.api_keys'::regclass AND tgname = 'audit_api_keys_update'
  );
  v_has_updated_at boolean := EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.api_keys'::regclass AND tgname = 'set_updated_at_api_keys'
  );
  v_new_connectors uuid[];
BEGIN
  IF v_has_audit THEN
    ALTER TABLE public.api_keys DISABLE TRIGGER audit_api_keys_update;
  END IF;
  IF v_has_updated_at THEN
    ALTER TABLE public.api_keys DISABLE TRIGGER set_updated_at_api_keys;
  END IF;

  -- a. Service accounts: one identity each, revoked with the account.
  INSERT INTO public.agent_identities (sponsor_user_id, kind, display_name, service_account_id, revoked_at, created_at)
  SELECT sa.sponsor_user_id, 'service_account', sa.name, sa.id, sa.revoked_at, sa.created_at
    FROM public.service_accounts sa
   WHERE NOT EXISTS (
     SELECT 1 FROM public.agent_identities ai WHERE ai.service_account_id = sa.id
   );

  UPDATE public.api_keys k
     SET agent_identity_id = ai.id
    FROM public.agent_identities ai
   WHERE k.agent_identity_id IS NULL
     AND k.service_account_id IS NOT NULL
     AND ai.service_account_id = k.service_account_id;

  -- b. Connectors: one identity per (user, client) over all its OAuth keys,
  -- created when the first of them was. A live connector that already
  -- exists for the pair takes the keys instead.
  WITH created AS (
    INSERT INTO public.agent_identities (sponsor_user_id, kind, client, display_name, created_at)
    SELECT k.user_id, 'connector', k.client, public.agent_identity_connector_name(k.client), min(k.created_at)
      FROM public.api_keys k
     WHERE k.agent_identity_id IS NULL
       AND public.api_key_is_connector(k.name, k.refresh_token_hash, k.service_account_id)
       AND NOT EXISTS (
         SELECT 1
           FROM public.agent_identities ai
          WHERE ai.kind = 'connector'
            AND ai.revoked_at IS NULL
            AND ai.sponsor_user_id = k.user_id
            AND coalesce(ai.client, '') = coalesce(k.client, '')
       )
     GROUP BY k.user_id, k.client
    RETURNING id
  )
  SELECT array_agg(id) INTO v_new_connectors FROM created;

  UPDATE public.api_keys k
     SET agent_identity_id = ai.id
    FROM public.agent_identities ai
   WHERE k.agent_identity_id IS NULL
     AND public.api_key_is_connector(k.name, k.refresh_token_hash, k.service_account_id)
     AND ai.kind = 'connector'
     AND ai.revoked_at IS NULL
     AND ai.sponsor_user_id = k.user_id
     AND coalesce(ai.client, '') = coalesce(k.client, '');

  -- c. Every other key: an identity of its own, revoked with the key. The
  -- CTE is read twice and calls gen_random_uuid(), so it is materialised
  -- once and the identity ids agree between the insert and the update.
  WITH manual AS (
    SELECT k.id AS key_id,
           gen_random_uuid() AS identity_id,
           k.user_id,
           k.client,
           k.name,
           k.created_at,
           k.revoked_at
      FROM public.api_keys k
     WHERE k.agent_identity_id IS NULL
       AND k.service_account_id IS NULL
       AND NOT public.api_key_is_connector(k.name, k.refresh_token_hash, k.service_account_id)
  ), created AS (
    INSERT INTO public.agent_identities (id, sponsor_user_id, kind, client, display_name, created_at, revoked_at)
    SELECT m.identity_id, m.user_id, 'api_key', m.client,
           coalesce(nullif(btrim(m.name), ''), 'API-nyckel'), m.created_at, m.revoked_at
      FROM manual m
    RETURNING id
  )
  UPDATE public.api_keys k
     SET agent_identity_id = m.identity_id
    FROM manual m
   WHERE k.id = m.key_id;

  -- d. A connector created above whose keys are all revoked is revoked at
  -- the latest of those revocations.
  UPDATE public.agent_identities ai
     SET revoked_at = r.last_revoked_at
    FROM (
      SELECT k.agent_identity_id, max(k.revoked_at) AS last_revoked_at
        FROM public.api_keys k
       WHERE k.agent_identity_id = ANY (v_new_connectors)
       GROUP BY k.agent_identity_id
      HAVING bool_and(k.revoked_at IS NOT NULL)
    ) r
   WHERE ai.id = r.agent_identity_id
     AND ai.revoked_at IS NULL;

  IF v_has_updated_at THEN
    ALTER TABLE public.api_keys ENABLE TRIGGER set_updated_at_api_keys;
  END IF;
  IF v_has_audit THEN
    ALTER TABLE public.api_keys ENABLE TRIGGER audit_api_keys_update;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_agent_identities() FROM PUBLIC, anon, authenticated, service_role;

SELECT public.backfill_agent_identities();

-- =============================================================================
-- 6. validate_and_increment_api_key
-- =============================================================================
--
-- The body is copied VERBATIM from 20261016120000 (the latest definition)
-- with these changes and nothing else:
--   * the key's agent_identity_id and client are read with the row;
--   * right after the key is matched, a key whose identity is paused is
--     refused: no row (403 AGENT_PAUSED upstream, via api_key_refusal), and
--     nothing is counted, before the service-account and person branches;
--   * agent_identity_id and client join the RETURNS TABLE and every
--     RETURN QUERY.
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
  service_account_name text,
  agent_identity_id uuid,
  client text
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
  v_agent_identity_id uuid;
  v_client text;
BEGIN
  -- Match the live key_hash, OR a previous (just-rotated) key_hash that is still
  -- inside its grace window. Both gated by revoked_at IS NULL.
  SELECT ak.id, ak.user_id, ak.company_id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode,
         ak.unattended_commit_limit, ak.refresh_token_hash IS NOT NULL, ak.service_account_id,
         ak.agent_identity_id, ak.client
  INTO   v_id, v_user_id, v_company_id, v_api_key_name,
         v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode,
         v_unattended_commit_limit, v_is_oauth, v_service_account_id,
         v_agent_identity_id, v_client
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

  -- A paused agent acts nowhere, whatever else the key may do: no row, and
  -- nothing counted. 403 AGENT_PAUSED upstream (see api_key_refusal).
  IF v_agent_identity_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.agent_identities ai
    WHERE ai.id = v_agent_identity_id
      AND ai.paused_at IS NOT NULL
  ) THEN
    RETURN;
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
                        v_service_account_id, v_service_account_name,
                        v_agent_identity_id, v_client;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids,
                        v_service_account_id, v_service_account_name,
                        v_agent_identity_id, v_client;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids,
                      v_service_account_id, v_service_account_name,
                      v_agent_identity_id, v_client;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;

-- =============================================================================
-- 7. api_key_refusal
-- =============================================================================
--
-- Called by the application only after validate_and_increment_api_key
-- answered no row, to tell a refusal with a code of its own from an unknown
-- key. Matches the same live hashes the validation does. Answers
-- 'AGENT_PAUSED' (checked first, as the validation does),
-- 'SERVICE_ACCOUNT_SUSPENDED', or NULL (unknown, revoked or otherwise
-- refused key: the generic answer). Writes nothing and counts nothing.
-- service_account_key_refusal (20261016120000) stays for the code deployed
-- before this migration; the application now calls this one.
CREATE FUNCTION public.api_key_refusal(p_key_hash text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
           WHEN ai.paused_at IS NOT NULL THEN 'AGENT_PAUSED'
           WHEN ak.service_account_id IS NOT NULL
                AND NOT public.service_account_is_active(ak.service_account_id)
             THEN 'SERVICE_ACCOUNT_SUSPENDED'
         END
  FROM public.api_keys ak
  LEFT JOIN public.agent_identities ai ON ai.id = ak.agent_identity_id
  WHERE ak.revoked_at IS NULL
    AND (
      ak.key_hash = p_key_hash
      OR (
        ak.previous_key_hash = p_key_hash
        AND ak.previous_key_expires_at IS NOT NULL
        AND ak.previous_key_expires_at > now()
      )
    )
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.api_key_refusal(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_key_refusal(text) TO service_role;

-- =============================================================================
-- 8. rotate_mcp_refresh_token
-- =============================================================================
--
-- The body is copied VERBATIM from 20261025084800 (the latest definition)
-- with these changes and nothing else:
--   * the grant's agent_identity_id is read with the row in steps 1 and 2;
--   * after the revoked check of steps 1 and 2, a grant whose identity is
--     paused answers the new outcome 'paused' and writes nothing: no
--     rotation, no retirement, so the same refresh token rotates normally
--     once the agent is resumed. Step 3 (reuse detection) is unchanged: a
--     reused token revokes the grant, paused or not.
-- Arguments and result type are unchanged, so CREATE OR REPLACE keeps the
-- service_role-only grant; it is restated anyway.

-- Outcomes:
--   'rotated'       presented = current refresh token: the caller's pair
--                   becomes current, the presented token the predecessor, the
--                   old predecessor is retired, the superseded access key
--                   gets p_grace_seconds.
--   'replayed'      presented = the predecessor: the current pair is its
--                   successor and is returned again (no write when it is the
--                   caller's derived pair).
--   'paused'        steps 1 and 2 matched a live grant whose agent identity
--                   is paused: nothing is written.
--   'reuse_revoked' presented = a retired token: the grant is revoked.
--   'revoked'       the matched grant was already revoked.
--   'invalid'       no grant knows the token.
CREATE OR REPLACE FUNCTION public.rotate_mcp_refresh_token(
  p_presented_hash    text,
  p_new_refresh_hash  text,
  p_new_key_hash      text,
  p_new_key_prefix    text,
  p_grace_seconds     integer
)
RETURNS TABLE(outcome text, scopes text[], api_key_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_revoked timestamptz;
  v_scopes text[];
  v_cur_key_hash text;
  v_cur_refresh_hash text;
  v_prev_refresh_hash text;
  v_agent_identity_id uuid;
BEGIN
  -- 1. The current refresh token: normal rotation.
  SELECT ak.id, ak.revoked_at, ak.scopes, ak.key_hash, ak.previous_refresh_token_hash, ak.agent_identity_id
    INTO v_id, v_revoked, v_scopes, v_cur_key_hash, v_prev_refresh_hash, v_agent_identity_id
  FROM public.api_keys ak
  WHERE ak.refresh_token_hash = p_presented_hash
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    IF v_revoked IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- A paused agent gets no new credentials while it is paused.
    IF v_agent_identity_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.agent_identities ai
      WHERE ai.id = v_agent_identity_id AND ai.paused_at IS NOT NULL
    ) THEN
      RETURN QUERY SELECT 'paused'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- The old predecessor is now two generations behind: from here on,
    -- presenting it is reuse.
    IF v_prev_refresh_hash IS NOT NULL THEN
      INSERT INTO public.api_key_retired_refresh_tokens (token_hash, api_key_id)
      VALUES (v_prev_refresh_hash, v_id)
      ON CONFLICT (token_hash) DO NOTHING;
    END IF;
    DELETE FROM public.api_key_retired_refresh_tokens r
     WHERE r.api_key_id = v_id
       AND r.retired_at < now() - interval '30 days';

    UPDATE public.api_keys ak
       SET previous_refresh_token_hash = p_presented_hash,
           previous_refresh_expires_at = NULL,
           previous_key_hash           = v_cur_key_hash,
           previous_key_expires_at     = now() + make_interval(secs => p_grace_seconds),
           refresh_token_hash          = p_new_refresh_hash,
           key_hash                    = p_new_key_hash,
           key_prefix                  = p_new_key_prefix
     WHERE ak.id = v_id;
    RETURN QUERY SELECT 'rotated'::text, v_scopes, v_id;
    RETURN;
  END IF;

  -- 2. The predecessor: an idempotent retry, however late.
  SELECT ak.id, ak.revoked_at, ak.scopes, ak.key_hash, ak.refresh_token_hash, ak.agent_identity_id
    INTO v_id, v_revoked, v_scopes, v_cur_key_hash, v_cur_refresh_hash, v_agent_identity_id
  FROM public.api_keys ak
  WHERE ak.previous_refresh_token_hash = p_presented_hash
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    IF v_revoked IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- A paused agent gets no new credentials while it is paused.
    IF v_agent_identity_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.agent_identities ai
      WHERE ai.id = v_agent_identity_id AND ai.paused_at IS NOT NULL
    ) THEN
      RETURN QUERY SELECT 'paused'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- The current pair is the presented token's successor. When it is the
    -- caller's derived pair the answer is the same pair again and nothing is
    -- written. Otherwise (rotated before derivation existed) it was never
    -- used, or this token would not be the predecessor: replace it once with
    -- the derived pair, keeping the replaced access key on the grace window.
    IF v_cur_refresh_hash IS DISTINCT FROM p_new_refresh_hash
       OR v_cur_key_hash IS DISTINCT FROM p_new_key_hash THEN
      UPDATE public.api_keys ak
         SET previous_key_hash       = v_cur_key_hash,
             previous_key_expires_at = now() + make_interval(secs => p_grace_seconds),
             refresh_token_hash      = p_new_refresh_hash,
             key_hash                = p_new_key_hash,
             key_prefix              = p_new_key_prefix
       WHERE ak.id = v_id;
    END IF;
    RETURN QUERY SELECT 'replayed'::text, v_scopes, v_id;
    RETURN;
  END IF;

  -- 3. Two or more generations old: reuse after the successor was used.
  SELECT r.api_key_id INTO v_id
  FROM public.api_key_retired_refresh_tokens r
  WHERE r.token_hash = p_presented_hash;

  IF v_id IS NOT NULL THEN
    SELECT ak.revoked_at INTO v_revoked
    FROM public.api_keys ak
    WHERE ak.id = v_id
    FOR UPDATE;

    IF v_revoked IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- One row holds the current and the previous credentials, so this kills
    -- the whole grant family at once.
    UPDATE public.api_keys ak
       SET revoked_at = now()
     WHERE ak.id = v_id;
    RETURN QUERY SELECT 'reuse_revoked'::text, NULL::text[], v_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'invalid'::text, NULL::text[], NULL::uuid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rotate_mcp_refresh_token(text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_mcp_refresh_token(text, text, text, text, integer)
  TO service_role;

-- =============================================================================
-- 9. pause_agent_identity / resume_agent_identity
-- =============================================================================
--
-- The sponsor only in this wave: called from the sponsor's own session
-- (auth.uid()). An identity that is not the caller's answers as unknown, so
-- the call does not reveal that it exists. Both are idempotent: pausing a
-- paused agent keeps the first pause, resuming a running one changes nothing.
-- A revoked identity takes neither.
--
-- A pause also cancels the agent's in-flight MCP tasks (mcp_tasks.api_key_id,
-- attribution only, no foreign key): their result is never handed to the
-- paused agent. The status='working' guard in the MCP handler
-- (completeMcpTask) keeps a cancelled task cancelled when the work it started
-- finishes later. A request already past validation when the pause commits
-- finishes; the next one is refused.

CREATE FUNCTION public.pause_agent_identity(p_id uuid)
RETURNS public.agent_identities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.agent_identities;
BEGIN
  SELECT * INTO v_row FROM public.agent_identities WHERE id = p_id FOR UPDATE;

  IF NOT FOUND OR v_uid IS NULL OR v_row.sponsor_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'AGENT_IDENTITY_NOT_FOUND: no such agent among the ones you answer for'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_IDENTITY_REVOKED: the agent is revoked'
      USING ERRCODE = '55000';
  END IF;
  IF v_row.paused_at IS NOT NULL THEN
    RETURN v_row;
  END IF;

  UPDATE public.agent_identities
     SET paused_at = now(),
         paused_by = v_uid
   WHERE id = p_id
  RETURNING * INTO v_row;

  UPDATE public.mcp_tasks t
     SET status = 'cancelled',
         status_message = 'Den här agenten är pausad i Accounted. Den som ansvarar för den kan återuppta den under Inställningar.'
   WHERE t.user_id = v_row.sponsor_user_id
     AND t.status IN ('working', 'input_required')
     AND t.api_key_id IN (
       SELECT ak.id FROM public.api_keys ak WHERE ak.agent_identity_id = p_id
     );

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.pause_agent_identity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pause_agent_identity(uuid) TO authenticated;

CREATE FUNCTION public.resume_agent_identity(p_id uuid)
RETURNS public.agent_identities
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.agent_identities;
BEGIN
  SELECT * INTO v_row FROM public.agent_identities WHERE id = p_id FOR UPDATE;

  IF NOT FOUND OR v_uid IS NULL OR v_row.sponsor_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'AGENT_IDENTITY_NOT_FOUND: no such agent among the ones you answer for'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'AGENT_IDENTITY_REVOKED: the agent is revoked'
      USING ERRCODE = '55000';
  END IF;
  IF v_row.paused_at IS NULL THEN
    RETURN v_row;
  END IF;

  UPDATE public.agent_identities
     SET paused_at = NULL,
         paused_by = NULL
   WHERE id = p_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.resume_agent_identity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resume_agent_identity(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
