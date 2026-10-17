-- Switching a package off is never refused for what is still open in it:
-- the package winds down instead (Profiles and Suggestions, winding down).
--
-- set_company_package_choice (migration 20261016200400) refused to switch a
-- package off while package_open_obligations named anything, because winding
-- down was not built. It is now: a switched-off package with open
-- obligations (an unbooked salary run, an unfiled AGI, an unpaid invoice,
-- unbooked POS days; src/lib/modules/obligations.ts) resolves to
-- winding_down, keeps its pages, tools and Att göra rows, and only its start
-- doors refuse (src/lib/modules/package-doors.ts), until the obligations are
-- settled and the package disappears. The founder's rule: "off" closes the
-- start paths only, obligations keep running, and a switch is refused only
-- for plan, country or legal form, which the application checks before it
-- stages the switch.
--
-- Restated from its latest definition (20261016200400) with the
-- obligations refusal removed and nothing else changed: the owner or admin
-- check, the advisory lock, the unchanged short-circuit, the upsert with who
-- decided and the audit_log row behandlingshistorik reads. The response no
-- longer carries PACKAGE_HAS_OPEN_OBLIGATIONS. package_open_obligations and
-- package_usage stay as they are: the "hide an unused package" detector
-- still asks whether anything is live before it suggests hiding one.
--
-- Nothing here touches the bookkeeping: no journal table, no trigger of
-- migration 017.
--
-- pg-test: tests/pg/package-winding-down.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

CREATE OR REPLACE FUNCTION public.set_company_package_choice(
  p_company_id uuid,
  p_package_id text,
  p_enabled boolean,
  p_source text,
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
  v_key text := 'package:' || p_package_id;
  v_old public.company_capability_config;
  v_new public.company_capability_config;
  v_actor_type text;
BEGIN
  IF p_package_id IS NULL OR p_package_id NOT IN ('bank', 'customer-invoices', 'supplier-invoices-and-payments',
      'receipts-and-documents', 'expenses', 'payroll', 'assets', 'pos-and-webshop') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PACKAGE_NOT_SWITCHABLE');
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'set_company_package_choice: p_enabled is required' USING ERRCODE = '22023';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('company', 'suggestion') THEN
    RAISE EXCEPTION 'set_company_package_choice: p_source must be company or suggestion' USING ERRCODE = '22023';
  END IF;
  IF p_decided_by IS NULL OR NOT public.service_account_actor_is_admin(p_company_id, p_decided_by) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PACKAGE_SWITCH_ADMIN_REQUIRED');
  END IF;

  -- One decision per company and package at a time.
  PERFORM pg_advisory_xact_lock(hashtextextended('company-package:' || p_company_id::text || ':' || p_package_id, 0));

  SELECT * INTO v_old
    FROM public.company_capability_config
   WHERE company_id = p_company_id AND capability_key = v_key
   FOR UPDATE;

  IF v_old.id IS NOT NULL AND v_old.enabled = p_enabled THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'package_id', p_package_id, 'enabled', p_enabled,
                              'capability_config_id', v_old.id);
  END IF;

  -- The credential that relayed the approval, as the commit RPCs record it;
  -- a type outside audit_log's list is recorded as the user, never a reason
  -- to fail the decision.
  v_actor_type := CASE
    WHEN p_actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account') THEN p_actor_type
    ELSE 'user'
  END;

  INSERT INTO public.company_capability_config (
    company_id, capability_key, enabled, source, decided_by, decided_actor_type, decided_actor_label,
    decided_at, pending_operation_id
  )
  VALUES (
    p_company_id, v_key, p_enabled, p_source, p_decided_by, v_actor_type, nullif(left(p_actor_label, 200), ''),
    now(), p_pending_operation_id
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
    CASE WHEN p_enabled THEN 'Switched package on: ' ELSE 'Switched package off: ' END || p_package_id,
    v_actor_type,
    nullif(left(p_actor_label, 200), '')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'unchanged', false,
    'package_id', p_package_id,
    'enabled', p_enabled,
    'previous_enabled', v_old.enabled,
    'capability_config_id', v_new.id,
    'decided_at', v_new.decided_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_company_package_choice(uuid, text, boolean, text, uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_company_package_choice(uuid, text, boolean, text, uuid, text, text, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
