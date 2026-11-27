-- "Gör om migrering" gives the replacement company its owner's personal team
-- when the source company has no team.
--
-- reset_company_for_migration (20261018134300) copies the source's team_id to
-- the replacement. A company created through POST /api/v1/companies or the
-- MCP tools without a named team got no team until #3995 (their personal-team
-- lookup always failed), and a reset of such a company handed the brand-new
-- replacement no team either, although its owner has a personal team and
-- every way of creating a company attaches it there (WL-08).
--
-- The replacement now keeps the source's team as before, and joins the
-- owner's personal team when the source has none: ensure_user_team(), the
-- team the web app gives every company its owner creates there (kind
-- personal, the earliest, then the lowest id, created when the owner has
-- none yet), so the reset calls the rule instead of copying it. The reset
-- acts as the owner (auth.uid(), also when support runs it through
-- support_reset_company_for_migration), the user ensure_user_team reads. The
-- team's members reach the replacement through sync_team_to_company, as in
-- create_company_with_owner. A source with a team keeps it on the
-- replacement, a byrå client's byrå team included.
--
-- The function is restated whole under its name: the body is
-- 20261018134300's except for the team. CREATE OR REPLACE keeps owner, ACL,
-- SECURITY DEFINER and search_path, and the grants are restated so the file
-- stands alone. Companies that already have no team are not touched here.
-- Pinned in tests/pg/company-migration-reset.pg.test.ts.

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
  v_sending_count       integer := 0;
  v_team_id             uuid;
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
  PERFORM 1 FROM public.company_sending_domains WHERE company_id = p_company_id FOR UPDATE;
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

  -- The replacement keeps the source's team. A source without one gives the
  -- replacement the owner's personal team (20261126150000): ensure_user_team,
  -- the team every company the owner creates in the web app joins, made when
  -- the owner has none yet. Read after every check, so a refused reset makes
  -- no team.
  v_team_id := v_source.team_id;
  IF v_team_id IS NULL THEN
    v_team_id := public.ensure_user_team();
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
    v_team_id,
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

  -- A team the replacement joins here, and the source was never on, gives
  -- its members what it gives them in every company of the team, as in
  -- create_company_with_owner. The owner is a member already.
  IF v_source.team_id IS NULL THEN
    PERFORM public.sync_team_to_company(v_new_company_id, v_team_id);
  END IF;

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

  -- The invoice sending domain moves too (20261018134300), after the reset
  -- row below exists: the tenant guard on company_sending_domains lets a
  -- company_id change through only for a recorded source -> replacement
  -- pair. Counted here, under the row lock above, for the snapshot.
  SELECT count(*) INTO v_sending_count
  FROM public.company_sending_domains
  WHERE company_id = p_company_id;

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
      'sending_domains_transferred', v_sending_count,
      'pending_invitations_transferred', v_invite_count
    ),
    v_eligibility -> 'counts',
    v_archived_at
  );

  -- Keep the company's own invoice sending domain on the active company, with
  -- its provider registration and verified DNS unchanged. Left on the
  -- archived source it kept a slot of the shared provider account and the
  -- unique index refused the replacement the same domain.
  UPDATE public.company_sending_domains
  SET company_id = v_new_company_id
  WHERE company_id = p_company_id;

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
