-- A migration reset must not un-onboard the company.
--
-- reset_company_for_migration archives the source company and creates a
-- replacement whose company_settings row is a copy of the source's: entity
-- type, fiscal year start month, VAT registration and period, address, every
-- answer the onboarding journey collects. It then forced
-- onboarding_complete = false and onboarding_step = 1 on that copy.
--
-- onboarding_complete has exactly one reader, the Hem page (the "Att göra"
-- nav entry, route "/"), which redirects to /onboarding when it is false.
-- /onboarding is the create-a-NEW-company journey: nothing in the product can
-- complete onboarding for a company that already exists, and the only writers
-- of onboarding_complete = true are company creation and the sandbox seed. So
-- a reset left the replacement permanently unable to open Hem, and steered
-- its owner into creating a second company for the same legal entity.
--
-- "Has this company been onboarded" is a fact about the answers on the
-- settings row, not about how much bookkeeping the company holds. The
-- replacement carries the same answers, so it inherits the same fact. The
-- fix is a removal: the two forced keys are gone from the override list.
--
-- initial_setup_path / _completed_at / _dismissed_at stay NULL on the
-- replacement. That re-opens the setup checklist on Hem (import again or
-- start from scratch, bank, Skatteverket), which is resumable and
-- dismissible: the right guide for a company that has to be filled again.
--
-- The function body below is otherwise identical to the one shipped in
-- 20260818084050 (renamed to ..._before_20260909100400 by 20260909100400,
-- which wraps it to lock zettle_connections first). CREATE OR REPLACE keeps
-- owner and privileges; the REVOKE is restated so the file stands alone.

CREATE OR REPLACE FUNCTION public.reset_company_for_migration_before_20260909100400(
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

REVOKE ALL ON FUNCTION public.reset_company_for_migration_before_20260909100400(uuid, text, text, boolean, boolean)
  FROM PUBLIC, anon, authenticated;

-- Repair the replacement companies created before this migration.
--
-- A replacement inherits from the ROOT of its reset chain: an intermediate
-- company in a chain (reset, then reset again) is itself a retained source,
-- was written with the forced false, and is immutable, so its flag says
-- nothing about whether the legal entity was onboarded.
--
-- Companies that are themselves a reset source are skipped: their settings
-- row is write-closed by company_settings_block_migration_reset_source_mutation
-- and they are archived, so nobody lands on their Hem. User-archived
-- replacements ARE repaired: un-archiving one must not resurrect the trap.
--
-- Idempotent: a second run matches no rows.
-- backfill:begin
WITH RECURSIVE chain AS (
  SELECT reset.replacement_company_id AS company_id,
         reset.source_company_id      AS root_company_id
  FROM public.company_migration_resets reset
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.company_migration_resets earlier
    WHERE earlier.replacement_company_id = reset.source_company_id
  )
  UNION ALL
  SELECT reset.replacement_company_id,
         chain.root_company_id
  FROM public.company_migration_resets reset
  JOIN chain ON chain.company_id = reset.source_company_id
)
UPDATE public.company_settings replacement
SET onboarding_complete = true,
    onboarding_step = root.onboarding_step
FROM chain
JOIN public.company_settings root
  ON root.company_id = chain.root_company_id
WHERE replacement.company_id = chain.company_id
  AND replacement.onboarding_complete IS NOT TRUE
  AND root.onboarding_complete IS TRUE
  AND NOT EXISTS (
    SELECT 1
    FROM public.company_migration_resets later
    WHERE later.source_company_id = replacement.company_id
  );
-- backfill:end

NOTIFY pgrst, 'reload schema';
