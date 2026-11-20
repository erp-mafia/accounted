-- Övergång till K3 (BFNAR 2012:1 kap. 35) for a company whose earlier
-- årsredovisningar were prepared under K2.
--
-- Why this exists: a company that moved from K2 to K3 had no way to make the
-- first K3 year's opening balance a K3 balance sheet. Its fixed assets kept
-- the K2 plan as one unit (35.18 asks for the carrying amount to be split on
-- significant components at the transition), no opening deferred tax was
-- booked (29, unless the 35.27 relief), and nothing recorded the facts the
-- transition notes need (35.31: first application and the relief rules
-- used; 35.33: the principles changed).
--
-- The transition date is the first day of the first K3 year: the mindre
-- företag route of 35.7 andra stycket, comparatives not restated (ÅRL 3:5
-- fjärde stycket), which is the only route Accounted supports. Locked and
-- closed years are never touched: every adjustment is booked in the first
-- K3 year, dated its first day, against equity (35.11).
--
-- What this migration adds:
--   1. k3_transitions: one per company (35.1, chapter 35 is applied once),
--      on the first K3 fiscal year, with the 35.27 choice, the relief rules
--      applied (35.21-35.29, 35.34), the principles changed (35.33), and,
--      once committed, the transition voucher and the opening deferred tax
--      it was computed from.
--   2. asset_transition_splits: an asset split on components at the
--      transition (35.18), with what the plain asset was before the split,
--      so an unposted split can be undone exactly.
--   3. split_asset_at_k3_transition: splits (or re-splits, or undoes) an
--      asset at the transition date. Each component's opening is its share
--      of the accumulated depreciation at the transition (the asset's
--      opening plus everything posted on it as a whole), so the component
--      engine continues prospectively from the K2 carrying amount and never
--      recharges a year.
--   4. commit_k3_transition: posts the transition voucher (draft through the
--      engine, numbered by commit_journal_entry) and marks the transition
--      committed in the same transaction.
--
-- pg-test: tests/pg/k3-transition.pg.test.ts

-- =============================================================================
-- 1. k3_transitions
-- =============================================================================

CREATE TABLE public.k3_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The first K3 fiscal year; the transition date is its first day (35.7).
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  -- K3 35.27: no deferred tax in the opening balance, the information not
  -- being available without unreasonable cost.
  deferred_tax_relief boolean NOT NULL DEFAULT false,
  -- The other relief rules applied (35.21-35.26, 35.28, 35.29, 35.34), for
  -- the 35.31 note.
  relief_rules text[] NOT NULL DEFAULT '{}'::text[],
  -- K3 35.33: the accounting principles changed at the transition.
  changed_principles text NOT NULL DEFAULT '' CHECK (length(changed_principles) <= 4000),
  -- Set only by commit_k3_transition: the voucher (NULL when there was
  -- nothing to book), the opening deferred tax at the transition and the
  -- temporary differences it was computed from.
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  opening_deferred_tax numeric(15, 2) NOT NULL DEFAULT 0,
  deferred_tax_items jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(deferred_tax_items) = 'array' AND jsonb_array_length(deferred_tax_items) <= 200),
  committed_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT k3_transitions_one_per_company UNIQUE (company_id),
  CONSTRAINT k3_transitions_relief_rules_check CHECK (
    relief_rules <@ ARRAY['35.21', '35.22', '35.23', '35.24', '35.25', '35.26', '35.28', '35.29', '35.34']::text[]
  ),
  CONSTRAINT k3_transitions_relief_no_deferred_tax CHECK (
    NOT deferred_tax_relief OR (opening_deferred_tax = 0 AND jsonb_array_length(deferred_tax_items) = 0)
  ),
  CONSTRAINT k3_transitions_entry_committed CHECK (journal_entry_id IS NULL OR committed_at IS NOT NULL)
);

COMMENT ON TABLE public.k3_transitions IS
  'The transition to K3 (BFNAR 2012:1 kap. 35), once per company: the first K3 fiscal year (its first day is the transition date, 35.7 andra stycket), the 35.27 relief, the relief rules applied and the principles changed (35.31, 35.33), and the committed transition voucher with the opening deferred tax.';

CREATE INDEX idx_k3_transitions_period ON public.k3_transitions (fiscal_period_id);
CREATE INDEX idx_k3_transitions_entry ON public.k3_transitions (journal_entry_id) WHERE journal_entry_id IS NOT NULL;

ALTER TABLE public.k3_transitions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.k3_transitions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.k3_transitions TO authenticated;

CREATE POLICY k3_transitions_select ON public.k3_transitions
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY k3_transitions_insert ON public.k3_transitions
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY k3_transitions_update ON public.k3_transitions
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY k3_transitions_delete ON public.k3_transitions
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER k3_transitions_updated_at
  BEFORE UPDATE ON public.k3_transitions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.k3_transitions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE TRIGGER k3_transitions_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.k3_transitions
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

-- Committed: a voucher still posted, or committed with nothing to book. A
-- transition whose voucher was reversed (storno) is open again.
CREATE FUNCTION public.k3_transition_is_committed(p_journal_entry_id uuid, p_committed_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT p_committed_at IS NOT NULL
     AND (
       p_journal_entry_id IS NULL
       OR EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.id = p_journal_entry_id AND je.status = 'posted'
       )
     );
$function$;

REVOKE ALL ON FUNCTION public.k3_transition_is_committed(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.guard_k3_transitions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_commit boolean := coalesce(current_setting('gnubok.k3_transition_commit', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Tenant teardown removes the transition with the company.
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    IF public.k3_transition_is_committed(OLD.journal_entry_id, OLD.committed_at) THEN
      RAISE EXCEPTION 'K3_TRANSITION_COMMITTED' USING ERRCODE = 'PT409',
        HINT = 'Reverse the transition voucher (storno) first.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.asset_transition_splits s WHERE s.transition_id = OLD.id) THEN
      RAISE EXCEPTION 'K3_TRANSITION_HAS_SPLITS' USING ERRCODE = 'PT409',
        HINT = 'Undo the component splits made at the transition first.';
    END IF;
    RETURN OLD;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_periods fp
     WHERE fp.id = NEW.fiscal_period_id AND fp.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'The transition year is not a fiscal year of the company' USING ERRCODE = '23514';
  END IF;

  -- The transition is made in the first K3 year (35.7): that year's own
  -- framework, not the company's latest.
  IF (TG_OP = 'INSERT' OR NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id)
     AND public.fiscal_year_framework(NEW.company_id, NEW.fiscal_period_id) IS DISTINCT FROM 'k3' THEN
    RAISE EXCEPTION 'K3_TRANSITION_NOT_K3' USING ERRCODE = 'PT409',
      HINT = 'The transition year must be reported under K3.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT v_commit AND (
      NEW.journal_entry_id IS NOT NULL
      OR NEW.committed_at IS NOT NULL
      OR NEW.opening_deferred_tax <> 0
      OR jsonb_array_length(NEW.deferred_tax_items) > 0
    ) THEN
      RAISE EXCEPTION 'A K3 transition is committed only by commit_k3_transition' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'A K3 transition''s identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NOT v_commit AND (
    NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
    OR NEW.committed_at IS DISTINCT FROM OLD.committed_at
    OR NEW.opening_deferred_tax IS DISTINCT FROM OLD.opening_deferred_tax
    OR NEW.deferred_tax_items IS DISTINCT FROM OLD.deferred_tax_items
  ) THEN
    RAISE EXCEPTION 'A K3 transition is committed only by commit_k3_transition' USING ERRCODE = '23514';
  END IF;

  IF NOT v_commit AND public.k3_transition_is_committed(OLD.journal_entry_id, OLD.committed_at) THEN
    -- The notes (relief rules, principles) stay editable; what was booked
    -- does not.
    IF NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id
       OR NEW.deferred_tax_relief IS DISTINCT FROM OLD.deferred_tax_relief THEN
      RAISE EXCEPTION 'K3_TRANSITION_COMMITTED' USING ERRCODE = 'PT409',
        HINT = 'Reverse the transition voucher (storno) first.';
    END IF;
  END IF;

  IF NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id
     AND EXISTS (SELECT 1 FROM public.asset_transition_splits s WHERE s.transition_id = OLD.id) THEN
    RAISE EXCEPTION 'K3_TRANSITION_HAS_SPLITS' USING ERRCODE = 'PT409',
      HINT = 'Undo the component splits made at the transition first.';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_k3_transitions() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_k3_transitions
  BEFORE INSERT OR UPDATE OR DELETE ON public.k3_transitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_k3_transitions();

CREATE TRIGGER audit_k3_transitions
  AFTER INSERT OR UPDATE OR DELETE ON public.k3_transitions
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 2. asset_transition_splits
-- =============================================================================

CREATE TABLE public.asset_transition_splits (
  asset_id uuid PRIMARY KEY REFERENCES public.assets(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  transition_id uuid NOT NULL REFERENCES public.k3_transitions(id) ON DELETE CASCADE,
  -- The transition date: the components' openings are stated the day before.
  split_date date NOT NULL,
  -- The accumulated depreciation at the transition, carried into the
  -- components' openings: the asset's opening plus everything posted on it
  -- as a whole.
  carried_accumulated numeric(15, 2) NOT NULL CHECK (carried_accumulated >= 0),
  -- The plain asset before the split, for an exact undo.
  original_cost numeric(15, 2) NOT NULL,
  original_salvage numeric(15, 2) NOT NULL,
  original_opening numeric(15, 2) NOT NULL,
  original_opening_date date,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.asset_transition_splits IS
  'Assets split on significant components at the transition to K3 (BFNAR 2012:1 35.18): the carrying amount at the transition date carried into the components, and the plain asset before the split. Written only by split_asset_at_k3_transition.';

CREATE INDEX idx_asset_transition_splits_company ON public.asset_transition_splits (company_id);
CREATE INDEX idx_asset_transition_splits_transition ON public.asset_transition_splits (transition_id);

ALTER TABLE public.asset_transition_splits ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asset_transition_splits TO service_role;
GRANT SELECT ON TABLE public.asset_transition_splits TO authenticated;

CREATE POLICY asset_transition_splits_select ON public.asset_transition_splits
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER asset_transition_splits_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.asset_transition_splits
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

-- The components a transition split made carry the history before the split
-- in their openings, so their basis (cost, opening, dates) moves only with
-- the split itself (split_asset_at_k3_transition re-splits or undoes it
-- while nothing is posted per component). A component added after the
-- transition is an ordinary one.
CREATE FUNCTION public.guard_transition_split_components()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_row public.asset_components;
  v_split_date date;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF current_setting('gnubok.allow_delete', true) = 'true'
     OR coalesce(current_setting('gnubok.asset_component_split', true), '') = 'on'
     OR coalesce(current_setting('gnubok.asset_components_backfill', true), '') = 'on' THEN
    RETURN v_row;
  END IF;

  SELECT s.split_date INTO v_split_date
    FROM public.asset_transition_splits s
   WHERE s.asset_id = v_row.asset_id;
  IF NOT FOUND OR OLD.acquisition_date >= v_split_date THEN
    RETURN v_row;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409',
      HINT = 'The component was made by the K3 transition split: change or undo the split instead.';
  END IF;

  IF NEW.cost IS DISTINCT FROM OLD.cost
     OR NEW.opening_accumulated_depreciation IS DISTINCT FROM OLD.opening_accumulated_depreciation
     OR NEW.opening_depreciation_date IS DISTINCT FROM OLD.opening_depreciation_date
     OR NEW.acquisition_date IS DISTINCT FROM OLD.acquisition_date
     OR NEW.depreciation_start_date IS DISTINCT FROM OLD.depreciation_start_date THEN
    RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409',
      HINT = 'The component was made by the K3 transition split: change or undo the split instead.';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_transition_split_components() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_transition_split_components
  BEFORE UPDATE OR DELETE ON public.asset_components
  FOR EACH ROW EXECUTE FUNCTION public.guard_transition_split_components();

-- =============================================================================
-- 3. split_asset_at_k3_transition
-- =============================================================================

-- p_components: [{name, cost, useful_life_months, salvage_value,
-- opening_accumulated_depreciation}], the asset's whole cost and its whole
-- accumulated depreciation at the transition; [] undoes the split.
CREATE FUNCTION public.split_asset_at_k3_transition(
  p_company_id uuid,
  p_asset_id uuid,
  p_components jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_transition public.k3_transitions;
  v_period_start date;
  v_period_closed boolean;
  v_period_locked_at timestamptz;
  v_company_lock_date date;
  v_asset public.assets;
  v_split public.asset_transition_splits;
  v_plain_posted numeric;
  v_carried numeric;
  v_cost_sum numeric;
  v_opening_sum numeric;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (
       NOT public.caller_is_company_member(p_company_id)
       OR NOT public.current_user_can_write()
     ) THEN
    RAISE EXCEPTION 'unauthorized K3 transition split for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_components IS NULL OR jsonb_typeof(p_components) <> 'array' THEN
    RAISE EXCEPTION 'Components must be an array' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_components) AS e(v)
     WHERE jsonb_typeof(e.v) <> 'object'
        OR length(btrim(coalesce(e.v ->> 'name', ''))) = 0
        OR length(e.v ->> 'name') > 200
        OR jsonb_typeof(e.v -> 'cost') <> 'number'
        OR jsonb_typeof(e.v -> 'salvage_value') <> 'number'
        OR jsonb_typeof(e.v -> 'opening_accumulated_depreciation') <> 'number'
        OR coalesce(jsonb_typeof(e.v -> 'useful_life_months'), 'null') NOT IN ('number', 'null')
  ) THEN
    RAISE EXCEPTION 'Invalid component' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_transition
    FROM public.k3_transitions t
   WHERE t.company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'K3_TRANSITION_NOT_STARTED' USING ERRCODE = 'PT409';
  END IF;
  IF public.k3_transition_is_committed(v_transition.journal_entry_id, v_transition.committed_at) THEN
    RAISE EXCEPTION 'K3_TRANSITION_COMMITTED' USING ERRCODE = 'PT409';
  END IF;

  SELECT fp.period_start, fp.is_closed, fp.locked_at
    INTO v_period_start, v_period_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_transition.fiscal_period_id;
  IF v_period_closed OR v_period_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot split at the K3 transition in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;
  SELECT cs.bookkeeping_locked_through INTO v_company_lock_date
    FROM public.company_settings cs WHERE cs.company_id = p_company_id;
  IF v_company_lock_date IS NOT NULL AND v_period_start <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_asset
    FROM public.assets a
   WHERE a.id = p_asset_id AND a.company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found: %', p_asset_id USING ERRCODE = 'P0002';
  END IF;
  IF v_asset.disposed_at IS NOT NULL THEN
    RAISE EXCEPTION 'ASSET_DISPOSED' USING ERRCODE = 'PT409';
  END IF;
  -- 17.4 is about materiella anläggningstillgångar, and mark is never
  -- depreciated; an asset acquired in a K3 year is split the ordinary way.
  IF v_asset.category IN ('immaterial', 'land') THEN
    RAISE EXCEPTION 'ASSET_NOT_SPLITTABLE' USING ERRCODE = 'PT409';
  END IF;
  IF v_asset.acquisition_date >= v_period_start THEN
    RAISE EXCEPTION 'ASSET_ACQUIRED_UNDER_K3' USING ERRCODE = 'PT409';
  END IF;
  -- The split is at the transition date: nothing may be posted on the asset
  -- from that day on.
  IF EXISTS (
    SELECT 1
      FROM public.depreciation_schedules ds
      JOIN public.fiscal_periods fp ON fp.id = ds.fiscal_period_id
     WHERE ds.asset_id = p_asset_id
       AND ds.journal_entry_id IS NOT NULL
       AND fp.period_end >= v_period_start
  ) THEN
    RAISE EXCEPTION 'LATER_DEPRECIATION_POSTED' USING ERRCODE = 'PT409';
  END IF;
  IF public.asset_net_impairment(p_asset_id, NULL) <> 0 THEN
    RAISE EXCEPTION 'ASSET_IMPAIRED' USING ERRCODE = 'PT409';
  END IF;

  SELECT * INTO v_split
    FROM public.asset_transition_splits s
   WHERE s.asset_id = p_asset_id
   FOR UPDATE;

  IF FOUND THEN
    -- Re-split or undo: only while nothing has reached the books per
    -- component and the components are still the split's own.
    IF EXISTS (
      SELECT 1
        FROM public.asset_components c
       WHERE c.asset_id = p_asset_id
         AND (
           c.derecognised_at IS NOT NULL
           OR c.acquisition_date >= v_split.split_date
           OR public.asset_component_has_posted_depreciation(c.id)
         )
    ) THEN
      RAISE EXCEPTION 'TRANSITION_SPLIT_IN_USE' USING ERRCODE = 'PT409';
    END IF;
    PERFORM set_config('gnubok.asset_component_split', 'on', true);
    DELETE FROM public.asset_components c WHERE c.asset_id = p_asset_id;
    PERFORM set_config('gnubok.asset_component_split', 'off', true);
    PERFORM set_config('gnubok.asset_components_sync', 'on', true);
    UPDATE public.assets a
       SET acquisition_cost = v_split.original_cost,
           salvage_value = v_split.original_salvage,
           opening_accumulated_depreciation = v_split.original_opening,
           opening_depreciation_date = v_split.original_opening_date
     WHERE a.id = p_asset_id;
    PERFORM set_config('gnubok.asset_components_sync', 'off', true);
    DELETE FROM public.asset_transition_splits s WHERE s.asset_id = p_asset_id;
    SELECT * INTO v_asset FROM public.assets a WHERE a.id = p_asset_id;
  ELSIF EXISTS (SELECT 1 FROM public.asset_components c WHERE c.asset_id = p_asset_id) THEN
    RAISE EXCEPTION 'ASSET_HAS_COMPONENTS' USING ERRCODE = 'PT409';
  END IF;

  IF jsonb_array_length(p_components) = 0 THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(ds.planned_depreciation), 0)
    INTO v_plain_posted
    FROM public.depreciation_schedules ds
   WHERE ds.asset_id = p_asset_id
     AND ds.journal_entry_id IS NOT NULL;
  v_carried := round(coalesce(v_asset.opening_accumulated_depreciation, 0) + v_plain_posted, 2);

  SELECT coalesce(sum((e.v ->> 'cost')::numeric), 0),
         coalesce(sum((e.v ->> 'opening_accumulated_depreciation')::numeric), 0)
    INTO v_cost_sum, v_opening_sum
    FROM jsonb_array_elements(p_components) AS e(v);

  -- The service computes the split from the same figures: a mismatch means
  -- the asset changed under it.
  IF abs(v_cost_sum - v_asset.acquisition_cost) > 0.005 OR abs(v_opening_sum - v_carried) > 0.005 THEN
    RAISE EXCEPTION 'ASSET_COMPONENTS_CHANGED' USING ERRCODE = 'PT409',
      DETAIL = format('cost %s of %s, opening %s of %s', v_cost_sum, v_asset.acquisition_cost, v_opening_sum, v_carried);
  END IF;

  INSERT INTO public.asset_transition_splits (
    asset_id, company_id, transition_id, split_date, carried_accumulated,
    original_cost, original_salvage, original_opening, original_opening_date
  ) VALUES (
    p_asset_id, p_company_id, v_transition.id, v_period_start, v_carried,
    v_asset.acquisition_cost, v_asset.salvage_value,
    coalesce(v_asset.opening_accumulated_depreciation, 0), v_asset.opening_depreciation_date
  );

  PERFORM set_config('gnubok.asset_component_split', 'on', true);
  INSERT INTO public.asset_components (
    user_id, company_id, asset_id, name, cost, useful_life_months, salvage_value,
    acquisition_date, depreciation_start_date, opening_accumulated_depreciation,
    opening_depreciation_date, sort_order
  )
  SELECT coalesce(auth.uid(), v_asset.user_id), p_company_id, p_asset_id, btrim(e.v ->> 'name'),
         (e.v ->> 'cost')::numeric,
         (e.v ->> 'useful_life_months')::integer,
         (e.v ->> 'salvage_value')::numeric,
         v_asset.acquisition_date,
         v_asset.depreciation_start_date,
         (e.v ->> 'opening_accumulated_depreciation')::numeric,
         CASE WHEN (e.v ->> 'opening_accumulated_depreciation')::numeric > 0 THEN v_period_start - 1 END,
         (e.ord - 1)::integer
    FROM jsonb_array_elements(p_components) WITH ORDINALITY AS e(v, ord);
  PERFORM set_config('gnubok.asset_component_split', 'off', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.split_asset_at_k3_transition(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.split_asset_at_k3_transition(uuid, uuid, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.split_asset_at_k3_transition(uuid, uuid, jsonb) IS
  'K3 35.18: splits a plain fixed asset on significant components at the transition date, each component opening at its share of the accumulated depreciation at the transition. Re-splits or undoes ([]) a split while nothing is posted per component.';

-- =============================================================================
-- 4. commit_k3_transition
-- =============================================================================

-- p_entry_id NULL: nothing to book (the 35.27 relief, or no difference);
-- the transition is committed without a voucher.
CREATE FUNCTION public.commit_k3_transition(
  p_company_id uuid,
  p_entry_id uuid,
  p_equity_account text,
  p_opening_deferred_tax numeric,
  p_deferred_tax_change numeric,
  p_deferred_tax_items jsonb,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_transition public.k3_transitions;
  v_period_start date;
  v_period_closed boolean;
  v_period_locked_at timestamptz;
  v_company_lock_date date;
  v_bad_lines integer;
  v_net_change numeric;
  v_items_sum numeric;
  v_voucher_number integer;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (
       NOT public.caller_is_company_member(p_company_id)
       OR NOT public.current_user_can_write()
     ) THEN
    RAISE EXCEPTION 'unauthorized K3 transition for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_deferred_tax_items IS NULL OR jsonb_typeof(p_deferred_tax_items) <> 'array' THEN
    RAISE EXCEPTION 'Deferred tax items must be an array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_deferred_tax_items) AS e(v)
     WHERE jsonb_typeof(e.v) <> 'object'
        OR coalesce(e.v ->> 'kind', '') NOT IN ('loss_carryforward', 'building', 'manual')
        OR length(btrim(coalesce(e.v ->> 'label', ''))) = 0
        OR jsonb_typeof(e.v -> 'carrying_amount') <> 'number'
        OR jsonb_typeof(e.v -> 'tax_value') <> 'number'
        OR jsonb_typeof(e.v -> 'temporary_difference') <> 'number'
        OR jsonb_typeof(e.v -> 'tax_rate') <> 'number'
        OR jsonb_typeof(e.v -> 'deferred_tax') <> 'number'
        OR (e.v ? 'reason' AND jsonb_typeof(e.v -> 'reason') NOT IN ('string', 'null'))
  ) THEN
    RAISE EXCEPTION 'Invalid deferred tax item' USING ERRCODE = '22023';
  END IF;
  -- K3 29.29: a loss carried into the first K3 year is recognised only with
  -- its reason, kept on the committed transition's items.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_deferred_tax_items) AS e(v)
     WHERE e.v ->> 'kind' = 'loss_carryforward'
       AND length(btrim(coalesce(e.v ->> 'reason', ''))) = 0
  ) THEN
    RAISE EXCEPTION 'A recognised loss carried forward needs its reason (K3 29.29)' USING ERRCODE = '22023';
  END IF;
  IF p_equity_account IS NULL OR p_equity_account !~ '^20[0-9]{2}$' THEN
    RAISE EXCEPTION 'Invalid equity account %', p_equity_account USING ERRCODE = '22023';
  END IF;

  -- Serialises with every other posting of the company.
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT * INTO v_transition
    FROM public.k3_transitions t
   WHERE t.company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'K3_TRANSITION_NOT_STARTED' USING ERRCODE = 'PT409';
  END IF;
  IF public.k3_transition_is_committed(v_transition.journal_entry_id, v_transition.committed_at) THEN
    RAISE EXCEPTION 'K3_TRANSITION_COMMITTED' USING ERRCODE = 'PT409';
  END IF;

  SELECT fp.period_start, fp.is_closed, fp.locked_at
    INTO v_period_start, v_period_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = v_transition.fiscal_period_id;
  IF v_period_closed OR v_period_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot book the K3 transition in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;
  IF public.fiscal_year_framework(p_company_id, v_transition.fiscal_period_id) IS DISTINCT FROM 'k3' THEN
    RAISE EXCEPTION 'K3_TRANSITION_NOT_K3' USING ERRCODE = 'PT409',
      HINT = 'The transition year must be reported under K3.';
  END IF;
  SELECT cs.bookkeeping_locked_through INTO v_company_lock_date
    FROM public.company_settings cs WHERE cs.company_id = p_company_id;
  IF v_company_lock_date IS NOT NULL AND v_period_start <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(sum((e.v ->> 'deferred_tax')::numeric), 0)
    INTO v_items_sum
    FROM jsonb_array_elements(p_deferred_tax_items) AS e(v);
  IF abs(v_items_sum - coalesce(p_opening_deferred_tax, 0)) > 0.005 THEN
    RAISE EXCEPTION 'Deferred tax items % do not sum to the opening deferred tax %', v_items_sum, p_opening_deferred_tax
      USING ERRCODE = '23514';
  END IF;
  IF v_transition.deferred_tax_relief AND (
    coalesce(p_opening_deferred_tax, 0) <> 0 OR jsonb_array_length(p_deferred_tax_items) > 0
  ) THEN
    RAISE EXCEPTION 'The 35.27 relief books no opening deferred tax' USING ERRCODE = '23514';
  END IF;

  IF p_entry_id IS NULL THEN
    IF abs(coalesce(p_deferred_tax_change, 0)) > 0.005 THEN
      RAISE EXCEPTION 'A deferred tax change needs a voucher' USING ERRCODE = '23514';
    END IF;
  ELSE
    PERFORM 1
       FROM public.journal_entries je
      WHERE je.id = p_entry_id
        AND je.company_id = p_company_id
        AND je.fiscal_period_id = v_transition.fiscal_period_id
        AND je.entry_date = v_period_start
        AND je.status = 'draft'
        AND je.source_type = 'system'
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Valid K3 transition draft not found: %', p_entry_id USING ERRCODE = '22023';
    END IF;

    -- Balance sheet lines against the equity account only (35.11): no
    -- result account, and no other equity account.
    SELECT count(*) FILTER (
             WHERE l.account_number !~ '^[12][0-9]{3}$'
                OR (l.account_number ~ '^20' AND l.account_number <> p_equity_account)
           ),
           coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE l.account_number = '2240'), 0)
             - coalesce(sum(l.debit_amount - l.credit_amount) FILTER (WHERE l.account_number = '1370'), 0)
      INTO v_bad_lines, v_net_change
      FROM public.journal_entry_lines l
     WHERE l.journal_entry_id = p_entry_id;

    IF v_bad_lines > 0 THEN
      RAISE EXCEPTION 'The transition voucher books balance sheet accounts against % only', p_equity_account
        USING ERRCODE = '23514';
    END IF;
    -- K3 35.16: development expensed in earlier financial reports is never
    -- capitalised at the transition, and a K2 company has nothing on 101x
    -- (BFNAR 2016:10 punkt 10.4) to adjust.
    IF EXISTS (
      SELECT 1 FROM public.journal_entry_lines l
       WHERE l.journal_entry_id = p_entry_id AND l.account_number ~ '^101[0-9]$'
    ) THEN
      RAISE EXCEPTION 'K3 35.16: expensed development cannot be capitalised at the transition'
        USING ERRCODE = '23514';
    END IF;
    IF abs(v_net_change - coalesce(p_deferred_tax_change, 0)) > 0.005 THEN
      RAISE EXCEPTION 'The draft voucher does not book the deferred tax change % on 2240 and 1370', p_deferred_tax_change
        USING ERRCODE = '23514';
    END IF;

    SELECT committed.voucher_number
      INTO v_voucher_number
      FROM public.commit_journal_entry(
        p_company_id,
        p_entry_id,
        'user_accept',
        NULL,
        p_actor_type,
        p_actor_label
      ) AS committed;
  END IF;

  PERFORM set_config('gnubok.k3_transition_commit', 'on', true);
  UPDATE public.k3_transitions t
     SET journal_entry_id = p_entry_id,
         committed_at = now(),
         opening_deferred_tax = round(coalesce(p_opening_deferred_tax, 0), 2),
         deferred_tax_items = p_deferred_tax_items
   WHERE t.id = v_transition.id;
  PERFORM set_config('gnubok.k3_transition_commit', 'off', true);

  RETURN QUERY SELECT v_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_k3_transition(uuid, uuid, text, numeric, numeric, jsonb, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_k3_transition(uuid, uuid, text, numeric, numeric, jsonb, text, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_k3_transition(uuid, uuid, text, numeric, numeric, jsonb, text, text) IS
  'K3 35.11: posts the transition voucher (balance sheet adjustments and the opening deferred tax against equity, dated the first day of the first K3 year) and marks the K3 transition committed, in one transaction. Voucher numbering is delegated to commit_journal_entry.';

NOTIFY pgrst, 'reload schema';
