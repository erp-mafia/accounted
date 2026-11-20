-- Nedskrivning, mark and the depreciation start date in the asset register.
--
-- Why this exists:
--   * ÅRL 4 kap. 5 § and K3 27.2-27.3: a fixed asset whose recoverable amount
--     is below its carrying amount on a balansdag is written down to it, and a
--     write-down is reversed when its reasons no longer hold (27.14-27.15),
--     never for goodwill (ÅRL 4:5 tredje stycket). The register had no
--     write-down at all: the carrying amount the engine planned from could
--     only fall by depreciation, and a disposal never cleared 12x8.
--   * Mark is never depreciated (K2 10.29 kommentar, K3 17.4): its useful life
--     is unlimited. useful_life_months > 0 made land impossible to register
--     except as a depreciating asset.
--   * K3 17.18: depreciation starts when the asset can be used, which may be
--     later than the acquisition date. Components have had their own start
--     date since 20261031200101; a plain asset had none.
--
-- What this migration adds:
--   1. assets.depreciation_start_date (NULL: the acquisition date), locked
--      once the asset's plan has driven a posting.
--   2. Category 'land': useful_life_months 0 means "not depreciated" and is
--      allowed for land only; a land asset carries no salvage value, opening
--      depreciation, components or start date.
--   3. public.asset_value_adjustments: one row per posted write-down or
--      reversal (per component for a component asset), written only by
--      commit_asset_value_adjustment in the voucher transaction. A row counts
--      while its voucher is posted; a storno (status 'reversed') takes it out.
--   4. commit_asset_value_adjustment: posts the voucher (Dr 77xx / Cr 12x8,
--      or the reverse for a reversal) and records the rows, under the asset
--      row lock, dated the balansdag, capped at the carrying amount (a
--      write-down) or the outstanding write-down (a reversal).
--   5. The basis locks (asset opening, component basis, delete) also count a
--      write-down as having reached the books; a component with a write-down
--      outstanding cannot be replaced, and a plain asset written down cannot
--      be split into components afterwards.
--
-- Uppskrivning (ÅRL 4:6) is not part of this migration: revaluation
-- upwards is not built.
--
-- pg-test: tests/pg/asset-impairment.pg.test.ts

-- =============================================================================
-- 1. assets: depreciation start date and land
-- =============================================================================

-- assets is read at every year-end and on every register page: fail the
-- migration job instead of queueing them behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.assets ADD COLUMN depreciation_start_date date;

COMMENT ON COLUMN public.assets.depreciation_start_date IS
  'K3 17.18: the day depreciation starts (the asset can be used). NULL: the acquisition date. Locked once the asset''s plan has driven a posting.';

ALTER TABLE public.assets
  ADD CONSTRAINT assets_depreciation_start_check CHECK (
    depreciation_start_date IS NULL OR depreciation_start_date >= acquisition_date
  );

ALTER TABLE public.assets DROP CONSTRAINT assets_category_check;
ALTER TABLE public.assets
  ADD CONSTRAINT assets_category_check CHECK (category IN (
    'immaterial',
    'building',
    'land',
    'land_improvement',
    'machinery',
    'equipment',
    'vehicle',
    'computer',
    'other_tangible'
  ));

-- 0 months: not depreciated, which only land is (unlimited useful life).
ALTER TABLE public.assets DROP CONSTRAINT assets_useful_life_months_check;
ALTER TABLE public.assets
  ADD CONSTRAINT assets_useful_life_months_check CHECK (
    useful_life_months > 0 OR (useful_life_months = 0 AND category = 'land')
  );

ALTER TABLE public.assets
  ADD CONSTRAINT assets_land_not_depreciated CHECK (
    category <> 'land'
    OR (
      useful_life_months = 0
      AND salvage_value = 0
      AND opening_accumulated_depreciation = 0
      AND k3_components IS NULL
      AND depreciation_start_date IS NULL
    )
  );

-- A disposed asset keeps every financial attribute (20260922214924), the
-- start date included. Restated with that one column added.
CREATE OR REPLACE FUNCTION public.enforce_asset_post_disposal_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF OLD.disposed_at IS NOT NULL THEN
    IF NEW.category IS DISTINCT FROM OLD.category
       OR NEW.acquisition_cost IS DISTINCT FROM OLD.acquisition_cost
       OR NEW.salvage_value IS DISTINCT FROM OLD.salvage_value
       OR NEW.useful_life_months IS DISTINCT FROM OLD.useful_life_months
       OR NEW.depreciation_method IS DISTINCT FROM OLD.depreciation_method
       OR NEW.restvarde_target IS DISTINCT FROM OLD.restvarde_target
       OR NEW.bas_asset_account IS DISTINCT FROM OLD.bas_asset_account
       OR NEW.bas_accumulated_account IS DISTINCT FROM OLD.bas_accumulated_account
       OR NEW.bas_expense_account IS DISTINCT FROM OLD.bas_expense_account
       OR NEW.acquisition_date IS DISTINCT FROM OLD.acquisition_date
       OR NEW.depreciation_start_date IS DISTINCT FROM OLD.depreciation_start_date
       OR NEW.k3_components IS DISTINCT FROM OLD.k3_components
       OR NEW.opening_accumulated_depreciation IS DISTINCT FROM OLD.opening_accumulated_depreciation
       OR NEW.opening_depreciation_date IS DISTINCT FROM OLD.opening_depreciation_date
       OR NEW.disposed_at IS DISTINCT FROM OLD.disposed_at
       OR NEW.disposed_proceeds IS DISTINCT FROM OLD.disposed_proceeds
       OR NEW.disposed_proceeds_vat IS DISTINCT FROM OLD.disposed_proceeds_vat
       OR NEW.disposed_vat_treatment IS DISTINCT FROM OLD.disposed_vat_treatment
       OR NEW.disposal_type IS DISTINCT FROM OLD.disposal_type
       OR NEW.disposal_journal_entry_id IS DISTINCT FROM OLD.disposal_journal_entry_id
       OR NEW.jamkning_amount IS DISTINCT FROM OLD.jamkning_amount
       OR NEW.jamkning_remaining_months IS DISTINCT FROM OLD.jamkning_remaining_months
       OR NEW.jamkning_total_months IS DISTINCT FROM OLD.jamkning_total_months
       OR NEW.jamkning_original_input_vat IS DISTINCT FROM OLD.jamkning_original_input_vat
       OR NEW.jamkning_direction IS DISTINCT FROM OLD.jamkning_direction
       OR NEW.jamkning_remaining_years IS DISTINCT FROM OLD.jamkning_remaining_years
       OR NEW.jamkning_total_years IS DISTINCT FROM OLD.jamkning_total_years
       OR NEW.jamkning_original_deduction_percent IS DISTINCT FROM OLD.jamkning_original_deduction_percent
       OR NEW.jamkning_new_deduction_percent IS DISTINCT FROM OLD.jamkning_new_deduction_percent THEN
      RAISE EXCEPTION 'Cannot modify financial or disposal attributes of a disposed asset (id=%)', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- =============================================================================
-- 2. asset_value_adjustments
-- =============================================================================

CREATE TABLE public.asset_value_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  -- The component the write-down was allocated to (a component asset); NULL
  -- for an asset depreciated as a whole.
  component_id uuid REFERENCES public.asset_components(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('impairment', 'impairment_reversal')),
  -- The balansdag the recoverable amount was assessed on (K3 27.3, 27.14):
  -- the last day of fiscal_period_id.
  adjustment_date date NOT NULL,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  amount numeric(15, 2) NOT NULL CHECK (amount > 0),
  -- Återvinningsvärde (K3 27.5) the amount was derived from, for the asset
  -- as a whole; the documentation the write-down rests on.
  recoverable_amount numeric(15, 2) CHECK (recoverable_amount IS NULL OR recoverable_amount >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  -- The accounts the voucher used, so a disposal clears the same 12x8.
  expense_account text NOT NULL,
  accumulated_account text NOT NULL,
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_value_adjustments_entry_component_unique
    UNIQUE NULLS NOT DISTINCT (journal_entry_id, component_id)
);

COMMENT ON TABLE public.asset_value_adjustments IS
  'Posted nedskrivningar and their reversals per asset (per component for a component asset), ÅRL 4:5 and K3 27. Written only by commit_asset_value_adjustment in the voucher transaction. A row counts while its voucher is posted (journal_entries.status = posted).';

CREATE INDEX idx_asset_value_adjustments_company ON public.asset_value_adjustments (company_id);
CREATE INDEX idx_asset_value_adjustments_asset ON public.asset_value_adjustments (asset_id, adjustment_date);
CREATE INDEX idx_asset_value_adjustments_component
  ON public.asset_value_adjustments (component_id)
  WHERE component_id IS NOT NULL;
CREATE INDEX idx_asset_value_adjustments_period ON public.asset_value_adjustments (fiscal_period_id);
CREATE INDEX idx_asset_value_adjustments_entry ON public.asset_value_adjustments (journal_entry_id);

ALTER TABLE public.asset_value_adjustments ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asset_value_adjustments TO service_role;
-- Read-only to sessions: commit_asset_value_adjustment (SECURITY DEFINER) is
-- the only writer.
GRANT SELECT ON TABLE public.asset_value_adjustments TO authenticated;

CREATE POLICY asset_value_adjustments_select ON public.asset_value_adjustments
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER asset_value_adjustments_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.asset_value_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE FUNCTION public.guard_asset_value_adjustments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A value adjustment is never updated: reverse its voucher (storno)'
      USING ERRCODE = '23514';
  END IF;
  -- Tenant teardown removes the register with the verifikat.
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Cannot delete a posted value adjustment (id=%)', OLD.id
    USING ERRCODE = '23514',
          HINT = 'Reverse the voucher (storno). The row is räkenskapsinformation (BFL 7 kap.).';
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_asset_value_adjustments() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_asset_value_adjustments
  BEFORE UPDATE OR DELETE ON public.asset_value_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.guard_asset_value_adjustments();

-- The net write-down outstanding (write-downs less reversals) of an asset as
-- a whole (p_component_id NULL) or of one component, counting posted
-- vouchers only.
CREATE FUNCTION public.asset_net_impairment(p_asset_id uuid, p_component_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT coalesce(sum(CASE WHEN v.kind = 'impairment' THEN v.amount ELSE -v.amount END), 0)
    FROM public.asset_value_adjustments v
    JOIN public.journal_entries je ON je.id = v.journal_entry_id AND je.status = 'posted'
   WHERE v.asset_id = p_asset_id
     AND v.component_id IS NOT DISTINCT FROM p_component_id;
$function$;

REVOKE ALL ON FUNCTION public.asset_net_impairment(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 3. Locks that now count a write-down
-- =============================================================================

-- A component's basis is locked once its plan has driven a posting: a posted
-- depreciation split, or a write-down allocated to it.
CREATE OR REPLACE FUNCTION public.asset_component_has_posted_depreciation(p_component_id uuid)
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
  ) OR EXISTS (
    SELECT 1
      FROM public.asset_value_adjustments v
      JOIN public.journal_entries je ON je.id = v.journal_entry_id AND je.status = 'posted'
     WHERE v.component_id = p_component_id
  );
$function$;

REVOKE ALL ON FUNCTION public.asset_component_has_posted_depreciation(uuid) FROM PUBLIC, anon, authenticated;

-- The asset-level opening lock (20260923142743, restated in 20261031200101)
-- also holds once a write-down is posted: the write-down was computed from
-- the carrying amount the opening is part of.
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
  ) OR EXISTS (
    SELECT 1
      FROM public.asset_value_adjustments v
      JOIN public.journal_entries je ON je.id = v.journal_entry_id AND je.status = 'posted'
     WHERE v.asset_id = OLD.id AND v.company_id = OLD.company_id
  ) THEN
    RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_asset_opening_after_depreciation() FROM PUBLIC, anon, authenticated;

-- The start date is part of the depreciation basis: once a planenlig
-- avskrivning or a write-down has posted, a correction goes through storno.
CREATE FUNCTION public.enforce_asset_start_after_posting()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.depreciation_start_date IS NOT DISTINCT FROM OLD.depreciation_start_date THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.depreciation_schedules ds
    WHERE ds.asset_id = OLD.id AND ds.company_id = OLD.company_id
      AND ds.journal_entry_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.asset_value_adjustments v
      JOIN public.journal_entries je ON je.id = v.journal_entry_id AND je.status = 'posted'
     WHERE v.asset_id = OLD.id AND v.company_id = OLD.company_id
  ) THEN
    RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_asset_start_after_posting() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_asset_start_after_posting
  BEFORE UPDATE OF depreciation_start_date ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_start_after_posting();

-- A write-down on an asset depreciated as a whole was computed from that
-- whole: splitting the asset into components afterwards would leave it
-- unallocated. A component with a write-down outstanding cannot be replaced
-- either: the replacement voucher clears depreciation, not 12x8.
CREATE FUNCTION public.guard_asset_components_impairment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1
        FROM public.asset_value_adjustments v
        JOIN public.journal_entries je ON je.id = v.journal_entry_id AND je.status = 'posted'
       WHERE v.asset_id = NEW.asset_id
         AND v.component_id IS NULL
    ) THEN
      RAISE EXCEPTION 'ASSET_CORRECTION_BLOCKED' USING ERRCODE = 'PT409',
        HINT = 'The asset has a write-down posted on it as a whole.';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.derecognised_at IS NULL
     AND NEW.derecognised_at IS NOT NULL
     AND public.asset_net_impairment(OLD.asset_id, OLD.id) <> 0 THEN
    RAISE EXCEPTION 'ASSET_COMPONENT_IMPAIRED' USING ERRCODE = 'PT409';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_asset_components_impairment() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER guard_asset_components_impairment
  BEFORE INSERT OR UPDATE OF derecognised_at ON public.asset_components
  FOR EACH ROW EXECUTE FUNCTION public.guard_asset_components_impairment();

-- delete_never_posted_asset (restated from 20261031200101): a write-down
-- voucher is as much "the books" as a posted avskrivning, reversed or not.
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
  ) OR EXISTS (
    SELECT 1
      FROM public.asset_value_adjustments v
     WHERE v.company_id = p_company_id
       AND v.asset_id = p_asset_id
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
-- 4. commit_asset_value_adjustment
-- =============================================================================
-- Posts a write-down (Dr 77xx / Cr 12x8) or its reversal (Dr 12x8 / Cr 77xx)
-- and records it, in one transaction under the asset row lock. The voucher is
-- built by the asset service from the recoverable amount; this RPC pins it to
-- the register:
--   * dated the last day of an open fiscal year (the balansdag of K3 27.3),
--     behind no lock date, with no depreciation posted for a later year and
--     no later write-down or reversal;
--   * a write-down at most the carrying amount (cost less opening, posted
--     depreciation and net write-downs), a reversal at most the write-down
--     outstanding, per component for a component asset (p_components covers
--     active components only and sums to the voucher);
--   * never a reversal on goodwill (ÅRL 4:5 tredje stycket: BAS 1070-1079);
--   * the voucher debits and credits exactly p_amount on the two accounts.
-- Refusals the caller can act on raise PT409 with a stable message the
-- engine maps to a typed error.

CREATE FUNCTION public.commit_asset_value_adjustment(
  p_company_id uuid,
  p_asset_id uuid,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_kind text,
  p_adjustment_date date,
  p_amount numeric,
  p_recoverable_amount numeric,
  p_reason text,
  p_expense_account text,
  p_accumulated_account text,
  p_components jsonb DEFAULT NULL,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_asset public.assets;
  v_period_start date;
  v_period_end date;
  v_period_closed boolean;
  v_period_locked_at timestamptz;
  v_company_lock_date date;
  v_entry_user_id uuid;
  v_has_components boolean;
  v_total_debit numeric;
  v_expense_debit numeric;
  v_expense_credit numeric;
  v_accumulated_debit numeric;
  v_accumulated_credit numeric;
  v_carrying numeric;
  v_outstanding numeric;
  v_given integer;
  v_distinct integer;
  v_sum numeric;
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
    RAISE EXCEPTION 'unauthorized asset value adjustment for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('impairment', 'impairment_reversal') THEN
    RAISE EXCEPTION 'Unknown value adjustment kind %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'The adjustment amount must be positive, in öre' USING ERRCODE = '23514';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'A write-down needs its reason (K3 27.3)' USING ERRCODE = '23514';
  END IF;
  IF p_expense_account IS NULL OR p_expense_account NOT BETWEEN '7700' AND '7799'
     OR p_accumulated_account IS NULL OR p_accumulated_account NOT BETWEEN '1000' AND '1299' THEN
    RAISE EXCEPTION 'Invalid write-down accounts % / %', p_expense_account, p_accumulated_account
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT a.*
    INTO v_asset
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found: %', p_asset_id USING ERRCODE = 'P0002';
  END IF;

  IF v_asset.disposed_at IS NOT NULL THEN
    RAISE EXCEPTION 'ASSET_DISPOSED' USING ERRCODE = 'PT409';
  END IF;

  IF p_kind = 'impairment_reversal' AND v_asset.bas_asset_account BETWEEN '1070' AND '1079' THEN
    RAISE EXCEPTION 'GOODWILL_REVERSAL_FORBIDDEN' USING ERRCODE = 'PT409';
  END IF;

  SELECT fp.period_start, fp.period_end, fp.is_closed, fp.locked_at
    INTO v_period_start, v_period_end, v_period_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = p_fiscal_period_id
     AND fp.company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found: %', p_fiscal_period_id USING ERRCODE = 'P0002';
  END IF;

  IF p_adjustment_date IS DISTINCT FROM v_period_end THEN
    RAISE EXCEPTION 'NOT_AT_BALANCE_SHEET_DATE' USING ERRCODE = 'PT409';
  END IF;

  IF p_adjustment_date < v_asset.acquisition_date THEN
    RAISE EXCEPTION 'A value adjustment cannot predate the acquisition' USING ERRCODE = '23514';
  END IF;

  IF v_period_closed OR v_period_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot adjust an asset in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;

  SELECT cs.bookkeeping_locked_through
    INTO v_company_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_company_lock_date IS NOT NULL AND p_adjustment_date <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date
      USING ERRCODE = '23514';
  END IF;

  -- A later year's depreciation was planned from the carrying amount without
  -- this adjustment; a later adjustment was assessed after it.
  IF EXISTS (
    SELECT 1
      FROM public.depreciation_schedules ds
      JOIN public.fiscal_periods fp ON fp.id = ds.fiscal_period_id
     WHERE ds.company_id = p_company_id
       AND ds.asset_id = p_asset_id
       AND ds.journal_entry_id IS NOT NULL
       AND fp.period_start > v_period_start
  ) THEN
    RAISE EXCEPTION 'LATER_DEPRECIATION_POSTED' USING ERRCODE = 'PT409';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.asset_value_adjustments v
      JOIN public.journal_entries je ON je.id = v.journal_entry_id AND je.status = 'posted'
     WHERE v.asset_id = p_asset_id
       AND v.adjustment_date > p_adjustment_date
  ) THEN
    RAISE EXCEPTION 'LATER_ADJUSTMENT_POSTED' USING ERRCODE = 'PT409';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.asset_components c
     WHERE c.asset_id = p_asset_id AND c.derecognised_at IS NULL
  ) INTO v_has_components;

  IF v_has_components THEN
    IF p_components IS NULL OR jsonb_typeof(p_components) <> 'array'
       OR jsonb_array_length(p_components) = 0 THEN
      RAISE EXCEPTION 'ASSET_COMPONENTS_CHANGED' USING ERRCODE = 'PT409';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_components) AS e(v)
       WHERE jsonb_typeof(e.v) <> 'object'
          OR coalesce(e.v ->> 'component_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR CASE
               WHEN jsonb_typeof(e.v -> 'amount') = 'number'
                 THEN (e.v ->> 'amount')::numeric <= 0
                   OR (e.v ->> 'amount')::numeric <> round((e.v ->> 'amount')::numeric, 2)
               ELSE true
             END
    ) THEN
      RAISE EXCEPTION 'Invalid component allocation' USING ERRCODE = '22023';
    END IF;
    SELECT count(*),
           count(DISTINCT (e.v ->> 'component_id')::uuid),
           coalesce(sum((e.v ->> 'amount')::numeric), 0)
      INTO v_given, v_distinct, v_sum
      FROM jsonb_array_elements(p_components) AS e(v);
    IF v_given <> v_distinct OR EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_components) AS e(v)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.asset_components c
          WHERE c.id = (e.v ->> 'component_id')::uuid
            AND c.asset_id = p_asset_id
            AND c.derecognised_at IS NULL
       )
    ) THEN
      RAISE EXCEPTION 'ASSET_COMPONENTS_CHANGED' USING ERRCODE = 'PT409';
    END IF;
    IF abs(v_sum - p_amount) > 0.005 THEN
      RAISE EXCEPTION 'Component allocation % does not match the adjustment %', v_sum, p_amount
        USING ERRCODE = '23514';
    END IF;

    -- Per component: the carrying amount (cost less opening, posted
    -- depreciation splits and the net write-down) caps a write-down; the
    -- write-down outstanding caps a reversal.
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_components) AS e(v)
        JOIN public.asset_components c ON c.id = (e.v ->> 'component_id')::uuid
       WHERE (e.v ->> 'amount')::numeric > CASE
               WHEN p_kind = 'impairment' THEN
                 c.cost - c.opening_accumulated_depreciation
                 - coalesce((
                     SELECT sum(dsc.amount)
                       FROM public.depreciation_schedule_components dsc
                       JOIN public.depreciation_schedules ds ON ds.id = dsc.schedule_id
                      WHERE dsc.component_id = c.id AND ds.journal_entry_id IS NOT NULL
                   ), 0)
                 - public.asset_net_impairment(p_asset_id, c.id)
               ELSE public.asset_net_impairment(p_asset_id, c.id)
             END + 0.005
    ) THEN
      RAISE EXCEPTION '%', CASE WHEN p_kind = 'impairment' THEN 'EXCEEDS_CARRYING_AMOUNT' ELSE 'EXCEEDS_WRITE_DOWN' END
        USING ERRCODE = 'PT409';
    END IF;
  ELSE
    IF p_components IS NOT NULL
       AND jsonb_typeof(p_components) = 'array'
       AND jsonb_array_length(p_components) > 0 THEN
      RAISE EXCEPTION 'ASSET_COMPONENTS_CHANGED' USING ERRCODE = 'PT409';
    END IF;
    IF p_kind = 'impairment' THEN
      v_carrying := v_asset.acquisition_cost - v_asset.opening_accumulated_depreciation
        - coalesce((
            SELECT sum(ds.planned_depreciation)
              FROM public.depreciation_schedules ds
             WHERE ds.asset_id = p_asset_id AND ds.journal_entry_id IS NOT NULL
          ), 0)
        - public.asset_net_impairment(p_asset_id, NULL);
      IF p_amount > v_carrying + 0.005 THEN
        RAISE EXCEPTION 'EXCEEDS_CARRYING_AMOUNT' USING ERRCODE = 'PT409';
      END IF;
    ELSE
      v_outstanding := public.asset_net_impairment(p_asset_id, NULL);
      IF p_amount > v_outstanding + 0.005 THEN
        RAISE EXCEPTION 'EXCEEDS_WRITE_DOWN' USING ERRCODE = 'PT409';
      END IF;
    END IF;
  END IF;

  -- Pin what this RPC can post: a system draft of this company, period and day.
  SELECT je.user_id
    INTO v_entry_user_id
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id
     AND je.fiscal_period_id = p_fiscal_period_id
     AND je.entry_date = p_adjustment_date
     AND je.status = 'draft'
     AND je.source_type = 'system'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Valid value adjustment draft not found: %', p_entry_id
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(sum(l.debit_amount), 0),
         coalesce(sum(l.debit_amount) FILTER (WHERE l.account_number = p_expense_account), 0),
         coalesce(sum(l.credit_amount) FILTER (WHERE l.account_number = p_expense_account), 0),
         coalesce(sum(l.debit_amount) FILTER (WHERE l.account_number = p_accumulated_account), 0),
         coalesce(sum(l.credit_amount) FILTER (WHERE l.account_number = p_accumulated_account), 0)
    INTO v_total_debit, v_expense_debit, v_expense_credit, v_accumulated_debit, v_accumulated_credit
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = p_entry_id;

  IF abs(v_total_debit - p_amount) > 0.005
     OR (p_kind = 'impairment' AND (abs(v_expense_debit - p_amount) > 0.005 OR abs(v_accumulated_credit - p_amount) > 0.005))
     OR (p_kind = 'impairment_reversal' AND (abs(v_accumulated_debit - p_amount) > 0.005 OR abs(v_expense_credit - p_amount) > 0.005)) THEN
    RAISE EXCEPTION 'The draft voucher does not book the adjustment % on % / %', p_amount, p_expense_account, p_accumulated_account
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

  IF v_has_components THEN
    INSERT INTO public.asset_value_adjustments (
      user_id, company_id, asset_id, component_id, kind, adjustment_date, fiscal_period_id,
      amount, recoverable_amount, reason, expense_account, accumulated_account, journal_entry_id
    )
    SELECT coalesce(v_entry_user_id, v_asset.user_id), p_company_id, p_asset_id,
           (e.v ->> 'component_id')::uuid, p_kind, p_adjustment_date, p_fiscal_period_id,
           (e.v ->> 'amount')::numeric, p_recoverable_amount, btrim(p_reason),
           p_expense_account, p_accumulated_account, p_entry_id
      FROM jsonb_array_elements(p_components) AS e(v);
  ELSE
    INSERT INTO public.asset_value_adjustments (
      user_id, company_id, asset_id, component_id, kind, adjustment_date, fiscal_period_id,
      amount, recoverable_amount, reason, expense_account, accumulated_account, journal_entry_id
    ) VALUES (
      coalesce(v_entry_user_id, v_asset.user_id), p_company_id, p_asset_id, NULL, p_kind,
      p_adjustment_date, p_fiscal_period_id, p_amount, p_recoverable_amount, btrim(p_reason),
      p_expense_account, p_accumulated_account, p_entry_id
    );
  END IF;

  RETURN QUERY SELECT v_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_asset_value_adjustment(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, text, text, jsonb, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_asset_value_adjustment(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, text, text, jsonb, text, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_asset_value_adjustment(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, text, text, jsonb, text, text
) IS 'Atomically posts a nedskrivning or its reversal (ÅRL 4:5, K3 27) on the balansdag and records it in asset_value_adjustments, under the asset row lock. Voucher numbering is delegated to commit_journal_entry.';

NOTIFY pgrst, 'reload schema';
