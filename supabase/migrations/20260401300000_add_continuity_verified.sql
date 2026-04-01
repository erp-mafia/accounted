-- Add continuity_verified column to fiscal_periods
-- NULL = not checked, true = IB/UB match verified, false = discrepancy detected
ALTER TABLE public.fiscal_periods
ADD COLUMN continuity_verified boolean;
