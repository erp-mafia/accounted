-- K3 component state: a register of components per asset, with history.
--
-- Why this exists: K3 17.4 and 17.11 split a materiell anläggningstillgång
-- whose significant parts are consumed at materially different rates into
-- components, and 17.13 depreciates each component on its own life. Until now
-- the components lived only in assets.k3_components (JSONB: name, cost, life,
-- salvage). The engine recomputed each component's charge from acquisition,
-- posted one voucher per asset and recorded one amount per asset, so nothing
-- recorded what each component had actually been charged. That made four
-- things impossible:
--   * opening accumulated depreciation per component (an asset migrated from
--     another system, or split at the K3 transition date, K3 35.18);
--   * prospective depreciation per component after a change of estimate
--     (K3 10.9-10.10): the remaining value needs the posted history;
--   * component replacement (K3 17.5, 17.21A): the replaced component's
--     carrying amount leaves the books and the new one is capitalised;
--   * the per-component register BFNAR 2013:2 punkt 4.8 presumes.
--
-- What this migration adds:
--   1. public.asset_components: one row per component, with its own
--      acquisition date (a tillkommande component per 17.5 has its own), its
--      depreciation start (17.18), opening accumulated depreciation and the
--      derecognition (replacement) it ended with. useful_life_months NULL is
--      a component that is not depreciated (mark, K3 17.13).
--   2. public.depreciation_schedule_components: what each component was
--      charged in a posted planenlig avskrivning. Written only by the posting
--      RPCs below, in the same transaction as the voucher; the split must sum
--      to the voucher.
--   3. assets.k3_components, acquisition_cost and the asset-level opening
--      become a projection of the active components for a component asset,
--      maintained by trigger (read-only to every other writer), so readers
--      that predate the table (the K3 notes, the v1 wire field) keep reading
--      the books' figures.
--   4. commit_asset_depreciation and commit_asset_disposal take the component
--      split (p_components) and record it; delete_never_posted_asset also
--      refuses an asset with a derecognised component; a new
--      commit_asset_component_replacement posts a replacement voucher and
--      updates the register in one transaction.
--   5. A backfill of the JSONB components into the table (so that no row is
--      ever left behind), with the posted history of those assets split per
--      component by each component's share of the annual charge, the split
--      the old engine used.
--
-- This reverses the earlier rule that K3 components carry no opening
-- balances.
--
-- pg-test: tests/pg/asset-components.pg.test.ts

-- =============================================================================
-- 1. asset_components
-- =============================================================================

CREATE TABLE public.asset_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  cost numeric(15, 2) NOT NULL CHECK (cost > 0),
  -- NULL: not depreciated (mark has an unlimited useful life, K3 17.13).
  useful_life_months integer CHECK (useful_life_months IS NULL OR useful_life_months > 0),
  salvage_value numeric(15, 2) NOT NULL DEFAULT 0
    CHECK (salvage_value >= 0 AND salvage_value <= cost),
  -- The date the component's expenditure was incurred: the asset's
  -- acquisition date for an original component, the replacement or
  -- addition date for a tillkommande one (K3 17.5).
  acquisition_date date NOT NULL,
  -- K3 17.18: depreciation starts when the component can be used. NULL means
  -- from the acquisition date.
  depreciation_start_date date,
  -- Accumulated depreciation booked before the component's history in
  -- Accounted starts (a previous system, or the K3 transition split, 35.18),
  -- stated per opening_depreciation_date. Never posted by Accounted.
  opening_accumulated_depreciation numeric(15, 2) NOT NULL DEFAULT 0,
  opening_depreciation_date date,
  -- The component this one replaced (K3 17.5), for the register's trail.
  replaces_component_id uuid REFERENCES public.asset_components(id),
  -- Derecognition (K3 17.21A): set only by commit_asset_component_replacement,
  -- together with the voucher that took the carrying amount off the books and
  -- the depreciation that voucher charged up to the derecognition date.
  derecognised_at date,
  derecognition_journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  derecognition_depreciation numeric(15, 2) NOT NULL DEFAULT 0
    CHECK (derecognition_depreciation >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_components_opening_check CHECK (
    opening_accumulated_depreciation >= 0
    -- Planenlig avskrivning never writes off the restvärde.
    AND opening_accumulated_depreciation <= cost - salvage_value
    AND (
      (opening_accumulated_depreciation = 0 AND opening_depreciation_date IS NULL)
      OR (opening_accumulated_depreciation > 0 AND opening_depreciation_date IS NOT NULL)
    )
    AND (opening_depreciation_date IS NULL OR opening_depreciation_date >= acquisition_date)
    -- A component that is not depreciated has nothing written off.
    AND (useful_life_months IS NOT NULL OR opening_accumulated_depreciation = 0)
  ),
  CONSTRAINT asset_components_start_check CHECK (
    depreciation_start_date IS NULL OR depreciation_start_date >= acquisition_date
  ),
  CONSTRAINT asset_components_derecognition_check CHECK (
    (derecognised_at IS NULL AND derecognition_journal_entry_id IS NULL AND derecognition_depreciation = 0)
    OR (derecognised_at IS NOT NULL AND derecognition_journal_entry_id IS NOT NULL
        AND derecognised_at >= acquisition_date)
  )
);

COMMENT ON TABLE public.asset_components IS
  'K3 components of a fixed asset (BFNAR 2012:1 17.4-17.5A, 17.13, 17.21A): cost, life, salvage, depreciation start, opening accumulated depreciation and derecognition per component. assets.k3_components, acquisition_cost and the asset-level opening are a trigger-maintained projection of the active rows.';

CREATE INDEX idx_asset_components_company ON public.asset_components (company_id);
CREATE INDEX idx_asset_components_asset ON public.asset_components (asset_id, sort_order);
CREATE INDEX idx_asset_components_derecognition_entry
  ON public.asset_components (derecognition_journal_entry_id)
  WHERE derecognition_journal_entry_id IS NOT NULL;
CREATE INDEX idx_asset_components_replaces
  ON public.asset_components (replaces_component_id)
  WHERE replaces_component_id IS NOT NULL;

ALTER TABLE public.asset_components ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asset_components TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asset_components TO authenticated;

-- Same predicates as public.assets (20260516120000).
CREATE POLICY asset_components_select ON public.asset_components
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY asset_components_insert ON public.asset_components
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY asset_components_update ON public.asset_components
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY asset_components_delete ON public.asset_components
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER asset_components_updated_at
  BEFORE UPDATE ON public.asset_components
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.asset_components
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- Archived migration-reset source companies are static (20260818084050).
CREATE TRIGGER asset_components_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.asset_components
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

-- =============================================================================
-- 2. depreciation_schedule_components
-- =============================================================================

CREATE TABLE public.depreciation_schedule_components (
  -- A surrogate key so the archive export can page the table like any other.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES public.depreciation_schedules(id) ON DELETE CASCADE,
  component_id uuid NOT NULL REFERENCES public.asset_components(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  amount numeric(15, 2) NOT NULL CHECK (amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT depreciation_schedule_components_unique UNIQUE (schedule_id, component_id)
);

COMMENT ON TABLE public.depreciation_schedule_components IS
  'Per-component split of a posted planenlig avskrivning (depreciation_schedules row). Written only by commit_asset_depreciation and commit_asset_disposal in the voucher transaction; the split sums to the voucher. Rows of a posted schedule are immutable.';

CREATE INDEX idx_depreciation_schedule_components_component
  ON public.depreciation_schedule_components (component_id);
CREATE INDEX idx_depreciation_schedule_components_company
  ON public.depreciation_schedule_components (company_id);

ALTER TABLE public.depreciation_schedule_components ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.depreciation_schedule_components TO service_role;
-- Read-only to sessions: the posting RPCs (SECURITY DEFINER) are the only writers.
GRANT SELECT ON TABLE public.depreciation_schedule_components TO authenticated;

CREATE POLICY depreciation_schedule_components_select ON public.depreciation_schedule_components
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER depreciation_schedule_components_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.depreciation_schedule_components
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE FUNCTION public.guard_depreciation_schedule_components()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_posted boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A component split row is never updated: the posting RPC replaces an unposted schedule''s rows'
      USING ERRCODE = '23514';
  END IF;

  -- Tenant teardown removes the row together with the verifikat.
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;

  SELECT ds.journal_entry_id IS NOT NULL
    INTO v_posted
    FROM public.depreciation_schedules ds
   WHERE ds.id = OLD.schedule_id;

  -- The schedule is already gone (a cascade from an unposted schedule, which
  -- block_posted_depreciation_schedule_delete let through), or it is an
  -- unposted proposal the posting RPC is about to post again.
  IF v_posted IS DISTINCT FROM true THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Cannot delete the component split of a posted depreciation schedule (id=%)', OLD.schedule_id
    USING ERRCODE = '23514',
          HINT = 'Reverse the depreciation voucher (storno). The split is räkenskapsinformation (BFL 7 kap.).';
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_depreciation_schedule_components() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_depreciation_schedule_components
  BEFORE UPDATE OR DELETE ON public.depreciation_schedule_components
  FOR EACH ROW EXECUTE FUNCTION public.guard_depreciation_schedule_components();

-- =============================================================================
-- 3. Guards on asset_components
-- =============================================================================

-- True when the component's own plan has driven a posting: a posted schedule
-- carries a split row for it.
CREATE FUNCTION public.asset_component_has_posted_depreciation(p_component_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.depreciation_schedule_components dsc
      JOIN public.depreciation_schedules ds ON ds.id = dsc.schedule_id
     WHERE dsc.component_id = p_component_id
       AND ds.journal_entry_id IS NOT NULL
  );
$function$;

REVOKE ALL ON FUNCTION public.asset_component_has_posted_depreciation(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.guard_asset_components()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_row public.asset_components;
  v_asset_company uuid;
  v_asset_disposed date;
  v_asset_acquired date;
  v_asset_has_components boolean;
  v_asset_plain_history boolean;
  v_posted boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
    -- Tenant teardown removes the register with the verifikat.
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
  ELSE
    v_row := NEW;
  END IF;

  IF coalesce(current_setting('gnubok.asset_components_backfill', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- The asset row lock is what component edits and the posting RPCs
  -- (commit_asset_depreciation, commit_asset_disposal,
  -- commit_asset_component_replacement) serialise on: a proposal computed
  -- before an edit is refused by its snapshot check, never posted stale.
  SELECT a.company_id, a.disposed_at, a.acquisition_date
    INTO v_asset_company, v_asset_disposed, v_asset_acquired
    FROM public.assets a
   WHERE a.id = v_row.asset_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- The asset is being deleted and its components go with it (ON DELETE
    -- CASCADE): delete_never_posted_asset decided that under the lock.
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Asset not found: %', v_row.asset_id USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.company_id IS DISTINCT FROM v_asset_company THEN
      RAISE EXCEPTION 'Component company does not match its asset' USING ERRCODE = '23514';
    END IF;
    IF v_asset_disposed IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot add a component to a disposed asset (id=%)', NEW.asset_id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.acquisition_date < v_asset_acquired THEN
      RAISE EXCEPTION 'A component cannot be acquired before its asset' USING ERRCODE = '23514';
    END IF;
    IF NEW.derecognised_at IS NOT NULL THEN
      RAISE EXCEPTION 'A component is derecognised only by commit_asset_component_replacement'
        USING ERRCODE = '23514';
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.asset_components c WHERE c.asset_id = NEW.asset_id)
      INTO v_asset_has_components;
    -- Depreciation posted on the asset as a whole (no component split): its
    -- plan cannot be continued per component by adding rows. A K3 split of
    -- an asset with history sets each component's opening from the carrying
    -- amount at the split date (K3 35.18) and goes through its own RPC.
    SELECT EXISTS (
      SELECT 1 FROM public.depreciation_schedules ds
       WHERE ds.asset_id = NEW.asset_id
         AND ds.journal_entry_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM public.depreciation_schedule_components dsc WHERE dsc.schedule_id = ds.id
         )
    ) INTO v_asset_plain_history;
    IF NOT v_asset_has_components AND v_asset_plain_history
       AND coalesce(current_setting('gnubok.asset_component_split', true), '') <> 'on' THEN
      RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409',
        HINT = 'Depreciation is posted on the asset as a whole; split it into components with the K3 split instead.';
    END IF;
    -- An opening balance describes depreciation before the asset's history
    -- in Accounted. Once the asset has posted history, a new (tillkommande)
    -- component starts at zero.
    IF NEW.opening_accumulated_depreciation > 0
       AND coalesce(current_setting('gnubok.asset_component_split', true), '') <> 'on'
       AND EXISTS (
         SELECT 1 FROM public.depreciation_schedules ds
          WHERE ds.asset_id = NEW.asset_id AND ds.journal_entry_id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409';
    END IF;
    RETURN NEW;
  END IF;

  v_posted := public.asset_component_has_posted_depreciation(v_row.id);

  IF TG_OP = 'DELETE' THEN
    IF v_asset_disposed IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot delete a component of a disposed asset (id=%)', OLD.asset_id
        USING ERRCODE = '23514';
    END IF;
    IF OLD.derecognised_at IS NOT NULL OR v_posted THEN
      RAISE EXCEPTION 'Cannot delete a component that has reached the books (id=%)', OLD.id
        USING ERRCODE = '23514',
              HINT = 'Replace or derecognise the component instead. The register row is räkenskapsinformation (BFL 7 kap.).';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.replaces_component_id IS DISTINCT FROM OLD.replaces_component_id THEN
    RAISE EXCEPTION 'A component''s identity and trail are immutable' USING ERRCODE = '23514';
  END IF;

  IF v_asset_disposed IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot modify a component of a disposed asset (id=%)', OLD.asset_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.derecognised_at IS DISTINCT FROM OLD.derecognised_at
     OR NEW.derecognition_journal_entry_id IS DISTINCT FROM OLD.derecognition_journal_entry_id
     OR NEW.derecognition_depreciation IS DISTINCT FROM OLD.derecognition_depreciation THEN
    IF OLD.derecognised_at IS NULL
       AND coalesce(current_setting('gnubok.asset_component_derecognition', true), '') = 'on' THEN
      NULL; -- commit_asset_component_replacement, in its voucher transaction
    ELSIF OLD.derecognised_at IS NOT NULL
       AND NEW.derecognised_at IS NULL
       AND NEW.derecognition_journal_entry_id IS NULL
       AND NEW.derecognition_depreciation = 0
       -- Storno release, the trust rule of 20260925194235: the reversed flag
       -- alone is not trusted, the posted storno that reverses the voucher
       -- must exist.
       AND EXISTS (
         SELECT 1
           FROM public.journal_entries je
           JOIN public.journal_entries storno
             ON storno.reverses_id = je.id
            AND storno.source_type = 'storno'
            AND storno.status = 'posted'
            AND storno.company_id = OLD.company_id
          WHERE je.id = OLD.derecognition_journal_entry_id
            AND je.company_id = OLD.company_id
            AND je.status = 'reversed'
       ) THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'A component is derecognised only by commit_asset_component_replacement and released only by the storno of that voucher'
        USING ERRCODE = '23514';
    END IF;
    -- Nothing else changes in the same statement.
    IF NEW.name IS DISTINCT FROM OLD.name
       OR NEW.cost IS DISTINCT FROM OLD.cost
       OR NEW.useful_life_months IS DISTINCT FROM OLD.useful_life_months
       OR NEW.salvage_value IS DISTINCT FROM OLD.salvage_value
       OR NEW.acquisition_date IS DISTINCT FROM OLD.acquisition_date
       OR NEW.depreciation_start_date IS DISTINCT FROM OLD.depreciation_start_date
       OR NEW.opening_accumulated_depreciation IS DISTINCT FROM OLD.opening_accumulated_depreciation
       OR NEW.opening_depreciation_date IS DISTINCT FROM OLD.opening_depreciation_date
       OR NEW.sort_order IS DISTINCT FROM OLD.sort_order THEN
      RAISE EXCEPTION 'A derecognition changes only the derecognition columns' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.derecognised_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot modify a derecognised component (id=%)', OLD.id USING ERRCODE = '23514';
  END IF;

  -- Once the component's plan has driven a posting, its basis (cost, dates,
  -- opening) is locked: a correction goes through storno. Useful life,
  -- salvage value and name stay editable: a changed estimate is applied
  -- prospectively (K3 10.9-10.10), which the engine does from the posted
  -- history.
  IF v_posted THEN
    IF NEW.opening_accumulated_depreciation IS DISTINCT FROM OLD.opening_accumulated_depreciation
       OR NEW.opening_depreciation_date IS DISTINCT FROM OLD.opening_depreciation_date
       OR NEW.cost IS DISTINCT FROM OLD.cost
       OR NEW.acquisition_date IS DISTINCT FROM OLD.acquisition_date
       OR NEW.depreciation_start_date IS DISTINCT FROM OLD.depreciation_start_date THEN
      RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409';
    END IF;
  END IF;

  IF NEW.acquisition_date < v_asset_acquired THEN
    RAISE EXCEPTION 'A component cannot be acquired before its asset' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_asset_components() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_asset_components
  BEFORE INSERT OR UPDATE OR DELETE ON public.asset_components
  FOR EACH ROW EXECUTE FUNCTION public.guard_asset_components();

-- A derecognition and its storno release have legal weight
-- (behandlingshistorik, BFNAR 2013:2 kap. 8): audited, scoped to those
-- changes so ordinary register edits do not flood audit_log.
CREATE TRIGGER audit_asset_component_derecognition
  AFTER UPDATE ON public.asset_components
  FOR EACH ROW
  WHEN (OLD.derecognised_at IS DISTINCT FROM NEW.derecognised_at)
  EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 4. The asset row as a projection of its active components
-- =============================================================================

-- For a component asset, acquisition_cost, the asset-level opening and
-- k3_components are what the active components say. The trigger is the only
-- writer of those columns on a component asset (guard below), so the asset
-- row can never disagree with its components.
CREATE FUNCTION public.sync_asset_components_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_asset_id uuid;
  v_count integer;
  v_json jsonb;
  v_cost numeric;
  v_opening numeric;
  v_opening_date date;
BEGIN
  IF coalesce(current_setting('gnubok.asset_components_backfill', true), '') = 'on' THEN
    RETURN NULL;
  END IF;

  v_asset_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.asset_id ELSE NEW.asset_id END;

  SELECT count(*),
         jsonb_agg(
           jsonb_build_object(
             'component_id', c.id,
             'name', c.name,
             'cost', c.cost,
             'useful_life_months', c.useful_life_months,
             'salvage_value', c.salvage_value
           ) ORDER BY c.sort_order, c.created_at, c.id
         ),
         coalesce(sum(c.cost), 0),
         coalesce(sum(c.opening_accumulated_depreciation), 0),
         max(c.opening_depreciation_date)
    INTO v_count, v_json, v_cost, v_opening, v_opening_date
    FROM public.asset_components c
   WHERE c.asset_id = v_asset_id
     AND c.derecognised_at IS NULL;

  PERFORM set_config('gnubok.asset_components_sync', 'on', true);
  IF v_count = 0 THEN
    -- The breakdown was cleared before anything was posted: a plain asset
    -- again, with the cost and opening it last had.
    UPDATE public.assets a
       SET k3_components = NULL
     WHERE a.id = v_asset_id
       AND a.k3_components IS NOT NULL;
  ELSE
    UPDATE public.assets a
       SET k3_components = v_json,
           acquisition_cost = v_cost,
           salvage_value = 0,
           opening_accumulated_depreciation = v_opening,
           opening_depreciation_date = CASE WHEN v_opening > 0 THEN v_opening_date END
     WHERE a.id = v_asset_id
       AND a.disposed_at IS NULL
       AND (a.k3_components IS DISTINCT FROM v_json
            OR a.acquisition_cost IS DISTINCT FROM v_cost
            OR a.salvage_value <> 0
            OR a.opening_accumulated_depreciation IS DISTINCT FROM v_opening
            OR a.opening_depreciation_date IS DISTINCT FROM CASE WHEN v_opening > 0 THEN v_opening_date END);
  END IF;
  PERFORM set_config('gnubok.asset_components_sync', 'off', true);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_asset_components_projection() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER sync_asset_components_projection
  AFTER INSERT OR UPDATE OR DELETE ON public.asset_components
  FOR EACH ROW EXECUTE FUNCTION public.sync_asset_components_projection();

CREATE FUNCTION public.guard_asset_components_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF coalesce(current_setting('gnubok.asset_components_sync', true), '') = 'on'
     OR coalesce(current_setting('gnubok.asset_components_backfill', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.k3_components IS NOT NULL THEN
      RAISE EXCEPTION 'assets.k3_components is a projection of asset_components: write the components'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.k3_components IS DISTINCT FROM OLD.k3_components THEN
    RAISE EXCEPTION 'assets.k3_components is a projection of asset_components: write the components'
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.acquisition_cost IS DISTINCT FROM OLD.acquisition_cost
      OR NEW.salvage_value IS DISTINCT FROM OLD.salvage_value
      OR NEW.opening_accumulated_depreciation IS DISTINCT FROM OLD.opening_accumulated_depreciation
      OR NEW.opening_depreciation_date IS DISTINCT FROM OLD.opening_depreciation_date)
     AND EXISTS (SELECT 1 FROM public.asset_components c WHERE c.asset_id = NEW.id) THEN
    RAISE EXCEPTION 'The cost, salvage value and opening of a component asset are the sum of its components: write the components'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_asset_components_projection() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_asset_components_projection
  BEFORE INSERT OR UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.guard_asset_components_projection();

-- The asset-level opening lock (20260923142743) stays as it was for a plain
-- asset. For a component asset the asset-level opening is the projection, and
-- each component's opening is locked by guard_asset_components on that
-- component's own posted history, so the projection may follow.
CREATE OR REPLACE FUNCTION public.enforce_asset_opening_after_depreciation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF coalesce(current_setting('gnubok.asset_components_sync', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.depreciation_schedules ds
    WHERE ds.asset_id = OLD.id AND ds.company_id = OLD.company_id
      AND ds.journal_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_asset_opening_after_depreciation() FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.assets.k3_components IS
  'Read-only projection of the active public.asset_components rows (component_id, name, cost, useful_life_months, salvage_value), maintained by sync_asset_components_projection. Write the components, never this column.';

-- =============================================================================
-- 5. Component split check shared by the posting RPCs
-- =============================================================================

-- p_components: [{component_id, amount, expected_opening_amount,
-- expected_opening_date}]. Raises unless it covers exactly the asset's active
-- components, each with its opening snapshot unchanged, and sums to p_total.
-- No split for an asset without components.
CREATE FUNCTION public.check_asset_component_split(
  p_asset_id uuid,
  p_components jsonb,
  p_total numeric
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_active integer;
  v_given integer;
  v_distinct integer;
  v_sum numeric;
BEGIN
  SELECT count(*)
    INTO v_active
    FROM public.asset_components c
   WHERE c.asset_id = p_asset_id
     AND c.derecognised_at IS NULL;

  IF v_active = 0 THEN
    IF p_components IS NOT NULL
       AND jsonb_typeof(p_components) = 'array'
       AND jsonb_array_length(p_components) > 0 THEN
      RAISE EXCEPTION 'ASSET_COMPONENTS_CHANGED' USING ERRCODE = 'PT409';
    END IF;
    RETURN;
  END IF;

  IF p_components IS NULL OR jsonb_typeof(p_components) <> 'array' THEN
    RAISE EXCEPTION 'ASSET_COMPONENTS_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_components) AS e(v)
     WHERE jsonb_typeof(e.v) <> 'object'
        OR coalesce(e.v ->> 'component_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR CASE
             WHEN jsonb_typeof(e.v -> 'amount') = 'number' THEN (e.v ->> 'amount')::numeric < 0
             ELSE true
           END
  ) THEN
    RAISE EXCEPTION 'Invalid component split' USING ERRCODE = '22023';
  END IF;

  SELECT count(*),
         count(DISTINCT (e.v ->> 'component_id')::uuid),
         coalesce(sum((e.v ->> 'amount')::numeric), 0)
    INTO v_given, v_distinct, v_sum
    FROM jsonb_array_elements(p_components) AS e(v);

  IF v_given <> v_distinct
     OR v_distinct <> v_active
     OR EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_components) AS e(v)
        WHERE NOT EXISTS (
          SELECT 1
            FROM public.asset_components c
           WHERE c.id = (e.v ->> 'component_id')::uuid
             AND c.asset_id = p_asset_id
             AND c.derecognised_at IS NULL
        )
     ) THEN
    RAISE EXCEPTION 'ASSET_COMPONENTS_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_components) AS e(v)
      JOIN public.asset_components c ON c.id = (e.v ->> 'component_id')::uuid
     WHERE c.opening_accumulated_depreciation
             IS DISTINCT FROM coalesce((e.v ->> 'expected_opening_amount')::numeric, 0)
        OR c.opening_depreciation_date IS DISTINCT FROM (e.v ->> 'expected_opening_date')::date
  ) THEN
    RAISE EXCEPTION 'ASSET_OPENING_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  IF abs(v_sum - p_total) > 0.005 THEN
    RAISE EXCEPTION 'Component split % does not match the depreciation total %', v_sum, p_total
      USING ERRCODE = '23514';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.check_asset_component_split(uuid, jsonb, numeric) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 6. commit_asset_depreciation: records the component split
-- =============================================================================
-- Last full definition: 20260923142743. Unchanged but for p_components: the
-- split is checked under the asset row lock and written in the voucher
-- transaction. Old callers (no p_components) still resolve here, and are
-- refused for a component asset because the split is required.

DROP FUNCTION IF EXISTS public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, numeric, date, text, text
);

CREATE FUNCTION public.commit_asset_depreciation(
  p_company_id uuid,
  p_asset_id uuid,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_planned_depreciation numeric,
  p_expected_opening_amount numeric,
  p_expected_opening_date date,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL,
  p_components jsonb DEFAULT NULL
)
RETURNS TABLE(voucher_number integer, schedule_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_asset_user_id uuid;
  v_opening_amount numeric;
  v_opening_date date;
  v_entry_user_id uuid;
  v_draft_debit numeric;
  v_schedule_id uuid;
  v_schedule_entry_id uuid;
  v_voucher_number integer;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- Same NULL-safe membership guard as commit_asset_disposal.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (
       NOT public.caller_is_company_member(p_company_id)
       OR NOT public.current_user_can_write()
     ) THEN
    RAISE EXCEPTION 'unauthorized asset depreciation for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_planned_depreciation IS NULL OR p_planned_depreciation <= 0 THEN
    RAISE EXCEPTION 'Planned depreciation must be positive'
      USING ERRCODE = '23514';
  END IF;

  -- The asset row lock is what post-versus-delete serialises on:
  -- delete_never_posted_asset takes the same lock before it decides, and so
  -- does every component write (guard_asset_components).
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT a.user_id, a.opening_accumulated_depreciation, a.opening_depreciation_date
    INTO v_asset_user_id, v_opening_amount, v_opening_date
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found: %', p_asset_id
      USING ERRCODE = 'P0002';
  END IF;

  -- The proposal was calculated before this transaction. Refuse a stale
  -- opening snapshot under the same row lock used by opening updates.
  IF v_opening_amount IS DISTINCT FROM p_expected_opening_amount
     OR v_opening_date IS DISTINCT FROM p_expected_opening_date THEN
    RAISE EXCEPTION 'ASSET_OPENING_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  -- The same for the component split: it must cover the active components
  -- as they stand under the lock and sum to the voucher.
  PERFORM public.check_asset_component_split(p_asset_id, p_components, p_planned_depreciation);

  -- Pin what this RPC can post: a year_end draft of this company and period.
  SELECT je.user_id
    INTO v_entry_user_id
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id
     AND je.fiscal_period_id = p_fiscal_period_id
     AND je.status = 'draft'
     AND je.source_type = 'year_end'
   FOR UPDATE;

  -- 22023, not P0002: a missing ASSET is an expected outcome of a concurrent
  -- delete that the caller skips, while a bad draft is a caller bug. Distinct
  -- SQLSTATEs let the engine tell them apart without parsing message text.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Valid depreciation draft not found: %', p_entry_id
      USING ERRCODE = '22023';
  END IF;

  -- The RPC is independently callable, so the amount the register records
  -- must be the amount the voucher books, not whatever the caller passes.
  SELECT coalesce(sum(l.debit_amount), 0)
    INTO v_draft_debit
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = p_entry_id;

  IF abs(v_draft_debit - p_planned_depreciation) > 0.005 THEN
    RAISE EXCEPTION 'Planned depreciation % does not match the draft voucher total %',
      p_planned_depreciation, v_draft_debit
      USING ERRCODE = '23514';
  END IF;

  SELECT ds.id, ds.journal_entry_id
    INTO v_schedule_id, v_schedule_entry_id
    FROM public.depreciation_schedules ds
   WHERE ds.asset_id = p_asset_id
     AND ds.fiscal_period_id = p_fiscal_period_id
   FOR UPDATE;

  -- unique_violation on purpose: it IS the (asset_id, fiscal_period_id)
  -- invariant, met one step earlier than the constraint would meet it.
  IF FOUND AND v_schedule_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Depreciation is already posted for asset % in this fiscal period', p_asset_id
      USING ERRCODE = '23505';
  END IF;

  -- An unposted proposal adopted below (a fresh one, or one released by the
  -- storno of its voucher) drops the split it carried while still unposted.
  IF v_schedule_id IS NOT NULL THEN
    DELETE FROM public.depreciation_schedule_components dsc
     WHERE dsc.schedule_id = v_schedule_id;
  END IF;

  -- Voucher first, link second: the order the old two-statement code used,
  -- now inside one transaction, so a failure at the link step takes the
  -- voucher commit (and its sequence increment) down with it.
  SELECT committed.voucher_number
    INTO v_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      p_entry_id,
      NULL,
      NULL,
      p_actor_type,
      p_actor_label
    ) AS committed;

  IF v_schedule_id IS NOT NULL THEN
    UPDATE public.depreciation_schedules
       SET planned_depreciation = p_planned_depreciation,
           journal_entry_id = p_entry_id,
           posted_at = now()
     WHERE id = v_schedule_id;
  ELSE
    INSERT INTO public.depreciation_schedules (
      user_id,
      company_id,
      asset_id,
      fiscal_period_id,
      planned_depreciation,
      journal_entry_id,
      posted_at
    ) VALUES (
      coalesce(v_entry_user_id, v_asset_user_id),
      p_company_id,
      p_asset_id,
      p_fiscal_period_id,
      p_planned_depreciation,
      p_entry_id,
      now()
    )
    RETURNING id INTO v_schedule_id;
  END IF;

  INSERT INTO public.depreciation_schedule_components (schedule_id, component_id, company_id, amount)
  SELECT v_schedule_id, (e.v ->> 'component_id')::uuid, p_company_id, (e.v ->> 'amount')::numeric
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p_components) = 'array' THEN p_components ELSE '[]'::jsonb END
         ) AS e(v);

  RETURN QUERY SELECT v_voucher_number, v_schedule_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, numeric, date, text, text, jsonb
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, numeric, date, text, text, jsonb
) TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, numeric, date, text, text, jsonb
) IS 'Atomically posts a planenlig avskrivning voucher, links its depreciation_schedules row and records the per-component split (required for a component asset, summing to the voucher), under the asset row lock. Voucher numbering is delegated to commit_journal_entry.';

-- =============================================================================
-- 7. commit_asset_disposal: records the component split of the final charge
-- =============================================================================
-- Last full definition: 20261012100100 (restated). Unchanged but for
-- p_components, the split of p_current_depreciation over the active
-- components, checked and recorded like the planenlig avskrivning's.

DROP FUNCTION IF EXISTS public.commit_asset_disposal(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric, numeric, text, integer, integer, numeric, numeric, numeric, text, text
);

CREATE FUNCTION public.commit_asset_disposal(
  p_company_id uuid,
  p_asset_id uuid,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_disposal_type text,
  p_disposed_at date,
  p_disposed_proceeds numeric,
  p_proceeds_vat numeric,
  p_vat_treatment text,
  p_current_depreciation numeric,
  p_jamkning_amount numeric,
  p_jamkning_direction text,
  p_jamkning_remaining_years integer,
  p_jamkning_total_years integer,
  p_jamkning_original_input_vat numeric,
  p_jamkning_original_deduction_percent numeric,
  p_jamkning_new_deduction_percent numeric,
  p_actor_type text DEFAULT NULL::text,
  p_actor_label text DEFAULT NULL::text,
  p_components jsonb DEFAULT NULL
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_asset_user_id uuid;
  v_entry_user_id uuid;
  v_schedule_id uuid;
  v_schedule_entry_id uuid;
  v_period_start date;
  v_period_closed boolean;
  v_period_locked_at timestamptz;
  v_company_lock_date date;
  v_voucher_number integer;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- NULL-safe membership guard (20260703180000): never the raw
  -- "NOT IN (SELECT user_company_ids())" form, which is NULL-unsafe.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (
       NOT public.caller_is_company_member(p_company_id)
       OR NOT public.current_user_can_write()
     ) THEN
    RAISE EXCEPTION 'unauthorized asset disposal for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Disposal metadata invariants. The values are derived server-side by the
  -- same planner that builds the draft entry, but the RPC is independently
  -- callable, so reject internally inconsistent register metadata here.
  IF coalesce(p_disposed_proceeds, 0) < 0 OR coalesce(p_proceeds_vat, 0) < 0 THEN
    RAISE EXCEPTION 'Disposal proceeds and VAT must be non-negative'
      USING ERRCODE = '23514';
  END IF;
  IF p_proceeds_vat > 0 AND p_vat_treatment IS NULL THEN
    RAISE EXCEPTION 'Disposal VAT requires a VAT treatment'
      USING ERRCODE = '23514';
  END IF;
  IF p_proceeds_vat > p_disposed_proceeds THEN
    RAISE EXCEPTION 'Disposal VAT cannot exceed gross proceeds'
      USING ERRCODE = '23514';
  END IF;
  IF p_disposal_type = 'scrap' AND coalesce(p_disposed_proceeds, 0) <> 0 THEN
    RAISE EXCEPTION 'Scrapping (utrangering) cannot carry proceeds'
      USING ERRCODE = '23514';
  END IF;

  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT a.user_id
    INTO v_asset_user_id
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
     AND a.disposed_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found or already disposed: %', p_asset_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT fp.period_start, fp.is_closed, fp.locked_at
    INTO v_period_start, v_period_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = p_fiscal_period_id
     AND fp.company_id = p_company_id
     AND p_disposed_at BETWEEN fp.period_start AND fp.period_end;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period does not contain disposal date'
      USING ERRCODE = '22007';
  END IF;

  IF v_period_closed OR v_period_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot dispose asset in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;

  SELECT cs.bookkeeping_locked_through
    INTO v_company_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_company_lock_date IS NOT NULL AND p_disposed_at <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.depreciation_schedules ds
      JOIN public.fiscal_periods fp ON fp.id = ds.fiscal_period_id
     WHERE ds.company_id = p_company_id
       AND ds.asset_id = p_asset_id
       AND ds.journal_entry_id IS NOT NULL
       AND fp.period_start > v_period_start
  ) THEN
    RAISE EXCEPTION 'Later depreciation is already posted for asset %', p_asset_id
      USING ERRCODE = '23514';
  END IF;

  IF p_entry_id IS NOT NULL THEN
    SELECT je.user_id
      INTO v_entry_user_id
      FROM public.journal_entries je
     WHERE je.id = p_entry_id
       AND je.company_id = p_company_id
       AND je.fiscal_period_id = p_fiscal_period_id
       AND je.entry_date = p_disposed_at
       AND je.status = 'draft'
       AND je.source_type = 'system'
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Valid disposal draft not found: %', p_entry_id
        USING ERRCODE = 'P0002';
    END IF;
  ELSIF abs(coalesce(p_current_depreciation, 0)) > 0.005 THEN
    RAISE EXCEPTION 'Current depreciation requires a disposal voucher'
      USING ERRCODE = '23514';
  END IF;

  IF coalesce(p_current_depreciation, 0) > 0.005 THEN
    -- The final charge is split over the active components like any
    -- planenlig avskrivning (none for an asset without components).
    PERFORM public.check_asset_component_split(p_asset_id, p_components, p_current_depreciation);

    SELECT ds.id, ds.journal_entry_id
      INTO v_schedule_id, v_schedule_entry_id
      FROM public.depreciation_schedules ds
     WHERE ds.asset_id = p_asset_id
       AND ds.fiscal_period_id = p_fiscal_period_id
     FOR UPDATE;

    IF FOUND AND v_schedule_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Depreciation was posted concurrently for asset %', p_asset_id
        USING ERRCODE = '23514';
    ELSIF FOUND THEN
      DELETE FROM public.depreciation_schedule_components dsc
       WHERE dsc.schedule_id = v_schedule_id;
      UPDATE public.depreciation_schedules
         SET planned_depreciation = p_current_depreciation,
             journal_entry_id = p_entry_id,
             posted_at = now()
       WHERE id = v_schedule_id;
    ELSE
      INSERT INTO public.depreciation_schedules (
        user_id,
        company_id,
        asset_id,
        fiscal_period_id,
        planned_depreciation,
        journal_entry_id,
        posted_at
      ) VALUES (
        coalesce(v_entry_user_id, v_asset_user_id),
        p_company_id,
        p_asset_id,
        p_fiscal_period_id,
        p_current_depreciation,
        p_entry_id,
        now()
      )
      RETURNING id INTO v_schedule_id;
    END IF;

    INSERT INTO public.depreciation_schedule_components (schedule_id, component_id, company_id, amount)
    SELECT v_schedule_id, (e.v ->> 'component_id')::uuid, p_company_id, (e.v ->> 'amount')::numeric
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p_components) = 'array' THEN p_components ELSE '[]'::jsonb END
           ) AS e(v);
  END IF;

  IF p_entry_id IS NOT NULL THEN
    SELECT committed.voucher_number
      INTO v_voucher_number
      -- commit_method must be one of journal_entries_commit_method_check's
      -- allowed values; the disposal dialog is a user-accepted commit.
      FROM public.commit_journal_entry(
        p_company_id,
        p_entry_id,
        'user_accept',
        NULL,
        p_actor_type,
        p_actor_label
      ) AS committed;
  END IF;

  UPDATE public.assets
     SET disposed_at = p_disposed_at,
         disposed_proceeds = p_disposed_proceeds,
         disposed_proceeds_vat = p_proceeds_vat,
         disposed_vat_treatment = p_vat_treatment,
         disposal_type = p_disposal_type,
         disposal_journal_entry_id = p_entry_id,
         jamkning_amount = p_jamkning_amount,
         jamkning_direction = p_jamkning_direction,
         jamkning_remaining_years = p_jamkning_remaining_years,
         jamkning_total_years = p_jamkning_total_years,
         jamkning_original_input_vat = p_jamkning_original_input_vat,
         jamkning_original_deduction_percent = p_jamkning_original_deduction_percent,
         jamkning_new_deduction_percent = p_jamkning_new_deduction_percent,
         jamkning_remaining_months = NULL,
         jamkning_total_months = NULL
   WHERE id = p_asset_id
     AND company_id = p_company_id
     AND disposed_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset disposal lost concurrent update: %', p_asset_id
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT v_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric, numeric, text, integer, integer, numeric, numeric, numeric, text, text, jsonb
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric, numeric, text, integer, integer, numeric, numeric, numeric, text, text, jsonb
) TO authenticated, service_role;

-- =============================================================================
-- 8. delete_never_posted_asset: a derecognised component has reached the books
-- =============================================================================
-- Last full definition: 20260921181008. Unchanged but for the derecognition
-- check: a replacement voucher is as much "the books" as a posted
-- avskrivning, and guard_asset_components would refuse the cascade anyway.

CREATE OR REPLACE FUNCTION public.delete_never_posted_asset(
  p_company_id uuid,
  p_asset_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_disposed_at date;
  v_disposal_entry_id uuid;
BEGIN
  SELECT a.disposed_at, a.disposal_journal_entry_id
    INTO v_disposed_at, v_disposal_entry_id
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_disposed_at IS NOT NULL OR v_disposal_entry_id IS NOT NULL THEN
    RETURN 'disposed';
  END IF;

  -- Read AFTER the lock is held. A posting that was in flight has committed
  -- by now and its link is visible; one that starts later waits on the lock.
  IF EXISTS (
    SELECT 1
      FROM public.depreciation_schedules ds
     WHERE ds.company_id = p_company_id
       AND ds.asset_id = p_asset_id
       AND ds.journal_entry_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.asset_components c
     WHERE c.company_id = p_company_id
       AND c.asset_id = p_asset_id
       AND c.derecognition_journal_entry_id IS NOT NULL
  ) THEN
    RETURN 'depreciation_posted';
  END IF;

  DELETE FROM public.depreciation_schedules ds
   WHERE ds.company_id = p_company_id
     AND ds.asset_id = p_asset_id
     AND ds.journal_entry_id IS NULL;

  DELETE FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id;

  RETURN 'deleted';
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_never_posted_asset(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_never_posted_asset(uuid, uuid) TO authenticated, service_role;

-- =============================================================================
-- 9. commit_asset_component_replacement (K3 17.5, 17.21A)
-- =============================================================================
-- Posts the voucher that takes a component off the books and marks it
-- derecognised, in one transaction, and registers the component that
-- replaces it (when one does). The replacing expenditure is already in the
-- ledger (a supplier invoice or bank row on the asset account): registering
-- it posts nothing, as createAsset posts nothing.
--
-- The voucher, built by the asset service: the component's depreciation up
-- to the derecognition date (Dr 78xx / Cr 12x9), its accumulated
-- depreciation off (Dr 12x9), its cost off (Cr 12x0) and the carrying amount
-- as a loss (Dr 797x, övrig rörelsekostnad, K3 17.22). This RPC pins the
-- voucher to the register: the cost credited on the asset account is the
-- component's cost, the depreciation charged is what the row records, and
-- the accumulated depreciation cleared is what the register holds.

CREATE FUNCTION public.commit_asset_component_replacement(
  p_company_id uuid,
  p_asset_id uuid,
  p_component_id uuid,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_derecognised_at date,
  p_depreciation_to_date numeric,
  p_accumulated_cleared numeric,
  p_new_component jsonb DEFAULT NULL,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer, new_component_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_asset public.assets;
  v_component public.asset_components;
  v_entry_user_id uuid;
  v_period_start date;
  v_period_end date;
  v_period_closed boolean;
  v_period_locked_at timestamptz;
  v_company_lock_date date;
  v_period_posted boolean;
  v_posted_component numeric;
  v_credit_asset numeric;
  v_debit_expense numeric;
  v_debit_accumulated numeric;
  v_voucher_number integer;
  v_new_id uuid;
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
    RAISE EXCEPTION 'unauthorized component replacement for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_depreciation_to_date IS NULL OR p_depreciation_to_date < 0
     OR p_accumulated_cleared IS NULL OR p_accumulated_cleared < 0 THEN
    RAISE EXCEPTION 'Depreciation amounts must be non-negative' USING ERRCODE = '23514';
  END IF;

  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT a.* INTO v_asset
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
     AND a.disposed_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found or already disposed: %', p_asset_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT c.* INTO v_component
    FROM public.asset_components c
   WHERE c.id = p_component_id
     AND c.asset_id = p_asset_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Component not found: %', p_component_id USING ERRCODE = 'P0002';
  END IF;

  IF v_component.derecognised_at IS NOT NULL THEN
    RAISE EXCEPTION 'ASSET_COMPONENT_NOT_ACTIVE' USING ERRCODE = 'PT409';
  END IF;

  IF p_derecognised_at < v_component.acquisition_date THEN
    RAISE EXCEPTION 'A component cannot be derecognised before it was acquired'
      USING ERRCODE = '23514';
  END IF;

  -- The last active component going without a replacement is the whole
  -- asset going: that is a disposal (commit_asset_disposal), which also
  -- settles proceeds and VAT.
  IF (p_new_component IS NULL OR jsonb_typeof(p_new_component) <> 'object')
     AND NOT EXISTS (
       SELECT 1 FROM public.asset_components c
        WHERE c.asset_id = p_asset_id
          AND c.id <> p_component_id
          AND c.derecognised_at IS NULL
     ) THEN
    RAISE EXCEPTION 'ASSET_LAST_COMPONENT' USING ERRCODE = 'PT409',
      HINT = 'Dispose the asset instead.';
  END IF;

  SELECT fp.period_start, fp.period_end, fp.is_closed, fp.locked_at
    INTO v_period_start, v_period_end, v_period_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = p_fiscal_period_id
     AND fp.company_id = p_company_id
     AND p_derecognised_at BETWEEN fp.period_start AND fp.period_end;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period does not contain the derecognition date'
      USING ERRCODE = '22007';
  END IF;

  IF v_period_closed OR v_period_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot derecognise a component in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;

  SELECT cs.bookkeeping_locked_through
    INTO v_company_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_company_lock_date IS NOT NULL AND p_derecognised_at <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date
      USING ERRCODE = '23514';
  END IF;

  -- Depreciation already posted for a later year planned the component
  -- through that year: replacing it now would leave that charge on the books.
  IF EXISTS (
    SELECT 1
      FROM public.depreciation_schedules ds
      JOIN public.fiscal_periods fp ON fp.id = ds.fiscal_period_id
     WHERE ds.company_id = p_company_id
       AND ds.asset_id = p_asset_id
       AND ds.journal_entry_id IS NOT NULL
       AND fp.period_start > v_period_start
  ) THEN
    RAISE EXCEPTION 'Later depreciation is already posted for asset %', p_asset_id
      USING ERRCODE = '23514';
  END IF;

  -- This year's depreciation already posted charged the component through
  -- the year end: only a derecognition on the balance sheet date, with no
  -- further charge, agrees with it.
  SELECT EXISTS (
    SELECT 1 FROM public.depreciation_schedules ds
     WHERE ds.asset_id = p_asset_id
       AND ds.fiscal_period_id = p_fiscal_period_id
       AND ds.journal_entry_id IS NOT NULL
  ) INTO v_period_posted;

  IF v_period_posted AND (p_derecognised_at <> v_period_end OR p_depreciation_to_date > 0.005) THEN
    RAISE EXCEPTION 'Depreciation for this fiscal year is already posted for asset %', p_asset_id
      USING ERRCODE = '23514';
  END IF;

  -- The accumulated depreciation the voucher clears is what the register
  -- holds for the component: its opening, its posted split and the charge to
  -- date.
  SELECT coalesce(sum(dsc.amount), 0)
    INTO v_posted_component
    FROM public.depreciation_schedule_components dsc
    JOIN public.depreciation_schedules ds ON ds.id = dsc.schedule_id
   WHERE dsc.component_id = p_component_id
     AND ds.journal_entry_id IS NOT NULL;

  IF abs(v_component.opening_accumulated_depreciation + v_posted_component + p_depreciation_to_date
         - p_accumulated_cleared) > 0.005 THEN
    RAISE EXCEPTION 'ASSET_COMPONENT_STATE_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  SELECT je.user_id
    INTO v_entry_user_id
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id
     AND je.fiscal_period_id = p_fiscal_period_id
     AND je.entry_date = p_derecognised_at
     AND je.status = 'draft'
     AND je.source_type = 'system'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Valid replacement draft not found: %', p_entry_id
      USING ERRCODE = '22023';
  END IF;

  SELECT
    coalesce(sum(l.credit_amount) FILTER (WHERE l.account_number = v_asset.bas_asset_account), 0),
    coalesce(sum(l.debit_amount) FILTER (WHERE l.account_number = v_asset.bas_expense_account), 0),
    coalesce(sum(l.debit_amount) FILTER (WHERE l.account_number = v_asset.bas_accumulated_account), 0)
    INTO v_credit_asset, v_debit_expense, v_debit_accumulated
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = p_entry_id;

  IF abs(v_credit_asset - v_component.cost) > 0.005
     OR abs(v_debit_expense - p_depreciation_to_date) > 0.005
     OR abs(v_debit_accumulated - p_accumulated_cleared) > 0.005 THEN
    RAISE EXCEPTION 'The replacement voucher does not match the component (cost %, charge %, accumulated %)',
      v_component.cost, p_depreciation_to_date, p_accumulated_cleared
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

  PERFORM set_config('gnubok.asset_component_derecognition', 'on', true);
  UPDATE public.asset_components
     SET derecognised_at = p_derecognised_at,
         derecognition_journal_entry_id = p_entry_id,
         derecognition_depreciation = p_depreciation_to_date
   WHERE id = p_component_id;
  PERFORM set_config('gnubok.asset_component_derecognition', 'off', true);

  IF p_new_component IS NOT NULL AND jsonb_typeof(p_new_component) = 'object' THEN
    INSERT INTO public.asset_components (
      user_id,
      company_id,
      asset_id,
      name,
      cost,
      useful_life_months,
      salvage_value,
      acquisition_date,
      depreciation_start_date,
      replaces_component_id,
      sort_order
    ) VALUES (
      coalesce(v_entry_user_id, v_asset.user_id),
      p_company_id,
      p_asset_id,
      p_new_component ->> 'name',
      (p_new_component ->> 'cost')::numeric,
      (p_new_component ->> 'useful_life_months')::integer,
      coalesce((p_new_component ->> 'salvage_value')::numeric, 0),
      coalesce((p_new_component ->> 'acquisition_date')::date, p_derecognised_at),
      (p_new_component ->> 'depreciation_start_date')::date,
      p_component_id,
      v_component.sort_order
    )
    RETURNING id INTO v_new_id;
  END IF;

  RETURN QUERY SELECT v_voucher_number, v_new_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_asset_component_replacement(
  uuid, uuid, uuid, uuid, uuid, date, numeric, numeric, jsonb, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_asset_component_replacement(
  uuid, uuid, uuid, uuid, uuid, date, numeric, numeric, jsonb, text, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_asset_component_replacement(
  uuid, uuid, uuid, uuid, uuid, date, numeric, numeric, jsonb, text, text
) IS 'K3 17.5/17.21A: posts the voucher that derecognises an asset component and marks it derecognised in one transaction, under the asset row lock, and registers the replacing component when given. Voucher numbering is delegated to commit_journal_entry.';

-- =============================================================================
-- 10. Backfill: JSONB components into the table
-- =============================================================================
-- The backfill keeps any row an install may already have (a self-hosted
-- install or a preview database, for example). The JSONB value itself is
-- left as it was. Companies archived by a migration reset are static and
-- skipped. An element the old validation would have refused is left in the
-- JSONB only, with a notice.

-- One JSONB element the old Zod validation would have accepted: numeric cost
-- above 0, a positive life, a salvage value between 0 and the cost. CASE
-- keeps every cast behind its type check.
CREATE FUNCTION public.asset_component_backfill_valid(p_value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(p_value) <> 'object' THEN false
    WHEN jsonb_typeof(p_value -> 'cost') IS DISTINCT FROM 'number' THEN false
    WHEN jsonb_typeof(p_value -> 'useful_life_months') IS DISTINCT FROM 'number' THEN false
    WHEN p_value -> 'salvage_value' IS NOT NULL
         AND jsonb_typeof(p_value -> 'salvage_value') NOT IN ('number', 'null') THEN false
    ELSE (p_value ->> 'cost')::numeric > 0
         AND (p_value ->> 'useful_life_months')::numeric > 0
         AND coalesce((p_value ->> 'salvage_value')::numeric, 0) BETWEEN 0 AND (p_value ->> 'cost')::numeric
  END;
$function$;

REVOKE ALL ON FUNCTION public.asset_component_backfill_valid(jsonb) FROM PUBLIC, anon, authenticated;

-- One statement, so the transaction-local backfill flag covers every write
-- whether or not the migration runner wraps the file in a transaction.
DO $$
DECLARE
  v_skipped integer;
BEGIN
  PERFORM set_config('gnubok.asset_components_backfill', 'on', true);

  SELECT count(*)
    INTO v_skipped
    FROM public.assets a
    CROSS JOIN LATERAL jsonb_array_elements(a.k3_components) AS e(value)
   WHERE jsonb_typeof(a.k3_components) = 'array'
     AND NOT public.asset_component_backfill_valid(e.value);
  IF v_skipped > 0 THEN
    RAISE NOTICE 'asset_components backfill: % JSONB element(s) left out, not valid components', v_skipped;
  END IF;

  INSERT INTO public.asset_components (
    user_id, company_id, asset_id, name, cost, useful_life_months, salvage_value,
    acquisition_date, sort_order
  )
  SELECT a.user_id,
         a.company_id,
         a.id,
         coalesce(nullif(btrim(e.value ->> 'name'), ''), 'Komponent ' || e.ordinality),
         round((e.value ->> 'cost')::numeric, 2),
         round((e.value ->> 'useful_life_months')::numeric)::integer,
         round(coalesce((e.value ->> 'salvage_value')::numeric, 0), 2),
         a.acquisition_date,
         (e.ordinality - 1)::integer
    FROM public.assets a
    CROSS JOIN LATERAL jsonb_array_elements(a.k3_components) WITH ORDINALITY AS e(value, ordinality)
   WHERE jsonb_typeof(a.k3_components) = 'array'
     AND public.asset_component_backfill_valid(e.value)
     AND NOT EXISTS (
       SELECT 1 FROM public.company_migration_resets m WHERE m.source_company_id = a.company_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.asset_components c WHERE c.asset_id = a.id
     );

  -- The posted history of those assets, split per component by each
  -- component's share of the annual charge ((cost - salvage) / life), the
  -- split the old engine posted as one amount. The last component takes the
  -- rounding remainder so each split sums to its voucher.
  WITH comp AS (
    SELECT c.id, c.asset_id, c.sort_order,
           (c.cost - c.salvage_value) / c.useful_life_months::numeric AS rate
      FROM public.asset_components c
     WHERE c.useful_life_months IS NOT NULL
       AND c.cost > c.salvage_value
  ), sched AS (
    SELECT ds.id AS schedule_id, ds.asset_id, ds.company_id, ds.planned_depreciation
      FROM public.depreciation_schedules ds
     WHERE ds.journal_entry_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM comp WHERE comp.asset_id = ds.asset_id)
       AND NOT EXISTS (
         SELECT 1 FROM public.depreciation_schedule_components x WHERE x.schedule_id = ds.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.company_migration_resets m WHERE m.source_company_id = ds.company_id
       )
  ), shares AS (
    SELECT s.schedule_id, s.company_id, comp.id AS component_id, s.planned_depreciation,
           round(s.planned_depreciation * comp.rate / sum(comp.rate) OVER (PARTITION BY s.schedule_id), 2) AS amount,
           row_number() OVER (PARTITION BY s.schedule_id ORDER BY comp.sort_order DESC, comp.id DESC) AS rn
      FROM sched s
      JOIN comp ON comp.asset_id = s.asset_id
  ), totals AS (
    SELECT shares.*, sum(shares.amount) OVER (PARTITION BY shares.schedule_id) AS split_total
      FROM shares
  )
  INSERT INTO public.depreciation_schedule_components (schedule_id, component_id, company_id, amount)
  SELECT t.schedule_id,
         t.component_id,
         t.company_id,
         CASE WHEN t.rn = 1 THEN t.amount + (t.planned_depreciation - t.split_total) ELSE t.amount END
    FROM totals t;

  PERFORM set_config('gnubok.asset_components_backfill', 'off', true);
END;
$$;

NOTIFY pgrst, 'reload schema';
