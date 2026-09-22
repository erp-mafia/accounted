-- Migration: opening accumulated depreciation on the asset register
--
-- Why this exists: a company moving to Accounted from another system brings
-- assets that are already partly depreciated. The ledger side arrives through
-- the SIE import (the 12x9 ackumulerade avskrivningar balance), but the
-- register row only knew acquisition date, cost and useful life, so the
-- depreciation engine counted only depreciation booked in Accounted. Book
-- value, the next depreciation proposal and the disposal gain/loss were then
-- wrong. BFNAR 2013:2 punkt 4.5 requires the register to carry the
-- ackumulerade avskrivningar per asset.
--
-- Two columns: the amount already depreciated before Accounted, and the date
-- it is stated per. Registering it NEVER posts a voucher: the amount is
-- already in the imported ledger. The engine reads it as depreciation on the
-- books through that date and plans the rest from there.
--
-- RLS: unchanged. The columns live on public.assets, whose company-scoped
-- policies (user_company_ids()) already cover every column.
--
-- Trigger: enforce_asset_post_disposal_immutability is redefined (same body
-- as 20260803226000_atomic_asset_disposal.sql plus the two new columns) so a
-- disposed asset's opening balance is frozen like its other financial
-- attributes.
--
-- pg-test: covered-by tests/pg/assets.pg.test.ts

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS opening_accumulated_depreciation NUMERIC(15, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_depreciation_date DATE;

COMMENT ON COLUMN public.assets.opening_accumulated_depreciation IS
  'Ackumulerad avskrivning booked before the asset entered Accounted (e.g. in a previous system), per opening_depreciation_date. Never posted by Accounted: the amount is already in the imported 12x9 balance.';
COMMENT ON COLUMN public.assets.opening_depreciation_date IS
  'Date the opening accumulated depreciation is stated per. Required when the amount is above 0.';

-- New columns: every existing row is (0, NULL), so the constraints hold and
-- validate immediately.
ALTER TABLE public.assets
  ADD CONSTRAINT assets_opening_depreciation_check CHECK (
    opening_accumulated_depreciation >= 0
    AND opening_accumulated_depreciation <= acquisition_cost
    AND (
      (opening_accumulated_depreciation = 0 AND opening_depreciation_date IS NULL)
      OR (opening_accumulated_depreciation > 0 AND opening_depreciation_date IS NOT NULL)
    )
    AND (opening_depreciation_date IS NULL OR opening_depreciation_date >= acquisition_date)
  );

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

NOTIFY pgrst, 'reload schema';
