-- Behandlingshistorik for skattekonto links and ignores (accounted#50, PH 171).
--
-- Why
--
-- A skattekonto row (public.skattekonto_transactions, the mirror of
-- Skatteverket's tax account) is settled in the books by its link,
-- journal_entry_id: Koppla points it at an existing verifikat, Bokför claims
-- it for the verifikat it just created, and a row that will never be booked
-- (history from before the company's first fiscal year) is set aside with
-- is_ignored. Those two columns decide what the skattekonto reconciliation
-- calls explained and what it calls open, so changing them is a step in the
-- processing of the books that BFL 5 kap 11 § and BFNAR 2013:2 p. 9.16 ask
-- the behandlingshistorik to show with who and when. Until now nothing
-- recorded it: the table had only the updated_at and writer-role triggers,
-- and an unlink or an ignore left no trace at all.
--
-- What is logged
--
-- One audit_log row per row whose link or ignored state changes, through the
-- existing public.write_audit_log() (actor resolution 20261031202000: the
-- session's user, else the person a service-role request acts for via the
-- x-accounted-actor header, the credential the request names). The trigger's
-- WHEN clause is the whole filter:
--
--   * journal_entry_id changes: link (NULL -> verifikat), unlink (verifikat
--     -> NULL), including the ON DELETE SET NULL a deleted draft verifikat
--     performs, which runs as the person who deleted it;
--   * is_ignored changes: ignore and restore.
--
-- Nothing else writes a row. The Skatteverket sync upserts every fetched row
-- on each run (status, amounts, texts, dates) and rewrites the proposal
-- columns (suggested_journal_entry_id, suggested_at); none of those is a link
-- or an ignore, and logging them would flood the log with the mirror's own
-- churn. INSERT is not logged either: the sync and the file import never
-- insert a row linked or ignored, and the row's arrival is Skatteverket's
-- event, not a step in the books. Rows are never deleted but by a company
-- teardown cascade.
--
-- write_audit_log() stores the whole row, old and new. A skattekonto row
-- holds Skatteverket's own data about the company (date, text, amount,
-- transaction id) and no personal data beyond what the company's own ledger
-- holds, so nothing is filtered out. It has no user_id column, so a write
-- that names nobody (a background job, a direct connection) is logged with
-- user_id NULL and the request's credential if it names one, which audit_log
-- allows since 20260330130000.
--
-- Record only: the trigger is AFTER UPDATE, returns NEW unchanged, and adds
-- no refusal. Matching, linking, ignoring and the sync behave exactly as
-- before. The sandbox teardown flag skips it inside write_audit_log().
--
-- behandlingshistorik_sources is restated from 20261101003400 unchanged but
-- for 'skattekonto_transactions' in the audited tables (AUDITED_TABLES in
-- src/lib/reports/behandlingshistorik.ts, which renders the rows).
--
-- Nothing here touches the migration 017 triggers, posted entries or their
-- lines. The app code is live a few minutes before this runs: until then
-- there are simply no skattekonto rows to render.
--
-- pg-test: tests/pg/skattekonto-link-audit.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. The trigger: link and ignore changes only
-- =============================================================================

DROP TRIGGER IF EXISTS audit_skattekonto_transactions_link ON public.skattekonto_transactions;
CREATE TRIGGER audit_skattekonto_transactions_link
  AFTER UPDATE ON public.skattekonto_transactions
  FOR EACH ROW
  WHEN (OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id
        OR OLD.is_ignored IS DISTINCT FROM NEW.is_ignored)
  EXECUTE FUNCTION public.write_audit_log();

COMMENT ON TRIGGER audit_skattekonto_transactions_link ON public.skattekonto_transactions IS
  'Behandlingshistorik (accounted#50): who linked, unlinked, ignored or restored a skattekonto row, and when. Fires only when journal_entry_id or is_ignored changes; the sync''s own updates write nothing.';

-- =============================================================================
-- 2. behandlingshistorik_sources: skattekonto_transactions is audited
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
            'booking_review_rules', 'employees', 'skattekonto_transactions'])
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
