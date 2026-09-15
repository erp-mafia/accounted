-- =============================================================================
-- correct_company_entity_type(): owner-only legal-form correction for a
-- company whose books are still empty.
--
-- A company registered under the wrong legal form (Growhub Ekonomisk förening
-- is stored as an aktiebolag because onboarding could not offer the form)
-- cannot be fixed by an UPDATE on companies.entity_type: the chart seeded for
-- the wrong form (2081 Aktiekapital, 2893 Skuld till aktieägare) stays behind
-- and every form-dependent rule (closing accounts, INK2, deadlines) would run
-- against it. The design (docs/research/ekonomisk-forening-support-design.md
-- section 11) restricts the automatic path to the deterministic class: no
-- journal entries at all. Anything else needs a reviewed migration.
--
-- Guards, all fail closed with a code the API maps to a Swedish message:
--   * caller is the company owner (company_members.role = 'owner');
--   * target form is in supported_entity_types() and differs from today;
--   * no journal_entries row exists for the company (posted, draft or
--     cancelled), no invoices and no supplier invoices, so no account has ever
--     been used;
--   * every chart_of_accounts row is a system-seeded one, so re-seeding does
--     not discard a user-created account (seed_chart_of_accounts() returns
--     early when any account exists, so the seeded rows are removed first).
--
-- Effects, in one transaction: companies.entity_type and
-- company_settings.entity_type updated, the seeded chart replaced by the
-- target form's seed, one audit_log UPDATE row with the old and new form and
-- the number of replaced accounts.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.correct_company_entity_type(
  p_company_id uuid,
  p_entity_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor            uuid := auth.uid();
  v_role             text;
  v_company          public.companies%ROWTYPE;
  v_entry_count      integer;
  v_invoice_count    integer;
  v_supplier_count   integer;
  v_custom_accounts  integer;
  v_removed_accounts integer;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_FORBIDDEN');
  END IF;

  IF p_entity_type IS NULL OR NOT (p_entity_type = ANY (public.supported_entity_types())) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_UNSUPPORTED');
  END IF;

  SELECT role INTO v_role
  FROM public.company_members
  WHERE company_id = p_company_id
    AND user_id = v_actor;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_NOT_FOUND');
  END IF;

  IF v_role <> 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_FORBIDDEN');
  END IF;

  SELECT * INTO v_company
  FROM public.companies
  WHERE id = p_company_id
  FOR UPDATE;

  IF NOT FOUND OR v_company.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_CHANGE_NOT_FOUND');
  END IF;

  IF v_company.entity_type = p_entity_type THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'entity_type', p_entity_type);
  END IF;

  -- Lock the tables a concurrent posting would touch, then prove the books
  -- are empty. A single verifikat of any status makes the company ineligible.
  PERFORM 1 FROM public.journal_entries WHERE company_id = p_company_id FOR UPDATE;
  PERFORM 1 FROM public.chart_of_accounts WHERE company_id = p_company_id FOR UPDATE;

  SELECT count(*) INTO v_entry_count FROM public.journal_entries WHERE company_id = p_company_id;
  SELECT count(*) INTO v_invoice_count FROM public.invoices WHERE company_id = p_company_id;
  SELECT count(*) INTO v_supplier_count FROM public.supplier_invoices WHERE company_id = p_company_id;
  IF v_entry_count > 0 OR v_invoice_count > 0 OR v_supplier_count > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ENTITY_TYPE_CHANGE_BOOKS_NOT_EMPTY',
      'journal_entries', v_entry_count,
      'invoices', v_invoice_count,
      'supplier_invoices', v_supplier_count
    );
  END IF;

  SELECT count(*) INTO v_custom_accounts
  FROM public.chart_of_accounts
  WHERE company_id = p_company_id
    AND is_system_account IS DISTINCT FROM true;
  IF v_custom_accounts > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ENTITY_TYPE_CHANGE_CUSTOM_ACCOUNTS',
      'custom_accounts', v_custom_accounts
    );
  END IF;

  DELETE FROM public.chart_of_accounts WHERE company_id = p_company_id;
  GET DIAGNOSTICS v_removed_accounts = ROW_COUNT;

  UPDATE public.companies
  SET entity_type = p_entity_type
  WHERE id = p_company_id;

  UPDATE public.company_settings
  SET entity_type = p_entity_type
  WHERE company_id = p_company_id;

  PERFORM public.seed_chart_of_accounts(p_company_id, p_entity_type);

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
    jsonb_build_object('entity_type', v_company.entity_type),
    jsonb_build_object(
      'entity_type', p_entity_type,
      'replaced_system_accounts', v_removed_accounts
    ),
    'Legal form corrected by the owner while the books were empty; seeded chart replaced'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'changed', true,
    'entity_type', p_entity_type,
    'previous_entity_type', v_company.entity_type,
    'replaced_system_accounts', v_removed_accounts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.correct_company_entity_type(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_company_entity_type(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
