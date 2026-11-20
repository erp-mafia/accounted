-- Upplupna kostnader (29xx) as the periodisering account on supplier invoice
-- lines.
--
-- 20260623120000_accrual_schedules.sql allowed only 17xx (förutbetalda
-- kostnader) on an expense schedule and on supplier_invoice_items. A cost for
-- months BEFORE the invoice month (September electricity on an October
-- invoice) belongs on a 29xx interimsskuld instead, booked on the last day of
-- each month it covers so that month's resultaträkning carries it:
--
--   30 Sep:        Dr 5020 (cost)          / Cr 2990 Övriga upplupna kostnader
--   invoice date:  Dr 2990 (net) + Dr 2641 / Cr 2440   (moms on the invoice date)
--
-- The month-end dating, the "period ends before the invoice month" rule and
-- the refusal of locked months live in the application (accruals service and
-- lib/bookkeeping/accruals/accrued-cost-guard.ts); these CHECKs only widen the
-- account range. Revenue schedules and customer invoice items stay 29xx.
-- Every existing row satisfies the wider ranges, so validation cannot fail.

ALTER TABLE public.accrual_schedules
  DROP CONSTRAINT IF EXISTS accrual_schedules_balance_account_range;
ALTER TABLE public.accrual_schedules
  ADD CONSTRAINT accrual_schedules_balance_account_range CHECK (
    (direction = 'expense' AND balance_account ~ '^(17|29)[0-9]{2}$')
    OR (direction = 'revenue' AND balance_account ~ '^29[0-9]{2}$')
  );

ALTER TABLE public.supplier_invoice_items
  DROP CONSTRAINT IF EXISTS supplier_invoice_items_accrual_account_range;
ALTER TABLE public.supplier_invoice_items
  ADD CONSTRAINT supplier_invoice_items_accrual_account_range CHECK (
    accrual_balance_account IS NULL OR accrual_balance_account ~ '^(17|29)[0-9]{2}$'
  );

COMMENT ON COLUMN public.accrual_schedules.posting_floor_date IS
  'The origin entry''s entry_date. Floors the dissolution dates of a deferral '
  '(17xx expense, 29xx revenue) so the interim account never goes negative. An '
  'upplupen kostnad (expense on 29xx) ignores it: its months lie before the '
  'invoice and each posts on its own last day.';

NOTIFY pgrst, 'reload schema';
