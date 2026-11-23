-- behandlingshistorik_sources: the window's audit rows read with the table
-- list as an index condition (follows 20261123091600 and 20261123091700).
--
-- Why
--
-- The window read kept the rows of the audited tables or of the global
-- actions in one condition: table_name = ANY (...) OR action = ANY (...).
-- 20261123091600 gave it idx_audit_log_history_window, which leaves out the
-- rows the read drops. A month is read through a BitmapOr of that index (the
-- table list) and the action index. For a whole year of a large company the
-- planner can choose a plain index scan of the same index instead, and an OR
-- across two columns is no index condition for it: only the company and the
-- dates are, so every row the company logged that year in tables the report
-- never reads is fetched and dropped. For a company whose other tables are
-- busy, that read passed the statement timeout PostgREST runs the call under.
--
-- What changes
--
-- The read is split into two parts that never share a row and together keep
-- exactly the rows the one condition kept:
--
--   * the audited tables' rows whose action is not a global one, with the
--     table list as its own condition, which PostgreSQL 17 (production) makes
--     an index condition in a plain index scan as in a bitmap one;
--   * the global actions' rows, on any table or none, as before.
--
-- A row of an audited table with a global action is in the second part only.
-- action is NOT NULL, so "<> ALL" is the exact complement of "= ANY". The
-- first part carries the exclusion word for word, the predicate of
-- idx_audit_log_history_window. The second part reads without it: each of
-- its cases names an INSERT, COMMIT or UPDATE, never a global action, so it
-- dropped none of those rows. Without it the second part cannot use that
-- index, and the planner reads the global actions through
-- idx_audit_log_action, as the one condition's other arm did. The rows the
-- function returns are the same; their order in the audit array follows the
-- plan, as it always did (the report orders its events itself, pinned in
-- src/lib/reports/__tests__/behandlingshistorik.test.ts).
--
-- The rest of the function is restated from 20261121150000 unchanged.
--
-- pg-test: tests/pg/behandlingshistorik-sources.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

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
  -- The window's rows, read in two parts that never share a row: the audited
  -- tables' rows other than the global actions, then the global actions on
  -- any table. Apart, the table list is an index condition in a plain index
  -- scan too (20261123104000); inside one OR with the actions it was one only
  -- in a bitmap plan. The first part carries the exclusion word for word, the
  -- predicate of idx_audit_log_history_window (20261123091600); it never
  -- matches a global action, so the second part reads without it.
  SELECT coalesce(json_agg(a), '[]'::json),
         array_agg(a.new_state->>'reversed_by_id')
           FILTER (WHERE a.action = 'REVERSE' AND a.table_name = 'journal_entries'),
         array_agg(a.new_state) FILTER (WHERE a.action = 'GUARD_BYPASSED')
    INTO v_audit, v_reversal_refs, v_guard_states
    FROM (
      SELECT a.*
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.created_at >= p_from
         AND a.created_at <= p_to
         AND a.table_name = ANY (ARRAY[
               'journal_entries', 'chart_of_accounts', 'company_settings', 'fiscal_periods',
               'api_keys', 'dimensions', 'dimension_values', 'account_dimension_rules',
               'accrual_schedules', 'document_attachments', 'mapping_rules',
               'categorization_templates', 'booking_template_library', 'sie_imports',
               'sie_import_chunks', 'bank_file_imports', 'cash_accounts',
               'invoice_payee_defaults', 'mail_connections', 'collection_connections',
               'service_accounts', 'company_capability_config', 'company_grants',
               'company_grant_settings', 'company_attest_policies', 'company_attest_limits',
               'booking_review_rules', 'employees', 'skattekonto_transactions',
               'contract_revenue_settings', 'company_attest_substitutes', 'transactions',
               'transaction_voucher_links'])
         AND a.action <> ALL (ARRAY[
               'SECURITY_EVENT', 'INTEGRITY_FAILURE', 'RETENTION_BLOCK',
               'DOCUMENT_DELETE_BLOCKED', 'GUARD_BYPASSED'])
         AND NOT coalesce(
               (a.table_name = 'journal_entries' AND a.action IN ('INSERT', 'COMMIT'))
               OR (a.table_name = 'journal_entries' AND a.action = 'UPDATE'
                   AND coalesce(a.old_state->>'status', '') NOT IN ('posted', 'reversed')
                   AND coalesce(a.new_state->>'status', '') NOT IN ('posted', 'reversed'))
               OR (a.table_name = 'document_attachments' AND a.action IN ('INSERT', 'UPDATE')),
               false)
      UNION ALL
      SELECT a.*
        FROM public.audit_log a
       WHERE a.company_id = p_company_id
         AND a.created_at >= p_from
         AND a.created_at <= p_to
         AND a.action = ANY (ARRAY[
               'SECURITY_EVENT', 'INTEGRITY_FAILURE', 'RETENTION_BLOCK',
               'DOCUMENT_DELETE_BLOCKED', 'GUARD_BYPASSED'])
    ) a;

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
