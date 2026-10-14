-- Payslip lines on unbooked runs stop carrying a cached default account.
--
-- salary_line_items.account_number used to be written on every line at
-- creation from the item type's default (lib/salary/account-mapping.ts). Three
-- of the write sites passed no employment type, so an owner's hourly,
-- unpaid-leave and manual lines stored 7210 instead of 7220, and a line whose
-- item type changed kept the account of its old type. From this change on the
-- column is an explicit override only: NULL means "the default", resolved at
-- booking from the item type, the employment type and the personnel category
-- (lineItemAccount in account-mapping.ts).
--
-- This clears the cached defaults on runs that have not been booked (draft,
-- review, approved, paid), so they book on the resolved account. A stored
-- account is cleared only when it equals what the old code would have cached
-- for that item type: the item type's base default (what the three sites
-- without an employment type stored), or, for owners and board members, the
-- typed default (7220/7282/7286, 7240). Anything else is a deliberate
-- override and stays. Untouched:
--   - booked and corrected runs: their verifikat is posted, the lines are the
--     record of what was booked;
--   - utlägg lines (expense_reimbursement): they carry the claim's own
--     liability account, never a default.
--
-- The value list mirrors the item-type map in account-mapping.ts; a vitest
-- (src/lib/salary/__tests__/account-mapping.test.ts) pins it to the resolver.
-- Data only: no schema change.

with base_default(item_type, account_number) as (
  values
    ('monthly_salary', '7210'),
    ('hourly_salary', '7210'),
    ('overtime', '7210'),
    ('overtime_50', '7210'),
    ('overtime_100', '7210'),
    ('ob_weekday_evening', '7210'),
    ('ob_weekend', '7210'),
    ('ob_night', '7210'),
    ('ob_holiday', '7210'),
    ('bonus', '7210'),
    ('commission', '7210'),
    ('gross_deduction_pension', '7218'),
    ('gross_deduction_other', '7210'),
    ('benefit_car', '7385'),
    ('benefit_housing', '7381'),
    ('benefit_meals', '7382'),
    ('benefit_wellness', '7699'),
    ('benefit_bike', '7388'),
    ('benefit_other', '7389'),
    ('sick_karens', '7281'),
    ('sick_day2_14', '7281'),
    ('sick_day15_plus', '7281'),
    ('vab', '7210'),
    ('parental_leave', '7210'),
    ('unpaid_leave', '7210'),
    ('vacation', '7285'),
    ('semesterersattning', '7285'),
    ('traktamente_taxfree', '7321'),
    ('traktamente_taxable', '7322'),
    ('mileage_taxfree', '7331'),
    ('mileage_taxable', '7332'),
    ('net_deduction_advance', '1613'),
    ('net_deduction_union', '2794'),
    ('net_deduction_benefit_payment', '7385'),
    ('net_deduction_other', '2799'),
    ('oresavrundning', '3740'),
    ('correction', '7210'),
    ('other', '7210')
),
typed_default(employment_type, base_account, account_number) as (
  values
    ('company_owner', '7210', '7220'),
    ('company_owner', '7281', '7282'),
    ('company_owner', '7285', '7286'),
    ('board_member', '7210', '7240')
),
cached as (
  select li.id
  from public.salary_line_items li
  join public.salary_run_employees sre on sre.id = li.salary_run_employee_id
  join public.salary_runs r on r.id = sre.salary_run_id
  join public.employees e on e.id = sre.employee_id
  join base_default d on d.item_type = li.item_type
  left join typed_default t
    on t.employment_type = e.employment_type
   and t.base_account = d.account_number
  where r.status in ('draft', 'review', 'approved', 'paid')
    and li.account_number is not null
    and li.account_number in (d.account_number, coalesce(t.account_number, d.account_number))
)
update public.salary_line_items li
set account_number = null
from cached
where li.id = cached.id;
