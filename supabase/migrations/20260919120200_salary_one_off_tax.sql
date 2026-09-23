-- Engångsskatt per payslip line (policy track of #2729).
-- pg-test: supabase/migrations/__tests__/salary-calculation-policy.pg.test.ts
--
-- Skatteverket taxes engångsbelopp (bonus, provision, retroactive pay,
-- semesterersättning at final settlement) at a flat percentage that depends
-- on the employee's estimated yearly income, instead of through the monthly
-- table where the amount would land in a higher bracket. The percentage is
-- verified by the operator and stored on the line; the engine never
-- estimates it (lib/salary/one-off-tax.ts). NULL = taxed by the table.
--
-- The CHECK mirrors validateOneOffTaxLine: a percentage only on a positive,
-- taxable addition of an eligible wage type, never on a deduction, a benefit
-- or a non-taxable row. Added NOT VALID and validated in 20260919120300
-- (same split as 20260906210300 / 20260906210301); every existing row is
-- NULL and passes.

ALTER TABLE public.salary_line_items
  ADD COLUMN IF NOT EXISTS one_off_tax_percent numeric(5,2);

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT IF EXISTS salary_line_items_one_off_tax_percent_check;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_one_off_tax_percent_check
  CHECK (
    one_off_tax_percent IS NULL
    OR (
      one_off_tax_percent >= 0
      AND one_off_tax_percent <= 100
      AND amount > 0
      AND is_taxable
      AND NOT is_gross_deduction
      AND NOT is_net_deduction
      AND item_type IN ('bonus', 'commission', 'other', 'correction', 'semesterersattning')
    )
  )
  NOT VALID;

COMMENT ON COLUMN public.salary_line_items.one_off_tax_percent IS
  'Engångsskatt: operator-verified flat withholding percentage for this line (SFL 11 kap., Skatteverket engångsbelopp). NULL = taxed through the monthly table. A valid jämkning decision on the employee overrides it.';

NOTIFY pgrst, 'reload schema';
