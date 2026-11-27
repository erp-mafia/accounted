-- A live spend connection blocks a company migration reset, like every other
-- integration. reset_company_for_migration archives the source company and
-- creates a replacement; a connection left behind would keep receiving card
-- expenses into the archived company while the replacement gets none.
--
-- The snapshot body is 20261104012126's (the support override, the latest
-- definition) with one change: the POS count also counts live
-- spend_connections (20261127161000), so a spend connection folds into the
-- same active_integrations_or_schedules blocker at the same places in the
-- blockers array as a POS connection. Live is active, or connecting while
-- the person is still within the consent window: an abandoned attempt stays
-- 'connecting' until the next one replaces it and must not block forever. No
-- row lock in the reset itself: an ended connection never goes live again (a
-- new connection is a new row), so there is no state for a lock to hold
-- still. The comment names the spend connections too; the grants are
-- restated as they were.
--
-- pg-test: tests/pg/company-migration-reset.pg.test.ts

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
  -- Set only by support_reset_company_for_migration, for this company, inside
  -- its own transaction. Not reachable from PostgREST: clients can set
  -- request.* settings only.
  v_support                    boolean := COALESCE(
    current_setting('app.migration_reset_support_company', true), ''
  ) = p_company_id::text;
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
  IF v_company.created_at < now() - interval '30 days' AND NOT v_support THEN
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

  IF v_locked_periods > 0 AND NOT v_support THEN
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

  -- A live POS or spend connection keeps delivering into the source.
  SELECT
    (SELECT count(*) FROM public.pos_connections
     WHERE company_id = p_company_id AND status <> 'disconnected')
    +
    (SELECT count(*) FROM public.spend_connections
     WHERE company_id = p_company_id
       AND (status = 'active' OR (status = 'connecting' AND pending_expires_at > now())))
  INTO v_pos;

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
    'blockers', v_blockers,
    'support_override', v_support
  );
END;
$$;

COMMENT ON FUNCTION public.company_migration_reset_snapshot(uuid) IS
  'Internal fail-closed reset snapshot shared by the preview and the locked reset. Accounting records are retained data, not blockers; archive, window, sandbox, lock, live bank, import, integration (incl. Zettle, POS and spend connections), worker and authority-filing state block. A support reset (support_reset_company_for_migration) lifts the window and lock blockers for its one company.';

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
