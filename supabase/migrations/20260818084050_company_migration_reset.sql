-- Owner-only company reset for redoing a failed migration.
--
-- This is intentionally an archive-and-replace operation, not a delete. The
-- source company remains the retention container for every document, import,
-- transaction, fiscal period, voucher, and voucher sequence. A new active
-- company is created for the replacement migration. No enforcement trigger is
-- disabled and no accounting-shaped row is changed or removed.

CREATE TABLE public.company_migration_resets (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_company_id      uuid NOT NULL UNIQUE REFERENCES public.companies(id) ON DELETE RESTRICT,
  replacement_company_id uuid NOT NULL UNIQUE REFERENCES public.companies(id) ON DELETE RESTRICT,
  actor_id               uuid,
  reason                 text NOT NULL CHECK (char_length(reason) BETWEEN 20 AND 1000),
  confirmation_snapshot  jsonb NOT NULL,
  source_counts           jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.company_migration_resets IS
  'Append-only audit trail for owner-confirmed archive-and-replace migration resets. Source accounting records are retained unchanged.';

ALTER TABLE public.company_migration_resets ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_migration_resets_select
  ON public.company_migration_resets
  FOR SELECT
  USING (replacement_company_id IN (SELECT public.user_company_ids()));

CREATE INDEX idx_company_migration_resets_created_at
  ON public.company_migration_resets (created_at DESC);

CREATE OR REPLACE FUNCTION public.company_migration_reset_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Company migration reset audit entries cannot be modified or deleted';
END;
$$;

CREATE TRIGGER company_migration_resets_no_update
  BEFORE UPDATE ON public.company_migration_resets
  FOR EACH ROW EXECUTE FUNCTION public.company_migration_reset_audit_immutable();

CREATE TRIGGER company_migration_resets_no_delete
  BEFORE DELETE ON public.company_migration_resets
  FOR EACH ROW EXECUTE FUNCTION public.company_migration_reset_audit_immutable();

CREATE TRIGGER company_migration_resets_no_truncate
  BEFORE TRUNCATE ON public.company_migration_resets
  FOR EACH STATEMENT EXECUTE FUNCTION public.company_migration_reset_audit_immutable();

REVOKE ALL ON FUNCTION public.company_migration_reset_audit_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.company_migration_resets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.company_migration_resets TO authenticated;

-- Close the invitation acceptance race after a successful reset. An insert
-- that started before the reset either completes before the source row lock
-- and is copied to the replacement, or resumes afterward and is rejected by
-- this trigger. This keeps the retained source closed to new memberships.
CREATE OR REPLACE FUNCTION public.block_migration_reset_source_member_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.company_migration_resets
    WHERE source_company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'Cannot add members to an archived migration reset source';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER company_members_block_migration_reset_source_insert
  BEFORE INSERT ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_member_insert();

REVOKE ALL ON FUNCTION public.block_migration_reset_source_member_insert()
  FROM PUBLIC, anon, authenticated;

-- Team membership sync must not target retained archives. Without this
-- active-company filter, one archived source row would make the trigger's
-- multi-row INSERT fail and prevent the same member reaching active companies.
CREATE OR REPLACE FUNCTION public.sync_team_member_to_companies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_role text;
BEGIN
  v_company_role := CASE
    WHEN NEW.role IN ('owner', 'admin') THEN 'admin'
    ELSE 'member'
  END;

  INSERT INTO public.company_members (company_id, user_id, role, source)
  SELECT company.id, NEW.user_id, v_company_role, 'team'
  FROM public.companies company
  WHERE company.team_id = NEW.team_id
    AND company.archived_at IS NULL
  ON CONFLICT (company_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Once the reset audit row exists, the source becomes a write-closed
-- retention container. These guards also reject requests that passed an RLS
-- check before the reset, waited on the source-company lock, and resumed after
-- commit. Existing bookkeeping enforcement triggers remain fully enabled.
CREATE OR REPLACE FUNCTION public.block_migration_reset_source_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_company_id := NEW.company_id;
  ELSE
    v_company_id := OLD.company_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.company_migration_resets
    WHERE source_company_id = v_company_id
  ) THEN
    RAISE EXCEPTION 'Archived migration reset source records are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'fiscal_periods',
    'journal_entries',
    'transactions',
    'document_attachments',
    'voucher_sequences',
    'sie_imports',
    'bank_file_imports',
    'skattekonto_file_imports',
    'receipts',
    'invoice_inbox_items',
    'customers',
    'suppliers',
    'invoices',
    'supplier_invoices',
    'invoice_deliveries',
    'stripe_payouts',
    'stripe_payment_events',
    'webshop_orders'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation()',
      v_table || '_block_migration_reset_source_mutation',
      v_table
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_migration_reset_source_journal_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entry_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_entry_id := NEW.journal_entry_id;
  ELSE
    v_entry_id := OLD.journal_entry_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.journal_entries je
    JOIN public.company_migration_resets reset
      ON reset.source_company_id = je.company_id
    WHERE je.id = v_entry_id
  ) THEN
    RAISE EXCEPTION 'Archived migration reset source records are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entry_lines_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.block_migration_reset_source_journal_line_mutation();

CREATE OR REPLACE FUNCTION public.protect_migration_reset_source_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.company_migration_resets
    WHERE source_company_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Migration reset source archive markers are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER companies_protect_migration_reset_source_archive
  BEFORE UPDATE OF archived_at, archived_by ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.protect_migration_reset_source_archive();

REVOKE ALL ON FUNCTION public.block_migration_reset_source_mutation()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.block_migration_reset_source_journal_line_mutation()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_migration_reset_source_archive()
  FROM PUBLIC, anon, authenticated;

-- Internal, fail-closed snapshot used by both preview and execution. Keeping
-- one implementation prevents the eligibility check from drifting between
-- the UI preview and the transaction that performs the reset.
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
  v_non_import_committed       integer;
  v_authority_submissions      integer;
  v_live_bank_connections      integer;
  v_active_automations         integer;
  v_incomplete_imports         integer;
  v_background_work            integer;
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

  -- A non-import committed entry proves that the company has moved beyond a
  -- pure migration attempt. Reversals and corrections are non-import source
  -- types and therefore block as well.
  SELECT count(*) INTO v_non_import_committed
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND status IN ('posted', 'reversed')
    AND (source_type IS NULL OR source_type NOT IN ('import', 'opening_balance'));

  IF v_non_import_committed > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'non_import_committed_entries',
      'count', v_non_import_committed
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

  IF v_incomplete_imports > 0 THEN
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

  IF v_active_automations > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'active_integrations_or_schedules',
      'count', v_active_automations
    ));
  END IF;

  -- Tenant-scoped workers must have reached a terminal state. The source
  -- mutation guards above are the final backstop for a request that was
  -- already waiting on a lock when the reset committed.
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

  -- Known authority interactions are combined into one conservative blocker.
  -- VAT declaration/lock is included because the final signature happens at
  -- Skatteverket and cannot be observed reliably from this database.
  SELECT
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
    (SELECT count(*)
     FROM public.skatteverket_api_audit_log
     WHERE company_id = p_company_id
       AND outcome = 'ok'
       AND endpoint IN ('agi/submit', 'declaration/lock'))
  INTO v_authority_submissions;

  IF v_authority_submissions > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'authority_submission_detected',
      'count', v_authority_submissions
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

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_company_migration_reset_eligibility(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_role  text;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'COMPANY_RESET_FORBIDDEN');
  END IF;

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

  RETURN jsonb_build_object(
    'ok', true,
    'eligibility', public.company_migration_reset_snapshot(p_company_id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_migration_reset_eligibility(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_company_migration_reset_eligibility(uuid) TO authenticated;

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
        'onboarding_complete', false,
        'onboarding_step', 1,
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

NOTIFY pgrst, 'reload schema';
