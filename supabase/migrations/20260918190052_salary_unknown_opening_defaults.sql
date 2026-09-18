-- Omission is not evidence that historical money is zero. Existing verified
-- values remain unchanged; new imports must explicitly provide known zeroes.
ALTER TABLE public.employee_opening_balances
  ALTER COLUMN ytd_net SET DEFAULT NULL,
  ALTER COLUMN opening_semester_liability SET DEFAULT NULL,
  ALTER COLUMN opening_semester_liability_avgifter SET DEFAULT NULL;
NOTIFY pgrst, 'reload schema';
