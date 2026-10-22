-- Who accepted which legal document, the user's analytics consent, and the
-- company's data choices (founder decisions 2026-10-21, legal docs review).
--
-- 1. legal_acceptances: one row per person, document and version accepted in
--    the acceptance prompt (src/lib/legal/documents.ts holds the versions).
--    Append-only: the API roles get SELECT and INSERT, never UPDATE or
--    DELETE, so a row is evidence of what was agreed and when. The row says
--    which button the person pressed (method). company_id is the company
--    that was open, as context only: the documents are accepted by the
--    person, for the customer they act for. Retained on account erasure
--    (tests/pg/account-erasure.pg.test.ts): it holds no personal data beyond
--    the tombstoned user id.
--
-- 2. user_preferences.analytics_consent: the person's own choice about
--    product analytics in the browser (PostHog analytics, masked session
--    replay, surveys). NULL until asked; the browser loads PostHog only when
--    it is true (src/lib/analytics/client.ts). analytics_consent_at is when
--    the choice was last made. Erased with the row by erase_user_personal_data.
--
-- 3. set_company_data_choice: the one write of a company's data choices,
--    stored like a package switch in company_capability_config:
--      'ai'                absent or enabled: AI processing runs. enabled =
--                          false turns every model call for the company off
--                          (the existing ENABLEMENT axis of CAPABILITY.ai).
--      'data:pooling'      absent or enabled: the company's anonymous
--                          patterns join the shared ones (counterparty
--                          directory, calibration samples). enabled = false
--                          opts out.
--      'data:contribution' only enabled = true counts: real content may be
--                          used to evaluate and improve the service. Off by
--                          default; nothing reads it yet.
--    Re-checks that the deciding user is an owner or admin (the route calls
--    it through the service role), writes who decided and when, and the
--    audit_log row behandlingshistorik reads. A choice equal to the current
--    state, the default included, writes nothing. service_role only.
--
-- Nothing here touches the bookkeeping: no journal table, no trigger of
-- migration 017.
--
-- pg-test: tests/pg/legal-acceptances-and-data-choices.pg.test.ts

-- =============================================================================
-- 1. legal_acceptances
-- =============================================================================

CREATE TABLE public.legal_acceptances (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id   uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  document_key text NOT NULL CONSTRAINT legal_acceptances_document_key_check CHECK (document_key ~ '^[a-z][a-z_-]{1,39}$'),
  version      text NOT NULL CONSTRAINT legal_acceptances_version_check CHECK (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  method       text NOT NULL CONSTRAINT legal_acceptances_method_check CHECK (method IN ('accept_all', 'accept_documents')),
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_acceptances_once UNIQUE (user_id, document_key, version)
);

CREATE INDEX idx_legal_acceptances_company_id ON public.legal_acceptances (company_id);

COMMENT ON TABLE public.legal_acceptances IS
  'Append-only: who accepted which legal document version, when, and with which button. Written by POST /api/legal/accept.';

ALTER TABLE public.legal_acceptances ENABLE ROW LEVEL SECURITY;

-- Append-only: no UPDATE or DELETE privilege for any API role. The FK
-- actions (ON DELETE SET NULL / CASCADE) run as the table owner and are not
-- blocked by this.
GRANT SELECT, INSERT ON TABLE public.legal_acceptances TO service_role;
GRANT SELECT, INSERT ON TABLE public.legal_acceptances TO authenticated;
-- no-grant: anon on public.legal_acceptances (accepting needs a signed-in person)

CREATE POLICY "users read own legal_acceptances"
  ON public.legal_acceptances FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "users insert own legal_acceptances"
  ON public.legal_acceptances FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND (company_id IS NULL OR company_id IN (SELECT public.user_company_ids()))
  );

-- =============================================================================
-- 2. user_preferences.analytics_consent
-- =============================================================================

ALTER TABLE public.user_preferences
  ADD COLUMN analytics_consent boolean,
  ADD COLUMN analytics_consent_at timestamptz;

COMMENT ON COLUMN public.user_preferences.analytics_consent IS
  'Product analytics in the browser (PostHog analytics, masked replay, surveys): NULL not asked, true granted, false declined.';
COMMENT ON COLUMN public.user_preferences.analytics_consent_at IS
  'When analytics_consent was last set.';

-- =============================================================================
-- 3. set_company_data_choice
-- =============================================================================

CREATE FUNCTION public.set_company_data_choice(
  p_company_id uuid,
  p_key text,
  p_enabled boolean,
  p_decided_by uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.company_capability_config;
  v_new public.company_capability_config;
  v_default boolean;
  v_actor_type text;
BEGIN
  IF p_key IS NULL OR p_key NOT IN ('ai', 'data:pooling', 'data:contribution') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DATA_CHOICE_UNKNOWN');
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'set_company_data_choice: p_enabled is required' USING ERRCODE = '22023';
  END IF;
  IF p_decided_by IS NULL OR NOT public.service_account_actor_is_admin(p_company_id, p_decided_by) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DATA_CHOICE_ADMIN_REQUIRED');
  END IF;

  -- What no row means: AI and pooling are on, contribution is off.
  v_default := p_key <> 'data:contribution';

  PERFORM pg_advisory_xact_lock(hashtextextended('company-data-choice:' || p_company_id::text || ':' || p_key, 0));

  SELECT * INTO v_old
    FROM public.company_capability_config
   WHERE company_id = p_company_id AND capability_key = p_key
   FOR UPDATE;

  IF (v_old.id IS NOT NULL AND v_old.enabled = p_enabled) OR (v_old.id IS NULL AND p_enabled = v_default) THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'key', p_key, 'enabled', p_enabled);
  END IF;

  v_actor_type := CASE
    WHEN p_actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account') THEN p_actor_type
    ELSE 'user'
  END;

  INSERT INTO public.company_capability_config (
    company_id, capability_key, enabled, source, decided_by, decided_actor_type, decided_actor_label,
    decided_at, pending_operation_id
  )
  VALUES (
    p_company_id, p_key, p_enabled, 'company', p_decided_by, v_actor_type, nullif(left(p_actor_label, 200), ''),
    now(), NULL
  )
  ON CONFLICT (company_id, capability_key) DO UPDATE
     SET enabled = EXCLUDED.enabled,
         source = EXCLUDED.source,
         decided_by = EXCLUDED.decided_by,
         decided_actor_type = EXCLUDED.decided_actor_type,
         decided_actor_label = EXCLUDED.decided_actor_label,
         decided_at = EXCLUDED.decided_at,
         pending_operation_id = EXCLUDED.pending_operation_id
  RETURNING * INTO v_new;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                description, actor_type, actor_label)
  VALUES (
    p_decided_by, p_company_id,
    CASE WHEN v_old.id IS NULL THEN 'INSERT' ELSE 'UPDATE' END,
    'company_capability_config', v_new.id, p_decided_by,
    CASE WHEN v_old.id IS NULL THEN NULL ELSE to_jsonb(v_old) END,
    to_jsonb(v_new),
    CASE WHEN p_enabled THEN 'Switched data choice on: ' ELSE 'Switched data choice off: ' END || p_key,
    v_actor_type,
    nullif(left(p_actor_label, 200), '')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'unchanged', false,
    'key', p_key,
    'enabled', p_enabled,
    'previous_enabled', coalesce(v_old.enabled, v_default),
    'capability_config_id', v_new.id,
    'decided_at', v_new.decided_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_company_data_choice(uuid, text, boolean, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_company_data_choice(uuid, text, boolean, uuid, text, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
