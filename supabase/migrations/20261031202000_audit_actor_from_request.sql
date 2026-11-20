-- Behandlingshistorik names the person who acted for a write made through a
-- service-role client, and the credential they acted through: an API key,
-- the MCP server, a service account, the invoicer role's scoped client, a
-- cron run, a route that writes with the service client.
--
-- Why it was wrong
--
-- write_audit_log() and write_sie_header_audit() take the actor from
-- auth.uid() (20261029110000, #126). A service-role request has no JWT
-- subject, so auth.uid() is NULL there and both functions fell back to the
-- row's own user_id: its creator. Every API, MCP and scoped-client request
-- runs as the service role, so an UPDATE or DELETE that person B made through
-- one of them was logged as person A who created the row, with actor_type
-- 'user'. Only the RPCs that take p_actor_type / p_actor_label named the
-- credential (through the gnubok.actor_type / gnubok.actor_label settings),
-- and none of them could name the person. The person was known all along,
-- in the application: every door binds the request's actor scope
-- (runWithActor: withRouteContext, withApiV1, the MCP tool call, the
-- pending-operation commit, withCronContext). It never reached the
-- transaction.
--
-- Version: first written as 20261031120000, which
-- person_party_without_org_number holds in production. write_audit_log()
-- below keeps that migration's rule that a party turning into a person never
-- leaves its old org number (a personnummer) in the trail.
--
-- The mechanism
--
-- Every PostgREST request a service-role client makes inside an actor scope
-- carries it in one header, x-accounted-actor, as ASCII JSON:
--   {"type": "mcp_oauth", "user_id": "<the person>", "label": "Claude (Anthropic)"}
-- (src/lib/supabase/actor-header.ts, wired into both service-role client
-- factories). PostgREST hands every request header to the transaction as
-- request.headers, so any trigger the request fires, inside any RPC, can read
-- it. public.service_request_actor() reads it, and both audit functions use
-- it when the statement has no session:
--
--   person:     auth.uid() (a user's own request)
--               > the header's user_id (a service-role request made for someone)
--               > the row's user_id (nobody named: a webhook, a worker on a
--                 direct connection, a migration), as before.
--   credential: gnubok.actor_type / gnubok.actor_label set by the RPC the
--               statement runs in (the explicit p_actor_* the caller passed)
--               > the header's type and label
--               > 'user', as before.
--               Taken as a pair, so a type is never shown with another
--               credential's label.
--
-- Trust
--
--   * The header counts only on a service-role request, read from
--     current_setting('role'): the role PostgREST switches to after it has
--     checked the JWT signature, unchanged inside SECURITY DEFINER functions
--     (the rule stamp_journal_entry_verified_principal uses, 20261016110000).
--     Only the application server holds that key, and it could write
--     audit_log rows directly anyway. A user's request names its user through
--     its JWT, and a header it sends is ignored.
--   * The value is asserted by the server, like p_actor_type and
--     p_actor_label: the verified principal of a commit stays in
--     journal_entries.committed_auth_role / committed_auth_uid.
--   * Record-only: a header that cannot be read names nobody, and the write
--     goes on with the old fallback. Its JSON is parsed in an exception
--     block, entered only when the header is present. No foreign key: a
--     user id that is not in auth.users is recorded as given (audit_log.user_id
--     has never had one).
--
-- What stays
--
--   * Everything else in both functions is the newest definition, unchanged
--     (20261029110000). CREATE OR REPLACE keeps owners and grants.
--   * The tables that audit through their own functions (collection
--     connections, service accounts, cash account routing, signing signers)
--     and the other places that fall back to the creator without a session
--     (journal_entries.committed_by, the commit_journal_entry event_log row)
--     are not changed here; they can read the same function.
--
-- pg-test: tests/pg/audit-actor-from-request.pg.test.ts
-- PostgREST end to end: tests/tool-pg/audit-actor-header.tool.test.ts

-- =============================================================================
-- 1. public.service_request_actor(): who a service-role request acts for
-- =============================================================================

CREATE OR REPLACE FUNCTION public.service_request_actor(
  OUT user_id uuid,
  OUT actor_type text,
  OUT actor_label text
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_headers text;
  v_actor   jsonb;
BEGIN
  -- Only the service role may name someone else.
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RETURN;
  END IF;

  -- A request without the header costs no parse and no exception block.
  v_headers := current_setting('request.headers', true);
  IF v_headers IS NULL OR strpos(v_headers, 'x-accounted-actor') = 0 THEN
    RETURN;
  END IF;

  -- Record-only: anything unreadable names nobody instead of failing the write.
  BEGIN
    v_actor := (v_headers::jsonb ->> 'x-accounted-actor')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  IF jsonb_typeof(v_actor) IS DISTINCT FROM 'object' THEN
    RETURN;
  END IF;

  IF (v_actor ->> 'user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    user_id := (v_actor ->> 'user_id')::uuid;
  END IF;
  -- The values audit_log_actor_type_check allows; anything else names no credential.
  IF (v_actor ->> 'type') IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account') THEN
    actor_type := v_actor ->> 'type';
    actor_label := left(nullif(btrim(v_actor ->> 'label'), ''), 200);
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.service_request_actor() IS
  'Who a service-role PostgREST request acts for, from its x-accounted-actor header (src/lib/supabase/actor-header.ts): the person (user_id), the credential type and its label. All NULL for any other role, without the header, or when the header cannot be read. Asserted by the application server, read by write_audit_log and write_sie_header_audit.';

REVOKE ALL ON FUNCTION public.service_request_actor() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_request_actor() TO service_role;

-- =============================================================================
-- 2. write_audit_log: the actor a service-role request names
-- =============================================================================

CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id     uuid;
  v_company_id  uuid;
  v_action      text;
  v_old_state   jsonb;
  v_new_state   jsonb;
  v_record_id   uuid;
  v_desc        text;
  v_session     uuid;
  v_actor_type  text;
  v_actor_label text;
  v_request     record;
BEGIN
  -- Sandbox teardown (cleanup_sandbox_user) deletes the company row itself;
  -- audit rows inserted mid-cascade would reference the vanishing company
  -- and violate audit_log_company_id_fkey. The flag is transaction-local and
  -- only set after the RPC's is_sandbox check.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;

    -- A party that becomes a person drops its org number, which was a
    -- personnummer (link_party_on_role_write): the trail records that it was
    -- set, never the value.
    IF TG_TABLE_NAME = 'parties'
       AND v_new_state->>'kind' = 'person'
       AND v_new_state->>'org_number' IS NULL
       AND v_old_state->>'org_number' IS NOT NULL THEN
      v_old_state := (v_old_state - 'org_number') || jsonb_build_object('org_number_set', true);
    END IF;
  END IF;

  -- WHO. The person: the session's user (#126); without a session, the
  -- person a service-role request acts for (service_request_actor); without
  -- either, the row's user_id, its owner or creator, as before. The
  -- credential: the one the RPC this runs in was handed, else the request's,
  -- else 'user'.
  v_actor_type := nullif(current_setting('gnubok.actor_type', true), '');
  v_actor_label := nullif(current_setting('gnubok.actor_label', true), '');
  v_session := auth.uid();
  IF v_session IS NOT NULL THEN
    v_user_id := v_session;
  ELSE
    SELECT r.user_id, r.actor_type, r.actor_label INTO v_request
      FROM public.service_request_actor() r;
    v_user_id := COALESCE(v_request.user_id, v_user_id);
    IF v_actor_type IS NULL AND v_request.actor_type IS NOT NULL THEN
      v_actor_type := v_request.actor_type;
      v_actor_label := v_request.actor_label;
    END IF;
  END IF;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc,
    COALESCE(v_actor_type, 'user'),
    v_actor_label
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- =============================================================================
-- 3. write_sie_header_audit (journal_entries): the same change
-- =============================================================================

CREATE OR REPLACE FUNCTION public.write_sie_header_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id     uuid;
  v_company_id  uuid;
  v_action      text;
  v_old_state   jsonb;
  v_new_state   jsonb;
  v_record_id   uuid;
  v_desc        text;
  v_session     uuid;
  v_actor_type  text;
  v_actor_label text;
  v_request     record;
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.import_batch_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.sie_imports WHERE id=NEW.import_batch_id AND company_id=NEW.company_id
      AND audit_mode='chunk' AND job_state IN ('running','finalizing') AND job_phase IN ('vouchers','finalize')
  ) THEN RETURN NEW; END IF;
  -- Sandbox teardown (cleanup_sandbox_user) deletes the company row itself;
  -- audit rows inserted mid-cascade would reference the vanishing company
  -- and violate audit_log_company_id_fkey. The flag is transaction-local and
  -- only set after the RPC's is_sandbox check.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;
  END IF;

  -- WHO, as in write_audit_log: the session's user, else the person a
  -- service-role request acts for, else the row's user_id; the credential
  -- the RPC was handed, else the request's, else 'user'.
  v_actor_type := nullif(current_setting('gnubok.actor_type', true), '');
  v_actor_label := nullif(current_setting('gnubok.actor_label', true), '');
  v_session := auth.uid();
  IF v_session IS NOT NULL THEN
    v_user_id := v_session;
  ELSE
    SELECT r.user_id, r.actor_type, r.actor_label INTO v_request
      FROM public.service_request_actor() r;
    v_user_id := COALESCE(v_request.user_id, v_user_id);
    IF v_actor_type IS NULL AND v_request.actor_type IS NOT NULL THEN
      v_actor_type := v_request.actor_type;
      v_actor_label := v_request.actor_label;
    END IF;
  END IF;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc,
    COALESCE(v_actor_type, 'user'),
    v_actor_label
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
