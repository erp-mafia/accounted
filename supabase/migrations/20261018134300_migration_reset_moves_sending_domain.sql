-- "Gör om migrering" moves the company's invoice sending domain to the
-- replacement company, like its inbound domains (crm#1288 follow-up).
--
-- reset_company_for_migration (20261012100700) moved company_inbound_domains
-- but left company_sending_domains on the archived source. The replacement
-- then could not claim the same domain (idx_company_sending_domains_domain is
-- global), its invoice mail fell back to the platform sender, and the
-- archived company kept a slot of the shared Resend account. Moving the row
-- keeps the company's verified DKIM and provider registration: the domain is
-- operational configuration of the same legal entity, not accounting data,
-- and is not write-closed by block_migration_reset_source_mutation.
--
-- The move needs a narrow exception in the tenant guard
-- (guard_company_sending_domain_tenant_write, 20260822130000): the reset runs
-- SECURITY DEFINER but still under the owner's tenant JWT claims, and the
-- guard refuses any company_id change from a tenant. The exception admits a
-- company_id change only when company_migration_resets records exactly that
-- source -> replacement pair (an append-only table tenants cannot write) and
-- domain plus verification state are unchanged. The reset therefore moves the
-- row right after inserting its company_migration_resets row.
--
-- Both functions are restated whole under their existing names; CREATE OR
-- REPLACE keeps owner, ACL, SECURITY DEFINER and search_path, and the grants
-- are restated so the file stands alone. No reset so far came from a company
-- that ever had a sending domain, so no row needs a backfill. Pinned in
-- tests/pg/company-migration-reset.pg.test.ts and
-- src/extensions/general/email/__tests__/company-sending-domains.pg.test.ts.

-- 1. Tenant guard: admit the recorded migration-reset move ------------------

CREATE OR REPLACE FUNCTION public.guard_company_sending_domain_tenant_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims jsonb;
  v_role text;
BEGIN
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    v_claims->>'role'
  );

  -- Trusted: service role, or no PostgREST context at all.
  IF coalesce(v_role, '') = 'service_role'
     OR (v_claims IS NULL AND v_role IS NULL) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
       OR NEW.resend_domain_id IS NOT NULL
       OR NEW.dns_records IS NOT NULL
       OR NEW.verified_at IS NOT NULL
       OR NEW.last_checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'company_sending_domains: a tenant claim starts as pending; verification state is written by the server'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  -- The one company_id change a tenant request may carry: the migration
  -- reset moving the row from its archived source to the replacement that
  -- company_migration_resets records (tenants cannot write that table), with
  -- domain and verification state unchanged.
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     AND NEW.domain IS NOT DISTINCT FROM OLD.domain
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.resend_domain_id IS NOT DISTINCT FROM OLD.resend_domain_id
     AND NEW.dns_records IS NOT DISTINCT FROM OLD.dns_records
     AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at
     AND NEW.last_checked_at IS NOT DISTINCT FROM OLD.last_checked_at
     AND EXISTS (
       SELECT 1
       FROM public.company_migration_resets r
       WHERE r.source_company_id = OLD.company_id
         AND r.replacement_company_id = NEW.company_id
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.domain IS DISTINCT FROM OLD.domain
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.resend_domain_id IS DISTINCT FROM OLD.resend_domain_id
     OR NEW.dns_records IS DISTINCT FROM OLD.dns_records
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.last_checked_at IS DISTINCT FROM OLD.last_checked_at THEN
    RAISE EXCEPTION 'company_sending_domains: domain and verification state are server-managed; tenants may only change sender_local_part, sender_name and enabled'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_company_sending_domain_tenant_write() FROM PUBLIC;

-- 2. Reset: move the sending domain after recording the reset ---------------

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
