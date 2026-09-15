-- =============================================================================
-- Guarded migration of a company's legal form when its books are NOT empty
-- (design: docs/research/ekonomisk-forening-support-design.md, section 11).
--
-- The empty-books class is handled by correct_company_entity_type()
-- (20260915150200) and the read-only assessment by
-- preview_company_entity_type_change() (20260915160000). A company with
-- posted history keeps every verifikat and every account: nothing is deleted
-- or renamed. Instead the owner plans a migration (a row here holding the
-- preview snapshot and the remap plan for the accounts whose meaning changes
-- with the form), applies it, and the application books ONE reclassification
-- verifikat through the bookkeeping engine for the remaps the owner confirmed.
--
-- The RPC below never posts a verifikat: the engine owns voucher numbering,
-- period locks, balance checks and the audit trail of a posting, and a
-- reclassification is an ordinary affärshändelse in the books that the
-- reviewer must be able to storno like any other. The RPC only does what the
-- engine cannot: flip the form atomically with the missing chart accounts,
-- behind the same owner-only guard as the empty-books correction.
--
-- Guards in apply_company_entity_type_migration():
--   * caller is the company owner;
--   * the migration row belongs to the company and is still 'planned';
--   * the target form is in supported_entity_types() and differs from today;
--   * a fresh preview lists the same decision accounts and balances as the
--     stored snapshot: a posting that landed between planning and applying
--     changes what the owner decided on, so the plan is stale (code
--     ENTITY_TYPE_MIGRATION_STALE; plan again);
--   * every remap in the plan references a decision account of the snapshot.
-- Effects: companies.entity_type and company_settings.entity_type updated,
-- the target form's seeded equity/settlement/revenue accounts inserted where
-- missing (user accounts untouched), the row marked applied with the plan,
-- one audit_log row.
--
-- rollback_company_entity_type_migration() flips the form back once the
-- application has reversed the reclassification verifikat (storno through
-- the engine). Accounts added on apply stay: they may carry postings by now
-- and an unused account is harmless.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_entity_type_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_entity_type TEXT NOT NULL,
  to_entity_type TEXT NOT NULL,
  -- preview_company_entity_type_change() result at planning time.
  preview JSONB NOT NULL,
  -- [{account_from, account_to, amount, decision: 'confirmed'|'skipped', reason}]
  remap_plan JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'applied', 'rolled_back')),
  applied_at TIMESTAMPTZ,
  applied_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  rolled_back_at TIMESTAMPTZ,
  reclassification_journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  rollback_journal_entry_id UUID REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT company_entity_type_migrations_forms_differ CHECK (from_entity_type <> to_entity_type),
  CONSTRAINT company_entity_type_migrations_plan_is_array CHECK (jsonb_typeof(remap_plan) = 'array')
);

COMMENT ON TABLE public.company_entity_type_migrations IS
  'Planned, applied and rolled-back legal-form migrations of a company with posted history: preview snapshot, remap plan and the reclassification verifikat (design section 11). Never deleted.';

CREATE INDEX IF NOT EXISTS idx_company_entity_type_migrations_company
  ON public.company_entity_type_migrations (company_id, created_at DESC);

DROP TRIGGER IF EXISTS company_entity_type_migrations_updated_at ON public.company_entity_type_migrations;
CREATE TRIGGER company_entity_type_migrations_updated_at
  BEFORE UPDATE ON public.company_entity_type_migrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.company_entity_type_migrations ENABLE ROW LEVEL SECURITY;

-- Every company member may read the history; owners and admins plan; the
-- status transitions happen only inside the two SECURITY DEFINER RPCs. The
-- application links the reclassification and rollback verifikat after the
-- engine has posted them, so UPDATE is granted for those columns only.
DROP POLICY IF EXISTS "company_entity_type_migrations_select" ON public.company_entity_type_migrations;
CREATE POLICY "company_entity_type_migrations_select" ON public.company_entity_type_migrations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "company_entity_type_migrations_insert" ON public.company_entity_type_migrations;
CREATE POLICY "company_entity_type_migrations_insert" ON public.company_entity_type_migrations
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND status = 'planned'
    AND company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin')
    )
  );
DROP POLICY IF EXISTS "company_entity_type_migrations_update" ON public.company_entity_type_migrations;
CREATE POLICY "company_entity_type_migrations_update" ON public.company_entity_type_migrations
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid() AND cm.role IN ('owner', 'admin')
    )
  );

-- Default privileges hand the API roles every right; take back what the
-- history must never allow (delete, truncate) and the status columns.
REVOKE ALL ON TABLE public.company_entity_type_migrations FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.company_entity_type_migrations TO authenticated;
GRANT UPDATE (reclassification_journal_entry_id, rollback_journal_entry_id, notes)
  ON TABLE public.company_entity_type_migrations TO authenticated;
GRANT ALL ON TABLE public.company_entity_type_migrations TO service_role;

-- -----------------------------------------------------------------------------
-- Seeded accounts a form needs, inserted only where missing. The rows mirror
-- the form-specific blocks of seed_chart_of_accounts() (20260915150000); the
-- shared blocks (1930, 2440, VAT, 3001 ...) exist in every seeded chart.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_missing_form_accounts(
  p_company_id uuid,
  p_entity_type text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_added   integer := 0;
BEGIN
  SELECT created_by INTO v_user_id FROM public.companies WHERE id = p_company_id;

  WITH wanted (account_number, account_name, account_class, account_group, account_type, normal_balance, sru_code) AS (
    SELECT * FROM (VALUES
      -- ekonomisk förening
      ('2083', 'Medlemsinsatser', 2, '20', 'equity', 'credit', '7301'),
      ('2084', 'Förlagsinsatser', 2, '20', 'equity', 'credit', '7301'),
      ('2086', 'Reservfond', 2, '20', 'equity', 'credit', '7301'),
      ('2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', '7302'),
      ('2099', 'Årets resultat', 2, '20', 'equity', 'credit', '7302'),
      ('2890', 'Övriga kortfristiga skulder', 2, '28', 'liability', 'credit', '7369'),
      ('3901', 'Medlemsavgifter', 3, '39', 'revenue', 'credit', '7413'),
      ('7010', 'Löner till kollektivanställda', 7, '70', 'expense', 'debit', '7514'),
      ('7210', 'Löner till tjänstemän', 7, '72', 'expense', 'debit', '7514'),
      ('7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', '7514')
    ) AS ekf(account_number, account_name, account_class, account_group, account_type, normal_balance, sru_code)
    WHERE p_entity_type = 'ekonomisk_forening'
    UNION ALL
    SELECT * FROM (VALUES
      -- aktiebolag
      ('2081', 'Aktiekapital', 2, '20', 'equity', 'credit', '7301'),
      ('2091', 'Balanserat resultat', 2, '20', 'equity', 'credit', '7302'),
      ('2099', 'Årets resultat', 2, '20', 'equity', 'credit', '7302'),
      ('2893', 'Skuld till aktieägare', 2, '28', 'liability', 'credit', '7369'),
      ('7010', 'Löner till kollektivanställda', 7, '70', 'expense', 'debit', '7514'),
      ('7210', 'Löner till tjänstemän', 7, '72', 'expense', 'debit', '7514'),
      ('7510', 'Arbetsgivaravgifter', 7, '75', 'expense', 'debit', '7514')
    ) AS ab(account_number, account_name, account_class, account_group, account_type, normal_balance, sru_code)
    WHERE p_entity_type = 'aktiebolag'
    UNION ALL
    SELECT * FROM (VALUES
      -- ideell förening (sru_code NULL: INK3 is not modelled)
      ('2067', 'Balanserat överskott eller underskott', 2, '20', 'equity', 'credit', NULL),
      ('2068', 'Överskott eller underskott från föregående år', 2, '20', 'equity', 'credit', NULL),
      ('2069', 'Årets resultat', 2, '20', 'equity', 'credit', NULL),
      ('2890', 'Övriga kortfristiga skulder', 2, '28', 'liability', 'credit', NULL)
    ) AS ideell(account_number, account_name, account_class, account_group, account_type, normal_balance, sru_code)
    WHERE p_entity_type = 'ideell_forening'
    UNION ALL
    SELECT * FROM (VALUES
      -- enskild firma (sru_code NULL: NE-bilaga, not INK2)
      ('2010', 'Eget kapital', 2, '20', 'equity', 'credit', NULL),
      ('2013', 'Övriga egna uttag', 2, '20', 'equity', 'credit', NULL),
      ('2018', 'Övriga egna insättningar', 2, '20', 'equity', 'credit', NULL)
    ) AS ef(account_number, account_name, account_class, account_group, account_type, normal_balance, sru_code)
    WHERE p_entity_type = 'enskild_firma'
  ),
  inserted AS (
    INSERT INTO public.chart_of_accounts
      (user_id, company_id, account_number, account_name, account_class, account_group, account_type, normal_balance, plan_type, is_system_account, sru_code)
    SELECT v_user_id, p_company_id, w.account_number, w.account_name, w.account_class, w.account_group, w.account_type, w.normal_balance, 'k1', true, w.sru_code
    FROM wanted w
    WHERE NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts c
      WHERE c.company_id = p_company_id AND c.account_number = w.account_number
    )
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM inserted;

  RETURN v_added;
END;
$$;

REVOKE ALL ON FUNCTION public.add_missing_form_accounts(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_missing_form_accounts(uuid, text) TO service_role;

-- -----------------------------------------------------------------------------
-- apply_company_entity_type_migration
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_company_entity_type_migration(
  p_migration_id uuid,
  p_remap_plan jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_migration    public.company_entity_type_migrations%ROWTYPE;
  v_role         text;
  v_company      public.companies%ROWTYPE;
  v_fresh        jsonb;
  v_stored_set   jsonb;
  v_fresh_set    jsonb;
  v_remap        jsonb;
  v_added        integer;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_FORBIDDEN');
  END IF;

  IF p_remap_plan IS NULL OR jsonb_typeof(p_remap_plan) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_INVALID_PLAN');
  END IF;

  SELECT * INTO v_migration
  FROM public.company_entity_type_migrations
  WHERE id = p_migration_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_NOT_FOUND');
  END IF;

  SELECT role INTO v_role
  FROM public.company_members
  WHERE company_id = v_migration.company_id AND user_id = v_actor;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_NOT_FOUND');
  END IF;
  IF v_role <> 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_FORBIDDEN');
  END IF;

  IF v_migration.status <> 'planned' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_NOT_PLANNED', 'status', v_migration.status);
  END IF;

  IF NOT (v_migration.to_entity_type = ANY (public.supported_entity_types())) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_UNSUPPORTED');
  END IF;

  -- Serialise with the empty-books correction and with a concurrent apply of
  -- another plan for the same company.
  PERFORM pg_advisory_xact_lock(hashtextextended('correct_company_entity_type:' || v_migration.company_id::text, 0));

  SELECT * INTO v_company
  FROM public.companies
  WHERE id = v_migration.company_id
  FOR UPDATE;
  IF NOT FOUND OR v_company.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_NOT_FOUND');
  END IF;

  IF v_company.entity_type = v_migration.to_entity_type THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_SAME_FORM');
  END IF;
  IF v_company.entity_type <> v_migration.from_entity_type THEN
    -- Another migration or correction changed the form since planning.
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_STALE', 'reason', 'entity_type');
  END IF;

  -- The owner decided on the decision-account balances of the snapshot; a
  -- posting since then makes those decisions moot.
  v_fresh := public.preview_company_entity_type_change(v_migration.company_id, v_migration.to_entity_type);
  IF COALESCE((v_fresh ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_STALE', 'reason', 'preview');
  END IF;
  v_stored_set := COALESCE(v_migration.preview -> 'decision_accounts', '[]'::jsonb);
  v_fresh_set := COALESCE(v_fresh -> 'decision_accounts', '[]'::jsonb);
  IF v_stored_set <> v_fresh_set THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ENTITY_TYPE_MIGRATION_STALE',
      'reason', 'decision_accounts',
      'decision_accounts', v_fresh_set
    );
  END IF;

  -- Every remap must point at a decision account of the snapshot.
  FOR v_remap IN SELECT value FROM jsonb_array_elements(p_remap_plan) LOOP
    IF NOT (v_remap ? 'account_from') OR NOT (v_remap ? 'decision')
       OR NOT (v_remap ->> 'decision' IN ('confirmed', 'skipped')) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_INVALID_PLAN');
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_stored_set) d
      WHERE d.value ->> 'account' = v_remap ->> 'account_from'
    ) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'ENTITY_TYPE_MIGRATION_INVALID_PLAN',
        'account', v_remap ->> 'account_from'
      );
    END IF;
  END LOOP;

  UPDATE public.companies
  SET entity_type = v_migration.to_entity_type
  WHERE id = v_migration.company_id;

  UPDATE public.company_settings
  SET entity_type = v_migration.to_entity_type
  WHERE company_id = v_migration.company_id;

  v_added := public.add_missing_form_accounts(v_migration.company_id, v_migration.to_entity_type);

  UPDATE public.company_entity_type_migrations
  SET status = 'applied',
      applied_at = now(),
      applied_by = v_actor,
      remap_plan = p_remap_plan
  WHERE id = p_migration_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description
  ) VALUES (
    v_actor,
    v_migration.company_id,
    'UPDATE',
    'companies',
    v_migration.company_id,
    v_actor,
    jsonb_build_object('entity_type', v_company.entity_type),
    jsonb_build_object(
      'entity_type', v_migration.to_entity_type,
      'migration_id', p_migration_id,
      'added_accounts', v_added,
      'remap_plan', p_remap_plan
    ),
    'Legal form migrated by the owner with posted history; missing form accounts added, remap plan recorded'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'migration_id', p_migration_id,
    'entity_type', v_migration.to_entity_type,
    'previous_entity_type', v_company.entity_type,
    'added_accounts', v_added
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_company_entity_type_migration(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_company_entity_type_migration(uuid, jsonb) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- rollback_company_entity_type_migration
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rollback_company_entity_type_migration(
  p_migration_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor     uuid := auth.uid();
  v_migration public.company_entity_type_migrations%ROWTYPE;
  v_role      text;
  v_company   public.companies%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_FORBIDDEN');
  END IF;

  SELECT * INTO v_migration
  FROM public.company_entity_type_migrations
  WHERE id = p_migration_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_NOT_FOUND');
  END IF;

  SELECT role INTO v_role
  FROM public.company_members
  WHERE company_id = v_migration.company_id AND user_id = v_actor;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_NOT_FOUND');
  END IF;
  IF v_role <> 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_FORBIDDEN');
  END IF;

  IF v_migration.status <> 'applied' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_NOT_APPLIED', 'status', v_migration.status);
  END IF;

  -- A confirmed reclassification must have been reversed by the application
  -- before the form flips back, otherwise the books would carry the new
  -- form's equity posts under the old form.
  IF v_migration.reclassification_journal_entry_id IS NOT NULL
     AND v_migration.rollback_journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_RECLASSIFICATION_NOT_REVERSED');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('correct_company_entity_type:' || v_migration.company_id::text, 0));

  SELECT * INTO v_company
  FROM public.companies
  WHERE id = v_migration.company_id
  FOR UPDATE;
  IF NOT FOUND OR v_company.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_NOT_FOUND');
  END IF;
  IF v_company.entity_type <> v_migration.to_entity_type THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ENTITY_TYPE_MIGRATION_STALE', 'reason', 'entity_type');
  END IF;

  UPDATE public.companies
  SET entity_type = v_migration.from_entity_type
  WHERE id = v_migration.company_id;

  UPDATE public.company_settings
  SET entity_type = v_migration.from_entity_type
  WHERE company_id = v_migration.company_id;

  UPDATE public.company_entity_type_migrations
  SET status = 'rolled_back',
      rolled_back_at = now()
  WHERE id = p_migration_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description
  ) VALUES (
    v_actor,
    v_migration.company_id,
    'UPDATE',
    'companies',
    v_migration.company_id,
    v_actor,
    jsonb_build_object('entity_type', v_migration.to_entity_type),
    jsonb_build_object(
      'entity_type', v_migration.from_entity_type,
      'migration_id', p_migration_id,
      'rollback_journal_entry_id', v_migration.rollback_journal_entry_id
    ),
    'Legal-form migration rolled back by the owner; accounts added on apply are kept'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'migration_id', p_migration_id,
    'entity_type', v_migration.from_entity_type
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rollback_company_entity_type_migration(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rollback_company_entity_type_migration(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
