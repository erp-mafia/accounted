-- Recurring payroll lines per employee (issue #2042).
--
-- A standard Swedish payroll setup is a benefit bike paid via bruttolöneavdrag:
-- the payslip carries the same signed line every month (e.g. "Förmånscykel
-- bruttolöneavdrag -670,17 kr"). employee_benefits only derives positive
-- taxable benefit rows, so recurring deductions had to be re-added by hand on
-- every run: easy to forget and silently wrong (overstated gross, tax, AGA).
--
-- This table mirrors the employee_benefits pattern: an active row inside its
-- validity window is derived into salary_line_items on every calculation,
-- marked with source_recurring_line_id so recalculation replaces derived rows
-- without touching manual ones.

-- Same-company integrity by construction (the dimensions pattern): the
-- composite FK below binds employee_id to the row's company_id, so an
-- RLS-authorized member of one company can never point a recurring line at
-- another company's employee (IDOR guard, CWE-639).
ALTER TABLE public.employees
  ADD CONSTRAINT employees_id_company_id_key UNIQUE (id, company_id);

CREATE TABLE public.employee_recurring_lines (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id, company_id)
    REFERENCES public.employees(id, company_id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Reuses existing salary_line_items item types; no CHECK expansion needed
  -- there. Deductions must be negative; 'other' is a recurring addition.
  item_type   text NOT NULL CHECK (item_type IN (
    'gross_deduction_pension',
    'gross_deduction_other',
    'net_deduction_union',
    'net_deduction_benefit_payment',
    'net_deduction_other',
    'other'
  )),
  description text NOT NULL,
  amount      numeric NOT NULL,
  -- Optional BAS account override; NULL falls back to the engine's
  -- LINE_ITEM_ACCOUNTS mapping for the item type.
  account_number text,

  valid_from  date NOT NULL,
  valid_to    date,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT employee_recurring_lines_amount_sign CHECK (
    (item_type LIKE '%deduction%' AND amount < 0)
    OR (item_type = 'other' AND amount > 0)
  ),
  CONSTRAINT employee_recurring_lines_account_format CHECK (
    account_number IS NULL OR account_number ~ '^[0-9]{4}$'
  )
);

ALTER TABLE public.employee_recurring_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company employee_recurring_lines"
  ON public.employee_recurring_lines FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company employee_recurring_lines"
  ON public.employee_recurring_lines FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company employee_recurring_lines"
  ON public.employee_recurring_lines FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company employee_recurring_lines"
  ON public.employee_recurring_lines FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_employee_recurring_lines_company
  ON public.employee_recurring_lines (company_id);
CREATE INDEX idx_employee_recurring_lines_employee
  ON public.employee_recurring_lines (employee_id);
CREATE INDEX idx_employee_recurring_lines_active
  ON public.employee_recurring_lines (employee_id, valid_from, valid_to)
  WHERE is_active = true;

CREATE TRIGGER set_updated_at_employee_recurring_lines
  BEFORE UPDATE ON public.employee_recurring_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_employee_recurring_lines
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_recurring_lines
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- Back-link so the calculation can replace derived rows idempotently,
-- mirroring salary_line_items.source_benefit_id.
ALTER TABLE public.salary_line_items
  ADD COLUMN source_recurring_line_id uuid
    REFERENCES public.employee_recurring_lines(id) ON DELETE SET NULL;

CREATE INDEX idx_salary_line_items_source_recurring_line
  ON public.salary_line_items (source_recurring_line_id)
  WHERE source_recurring_line_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
