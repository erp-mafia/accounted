-- An unresolved migrated source may be displayed, but may not silently
-- authorize new paid withdrawals. Default omission means no review hold.
ALTER TABLE public.employee_opening_balances ADD CONSTRAINT opening_vacation_hold_boolean
  CHECK (vacation_balance IS NULL OR NOT vacation_balance ? 'withdrawals_blocked' OR jsonb_typeof(vacation_balance->'withdrawals_blocked') = 'boolean');
ALTER TABLE public.salary_run_employees ADD CONSTRAINT payslip_vacation_hold_boolean
  CHECK (vacation_balance IS NULL OR NOT vacation_balance ? 'withdrawals_blocked' OR jsonb_typeof(vacation_balance->'withdrawals_blocked') = 'boolean');
ALTER TABLE public.employee_vacation_balances ADD CONSTRAINT ledger_vacation_hold_boolean
  CHECK (vacation_balance IS NULL OR NOT vacation_balance ? 'withdrawals_blocked' OR jsonb_typeof(vacation_balance->'withdrawals_blocked') = 'boolean');
NOTIFY pgrst, 'reload schema';
