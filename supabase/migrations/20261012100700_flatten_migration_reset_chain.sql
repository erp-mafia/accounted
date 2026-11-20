-- Flatten the migration-reset chain to two functions.
--
-- Each change to the reset eligibility since 20260818084050 renamed the live
-- function to *_before_<version> and wrapped it, so one preview call ran
-- nine nested snapshot functions, and the reset ran a wrapper around the real
-- body. Four blockers raised by inner layers were filtered out again by an
-- outer one (journal_entries_exist, voucher_sequence_state_exists,
-- invoice_records_exist, non_import_committed_entries), and three layers each
-- re-summed authority_submission_detected out of the inner JSON. Reading what
-- the reset checks meant reading nine migrations in order.
--
-- This migration replaces both functions with one body each, under the
-- existing names, and drops the nine renamed layers (eight snapshot, one
-- reset). Behaviour is unchanged, including the order of the blockers array
-- (the preview renders it as is):
--
--   company_already_archived, migration_window_expired, sandbox_company,
--   locked_or_closed_periods, live_bank_connections,
--   imports_in_progress (counted; omitted while a durable SIE job runs),
--   active_integrations_or_schedules (Zettle and POS folded in when others
--   exist), background_work_in_progress, authority_submission_detected (sum
--   of all evidence sources), then three late appends kept from their
--   layers: active_integrations_or_schedules for a company whose only
--   integrations are Zettle (POS folded in) (20260909100400), a count-less
--   imports_in_progress for a durable SIE job or an import hold
--   (20260911165003), and active_integrations_or_schedules for a POS-only
--   company (20261011203600).
--
-- The reset body is the 20260920190800 restatement plus the Zettle row lock
-- the 20260909100400 wrapper took before delegating. The wrapper gated that
-- lock on the caller being an owner; the same gate is the pre-lock fast-fail
-- here, so the lock sits right after it and the lock order is unchanged:
-- zettle_connections, companies, then every child table.
--
-- The reset takes no POS lock: 20261011203600 left the reset alone because an
-- ended POS connection never goes live again.
--
-- CREATE OR REPLACE keeps owner, ACL, SECURITY DEFINER, search_path and
-- volatility; the grants are restated so the file stands alone. The snapshot
-- revoke includes service_role again, as 20260911165003 had it: the
-- 20261011203600 wrapper was a new function and kept the default service_role
-- EXECUTE. get_company_migration_reset_eligibility is not touched.
-- Pinned in tests/pg/company-migration-reset.pg.test.ts.

-- 1. Snapshot: one body under the existing name ----------------------------

CREATE OR REPLACE FUNCTION public.company_migration_reset_snapshot(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company                    public.companies%ROWTYPE;
  v_display_name               text;
  v_counts                     jsonb;
  v_blockers                   jsonb := '[]'::jsonb;
  v_locked_periods             integer;
  v_live_bank_connections      integer;
  v_incomplete_imports         integer;
  v_durable_import_running     boolean;
  v_active_automations         integer;
  v_zettle                     integer;
  v_pos                        integer;
  v_background_work            integer;
  v_authority_submissions      integer;
BEGIN
  SELECT * INTO v_company
  FROM public.companies
  WHERE id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'COMPANY_RESET_NOT_FOUND',
      'blockers', jsonb_build_array(jsonb_build_object('code', 'company_not_found'))
    );
  END IF;

  SELECT COALESCE(
    NULLIF(trim(cs.company_name), ''),
    NULLIF(trim(v_company.name), ''),
    v_company.id::text
  )
  INTO v_display_name
  FROM (SELECT 1) seed
  LEFT JOIN public.company_settings cs ON cs.company_id = p_company_id;

  -- Accounting records are retained, not disposed of: they are reported as
  -- counts and never decide eligibility.
  SELECT jsonb_build_object(
    'journal_entries', (SELECT count(*) FROM public.journal_entries WHERE company_id = p_company_id),
    'journal_entry_lines', (
      SELECT count(*)
      FROM public.journal_entry_lines line
      JOIN public.journal_entries entry ON entry.id = line.journal_entry_id
      WHERE entry.company_id = p_company_id
    ),
    'committed_import_entries', (
      SELECT count(*)
      FROM public.journal_entries
      WHERE company_id = p_company_id
        AND status IN ('posted', 'reversed')
        AND source_type IN ('import', 'opening_balance')
    ),
    'transactions', (SELECT count(*) FROM public.transactions WHERE company_id = p_company_id),
    'fiscal_periods', (SELECT count(*) FROM public.fiscal_periods WHERE company_id = p_company_id),
    'documents', (SELECT count(*) FROM public.document_attachments WHERE company_id = p_company_id),
    'voucher_sequences', (SELECT count(*) FROM public.voucher_sequences WHERE company_id = p_company_id),
    'sie_imports', (SELECT count(*) FROM public.sie_imports WHERE company_id = p_company_id),
    'bank_file_imports', (SELECT count(*) FROM public.bank_file_imports WHERE company_id = p_company_id),
    'skattekonto_file_imports', (SELECT count(*) FROM public.skattekonto_file_imports WHERE company_id = p_company_id),
    'customers', (SELECT count(*) FROM public.customers WHERE company_id = p_company_id),
    'suppliers', (SELECT count(*) FROM public.suppliers WHERE company_id = p_company_id),
    'invoices', (SELECT count(*) FROM public.invoices WHERE company_id = p_company_id),
    'supplier_invoices', (SELECT count(*) FROM public.supplier_invoices WHERE company_id = p_company_id),
    'bank_connections', (SELECT count(*) FROM public.bank_connections WHERE company_id = p_company_id)
  ) INTO v_counts;

  IF v_company.archived_at IS NOT NULL THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'company_already_archived',
      'count', 1
    ));
  END IF;

  -- Self-service is a short migration-recovery window, not a general ledger
  -- restart. Older companies require support and a case-specific review.
  IF v_company.created_at < now() - interval '30 days' THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'migration_window_expired',
      'count', 1
    ));
  END IF;

  -- Sandbox companies have a separate short-lived cleanup lifecycle and must
  -- never be converted into retained legal archives by this product flow.
  IF EXISTS (
    SELECT 1
    FROM public.company_settings
    WHERE company_id = p_company_id
      AND is_sandbox = true
  ) THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'sandbox_company',
      'count', 1
    ));
  END IF;

  SELECT
    (SELECT count(*)
     FROM public.fiscal_periods
     WHERE company_id = p_company_id
       AND (is_closed = true OR locked_at IS NOT NULL OR closed_externally = true))
    +
    (SELECT count(*)
     FROM public.company_settings
     WHERE company_id = p_company_id
       AND bookkeeping_locked_through IS NOT NULL)
  INTO v_locked_periods;

  IF v_locked_periods > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'locked_or_closed_periods',
      'count', v_locked_periods
    ));
  END IF;

  -- A live PSD2 connection can be selected by the service-role sync cron and
  -- import transactions without an interactive company session. Require the
  -- owner to disconnect it before reset so the retained source stays static.
  SELECT count(*) INTO v_live_bank_connections
  FROM public.bank_connections
  WHERE company_id = p_company_id
    AND status IN ('pending', 'pending_selection', 'active');

  IF v_live_bank_connections > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'live_bank_connections',
      'count', v_live_bank_connections
    ));
  END IF;

  -- Never archive while an import can still finalize rows against the source.
  -- A durable SIE job that has not reached a terminal state, or a period held
  -- by an import, is reported last and without a count (see below).
  v_durable_import_running :=
    EXISTS (
      SELECT 1 FROM public.sie_imports
      WHERE company_id = p_company_id
        AND job_state NOT IN ('completed', 'undone', 'failed')
    )
    OR EXISTS (
      SELECT 1 FROM public.fiscal_periods
      WHERE company_id = p_company_id
        AND import_hold IS NOT NULL
    );

  SELECT
    (SELECT count(*) FROM public.sie_imports
     WHERE company_id = p_company_id AND status IN ('pending', 'mapped'))
    +
    (SELECT count(*) FROM public.bank_file_imports
     WHERE company_id = p_company_id AND status IN ('pending', 'processing'))
    +
    (SELECT count(*) FROM public.skattekonto_file_imports
     WHERE company_id = p_company_id AND status IN ('pending', 'processing'))
  INTO v_incomplete_imports;

  IF NOT v_durable_import_running AND v_incomplete_imports > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'imports_in_progress',
      'count', v_incomplete_imports
    ));
  END IF;

  -- Other background writers can run on service credentials or team-level
  -- capabilities after the interactive company session has moved. A reset is
  -- allowed only after every such integration or schedule is inactive.
  SELECT
    (SELECT count(*) FROM public.stripe_connections
     WHERE company_id = p_company_id AND status IN ('pending', 'active'))
    +
    (SELECT count(*) FROM public.woocommerce_connections
     WHERE company_id = p_company_id AND status IN ('pending', 'active'))
    +
    (SELECT count(*) FROM public.shopify_connections
     WHERE company_id = p_company_id AND status IN ('pending', 'active'))
    +
    (SELECT count(*) FROM public.skatteverket_tokens
     WHERE company_id = p_company_id AND status = 'active')
    +
    (SELECT count(*) FROM public.skatteverket_company_connections
     WHERE company_id = p_company_id AND status IN ('pending', 'partial', 'verified'))
    +
    (SELECT count(*) FROM public.recurring_invoice_schedules
     WHERE company_id = p_company_id AND status = 'active')
    +
    (SELECT count(*) FROM public.accrual_schedule_installments
     WHERE company_id = p_company_id AND status = 'pending')
  INTO v_active_automations;

  SELECT count(*) INTO v_zettle
  FROM public.zettle_connections
  WHERE company_id = p_company_id AND status IN ('pending', 'active');

  -- A live POS connection keeps fetching business days into the source.
  SELECT count(*) INTO v_pos
  FROM public.pos_connections
  WHERE company_id = p_company_id AND status <> 'disconnected';

  IF v_active_automations > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'active_integrations_or_schedules',
      'count', v_active_automations + v_zettle + v_pos
    ));
  END IF;

  -- Tenant-scoped workers must have reached a terminal state. The source
  -- mutation guards are the final backstop for a request that was already
  -- waiting on a lock when the reset committed.
  SELECT
    (SELECT count(*) FROM public.invoice_inbox_items
     WHERE company_id = p_company_id AND status = 'processing')
    +
    (SELECT count(*) FROM public.receipts
     WHERE company_id = p_company_id AND status IN ('pending', 'processing'))
    +
    (SELECT count(*) FROM public.operations
     WHERE company_id = p_company_id AND status IN ('queued', 'running'))
    +
    (SELECT count(*) FROM public.pending_operations
     WHERE company_id = p_company_id AND status = 'committing')
    +
    (SELECT count(*) FROM public.invoice_deliveries
     WHERE company_id = p_company_id AND status IN ('preparing', 'pending'))
    +
    (SELECT count(*) FROM public.stripe_payouts
     WHERE company_id = p_company_id AND status = 'processing')
    +
    (SELECT count(*) FROM public.stripe_payment_events
     WHERE company_id = p_company_id AND status = 'processing')
    +
    (SELECT count(*) FROM public.whatsapp_conversations
     WHERE company_id = p_company_id
       AND (pending_ack = true OR service_window_expires_at > now()))
    +
    (SELECT count(*)
     FROM public.whatsapp_messages message
     JOIN public.whatsapp_conversations conversation
       ON conversation.id = message.conversation_id
     WHERE conversation.company_id = p_company_id
       AND message.processing_status IN ('received', 'processing'))
  INTO v_background_work;

  IF v_background_work > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'background_work_in_progress',
      'count', v_background_work
    ));
  END IF;

  -- Known authority interactions, combined into one conservative blocker.
  -- The final signature of a VAT declaration happens at Skatteverket and
  -- cannot be observed reliably from this database, so lock, submit, a
  -- started VAT draft without a logged lock/submit, an AGI underlag awaiting
  -- signature and any ROT/RUT payout file all count as evidence.
  SELECT
    -- filed declarations and submissions
    (SELECT count(*)
     FROM public.agi_declarations
     WHERE company_id = p_company_id
       AND (submitted_at IS NOT NULL OR status IN ('submitted', 'accepted', 'rejected')))
    +
    (SELECT count(*)
     FROM public.salary_runs
     WHERE company_id = p_company_id
       AND agi_submitted_at IS NOT NULL)
    +
    (SELECT count(*)
     FROM public.arsredovisning_submissions
     WHERE company_id = p_company_id
       AND environment = 'prod'
       AND (
         uploaded_at IS NOT NULL
         OR status IN (
           'sending', 'uploaded', 'unknown', 'inkommen', 'forelagd',
           'komplettering', 'registrerad', 'avslutad'
         )
       ))
    +
    (SELECT count(*)
     FROM public.rot_rut_payout_requests
     WHERE company_id = p_company_id
       AND (submitted_at IS NOT NULL OR status IN ('submitted', 'paid', 'partially_paid', 'rejected')))
    +
    -- successful Skatteverket calls, including the direct VAT submit
    (SELECT count(*)
     FROM public.skatteverket_api_audit_log
     WHERE company_id = p_company_id
       AND outcome = 'ok'
       AND endpoint IN ('agi/submit', 'declaration/lock'))
    +
    (SELECT count(*)
     FROM public.skatteverket_api_audit_log
     WHERE company_id = p_company_id
       AND outcome = 'ok'
       AND endpoint = 'declaration/submit')
    +
    -- VAT draft workflows not already covered by a logged lock/submit
    (SELECT count(*)
     FROM public.extension_data state
     WHERE state.company_id = p_company_id
       AND state.extension_id = 'skatteverket'
       AND state.key LIKE 'submission\_%' ESCAPE '\'
       AND NOT EXISTS (
         SELECT 1
         FROM public.skatteverket_api_audit_log audit
         WHERE audit.company_id = p_company_id
           AND audit.outcome = 'ok'
           AND audit.endpoint IN ('declaration/lock', 'declaration/submit')
           AND (
             audit.redovisningsperiod IS NULL
             OR audit.redovisningsperiod = substring(state.key FROM 12)
           )
       ))
    +
    -- external filing staging: AGI awaiting signature (declaration row and
    -- extension cache count as one workflow per period) and every ROT/RUT
    -- payout request not yet submitted
    (SELECT count(*)
     FROM (
       SELECT
         'agi:' || declaration.period_year::text
           || lpad(declaration.period_month::text, 2, '0') AS workflow
       FROM public.agi_declarations declaration
       WHERE declaration.company_id = p_company_id
         AND declaration.status = 'pending_signature'

       UNION

       SELECT
         'agi:' || regexp_replace(
           substring(state.key FROM char_length('agi_submission_') + 1),
           '[^0-9]',
           '',
           'g'
         ) AS workflow
       FROM public.extension_data state
       WHERE state.company_id = p_company_id
         AND state.extension_id = 'skatteverket'
         AND state.key LIKE 'agi\_submission\_%' ESCAPE '\'
         AND NOT EXISTS (
           SELECT 1
           FROM public.agi_declarations declaration
           WHERE declaration.company_id = p_company_id
             AND declaration.period_year::text
                   || lpad(declaration.period_month::text, 2, '0')
                 = regexp_replace(
                     substring(state.key FROM char_length('agi_submission_') + 1),
                     '[^0-9]',
                     '',
                     'g'
                   )
             AND (
               declaration.submitted_at IS NOT NULL
               OR declaration.status IN ('submitted', 'accepted', 'rejected')
             )
         )

       UNION

       SELECT 'rot_rut:' || request.id::text AS workflow
       FROM public.rot_rut_payout_requests request
       WHERE request.company_id = p_company_id
         AND NOT (
           request.submitted_at IS NOT NULL
           OR request.status IN ('submitted', 'paid', 'partially_paid', 'rejected')
         )
     ) staging)
  INTO v_authority_submissions;

  IF v_authority_submissions > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'authority_submission_detected',
      'count', v_authority_submissions
    ));
  END IF;

  -- A Zettle connection with no other active integration is listed after the
  -- authority blocker (order kept from 20260909100400), POS folded in.
  IF v_active_automations = 0 AND v_zettle > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'active_integrations_or_schedules',
      'count', v_zettle + v_pos
    ));
  END IF;

  IF v_durable_import_running THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'imports_in_progress'
    ));
  END IF;

  -- POS connections with no other active integration come last (order kept
  -- from 20261011203600).
  IF v_active_automations = 0 AND v_zettle = 0 AND v_pos > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'active_integrations_or_schedules',
      'count', v_pos
    ));
  END IF;

  RETURN jsonb_build_object(
    'eligible', jsonb_array_length(v_blockers) = 0,
    'company_id', p_company_id,
    'display_name', v_display_name,
    'created_at', v_company.created_at,
    'window_ends_at', v_company.created_at + interval '30 days',
    'counts', v_counts,
    'blockers', v_blockers
  );
END;
$$;

COMMENT ON FUNCTION public.company_migration_reset_snapshot(uuid) IS
  'Internal fail-closed reset snapshot shared by the preview and the locked reset. Accounting records are retained data, not blockers; archive, window, sandbox, lock, live bank, import, integration (incl. Zettle and POS connections), worker and authority-filing state block.';

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION public.company_migration_reset_snapshot_before_20261011203600(uuid);
DROP FUNCTION public.company_migration_reset_snapshot_before_sie_jobs(uuid);
DROP FUNCTION public.company_migration_reset_snapshot_before_20260909100400(uuid);
DROP FUNCTION public.company_migration_reset_snapshot_before_20260826150000(uuid);
DROP FUNCTION public.company_migration_reset_snapshot_before_20260818231500(uuid);
DROP FUNCTION public.company_migration_reset_snapshot_before_20260818224000(uuid);
DROP FUNCTION public.company_migration_reset_snapshot_before_20260818143004(uuid);
DROP FUNCTION public.company_migration_reset_snapshot_before_20260818141018(uuid);

-- 2. Reset: one body under the existing name -------------------------------

CREATE OR REPLACE FUNCTION public.reset_company_for_migration(
  p_company_id uuid,
  p_confirmed_name text,
  p_reason text,
  p_confirm_no_filed_declarations boolean,
  p_confirm_retained_archive boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor               uuid := auth.uid();
  v_role                text;
  v_source              public.companies%ROWTYPE;
  v_source_settings     public.company_settings%ROWTYPE;
  v_has_settings        boolean := false;
  v_display_name        text;
  v_eligibility         jsonb;
  v_new_company_id      uuid := gen_random_uuid();
  v_reset_id            uuid := gen_random_uuid();
  v_archived_at         timestamptz := now();
  v_provider_count      integer := 0;
  v_inbox_count         integer := 0;
  v_domain_count        integer := 0;
  v_invite_count        integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_FORBIDDEN');
  END IF;

  -- Reject outsiders and non-owners before taking tenant-wide row locks. The
  -- same gate is repeated under lock below so a concurrent role change cannot
  -- authorize execution.
  SELECT role INTO v_role
  FROM public.company_members
  WHERE company_id = p_company_id
    AND user_id = v_actor;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_NOT_FOUND');
  END IF;

  IF v_role <> 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_FORBIDDEN');
  END IF;

  -- Lock Zettle connections before the company row (the 20260909100400
  -- wrapper took this lock): only an owner gets here, so outsiders and
  -- non-owner members cannot hold row locks on a foreign company while being
  -- rejected.
  PERFORM 1 FROM public.zettle_connections
  WHERE company_id = p_company_id FOR UPDATE;

  -- Serializes resets of the same source company. All work below is one
  -- database transaction because RPC execution is transactional.
  SELECT * INTO v_source
  FROM public.companies
  WHERE id = p_company_id
  FOR UPDATE;

  IF NOT FOUND OR v_source.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_NOT_FOUND');
  END IF;

  -- Lock every existing row that can change eligibility. New child inserts
  -- also wait on the source-company FOR UPDATE lock through their company_id
  -- foreign key. This closes the race where a period is locked, a voucher is
  -- committed, or a filing is recorded between the check and the archive.
  PERFORM 1 FROM public.company_members WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.fiscal_periods WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.journal_entries WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.sie_imports WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.bank_file_imports WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.skattekonto_file_imports WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.agi_declarations WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.salary_runs WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.arsredovisning_submissions WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.rot_rut_payout_requests WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.skatteverket_api_audit_log WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.company_inboxes WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.company_inbound_domains WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.company_invitations WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.receipts WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.invoice_inbox_items WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.operations WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.pending_operations WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.invoice_deliveries WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.stripe_payouts WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.stripe_payment_events WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.webshop_orders WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.customers WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.suppliers WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.invoices WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.supplier_invoices WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.whatsapp_conversations WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.whatsapp_messages
  WHERE conversation_id IN (
    SELECT id FROM public.whatsapp_conversations WHERE company_id = p_company_id
  ) FOR UPDATE;
  PERFORM 1 FROM public.provider_consents WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.company_subscriptions WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.company_capability_config WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.capability_grants WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.user_preferences WHERE active_company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.stripe_connections WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.woocommerce_connections WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.shopify_connections WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.skatteverket_tokens WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.skatteverket_company_connections WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.recurring_invoice_schedules WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.accrual_schedule_installments WHERE company_id = p_company_id FOR UPDATE;

  -- Repeat authorization after locking membership rows. A removed owner must
  -- not retain authority from the pre-lock fast-fail check.
  SELECT role INTO v_role
  FROM public.company_members
  WHERE company_id = p_company_id
    AND user_id = v_actor;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_NOT_FOUND');
  END IF;

  IF v_role <> 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_FORBIDDEN');
  END IF;

  SELECT * INTO v_source_settings
  FROM public.company_settings
  WHERE company_id = p_company_id
  FOR UPDATE;
  v_has_settings := FOUND;

  v_display_name := COALESCE(
    NULLIF(trim(v_source_settings.company_name), ''),
    NULLIF(trim(v_source.name), ''),
    v_source.id::text
  );

  IF trim(COALESCE(p_confirmed_name, '')) <> v_display_name THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_CONFIRMATION_MISMATCH');
  END IF;

  IF char_length(trim(COALESCE(p_reason, ''))) NOT BETWEEN 20 AND 1000 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_REASON_INVALID');
  END IF;

  IF p_confirm_no_filed_declarations IS DISTINCT FROM true
     OR p_confirm_retained_archive IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_CONFIRMATION_REQUIRED');
  END IF;

  -- Re-evaluate under the source-company row lock. No preview result is
  -- trusted for execution.
  v_eligibility := public.company_migration_reset_snapshot(p_company_id);
  IF COALESCE((v_eligibility ->> 'eligible')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'COMPANY_RESET_INELIGIBLE',
      'details', v_eligibility
    );
  END IF;

  -- Archive the source first inside this transaction. RLS excludes it after
  -- commit, while every source-owned record remains untouched.
  UPDATE public.companies
  SET archived_at = v_archived_at,
      archived_by = v_actor
  WHERE id = p_company_id;

  INSERT INTO public.companies (
    id,
    name,
    org_number,
    entity_type,
    accounting_framework,
    created_by,
    team_id,
    tic_snapshot,
    tic_snapshot_fetched_at,
    created_at,
    updated_at
  ) VALUES (
    v_new_company_id,
    v_source.name,
    v_source.org_number,
    v_source.entity_type,
    v_source.accounting_framework,
    v_actor,
    v_source.team_id,
    v_source.tic_snapshot,
    v_source.tic_snapshot_fetched_at,
    v_archived_at,
    v_archived_at
  );

  INSERT INTO public.company_members (
    company_id,
    user_id,
    role,
    source,
    invited_by,
    joined_at,
    created_at,
    updated_at
  )
  SELECT
    v_new_company_id,
    user_id,
    role,
    source,
    invited_by,
    joined_at,
    v_archived_at,
    v_archived_at
  FROM public.company_members
  WHERE company_id = p_company_id
    AND user_id = v_actor;

  -- Bootstrap the calling owner first. The membership guard then recognizes
  -- that owner while copying any additional owners and members.
  INSERT INTO public.company_members (
    company_id,
    user_id,
    role,
    source,
    invited_by,
    joined_at,
    created_at,
    updated_at
  )
  SELECT
    v_new_company_id,
    user_id,
    role,
    source,
    invited_by,
    joined_at,
    v_archived_at,
    v_archived_at
  FROM public.company_members
  WHERE company_id = p_company_id
    AND user_id <> v_actor;

  IF v_has_settings THEN
    INSERT INTO public.company_settings
    SELECT (jsonb_populate_record(
      NULL::public.company_settings,
      to_jsonb(v_source_settings) || jsonb_build_object(
        'id', gen_random_uuid(),
        'company_id', v_new_company_id,
        'user_id', v_actor,
        'created_at', v_archived_at,
        'updated_at', v_archived_at,
        -- onboarding_complete and onboarding_step are deliberately NOT
        -- overridden: every answer onboarding collects is copied from the
        -- source on this very row, so the replacement inherits the fact.
        'bookkeeping_locked_through', NULL,
        'initial_setup_path', NULL,
        'initial_setup_completed_at', NULL,
        'initial_setup_dismissed_at', NULL
      )
    )).*;
  END IF;

  -- The replacement gets a fresh chart and a fresh voucher namespace. The
  -- source voucher_sequences are deliberately not copied or recalculated.
  PERFORM public.seed_chart_of_accounts(v_new_company_id, v_source.entity_type);

  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  ) VALUES (
    v_new_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  ) ON CONFLICT (company_id, ledger_account) DO NOTHING;

  -- Keep inbound document routing on the active company. Company insertion
  -- auto-provisions a fresh inbox; replace it with the source's active address
  -- so messages sent after commit cannot normally land in the archive.
  SELECT count(*) INTO v_inbox_count
  FROM public.company_inboxes
  WHERE company_id = p_company_id
    AND status = 'active';

  IF v_inbox_count > 0 THEN
    DELETE FROM public.company_inboxes
    WHERE company_id = v_new_company_id
      AND status = 'active';

    UPDATE public.company_inboxes
    SET company_id = v_new_company_id
    WHERE company_id = p_company_id
      AND status = 'active';
  END IF;

  UPDATE public.company_inbound_domains
  SET company_id = v_new_company_id
  WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_domain_count = ROW_COUNT;

  -- Keep still-valid invitations pointed at the active company. Completed and
  -- expired invitation history remains with the retained source.
  UPDATE public.company_invitations
  SET company_id = v_new_company_id
  WHERE company_id = p_company_id
    AND status = 'pending'
    AND expires_at > v_archived_at;
  GET DIAGNOSTICS v_invite_count = ROW_COUNT;

  -- Carry only operational access required to redo the migration. Accounting
  -- data and bank connections remain with the retained source company.
  UPDATE public.provider_consents
  SET company_id = v_new_company_id
  WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_provider_count = ROW_COUNT;

  UPDATE public.company_subscriptions
  SET company_id = v_new_company_id
  WHERE company_id = p_company_id;

  UPDATE public.company_capability_config
  SET company_id = v_new_company_id
  WHERE company_id = p_company_id;

  -- Company insertion seeds a new trial. Remove it before moving the original
  -- grants so a reset can never extend or duplicate entitlement time.
  DELETE FROM public.capability_grants
  WHERE company_id = v_new_company_id;

  UPDATE public.capability_grants
  SET company_id = v_new_company_id
  WHERE company_id = p_company_id;

  UPDATE public.user_preferences
  SET active_company_id = v_new_company_id,
      updated_at = v_archived_at
  WHERE active_company_id = p_company_id;

  INSERT INTO public.company_migration_resets (
    id,
    source_company_id,
    replacement_company_id,
    actor_id,
    reason,
    confirmation_snapshot,
    source_counts,
    created_at
  ) VALUES (
    v_reset_id,
    p_company_id,
    v_new_company_id,
    v_actor,
    trim(p_reason),
    jsonb_build_object(
      'confirmed_name', trim(p_confirmed_name),
      'confirmed_no_filed_declarations', true,
      'confirmed_retained_archive', true,
      'source_created_at', v_source.created_at,
      'provider_consents_transferred', v_provider_count,
      'active_inboxes_transferred', v_inbox_count,
      'inbound_domains_transferred', v_domain_count,
      'pending_invitations_transferred', v_invite_count
    ),
    v_eligibility -> 'counts',
    v_archived_at
  );

  INSERT INTO public.audit_log (
    user_id,
    company_id,
    action,
    table_name,
    record_id,
    actor_id,
    old_state,
    new_state,
    description
  ) VALUES (
    v_actor,
    p_company_id,
    'UPDATE',
    'companies',
    p_company_id,
    v_actor,
    jsonb_build_object('archived_at', NULL),
    jsonb_build_object(
      'archived_at', v_archived_at,
      'archived_by', v_actor,
      'replacement_company_id', v_new_company_id,
      'migration_reset_id', v_reset_id
    ),
    'Source company archived for owner-confirmed migration reset'
  ), (
    v_actor,
    v_new_company_id,
    'INSERT',
    'companies',
    v_new_company_id,
    v_actor,
    NULL,
    jsonb_build_object(
      'source_company_id', p_company_id,
      'migration_reset_id', v_reset_id
    ),
    'Replacement company created for owner-confirmed migration reset'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'reset_id', v_reset_id,
    'source_company_id', p_company_id,
    'replacement_company_id', v_new_company_id,
    'archived_at', v_archived_at,
    'counts', v_eligibility -> 'counts'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reset_company_for_migration(uuid, text, text, boolean, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_company_for_migration(uuid, text, text, boolean, boolean)
  TO authenticated;

DROP FUNCTION public.reset_company_for_migration_before_20260909100400(uuid, text, text, boolean, boolean);

NOTIFY pgrst, 'reload schema';
