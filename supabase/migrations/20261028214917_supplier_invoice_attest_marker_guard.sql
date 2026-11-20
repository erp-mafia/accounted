-- Attest of supplier invoices: only the attest service sets the marker (#124).
--
-- supplier_invoices.approved_at is the attest marker: with an attest policy
-- on, payments leave an invoice out until it is set (loadAttestBlockedInvoiceIds,
-- read by the payment file and bank payment paths). When it may be set is
-- decided in one place, src/lib/supplier-invoices/attest-policy.ts, applied by
-- attest-service.ts. But the supplier_invoices_update policy lets every
-- writing member update the whole row through PostgREST, and no trigger
-- looked at the marker, so a member could set approved_at (and approved_by)
-- directly and skip the policy: who attests, four eyes, any or all.
--
-- 1. guard_supplier_invoice_attest_marker: a signed-in session (authenticated)
--    or anon can no longer set, change or clear approved_at or approved_by, on
--    INSERT or UPDATE. The attest service writes the marker as the service
--    role once the rules said yes, from every door: the dashboard, v1, the
--    approved agent operation and the mail's link. A SECURITY DEFINER
--    function runs as its owner and passes: none writes the marker today, and
--    one that does is reviewed SQL. A write that leaves both columns as they
--    are (an edit, a status flip) never reaches the check.
-- 2. audit_company_attest_policies: the policy decides who controls
--    payments. Every save that changes a rule is logged to audit_log, and
--    behandlingshistorik reads it (behandlingshistorik_sources, section 4).
-- 3. supplier_invoice_attestations.user_id: RESTRICT instead of CASCADE.
--    Accounts are never deleted (erasure keeps the auth.users row as a
--    tombstone), so the cascade never fired; RESTRICT makes that a
--    constraint for the attest trail, as account_reconciliations.signed_by
--    already is. Sandbox teardown deletes the company's supplier invoices,
--    and with them their attestations, before it deletes the account.
-- 4. behandlingshistorik_sources: the function of 20261023094050, unchanged
--    but for company_attest_policies in the audited tables
--    (AUDITED_TABLES in src/lib/reports/behandlingshistorik.ts).
--
-- pg-test: tests/pg/supplier-invoice-attest-marker.pg.test.ts

-- 1. The marker -----------------------------------------------------------------
--
-- SECURITY INVOKER on purpose: current_user is the role that wrote the row
-- (inside a definer function, its owner). The trigger fires whatever EXECUTE
-- grants say, so nobody needs to call the function directly.
CREATE OR REPLACE FUNCTION public.guard_supplier_invoice_attest_marker()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'Attesten sätts bara när fakturan attesteras (Attestera på fakturan, API:t eller ett godkänt agentförslag).'
      USING ERRCODE = '42501',
            DETAIL = format('supplier invoice %s: approved_at and approved_by are written by the attest service only', NEW.id),
            HINT = 'POST /api/supplier-invoices/{id}/approve, POST /api/v1/companies/{companyId}/supplier-invoices/{id}/approve or gnubok_approve_supplier_invoice.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_supplier_invoice_attest_marker() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.guard_supplier_invoice_attest_marker() IS
  'Refuses a session (authenticated, anon) that sets, changes or clears supplier_invoices.approved_at or approved_by: the attest marker payments read is written by the attest service (service role) after the attest policy said yes.';

CREATE TRIGGER guard_supplier_invoice_attest_marker_insert
  BEFORE INSERT ON public.supplier_invoices
  FOR EACH ROW
  WHEN (NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL)
  EXECUTE FUNCTION public.guard_supplier_invoice_attest_marker();

CREATE TRIGGER guard_supplier_invoice_attest_marker_update
  BEFORE UPDATE OF approved_at, approved_by ON public.supplier_invoices
  FOR EACH ROW
  WHEN (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by)
  EXECUTE FUNCTION public.guard_supplier_invoice_attest_marker();

COMMENT ON COLUMN public.supplier_invoices.approved_at IS
  'The attest marker: when the invoice was attested (with an attest policy, when the policy was satisfied). Set by the attest service only (guard_supplier_invoice_attest_marker); payments read it.';

-- 2. Policy changes in audit_log --------------------------------------------------
--
-- write_audit_log() cannot serve this table: it keys the row by NEW.id, and
-- the policy's key is company_id. The person is the session's user, who
-- cannot name someone else; a service-role save (v1, an approved operation)
-- has none and names the key's owner in updated_by.
CREATE OR REPLACE FUNCTION public.audit_company_attest_policies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := coalesce(auth.uid(), NEW.updated_by);
BEGIN
  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, NEW.company_id, TG_OP, TG_TABLE_NAME, NEW.company_id, v_user_id,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END, to_jsonb(NEW),
    CASE WHEN TG_OP = 'INSERT' THEN 'Created attest policy' ELSE 'Updated attest policy' END,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_company_attest_policies() FROM PUBLIC, anon;

CREATE TRIGGER audit_company_attest_policies_insert
  AFTER INSERT ON public.company_attest_policies
  FOR EACH ROW EXECUTE FUNCTION public.audit_company_attest_policies();

-- A save that changes no rule (the settings page saves the whole row) is not a change.
CREATE TRIGGER audit_company_attest_policies_update
  AFTER UPDATE ON public.company_attest_policies
  FOR EACH ROW
  WHEN (
    OLD.enabled IS DISTINCT FROM NEW.enabled
    OR OLD.threshold_amount IS DISTINCT FROM NEW.threshold_amount
    OR OLD.mode IS DISTINCT FROM NEW.mode
    OR OLD.attesters IS DISTINCT FROM NEW.attesters
    OR OLD.preparer_may_attest IS DISTINCT FROM NEW.preparer_may_attest
  )
  EXECUTE FUNCTION public.audit_company_attest_policies();

-- 3. The attest trail outlives its attester ---------------------------------------
ALTER TABLE public.supplier_invoice_attestations
  DROP CONSTRAINT supplier_invoice_attestations_user_id_fkey;
ALTER TABLE public.supplier_invoice_attestations
  ADD CONSTRAINT supplier_invoice_attestations_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.supplier_invoice_attestations.user_id IS
  'The attester. RESTRICT: the company keeps the record of who attested or rejected, so the account cannot be deleted from under it (accounts are erased as tombstones, never deleted).';

-- 4. behandlingshistorik reads the policy changes ---------------------------------
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
            'company_grant_settings', 'company_attest_policies'])
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
