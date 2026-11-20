-- Behandlingshistorik (BFL 5 kap. 11 §, BFNAR 2013:2 p. 9.16): the report's
-- source rows, one statement per question.
--
-- The report read journal_entries, audit_log, journal_entry_rattelse_log and
-- suggestion_log through PostgREST, 1 000 rows per request with offset paging
-- (page k re-read the k pages before it), and in fiscal-year mode sent every
-- one of the period's voucher ids back in .in() lists of 200: once each for
-- the audit rows, the bypassed guards, the rättelser and the decisions. A
-- 50 000-verifikat year was over 1 000 round trips, and the decisions list
-- (suggestion_log, with its long select list) crossed the API gateway's 8 KB
-- request line at about 198 ids: 414 URI Too Long, so the report failed for
-- every fiscal year with more than about 200 verifikat. The joins now happen
-- here, and nothing in the request grows with the company.
--
-- Both functions are SECURITY INVOKER: RLS scopes a signed-in caller exactly
-- as the direct reads did, and every predicate names the company, so a
-- service-role caller (API key, MCP) is scoped by its arguments. Read-only,
-- one snapshot per call. plan_cache_mode = force_custom_plan: the windows and
-- the fiscal-year flag decide the plan, so each call plans with its values.
--
-- Semantics are the TypeScript reader's (src/lib/reports/behandlingshistorik.ts),
-- unchanged:
--   * window: p_from .. p_to inclusive (the report's
--     '<from>T00:00:00.000Z' .. '<to>T23:59:59.999Z').
--   * audit rows: every row of the company logged inside the window whose
--     table is one of AUDITED_TABLES or whose action is one of GLOBAL_ACTIONS;
--     in fiscal-year mode also, whenever logged, the journal_entries rows
--     about the period's verifikat, the GUARD_BYPASSED rows naming one, and
--     the sie_import_chunks receipts of the imports that wrote them.
--   * rättelser: logged inside the window, plus in fiscal-year mode every one
--     on the period's verifikat.
--   * decisions: registered inside the window, plus in fiscal-year mode every
--     one that booked one of the period's verifikat, with the vouchers and
--     staged operations their receipts read (loadReceiptContext).

-- ── 1. Ledger history: verifikat, audit rows, rättelser ─────────────────────
--
-- One row of JSON arrays: entries with the columns the report reads; audit
-- rows whole (select *), those logged inside the window in audit and, in
-- fiscal-year mode, those logged outside it in audit_outside (disjoint by
-- created_at); rättelse rows whole. A row of json columns, not one json value:
-- PostgREST wraps a scalar result in json_agg(...)->0, which parses the whole
-- document again (tens of MB for a large year).
--
-- Left out, because no event can come from them (auditRowToEvent returns
-- null; src/lib/reports/__tests__/behandlingshistorik.test.ts pins each class
-- to that): journal_entries INSERT and COMMIT, journal_entries UPDATE with
-- neither state posted or reversed (a draft being edited), and
-- document_attachments INSERT and UPDATE. They are most of the log (two
-- full-row snapshots per verifikat, one per underlag) and were read and
-- thrown away on every request.
--
-- entries: fiscal-year mode, every verifikat of the period. Date-range mode,
-- the ones committed inside the window (the reader re-checks at millisecond
-- precision) plus the ones the window's rows look up by id: the verifikat a
-- rättelse corrected, the storno a REVERSE row names, and the vouchers a
-- bypassed guard names.
--
-- Rows about the period's verifikat logged outside the window are looked up
-- per verifikat in the (table_name, record_id) index, and only where they can
-- exist. After the window: once the company has logged anything after it,
-- which a current year never has. Before the window: once the company has
-- logged anything before it, and then not for a verifikat whose INSERT row
-- (written by the audit trigger in the transaction that created it, and
-- immutable) lies inside the window a day or more after it opens: no row
-- about a verifikat precedes its creation, and the day absorbs a transaction
-- that started before midnight.
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
            'company_grant_settings'])
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

-- ── 2. Decisions and what their receipts read ───────────────────────────────
--
-- One row of JSON arrays, the inputs of buildDecisionReceipts
-- (src/lib/suggestion-log/receipts.ts):
--   rows: the suggestion_log rows, with the columns the receipt reads;
--   entries: the vouchers the rows booked (final.journal_entry_id);
--   operations: the staged operations the rows name (pending_operation_id);
--   legacy_by_entry / legacy_by_registration: for rows that name none, the
--     committed operations whose result named the booked voucher as
--     journal_entry_id / registration_journal_entry_id.
CREATE OR REPLACE FUNCTION public.behandlingshistorik_decisions(
  p_company_id uuid,
  p_period_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_fiscal_year boolean
)
RETURNS TABLE (
  rows json,
  entries json,
  operations json,
  legacy_by_entry json,
  legacy_by_registration json
)
LANGUAGE plpgsql
STABLE
SET search_path TO ''
SET plan_cache_mode TO 'force_custom_plan'
AS $$
BEGIN
  RETURN QUERY
  WITH decision_rows AS MATERIALIZED (
    SELECT s.id, s.kind, s.transaction_id, s.inbox_item_id, s.document_id, s.suggestions,
           s.acted_on, s.final, s.outcome, s.actor_type, s.resolved_by, s.created_at,
           s.rule_version, s.policy_version, s.input_hash, s.checks, s.confidence_band,
           s.pending_operation_id
      FROM public.suggestion_log s
     WHERE s.company_id = p_company_id
       AND ((s.created_at >= p_from AND s.created_at <= p_to)
            OR (p_fiscal_year AND s.final->>'journal_entry_id' IN (
                  SELECT e.id::text FROM public.journal_entries e
                   WHERE e.company_id = p_company_id
                     AND e.fiscal_period_id = p_period_id)))
  ),
  -- bookedEntryId(): final is an object whose journal_entry_id is a non-empty
  -- string. legacy: the row names no staged operation.
  booked AS MATERIALIZED (
    SELECT DISTINCT d.final->>'journal_entry_id' AS entry_id, d.pending_operation_id IS NULL AS legacy
      FROM decision_rows d
     WHERE jsonb_typeof(d.final) = 'object'
       AND jsonb_typeof(d.final->'journal_entry_id') = 'string'
       AND d.final->>'journal_entry_id' <> ''
  ),
  company_operations AS NOT MATERIALIZED (
    SELECT po.id, po.operation_type, po.actor_type, po.actor_id, po.actor_label, po.risk_level,
           po.agent_metadata, po.created_at, po.resolved_at, po.status,
           po.result_data->>'journal_entry_id' AS journal_entry_id,
           po.result_data->>'registration_journal_entry_id' AS registration_journal_entry_id
      FROM public.pending_operations po
     WHERE po.company_id = p_company_id
  )
  SELECT
    (SELECT coalesce(json_agg(d), '[]'::json) FROM decision_rows d),
    (
      SELECT coalesce(json_agg(t), '[]'::json)
        FROM (
          SELECT e.id, e.voucher_series, e.voucher_number, e.status, e.committed_actor_type,
                 e.committed_actor_label, e.commit_method
            FROM public.journal_entries e
           WHERE e.company_id = p_company_id
             -- The reader looks vouchers up by the string it holds, and the
             -- ids it gets back are canonical: no other string can match.
             AND e.id IN (
                   SELECT b.entry_id::uuid FROM booked b
                    WHERE b.entry_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        ) t),
    (
      SELECT coalesce(json_agg(t), '[]'::json)
        FROM (
          SELECT o.id, o.operation_type, o.actor_type, o.actor_id, o.actor_label, o.risk_level,
                 o.agent_metadata, o.created_at, o.resolved_at, o.journal_entry_id,
                 o.registration_journal_entry_id
            FROM company_operations o
           WHERE o.id IN (SELECT d.pending_operation_id FROM decision_rows d WHERE d.pending_operation_id IS NOT NULL)
        ) t),
    (
      SELECT coalesce(json_agg(t), '[]'::json)
        FROM (
          SELECT o.id, o.operation_type, o.actor_type, o.actor_id, o.actor_label, o.risk_level,
                 o.agent_metadata, o.created_at, o.resolved_at, o.journal_entry_id,
                 o.registration_journal_entry_id
            FROM company_operations o
           WHERE o.status = 'committed'
             AND o.journal_entry_id IN (SELECT b.entry_id FROM booked b WHERE b.legacy)
           ORDER BY o.id
        ) t),
    (
      SELECT coalesce(json_agg(t), '[]'::json)
        FROM (
          SELECT o.id, o.operation_type, o.actor_type, o.actor_id, o.actor_label, o.risk_level,
                 o.agent_metadata, o.created_at, o.resolved_at, o.journal_entry_id,
                 o.registration_journal_entry_id
            FROM company_operations o
           WHERE o.status = 'committed'
             AND o.registration_journal_entry_id IN (SELECT b.entry_id FROM booked b WHERE b.legacy)
           ORDER BY o.id
        ) t);
END;
$$;

REVOKE ALL ON FUNCTION public.behandlingshistorik_decisions(uuid, uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.behandlingshistorik_decisions(uuid, uuid, timestamptz, timestamptz, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
