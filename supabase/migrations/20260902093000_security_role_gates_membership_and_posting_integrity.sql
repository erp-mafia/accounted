-- Security audit 2026-09-01, high items (report "Accounted Security Audit").
-- pg-test: tests/pg/security-role-gates-and-posting-integrity.pg.test.ts
--
-- A. The read-only `viewer` role could write. The 20260702093000 design
--    blocks viewers only through RLS predicates that AND in
--    current_user_can_write(); everything that bypasses RLS skipped the gate:
--    15 authenticated-callable SECURITY DEFINER writers (commit_journal_entry,
--    import_sie_journal_entries, bulk_book_transactions, match_batch_allocate,
--    link_*_to_voucher, create_document_version, next_voucher_number,
--    reserve/release_voucher_range, rotate_company_inbox,
--    generate_invoice_number, ensure_company_dimensions,
--    relink_documents_to_correction, seed_chart_of_accounts) and ~45 tables
--    whose write policies were membership-only. Rather than re-emitting 15
--    function bodies and 130 policies, this adds ONE table-level guard,
--    enforce_company_writer_role(), on every company-scoped table a viewer
--    must never write. It keys on the JWT role claim (so it fires inside
--    SECURITY DEFINER bodies too, where current_user is the owner) and on
--    auth.uid(), and is a no-op for service_role, pg_cron, migrations and
--    trigger cascades (pg_trigger_depth() > 1). Deliberately NOT attached:
--    agent_conversations/agent_messages (viewer chat is a feature),
--    booking_template_usage and categorize_calibration_samples (telemetry a
--    read-only browsing session emits).
--
-- B. Admin -> owner escalation. company_members_update only guarded role
--    changes, so an admin could re-point the owner row's user_id; the
--    invitations CHECK allowed role 'owner' and the accept path copies the
--    role verbatim under the service client; team_members had no transition
--    guard at all. Triggers below close all three. companies gains an
--    owner-only guard on team_id/archived_at/created_by and the INSERT policy
--    now requires membership of the team a company is attached to.
--
-- C. Posting integrity. Direct PostgREST statements (current_user =
--    authenticated) could INSERT lines under a posted verifikat, INSERT a
--    header with status 'posted', or flip a self-numbered draft to posted,
--    bypassing commit_journal_entry and voucher sequencing (BFL 5 kap. 5 §,
--    BFNAR 2013:2). These checks key on current_user IN ('anon',
--    'authenticated'): inside SECURITY DEFINER RPCs current_user is the
--    definer, so the engine's sanctioned paths (commit_journal_entry,
--    import_sie_journal_entries, correct_entry_lines_inline, storno) are
--    untouched, while the engine's own direct writes stay legal: it inserts
--    drafts (voucher 0, or a sequence-issued number for reversals) and flips
--    draft -> posted only with a sequence-issued number.
--
-- D. create_document_version: role gate + storage_path must live under the
--    document's company (or the caller's user folder). validate_version_chain
--    was anon-callable with no tenant check (a document-UUID oracle):
--    membership required, anon revoked. match_documents /
--    match_booking_templates lose anon EXECUTE. update_overdue_supplier_invoices
--    and redact_expired_invoice_delivery_pii are cron maintenance with no
--    application caller: service_role only. seed_asset_categories existed only
--    in production (no migration, no code reference): dropped.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.jwt_caller_is_end_user()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  ) IN ('anon', 'authenticated');
$$;

-- Membership with a writing role, for an explicit company (the
-- current_user_can_write() twin that does not depend on the active company).
CREATE OR REPLACE FUNCTION public.caller_can_write_company(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- No archived_at filter here: archived companies are already frozen by the
  -- migration-reset triggers, which must keep producing their own message.
  SELECT p_company_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.user_id = auth.uid()
      AND cm.company_id = p_company_id
      AND cm.role <> 'viewer'
  );
$$;

CREATE OR REPLACE FUNCTION public.caller_is_company_owner(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_company_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.user_id = auth.uid() AND cm.company_id = p_company_id AND cm.role = 'owner'
  );
$$;

CREATE OR REPLACE FUNCTION public.caller_is_team_owner(p_team_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_team_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.user_id = auth.uid() AND tm.team_id = p_team_id AND tm.role = 'owner'
  );
$$;

-- ---------------------------------------------------------------------------
-- A. Viewer write guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_company_writer_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_company uuid;
BEGIN
  IF NOT public.jwt_caller_is_end_user() OR pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_company := OLD.company_id;
  ELSE
    v_company := NEW.company_id;
  END IF;

  IF v_company IS NOT NULL AND NOT public.caller_can_write_company(v_company) THEN
    RAISE EXCEPTION 'row-level security: no write access to company % for % on %', v_company, TG_OP, TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Child tables: resolve company_id through the parent named in TG_ARGV.
CREATE OR REPLACE FUNCTION public.enforce_company_writer_role_via_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_fk uuid;
  v_company uuid;
BEGIN
  IF NOT public.jwt_caller_is_end_user() OR pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_row := to_jsonb(OLD);
  ELSE
    v_row := to_jsonb(NEW);
  END IF;
  v_fk := (v_row ->> TG_ARGV[1])::uuid;

  IF v_fk IS NOT NULL THEN
    EXECUTE format('SELECT company_id FROM public.%I WHERE id = $1', TG_ARGV[0])
      INTO v_company USING v_fk;
    IF v_company IS NOT NULL AND NOT public.caller_can_write_company(v_company) THEN
      RAISE EXCEPTION 'row-level security: no write access to company % for % on %', v_company, TG_OP, TG_TABLE_NAME
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- core tables reachable through membership-only SECURITY DEFINER writers
    'journal_entries', 'transactions', 'invoices', 'invoice_payments',
    'supplier_invoices', 'supplier_invoice_payments', 'document_attachments',
    'voucher_sequences', 'company_inboxes', 'chart_of_accounts',
    -- tables whose own write policies were membership-only
    'account_dimension_rules', 'accrual_schedule_installments', 'accrual_schedules',
    'agent_memory', 'agent_profiles', 'agi_declarations',
    'arsredovisning_narratives', 'arsredovisning_signature_requests', 'articles',
    'assets', 'cash_accounts', 'depreciation_schedules', 'dimension_values',
    'dimensions', 'employee_benefits', 'employee_opening_balances',
    'employee_vacation_balances', 'employees', 'journal_entry_no_doc_required',
    'mileage_trips', 'recurring_invoice_schedules', 'rot_rut_payout_requests',
    'salary_absence_days', 'salary_line_items', 'salary_payslip_deliveries',
    'salary_payslip_links', 'salary_run_employees', 'salary_runs',
    'salary_worked_days', 'shift_premium_rules', 'shopify_connections',
    'skattekonto_file_imports', 'skattekonto_rules', 'skattekonto_transactions',
    'stripe_connections', 'supplier_payment_batch_items', 'supplier_payment_batches',
    'transaction_voucher_links', 'vacation_year_closures', 'webshop_orders',
    'webshop_store_settings', 'woocommerce_connections'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'enforce_company_writer_role: table % missing, skipped', t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER aa_enforce_company_writer_role BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role()', t);
  END LOOP;
END $$;

DO $$
DECLARE
  spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ARRAY['journal_entry_lines', 'journal_entries', 'journal_entry_id'],
    ARRAY['invoice_items', 'invoices', 'invoice_id'],
    ARRAY['supplier_invoice_items', 'supplier_invoices', 'supplier_invoice_id'],
    ARRAY['recurring_invoice_schedule_items', 'recurring_invoice_schedules', 'schedule_id'],
    ARRAY['rot_rut_payout_request_items', 'rot_rut_payout_requests', 'request_id']
  ] LOOP
    IF to_regclass('public.' || spec[1]) IS NULL THEN
      RAISE NOTICE 'enforce_company_writer_role_via_parent: table % missing, skipped', spec[1];
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.%I', spec[1]);
    EXECUTE format(
      'CREATE TRIGGER aa_enforce_company_writer_role BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role_via_parent(%L, %L)',
      spec[1], spec[2], spec[3]);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- B. Membership and ownership guards
-- ---------------------------------------------------------------------------

-- company_members: identity columns are immutable from user sessions; role
-- changes stay owner-only (unchanged semantics from 20260826130100).
CREATE OR REPLACE FUNCTION public.enforce_company_member_role_transitions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  caller_role text;
BEGIN
  -- Service role, SECURITY DEFINER cascades, and direct SQL have no auth context.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Trigger-cascaded writes come from our own sync triggers
  -- (team_member_sync_role_update), not from a direct user statement.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Who a membership row belongs to is never editable: re-pointing the owner
  -- row's user_id was an admin -> owner takeover.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'company_members: user_id and company_id are immutable'
      USING ERRCODE = '42501';
  END IF;

  -- Nothing to enforce if the role field isn't changing.
  IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;

  caller_role := public.user_role_in_company(OLD.company_id);

  IF caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION
      'Only owners can change member roles (your role: %)',
      COALESCE(caller_role, 'none');
  END IF;

  RETURN NEW;
END;
$$;

-- company_invitations: an invitation never mints an owner. The API schema
-- already refused it; the RLS INSERT policy (admin) and the CHECK constraint
-- did not, and the accept path copies the role under the service client.
CREATE OR REPLACE FUNCTION public.enforce_company_invitation_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'owner' THEN
    RAISE EXCEPTION 'company_invitations: role owner cannot be granted by invitation'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_company_invitation_role ON public.company_invitations;
CREATE TRIGGER enforce_company_invitation_role
  BEFORE INSERT OR UPDATE OF role ON public.company_invitations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_invitation_role();

-- team_members: mirror of the company_members guard. The first owner of a
-- team may be self-inserted (create_team_with_owner / ensure_user_team run as
-- definer with the caller's JWT); every later owner grant needs a team owner.
CREATE OR REPLACE FUNCTION public.enforce_team_member_role_transitions()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'owner'
       AND NOT public.caller_is_team_owner(NEW.team_id)
       AND NOT (
         NEW.user_id = auth.uid()
         AND NOT EXISTS (
           SELECT 1 FROM public.team_members tm
           WHERE tm.team_id = NEW.team_id AND tm.role = 'owner'
         )
       ) THEN
      RAISE EXCEPTION 'team_members: only a team owner can add another owner'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    RAISE EXCEPTION 'team_members: user_id and team_id are immutable'
      USING ERRCODE = '42501';
  END IF;

  -- Team admins keep the pre-existing ability to move members between the
  -- non-owner roles; anything touching 'owner' needs a team owner.
  IF NEW.role IS DISTINCT FROM OLD.role
     AND NOT public.caller_is_team_owner(OLD.team_id)
     AND NOT (
       public.user_is_team_admin(OLD.team_id)
       AND OLD.role <> 'owner' AND NEW.role <> 'owner'
     ) THEN
    RAISE EXCEPTION 'team_members: only a team owner can grant or remove the owner role'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_team_member_role_transitions ON public.team_members;
CREATE TRIGGER enforce_team_member_role_transitions
  BEFORE INSERT OR UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_team_member_role_transitions();

-- companies: team attachment, archiving and provenance are owner-only from a
-- user session, and a company may only be attached to a team the caller
-- belongs to. Service-role paths (delete route, migration reset internals)
-- are unaffected.
CREATE OR REPLACE FUNCTION public.enforce_company_owner_only_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'companies: created_by is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    IF NOT public.caller_is_company_owner(OLD.id) THEN
      RAISE EXCEPTION 'companies: only the owner can change the team attachment'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.team_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.team_members tm WHERE tm.team_id = NEW.team_id AND tm.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'companies: cannot attach a company to a team you are not a member of'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF (NEW.archived_at IS DISTINCT FROM OLD.archived_at
      OR NEW.archived_by IS DISTINCT FROM OLD.archived_by)
     AND NOT public.caller_is_company_owner(OLD.id) THEN
    RAISE EXCEPTION 'companies: only the owner can archive or restore a company'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_company_owner_only_columns ON public.companies;
CREATE TRIGGER enforce_company_owner_only_columns
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_owner_only_columns();

DROP POLICY IF EXISTS "companies_insert" ON public.companies;
CREATE POLICY "companies_insert" ON public.companies
  FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    AND (team_id IS NULL OR team_id IN (SELECT public.user_team_ids()))
  );

-- ---------------------------------------------------------------------------
-- C. Posting integrity for direct statements
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_journal_entry_insert_shape()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Direct PostgREST statement (current_user is the end-user role). Inside a
  -- SECURITY DEFINER RPC current_user is the definer, so the engine's
  -- sanctioned writers are not affected.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'draft'
     OR NEW.committed_at IS NOT NULL
     OR NEW.commit_method IS NOT NULL THEN
    RAISE EXCEPTION 'journal_entries: direct inserts must be drafts; post through commit_journal_entry'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_enforce_journal_entry_insert_shape ON public.journal_entries;
CREATE TRIGGER aa_enforce_journal_entry_insert_shape
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_journal_entry_insert_shape();

-- Header immutability: identical to the live definition, plus one rule in the
-- draft branch: a direct statement may flip draft -> posted only with a
-- voucher number the sequence has actually issued (0 < n <= last_number).
-- The engine's reversal path (next_voucher_number then UPDATE) satisfies it;
-- a self-chosen number outside the sequence does not.
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_last_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    IF NEW.status = 'posted' AND current_user IN ('anon', 'authenticated') THEN
      SELECT vs.last_number INTO v_last_number
      FROM public.voucher_sequences vs
      WHERE vs.company_id = NEW.company_id
        AND vs.fiscal_period_id = NEW.fiscal_period_id
        AND vs.voucher_series = NEW.voucher_series;
      IF NEW.voucher_number IS NULL OR NEW.voucher_number <= 0
         OR v_last_number IS NULL OR NEW.voucher_number > v_last_number THEN
        RAISE EXCEPTION 'journal_entries: voucher number % was not issued by the sequence; post through commit_journal_entry',
          NEW.voucher_number USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
         OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
         OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Narrow un-reversal path: when delete_last_voucher removes a storno entry,
  -- it flips the original from 'reversed' back to 'posted'. No other fields
  -- may change, and the bypass flag must be set.
  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
       OR NEW.fiscal_period_id != OLD.fiscal_period_id
       OR NEW.voucher_number != OLD.voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields during un-reversal (id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- Notes-only annotation on a committed entry (posted/reversed/cancelled).
  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (to_jsonb(NEW) - 'notes' - 'updated_at')
       = (to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Source-type re-tag of a mis-typed opening balance (mark_entry_as_opening_balance).
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_source_type_retag', true) = 'true'
     AND OLD.source_type IN ('manual', 'import')
     AND NEW.source_type = 'opening_balance'
     AND (to_jsonb(NEW) - 'source_type' - 'updated_at')
       = (to_jsonb(OLD) - 'source_type' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Metadata rättelse of a posted verifikation (correct_entry_metadata).
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_metadata_rattelse', true) = 'true'
     AND (to_jsonb(NEW) - 'description' - 'entry_date' - 'updated_at')
       = (to_jsonb(OLD) - 'description' - 'entry_date' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$$;

-- Line immutability: identical to the live definition, plus INSERT coverage.
-- A direct statement may only add lines to a draft header; sanctioned RPCs
-- (correct_entry_lines_inline under its GUC, import, storno) run as definer.
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_status text;
BEGIN
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status FROM public.journal_entries
  WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF TG_OP = 'INSERT' THEN
    IF v_status IS DISTINCT FROM 'draft'
       AND current_user IN ('anon', 'authenticated')
       AND current_setting('gnubok.allow_line_rattelse', true) IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'journal_entry_lines: cannot add lines to a % journal entry', v_status
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Dimension retag carve-out (dimensions plan PR6, founder-approved):
  -- while the transaction-local GUC set by retag_line_dimensions is active,
  -- permit UPDATE of a POSTED line iff ONLY the dimension columns change.
  IF TG_OP = 'UPDATE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_dimension_retag', true) = 'true'
     AND (to_jsonb(NEW) - 'dimensions' - 'cost_center' - 'project')
       = (to_jsonb(OLD) - 'dimensions' - 'cost_center' - 'project') THEN
    RETURN NEW;
  END IF;

  -- Inline rättelse carve-out (BFL 5 kap 5 §, founder-approved 2026-07-23):
  -- while the transaction-local GUC set by correct_entry_lines_inline() is
  -- active, permit DELETE of a POSTED line (a struck line).
  IF TG_OP = 'DELETE'
     AND v_status = 'posted'
     AND current_setting('gnubok.allow_line_rattelse', true) = 'true' THEN
    RETURN OLD;
  END IF;

  IF v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF v_status = 'cancelled' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Cannot % lines of a cancelled journal entry.', TG_OP;
  END IF;

  RAISE EXCEPTION 'Cannot % lines of a % journal entry.', TG_OP, v_status;
END; $$;

DROP TRIGGER IF EXISTS enforce_journal_entry_line_immutability ON public.journal_entry_lines;
CREATE TRIGGER enforce_journal_entry_line_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_journal_entry_line_immutability();

-- ---------------------------------------------------------------------------
-- D. Document RPCs and leftover grants
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_document_version(
  p_user_id uuid, p_original_doc_id uuid, p_storage_path text, p_file_name text,
  p_file_size_bytes bigint, p_mime_type text, p_sha256_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_current document_attachments%ROWTYPE;
  v_new_id uuid;
  v_root_id uuid;
  v_next_version integer;
  v_caller_role text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required to create document version';
  END IF;
  IF p_user_id IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'p_user_id does not match authenticated user';
  END IF;

  SELECT * INTO v_current
  FROM public.document_attachments
  WHERE id = p_original_doc_id
    AND is_current_version = true
  FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'Document % not found or is not the current version', p_original_doc_id;
  END IF;

  SELECT cm.role INTO v_caller_role
  FROM public.company_members cm
  WHERE cm.company_id = v_current.company_id
    AND cm.user_id = v_caller;

  IF v_caller_role IS NULL THEN
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, description)
    VALUES (v_caller, v_current.company_id, 'SECURITY_EVENT', 'document_attachments', p_original_doc_id,
      'Blocked cross-company create_document_version attempt');
    RAISE EXCEPTION 'User is not a member of the document''s company';
  END IF;

  -- Read-only members supersede nothing: same rule as every document write.
  IF v_caller_role = 'viewer' THEN
    RAISE EXCEPTION 'read-only role cannot create document versions' USING ERRCODE = '42501';
  END IF;

  -- The new object must live in this company's folder (or the caller's own
  -- legacy user folder): a foreign key would re-anchor another tenant's file.
  IF p_storage_path IS NULL
     OR NOT (
       p_storage_path LIKE 'documents/' || v_current.company_id::text || '/%'
       OR p_storage_path LIKE 'documents/' || v_caller::text || '/%'
     ) THEN
    RAISE EXCEPTION 'storage_path must be under the document''s company folder' USING ERRCODE = '42501';
  END IF;

  v_root_id := COALESCE(v_current.original_id, v_current.id);
  v_next_version := v_current.version + 1;

  PERFORM set_config('gnubok.allow_supersede', 'true', true);

  INSERT INTO public.document_attachments (
    user_id, company_id, storage_path, file_name, file_size_bytes,
    mime_type, sha256_hash, version, original_id, is_current_version,
    uploaded_by, upload_source, digitization_date,
    journal_entry_id, journal_entry_line_id, prev_version_hash
  ) VALUES (
    p_user_id, v_current.company_id, p_storage_path, p_file_name,
    p_file_size_bytes, p_mime_type, p_sha256_hash, v_next_version,
    v_root_id, true, p_user_id, v_current.upload_source, now(),
    v_current.journal_entry_id, v_current.journal_entry_line_id,
    v_current.sha256_hash
  )
  RETURNING id INTO v_new_id;

  UPDATE public.document_attachments
  SET is_current_version = false,
      superseded_by_id = v_new_id
  WHERE id = p_original_doc_id;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
  VALUES (
    v_caller, v_current.company_id, 'UPDATE', 'document_attachments', p_original_doc_id, v_caller,
    'Document superseded: v' || v_current.version || ' (' || v_current.sha256_hash || ') -> v' || v_next_version || ' (' || p_sha256_hash || '); new id=' || v_new_id
  );

  RETURN v_new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_version_chain(p_document_id uuid)
RETURNS TABLE(version integer, document_id uuid, hash_valid boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_id uuid;
  v_company uuid;
BEGIN
  SELECT COALESCE(da.original_id, da.id), da.company_id INTO v_root_id, v_company
  FROM public.document_attachments da
  WHERE da.id = p_document_id;

  -- One message for "missing" and "not yours": no existence oracle.
  IF v_root_id IS NULL
     OR (public.jwt_caller_is_end_user() AND NOT public.caller_is_company_member(v_company)) THEN
    RAISE EXCEPTION 'Document % not found', p_document_id;
  END IF;

  RETURN QUERY
  WITH chain AS (
    SELECT
      da.id AS doc_id,
      da.version AS ver,
      da.sha256_hash,
      da.prev_version_hash,
      LAG(da.sha256_hash) OVER (ORDER BY da.version) AS expected_prev_hash
    FROM public.document_attachments da
    WHERE da.id = v_root_id OR da.original_id = v_root_id
    ORDER BY da.version
  )
  SELECT
    chain.ver,
    chain.doc_id,
    CASE
      WHEN chain.ver = 1 THEN chain.prev_version_hash IS NULL
      ELSE chain.prev_version_hash IS NOT DISTINCT FROM chain.expected_prev_hash
    END AS hash_valid
  FROM chain
  ORDER BY chain.ver;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_version_chain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_version_chain(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.match_documents(vector, integer, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_documents(vector, integer, double precision) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.match_booking_templates(vector, integer, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_booking_templates(vector, integer, double precision) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.update_overdue_supplier_invoices() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_overdue_supplier_invoices() TO service_role;
REVOKE EXECUTE ON FUNCTION public.redact_expired_invoice_delivery_pii() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redact_expired_invoice_delivery_pii() TO service_role;

-- Production-only leftover with no migration and no caller.
DROP FUNCTION IF EXISTS public.seed_asset_categories(uuid);
