-- Upplupna intäkter (17xx) as the periodisering account on customer invoice
-- lines (#62).
--
-- 20260623120000_accrual_schedules.sql allowed only 29xx (förutbetalda
-- intäkter) on a revenue schedule and on invoice_items. Revenue earned in
-- months BEFORE the invoice month (September consulting on an October
-- invoice) belongs on a 17xx interimsfordran instead, booked on the last day
-- of each month it covers so that month's resultaträkning carries it:
--
--   30 Sep:        Dr 1790 Övriga förutbetalda kostnader och upplupna intäkter
--                  / Cr 3xxx (revenue)                          (no moms)
--   invoice date:  Dr 1510 / Cr 1790 (net) + Cr 26xx            (moms on the invoice date)
--
-- The mirror of 20261016004700_accrued_costs_on_supplier_invoices.sql. The
-- month-end dating, the "period ends before the invoice month" rule and the
-- refusal of locked months live in the application (accruals service and
-- lib/bookkeeping/accruals/accrued-cost-guard.ts); these CHECKs only widen
-- the account range. Every existing row satisfies the wider ranges, so
-- validation cannot fail.

ALTER TABLE public.accrual_schedules
  DROP CONSTRAINT IF EXISTS accrual_schedules_balance_account_range;
ALTER TABLE public.accrual_schedules
  ADD CONSTRAINT accrual_schedules_balance_account_range CHECK (
    (direction = 'expense' AND balance_account ~ '^(17|29)[0-9]{2}$')
    OR (direction = 'revenue' AND balance_account ~ '^(17|29)[0-9]{2}$')
  );

ALTER TABLE public.invoice_items
  DROP CONSTRAINT IF EXISTS invoice_items_accrual_account_range;
ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_accrual_account_range CHECK (
    accrual_balance_account IS NULL OR accrual_balance_account ~ '^(17|29)[0-9]{2}$'
  );

COMMENT ON COLUMN public.accrual_schedules.posting_floor_date IS
  'The origin entry''s entry_date. Floors the dissolution dates of a deferral '
  '(17xx expense, 29xx revenue) so the interim account never goes negative. An '
  'upplupen kostnad (expense on 29xx) or upplupen intäkt (revenue on 17xx) '
  'ignores it: its months lie before the invoice and each posts on its own last day.';

NOTIFY pgrst, 'reload schema';
