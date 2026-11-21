-- Behandlingshistorik for bank-anchor moves (#2407).
--
-- Why
--
-- A bank row (public.transactions) is booked through two anchors: the
-- pointer transactions.journal_entry_id and the junction
-- public.transaction_voucher_links (role, allocated_amount). Three paths move
-- those anchors between verifikat after the booking:
--
--   * a correction (relinkTransactionsToEntry in
--     src/lib/core/bookkeeping/storno-service.ts) moves both from the
--     original to the correction;
--   * delete_last_voucher on a correction moves them back to the original,
--     and drops a junction row the original already holds for the same bank
--     row;
--   * a storno releases them (release_reversed_entry_transactions and the
--     engine's junction cleanup).
--
-- None of them left a trace. The verifikat chain itself is logged
-- (reverses_id, correction_of_id, the delete snapshot), but not why a bank
-- row's booking changed verifikat, which BFNAR 2013:2 p. 9.16 asks the
-- behandlingshistorik to show with who and when.
--
-- What is logged
--
-- One audit_log row per anchor that changes, through the existing
-- public.write_audit_log() (actor resolved like every other row,
-- 20261031202000), so every path is covered, today's three and any later
-- one:
--
--   * transactions: journal_entry_id changes FROM a verifikat, to another
--     one or to NULL (moved, released). A first booking (NULL -> verifikat)
--     is not logged: the verifikat it creates is the record of it.
--   * transaction_voucher_links: journal_entry_id changes (moved), and a row
--     is deleted (released, or the duplicate delete_last_voucher drops, with
--     its role and allocated_amount in old_state). INSERT is the booking
--     itself and is not logged.
--
-- What a row keeps: a link row is small and kept whole (transaction_id,
-- journal_entry_id, role, allocated_amount). A bank row is cut to the
-- columns that name it and its booking (id, date, description, amount,
-- currency, cash account, journal_entry_id): write_audit_log is restated
-- from 20261031202000 with that one branch, the way it already strips a
-- person's org number from parties. The counterparty's org number (a
-- personnummer for an individual), IBAN, account and the enrichment payload
-- never enter audit_log, which cannot be erased.
--
-- Record only: AFTER triggers, return unchanged, no refusal. Booking,
-- correction, storno and delete behave exactly as before. The sandbox
-- teardown flag skips them inside write_audit_log().
--
-- behandlingshistorik_sources is restated from 20261108180000 unchanged but
-- for 'transactions' and 'transaction_voucher_links' in the audited tables
-- (AUDITED_TABLES in src/lib/reports/behandlingshistorik.ts, which renders
-- the rows).
--
-- Nothing here touches the migration 017 triggers, posted entries or their
-- lines.
--
-- pg-test: tests/pg/bank-anchor-audit.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. The triggers: anchor moves and releases only
-- =============================================================================

DROP TRIGGER IF EXISTS audit_transactions_anchor ON public.transactions;
CREATE TRIGGER audit_transactions_anchor
  AFTER UPDATE OF journal_entry_id ON public.transactions
  FOR EACH ROW
  WHEN (OLD.journal_entry_id IS NOT NULL
        AND OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id)
  EXECUTE FUNCTION public.write_audit_log();

COMMENT ON TRIGGER audit_transactions_anchor ON public.transactions IS
  'Behandlingshistorik (#2407): a bank row''s booking moved to another verifikat or released. Fires only when journal_entry_id leaves a verifikat; a first booking writes nothing.';

DROP TRIGGER IF EXISTS audit_transaction_voucher_links_moved ON public.transaction_voucher_links;
CREATE TRIGGER audit_transaction_voucher_links_moved
  AFTER UPDATE OF journal_entry_id ON public.transaction_voucher_links
  FOR EACH ROW
  WHEN (OLD.journal_entry_id IS DISTINCT FROM NEW.journal_entry_id)
  EXECUTE FUNCTION public.write_audit_log();

COMMENT ON TRIGGER audit_transaction_voucher_links_moved ON public.transaction_voucher_links IS
  'Behandlingshistorik (#2407): a bank row''s link moved to another verifikat (correction, delete of a correction).';

DROP TRIGGER IF EXISTS audit_transaction_voucher_links_removed ON public.transaction_voucher_links;
CREATE TRIGGER audit_transaction_voucher_links_removed
  AFTER DELETE ON public.transaction_voucher_links
  FOR EACH ROW
  EXECUTE FUNCTION public.write_audit_log();

COMMENT ON TRIGGER audit_transaction_voucher_links_removed ON public.transaction_voucher_links IS
  'Behandlingshistorik (#2407): a bank row''s link removed (storno release, a duplicate dropped by delete_last_voucher, a deleted verifikat), with its role and allocated_amount.';

-- =============================================================================
-- 2. write_audit_log: a bank row keeps only the columns that name it
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

  -- A bank row whose booking moved (audit_transactions_anchor, #2407): the
  -- trail keeps what names the row and its booking, never the
  -- counterparty's identity (org number, which is a personnummer for an
  -- individual, IBAN, account) or the enrichment payload. audit_log cannot
  -- be erased, so a column that is not on this list never enters it.
  IF TG_TABLE_NAME = 'transactions' THEN
    SELECT jsonb_object_agg(e.key, e.value) INTO v_old_state
      FROM jsonb_each(v_old_state) e
     WHERE e.key = ANY (ARRAY['id', 'company_id', 'user_id', 'cash_account_id', 'date',
                              'description', 'amount', 'currency', 'journal_entry_id']);
    SELECT jsonb_object_agg(e.key, e.value) INTO v_new_state
      FROM jsonb_each(v_new_state) e
     WHERE e.key = ANY (ARRAY['id', 'company_id', 'user_id', 'cash_account_id', 'date',
                              'description', 'amount', 'currency', 'journal_entry_id']);
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
-- 3. behandlingshistorik_sources: the bank anchors are audited
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
            'booking_review_rules', 'employees', 'skattekonto_transactions',
            'contract_revenue_settings', 'company_attest_substitutes', 'transactions',
            'transaction_voucher_links'])
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
