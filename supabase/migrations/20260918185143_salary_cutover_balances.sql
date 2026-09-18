-- Keep unavailable historical amounts unknown instead of reporting false zeroes.
ALTER TABLE public.employee_opening_balances
  ALTER COLUMN ytd_net DROP NOT NULL,
  ALTER COLUMN opening_semester_liability DROP NOT NULL,
  ALTER COLUMN opening_semester_liability_avgifter DROP NOT NULL,
  ADD COLUMN vacation_balance jsonb;
ALTER TABLE public.salary_run_employees
  ALTER COLUMN ytd_net DROP NOT NULL,
  ADD COLUMN vacation_balance jsonb;
ALTER TABLE public.salary_line_items
  ADD COLUMN vacation_movements jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(vacation_movements) = 'array');
ALTER TABLE public.employee_vacation_balances ADD COLUMN vacation_balance jsonb;

CREATE FUNCTION public.valid_payroll_vacation_balance(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE k text; v jsonb; y integer; start_date date; cutoff date; total numeric := 0;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT value ?& ARRAY[
    'as_of_date','year_start','annual_entitlement','tracking','paid','extra_paid','unpaid','advance','saved_by_year','source_reference','review_notes'
  ] THEN RETURN false; END IF;
  start_date := (value->>'year_start')::date; cutoff := (value->>'as_of_date')::date;
  IF start_date IS NULL OR cutoff IS NULL OR cutoff < start_date OR cutoff >= start_date + interval '1 year'
    OR jsonb_typeof(value->'tracking') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(value->'source_reference') IS DISTINCT FROM 'string'
    OR length(value->>'source_reference') NOT BETWEEN 1 AND 2000
    OR jsonb_typeof(value->'review_notes') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'saved_by_year') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['annual_entitlement','paid','extra_paid','unpaid','advance'] LOOP
    IF jsonb_typeof(value->k) IS DISTINCT FROM 'number' OR (value->>k)::numeric NOT BETWEEN 0 AND 366 THEN RETURN false; END IF;
    IF k <> 'annual_entitlement' THEN total := total + (value->>k)::numeric; END IF;
  END LOOP;
  y := extract(year FROM start_date);
  FOR k,v IN SELECT * FROM jsonb_each(value->'saved_by_year') LOOP
    IF k !~ '^\d{4}$' OR k::integer NOT BETWEEN y-5 AND y-1 OR jsonb_typeof(v) IS DISTINCT FROM 'number'
      OR v::text::numeric NOT BETWEEN 0 AND 366 THEN RETURN false; END IF;
    total := total + v::text::numeric;
  END LOOP;
  IF jsonb_array_length(value->'review_notes') > 20 THEN RETURN false; END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(value->'review_notes') LOOP
    IF jsonb_typeof(v) <> 'string' OR length(v #>> '{}') > 2000 THEN RETURN false; END IF;
  END LOOP;
  RETURN (value->>'tracking')::boolean OR total = 0;
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;

ALTER TABLE public.employee_opening_balances ADD CONSTRAINT opening_vacation_balance_valid
  CHECK (vacation_balance IS NULL OR public.valid_payroll_vacation_balance(vacation_balance));
ALTER TABLE public.salary_run_employees ADD CONSTRAINT payslip_vacation_balance_valid
  CHECK (vacation_balance IS NULL OR public.valid_payroll_vacation_balance(vacation_balance));
ALTER TABLE public.employee_vacation_balances ADD CONSTRAINT ledger_vacation_balance_valid
  CHECK (vacation_balance IS NULL OR public.valid_payroll_vacation_balance(vacation_balance));

CREATE FUNCTION public.valid_payroll_vacation_movements(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE v jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value) > 366 THEN RETURN false; END IF;
  FOR v IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT v ?& ARRAY['date','category','days']
      OR (v->>'date')::date IS NULL OR jsonb_typeof(v->'days') IS DISTINCT FROM 'number'
      OR (v->>'days')::numeric <= 0 OR (v->>'days')::numeric > 366
      OR coalesce(v->>'category','') NOT IN ('paid','extra_paid','saved','unpaid','advance')
      OR ((v->>'category' = 'saved') <> (v ? 'saved_year'))
      OR (v ? 'saved_year' AND coalesce(v->>'saved_year','') !~ '^\d{4}$') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
ALTER TABLE public.salary_line_items ADD CONSTRAINT vacation_movements_valid
  CHECK (public.valid_payroll_vacation_movements(vacation_movements));

COMMENT ON COLUMN public.employee_opening_balances.vacation_balance IS
  'Authoritative remaining-day snapshot with its own cutoff, separate extra-paid and saved origin-year buckets. Null preserves legacy allocation handling.';
COMMENT ON COLUMN public.salary_run_employees.vacation_balance IS
  'Frozen, categorized balance at the deviation cutoff, calculated from the opening and dated withdrawals. Not the current live employee balance.';
COMMENT ON COLUMN public.employee_opening_balances.ytd_net IS
  'Null means historical net payments are unavailable; never infer net from gross minus tax.';

NOTIFY pgrst, 'reload schema';
