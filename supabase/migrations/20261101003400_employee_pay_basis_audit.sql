-- Behandlingshistorik for an employee's pay basis (accounted#30).
--
-- Why
--
-- What an employee is paid from (monthly salary or hourly rate, employment
-- degree, working week, tax table and column, jämkning, extra tax, F-skatt,
-- vacation rule and rates, Växa-stöd, personalkategori, Fora code, default
-- dimensions, employment dates and type, active or not) decides the payroll
-- bookings. BFL 5 kap 11 § and BFNAR 2013:2 p. 9.16 ask the behandlingshistorik
-- to show changes to settings that affect how bokföringsposter are produced,
-- with who and when. Each booked payslip stores the figures it was calculated
-- with, so booked records stay traceable; the history of the master data was
-- the missing part: public.employees had no audit trigger at all (only the
-- updated_at, specification number, writer-role and EF owner triggers).
--
-- Why not write_audit_log()
--
-- write_audit_log() copies the whole row into old_state/new_state. An
-- employees row holds the personnummer (sealed, but still the person's
-- identifier), the bank account, the address and contact details, none of
-- which is a pay basis and none of which belongs in an immutable log. So this
-- is a function of its own (like audit_cash_account_routing, 20260921070500)
-- that keeps only the pay-basis columns, plus the first and last name so the
-- report can say whose pay changed. It writes nothing when only other columns
-- change (address, bank account, e-mail, personnummer, tax municipality).
--
-- The columns are picked out of to_jsonb(NEW) by name, never read as
-- NEW.<column>: a column dropped or renamed later just stops being logged, it
-- can never make an employee write fail. EMPLOYEE_PAY_FIELDS in
-- src/lib/reports/behandlingshistorik.ts labels the same list, and a unit test
-- holds the two together.
--
-- WHO
--
-- Exactly as write_audit_log() (20261031202000): the person is the session's
-- user, else the person a service-role request acts for (the
-- x-accounted-actor header every API key, MCP and service-account request
-- carries, read by service_request_actor()), else the row's user_id; the
-- credential is the one an RPC set in gnubok.actor_type / gnubok.actor_label,
-- else the request's, else 'user'. The dashboard edits employees with the
-- session client, the v1 API and the MCP commit executors with the service
-- client inside an actor scope, so every door names its person.
--
-- Scope
--
--   * AFTER INSERT (the starting pay basis) and AFTER UPDATE (only when a
--     pay-basis column actually changed). No DELETE row: employees are soft
--     deleted (is_active = false, logged as an UPDATE), and the only hard
--     deletes are company and sandbox teardown cascades, where an audit row
--     would point at a company being removed.
--   * The sandbox teardown flag skips the trigger, as in write_audit_log().
--   * Record only: nothing about the employee write changes. The trigger
--     returns NEW unchanged and raises nothing of its own.
--
-- behandlingshistorik_sources is restated from 20261031150000 unchanged but
-- for 'employees' in the audited tables (AUDITED_TABLES in
-- src/lib/reports/behandlingshistorik.ts). The sammalöneregeln confirmation
-- rows (GUARD_BYPASSED, table_name employees) were already selected by their
-- action and render as before.
--
-- Nothing here touches the migration 017 triggers, posted entries or their
-- lines. The app code is live a few minutes before this runs: until then
-- there are simply no employees rows to render.
--
-- pg-test: tests/pg/employee-pay-basis-audit.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. audit_employee_pay_basis(): the narrow trigger function
-- =============================================================================

CREATE OR REPLACE FUNCTION public.audit_employee_pay_basis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- The pay basis. Keep in step with EMPLOYEE_PAY_FIELDS in
  -- src/lib/reports/behandlingshistorik.ts (a unit test compares them).
  c_pay_keys CONSTANT text[] := ARRAY[
    'employment_type', 'personnel_category', 'employment_start', 'employment_end',
    'employment_degree', 'hours_per_week', 'workdays_per_week',
    'salary_type', 'monthly_salary', 'hourly_rate',
    'tax_table_number', 'tax_column', 'is_sidoinkomst',
    'jamkning_percentage', 'jamkning_valid_from', 'jamkning_valid_to',
    'extra_tax_amount', 'extra_tax_percentage',
    'f_skatt_status', 'f_skatt_verified_at',
    'vacation_rule', 'vacation_days_per_year', 'vacation_days_saved',
    'vacation_pay_rate', 'semestertillagg_rate',
    'housing_benefit_type', 'vaxa_stod_eligible', 'vaxa_stod_start', 'vaxa_stod_end',
    'fora_fok_id', 'fora_fok_start_date', 'default_dimensions', 'is_active'];
  -- Whose pay it is: stored with the pay basis, never compared.
  c_identity_keys CONSTANT text[] := ARRAY['first_name', 'last_name'];
  v_old_state   jsonb;
  v_new_state   jsonb;
  v_user_id     uuid;
  v_session     uuid;
  v_actor_type  text;
  v_actor_label text;
  v_request     record;
BEGIN
  -- Same teardown guard as write_audit_log() (20260807130000).
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    INTO v_new_state
    FROM jsonb_each(to_jsonb(NEW)) e
   WHERE e.key = ANY (c_pay_keys || c_identity_keys);

  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      INTO v_old_state
      FROM jsonb_each(to_jsonb(OLD)) e
     WHERE e.key = ANY (c_pay_keys || c_identity_keys);
    -- An edit of the address, bank account, e-mail or name only: no pay
    -- basis changed, nothing to log.
    IF (v_old_state - c_identity_keys) = (v_new_state - c_identity_keys) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- WHO, as in write_audit_log (20261031202000): the session's user, else the
  -- person a service-role request acts for, else the row's user_id; the
  -- credential the RPC was handed, else the request's, else 'user'.
  v_user_id := NEW.user_id;
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

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  )
  VALUES (
    v_user_id, NEW.company_id, TG_OP, TG_TABLE_NAME, NEW.id, v_user_id,
    v_old_state, v_new_state,
    CASE TG_OP WHEN 'INSERT' THEN 'Created employee pay basis' ELSE 'Updated employee pay basis' END,
    COALESCE(v_actor_type, 'user'),
    v_actor_label
  );

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.audit_employee_pay_basis() IS
  'Behandlingshistorik for employees (accounted#30): writes the pay-basis columns and the name, old and new, to audit_log on INSERT and on an UPDATE that changes one of them. Never the personnummer, bank account, address or contact details. Actor as write_audit_log().';

REVOKE EXECUTE ON FUNCTION public.audit_employee_pay_basis() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_employees_pay_basis ON public.employees;
CREATE TRIGGER audit_employees_pay_basis
  AFTER INSERT OR UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.audit_employee_pay_basis();

-- =============================================================================
-- 2. behandlingshistorik_sources: employees is audited
-- =============================================================================

CREATE OR REPLACE FUNCTION public.behandlingshistorik_sources(
  p_company_id uuid,
  p_period_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_fiscal_year boolean
)
RETURNS TABLE (entries json, audit json, audit_outside json, rattelse json)
LANGUAGE plpgsql
STABLE
SET search_path TO ''
SET plan_cache_mode TO 'force_custom_plan'
AS $$
DECLARE
  v_logged_before boolean := false;
  v_logged_after boolean := false;
  v_audit json;
  v_audit_outside json := '[]';
  v_created_inside uuid[];
  v_reversal_refs text[];
  v_guard_states jsonb[];
  v_rattelse json;
  v_rattelse_refs text[];
  v_entry_refs text[] := '{}';
  v_entries json;
BEGIN
  SELECT coalesce(json_agg(a), '[]'::json),
         array_agg(a.new_state->>'reversed_by_id')
           FILTER (WHERE a.action = 'REVERSE' AND a.table_name = 'journal_entries'),
         array_agg(a.new_state) FILTER (WHERE a.action = 'GUARD_BYPASSED')
    INTO v_audit, v_reversal_refs, v_guard_states
    FROM public.audit_log a
   WHERE a.company_id = p_company_id
     AND a.created_at >= p_from
     AND a.created_at <= p_to
     AND (a.table_name = ANY (ARRAY[
            'journal_entries', 'chart_of_accounts', 'company_settings', 'fiscal_periods',
            'api_keys', 'dimensions', 'dimension_values', 'account_dimension_rules',
            'accrual_schedules', 'document_attachments', 'mapping_rules',
            'categorization_templates', 'booking_template_library', 'sie_imports',
            'sie_import_chunks', 'bank_file_imports', 'cash_accounts',
            'invoice_payee_defaults', 'mail_connections', 'collection_connections',
            'service_accounts', 'company_capability_config', 'company_grants',
            'company_grant_settings', 'company_attest_policies', 'company_attest_limits',
            'booking_review_rules', 'employees'])
          OR a.action = ANY (ARRAY[
            'SECURITY_EVENT', 'INTEGRITY_FAILURE', 'RETENTION_BLOCK',
            'DOCUMENT_DELETE_BLOCKED', 'GUARD_BYPASSED']))
     AND NOT coalesce(
           (a.table_name = 'journal_entries' AND a.action IN ('INSERT', 'COMMIT'))
           OR (a.table_name = 'journal_entries' AND a.action = 'UPDATE'
               AND coalesce(a.old_state->>'status', '') NOT IN ('posted', 'reversed')
               AND coalesce(a.new_state->>'status', '') NOT IN ('posted', 'reversed'))
           OR (a.table_name = 'document_attachments' AND a.action IN ('INSERT', 'UPDATE')),
           false);

  -- Fiscal-year mode, outside the window: rows about the period's verifikat
  -- (a storno or bokslut after year end), bypassed guards naming one (dated
  -- when overridden, which can be after year end), and the receipts of the
  -- SIE chunks that imported them (an older year can be imported today). The
  -- three can meet on a row, so they are made distinct.
  IF p_fiscal_year THEN
    v_logged_before := EXISTS (
      SELECT 1 FROM public.audit_log b WHERE b.company_id = p_company_id AND b.created_at < p_from);
    v_logged_after := EXISTS (
      SELECT 1 FROM public.audit_log b WHERE b.company_id = p_company_id AND b.created_at > p_to);
    IF v_logged_before THEN
      SELECT array_agg(a.record_id)
        INTO v_created_inside
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.created_at >= p_from + interval '1 day'
         AND a.created_at <= p_to
         AND a.table_name = 'journal_entries'
         AND a.action = 'INSERT';
    END IF;

    WITH period_entries AS MATERIALIZED (
      SELECT e.id, e.import_batch_id,
             NOT EXISTS (
               SELECT 1 FROM unnest(coalesce(v_created_inside, '{}'::uuid[])) AS c(id) WHERE c.id = e.id
             ) AS may_predate_window
        FROM public.journal_entries e
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = p_period_id
    ),
    outside_window AS (
      SELECT a.*
        FROM period_entries pe
       CROSS JOIN LATERAL (
         SELECT a.*
           FROM public.audit_log a
          WHERE a.table_name = 'journal_entries'
            AND a.record_id = pe.id
            AND a.company_id = p_company_id
            AND (a.created_at < p_from OR a.created_at > p_to)
            AND NOT coalesce(
                  a.action IN ('INSERT', 'COMMIT')
                  OR (a.action = 'UPDATE'
                      AND coalesce(a.old_state->>'status', '') NOT IN ('posted', 'reversed')
                      AND coalesce(a.new_state->>'status', '') NOT IN ('posted', 'reversed')),
                  false)
       ) a
       WHERE v_logged_after OR (v_logged_before AND pe.may_predate_window)
      UNION ALL
      SELECT a.*
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.action = 'GUARD_BYPASSED'
         AND (a.created_at < p_from OR a.created_at > p_to)
         AND a.new_state->>'journal_entry_id' IN (SELECT pe.id::text FROM period_entries pe)
      UNION ALL
      SELECT a.*
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.table_name = 'sie_import_chunks'
         AND (a.created_at < p_from OR a.created_at > p_to)
         AND a.new_state->>'import_id' IN (
               SELECT pe.import_batch_id::text FROM period_entries pe WHERE pe.import_batch_id IS NOT NULL)
    )
    SELECT coalesce(json_agg(o), '[]'::json)
      INTO v_audit_outside
      FROM (SELECT DISTINCT ON (w.id) w.* FROM outside_window w ORDER BY w.id) o;
  END IF;

  SELECT coalesce(json_agg(r), '[]'::json), array_agg(r.journal_entry_id::text)
    INTO v_rattelse, v_rattelse_refs
    FROM public.journal_entry_rattelse_log r
   WHERE r.company_id = p_company_id
     AND ((r.created_at >= p_from AND r.created_at <= p_to)
          OR (p_fiscal_year AND r.journal_entry_id IN (
                SELECT e.id FROM public.journal_entries e
                 WHERE e.company_id = p_company_id
                   AND e.fiscal_period_id = p_period_id)));

  IF NOT p_fiscal_year THEN
    v_entry_refs := coalesce(v_reversal_refs, '{}') || coalesce(v_rattelse_refs, '{}') || ARRAY(
      SELECT s->>'journal_entry_id'
        FROM unnest(coalesce(v_guard_states, '{}')) s
      UNION ALL
      SELECT c->>'journal_entry_id'
        FROM unnest(coalesce(v_guard_states, '{}')) s
       CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(s->'candidates') = 'array' THEN s->'candidates' ELSE '[]'::jsonb END) c
       WHERE jsonb_typeof(c) = 'object'
    );
  END IF;

  SELECT coalesce(json_agg(t), '[]'::json)
    INTO v_entries
    FROM (
      SELECT e.id, e.voucher_series, e.voucher_number, e.entry_date, e.description, e.source_type,
             e.status, e.committed_at, e.user_id, e.committed_actor_type, e.committed_actor_label,
             e.commit_method, e.reverses_id, e.correction_of_id, e.import_batch_id,
             e.committed_auth_role, e.committed_auth_uid
        FROM public.journal_entries e
       WHERE e.company_id = p_company_id
         AND e.fiscal_period_id = p_period_id
         AND (p_fiscal_year
              OR (e.committed_at >= p_from AND e.committed_at < p_to + interval '1 millisecond')
              OR e.id::text = ANY (v_entry_refs))
    ) t;

  RETURN QUERY SELECT v_entries, v_audit, v_audit_outside, v_rattelse;
END;
$$;

REVOKE ALL ON FUNCTION public.behandlingshistorik_sources(uuid, uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.behandlingshistorik_sources(uuid, uuid, timestamptz, timestamptz, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
