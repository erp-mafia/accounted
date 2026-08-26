-- Atomic fixed-asset disposal.
--
-- A disposal voucher and the immutable asset-register update are one legal
-- event. This RPC calls commit_journal_entry for sequential voucher numbering,
-- records any disposal-date depreciation schedule, and marks the asset as
-- disposed in the same transaction.

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS disposal_type text,
  ADD COLUMN IF NOT EXISTS disposal_journal_entry_id uuid,
  ADD COLUMN IF NOT EXISTS jamkning_direction text,
  ADD COLUMN IF NOT EXISTS jamkning_remaining_years integer,
  ADD COLUMN IF NOT EXISTS jamkning_total_years integer,
  ADD COLUMN IF NOT EXISTS jamkning_original_deduction_percent numeric(5, 2),
  ADD COLUMN IF NOT EXISTS jamkning_new_deduction_percent numeric(5, 2);

-- All constrained columns are new and NULL for existing rows, so validation
-- can never fail. Add every constraint NOT VALID and validate separately:
-- an immediate FK validation takes SHARE ROW EXCLUSIVE on journal_entries (a
-- hot table) and each plain CHECK scans assets under a blocking lock, while
-- VALIDATE CONSTRAINT only needs SHARE UPDATE EXCLUSIVE and does not block
-- writes.
ALTER TABLE public.assets
  DROP CONSTRAINT IF EXISTS assets_disposal_journal_entry_id_fkey,
  ADD CONSTRAINT assets_disposal_journal_entry_id_fkey
    FOREIGN KEY (disposal_journal_entry_id)
    REFERENCES public.journal_entries(id) ON DELETE RESTRICT
    NOT VALID,
  DROP CONSTRAINT IF EXISTS assets_disposal_type_check,
  ADD CONSTRAINT assets_disposal_type_check CHECK (
    disposal_type IS NULL OR disposal_type IN ('sale', 'scrap', 'business_transfer')
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS assets_jamkning_direction_check,
  ADD CONSTRAINT assets_jamkning_direction_check CHECK (
    jamkning_direction IS NULL OR jamkning_direction IN ('increase', 'decrease', 'none', 'transferred')
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS assets_jamkning_years_check,
  ADD CONSTRAINT assets_jamkning_years_check CHECK (
    (jamkning_remaining_years IS NULL OR jamkning_remaining_years >= 0)
    AND (jamkning_total_years IS NULL OR jamkning_total_years IN (5, 10))
    AND (
      jamkning_remaining_years IS NULL
      OR jamkning_total_years IS NULL
      OR jamkning_remaining_years <= jamkning_total_years
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS assets_jamkning_percent_check,
  ADD CONSTRAINT assets_jamkning_percent_check CHECK (
    (jamkning_original_deduction_percent IS NULL OR jamkning_original_deduction_percent BETWEEN 0 AND 100)
    AND (jamkning_new_deduction_percent IS NULL OR jamkning_new_deduction_percent BETWEEN 0 AND 100)
  ) NOT VALID;

ALTER TABLE public.assets VALIDATE CONSTRAINT assets_disposal_journal_entry_id_fkey;
ALTER TABLE public.assets VALIDATE CONSTRAINT assets_disposal_type_check;
ALTER TABLE public.assets VALIDATE CONSTRAINT assets_jamkning_direction_check;
ALTER TABLE public.assets VALIDATE CONSTRAINT assets_jamkning_years_check;
ALTER TABLE public.assets VALIDATE CONSTRAINT assets_jamkning_percent_check;

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
       OR NEW.k3_components IS DISTINCT FROM OLD.k3_components
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

CREATE OR REPLACE FUNCTION public.commit_asset_disposal(
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
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
      );
    END IF;
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
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
) TO authenticated;

COMMENT ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
) IS 'Atomically posts a fixed-asset disposal voucher, disposal-date depreciation schedule, and immutable asset-register state.';

NOTIFY pgrst, 'reload schema';
