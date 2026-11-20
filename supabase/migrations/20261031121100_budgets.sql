-- =============================================================================
-- Budgets per account, month and dimension (accounted#134, part 1)
--
-- The tables `budgets` and `budget_entries` existed once and were dropped as
-- unused in 20240101000027. This is the foundation of the feature that
-- replaces them: named budget versions per räkenskapsår, their amounts per
-- resultatkonto, month and dimension tag, the atomic grid save, and the
-- actuals the comparison reads.
--
-- A budget is planning data, not räkenskapsinformation (BFL 7 kap.): it
-- records no affärshändelse and no verifikation, and nothing in the books
-- needs it to be followed or understood. So it is deleted freely; the audit
-- log still records who changed what.
--
--   1. budgets: one named version of a year's budget. A name is unique per
--      year (case and surrounding blanks ignored); at most one budget per year
--      is the default, the one a report reads when none is named. Setting a
--      budget as the default takes the default from the year's other budget,
--      in the same statement. An archived budget is read-only and never the
--      default. The company and the year of a budget never change.
--   2. budget_lines: one amount per budget, account, month and dimension tag,
--      in the SIE sign (#PBUDGET: debit positive, so a revenue budget is
--      negative). Only resultatkonton 3000-8999 in v1. month is the first day
--      of the month and lies inside the budget's räkenskapsår. dimensions is
--      the journal lines' bag ({"6":"P001"}), with the same well-formed CHECK
--      as journal_entry_lines (jel_dimensions_well_formed, 20260928200200).
--      A zero amount is no row: the grid save deletes the cell instead. The
--      account must be in the company's kontoplan (composite foreign key);
--      a deleted account takes its budget lines with it, and the kontoplan's
--      delete paths refuse an account that has budget lines
--      (get_account_budget_line_counts).
--   3. upsert_budget_lines(budget, lines): the grid save. Every cell of one
--      call is written or none is: an account outside the kontoplan, a month
--      outside the year, a repeated cell or an archived budget refuses the
--      whole call with a structured answer. Its rules and counts live in the
--      STABLE upsert_budget_lines_preview, which is also the dry run (the MCP
--      staging preview may only read).
--   4. get_account_month_actuals(company, year, from, to, dimensions): the
--      booked result per account and month, with the resultatrapport's
--      exclusions (the year-end chain and a resultatavslut by shape,
--      year_end_chain_entry_ids), read from ledger_account_days once the
--      company's summaries are built and from the journal lines otherwise.
--
-- Both tables: RLS on user_company_ids() with caller_can_write_company() for
-- writes, the writer-role trigger, audit and updated_at triggers, explicit
-- grants. No posted entry, journal table or enforcement trigger is touched.
--
-- pg-test: tests/pg/budgets.pg.test.ts
-- =============================================================================

-- 1 ---------------------------------------------------------------------------

CREATE TABLE public.budgets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 100),
  is_default boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The target of budget_lines' composite key: a line and its budget share
  -- a company by construction.
  UNIQUE (id, company_id),
  -- The year is the company's own (fiscal_periods_id_company_id_key).
  FOREIGN KEY (fiscal_period_id, company_id)
    REFERENCES public.fiscal_periods (id, company_id) ON DELETE CASCADE,
  CONSTRAINT budgets_archived_not_default CHECK (NOT (is_default AND archived_at IS NOT NULL))
);

COMMENT ON TABLE public.budgets IS
  'Named budget versions per räkenskapsår (accounted#134). Planning data, not räkenskapsinformation: deleted freely. At most one default per year.';

CREATE UNIQUE INDEX budgets_name_per_year ON public.budgets (fiscal_period_id, lower(name));
CREATE UNIQUE INDEX budgets_one_default_per_year ON public.budgets (fiscal_period_id) WHERE is_default;
CREATE INDEX idx_budgets_company_id ON public.budgets (company_id);

ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.budgets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.budgets TO authenticated;

CREATE POLICY "view own-company budgets"
  ON public.budgets FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company budgets"
  ON public.budgets FOR INSERT WITH CHECK (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );
CREATE POLICY "update own-company budgets"
  ON public.budgets FOR UPDATE USING (company_id IN (SELECT user_company_ids()))
  WITH CHECK (company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id));
CREATE POLICY "delete own-company budgets"
  ON public.budgets FOR DELETE USING (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE TRIGGER set_updated_at_budgets
  BEFORE UPDATE ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_budgets
  AFTER INSERT OR UPDATE OR DELETE ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- A budget stays in its company and its year: its months were validated
-- against that year. The default moves to the budget that takes it.
CREATE OR REPLACE FUNCTION public.enforce_budget_identity_and_default()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.company_id IS DISTINCT FROM OLD.company_id
          OR NEW.fiscal_period_id IS DISTINCT FROM OLD.fiscal_period_id) THEN
    RAISE EXCEPTION 'En budget kan inte flyttas till ett annat räkenskapsår eller företag. Skapa en ny budget för det året.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.is_default AND (TG_OP = 'INSERT' OR NOT OLD.is_default) THEN
    UPDATE public.budgets
       SET is_default = false
     WHERE fiscal_period_id = NEW.fiscal_period_id
       AND id <> NEW.id
       AND is_default;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_budget_identity_and_default() FROM PUBLIC, anon;

CREATE TRIGGER enforce_budget_identity_and_default
  BEFORE INSERT OR UPDATE ON public.budgets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_budget_identity_and_default();

COMMENT ON FUNCTION public.enforce_budget_identity_and_default() IS
  'A budget keeps its company and räkenskapsår; a budget that becomes the default takes the default from the year''s other budgets.';

-- 2 ---------------------------------------------------------------------------

CREATE TABLE public.budget_lines (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  budget_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_number text NOT NULL CHECK (account_number ~ '^[3-8][0-9]{3}$'),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount numeric(15, 2) NOT NULL CHECK (amount <> 0 AND amount <> 'NaN'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (budget_id, company_id)
    REFERENCES public.budgets (id, company_id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, account_number)
    REFERENCES public.chart_of_accounts (company_id, account_number) ON DELETE CASCADE,
  CONSTRAINT budget_lines_dimensions_is_object CHECK (jsonb_typeof(dimensions) = 'object'),
  -- The journal lines' contract, verbatim (jel_dimensions_well_formed).
  CONSTRAINT budget_lines_dimensions_well_formed
    CHECK (NOT (dimensions @? 'strict $.keyvalue() ? (!(@.key like_regex "^[1-9][0-9]*$") || @.value.type() != "string" || !(@.value like_regex "^[^\"{}]{1,40}$" flag "s"))')),
  CONSTRAINT budget_lines_cell_unique UNIQUE (budget_id, account_number, month, dimensions)
);

COMMENT ON TABLE public.budget_lines IS
  'One budget amount per budget, resultatkonto (3000-8999), month (first day) and dimension tag, in the SIE sign (debit positive, as #PBUDGET). A zero amount is no row.';
COMMENT ON COLUMN public.budget_lines.amount IS
  'SIE sign: debit positive, so a revenue budget on class 3 is negative.';

CREATE INDEX idx_budget_lines_company_account ON public.budget_lines (company_id, account_number);

ALTER TABLE public.budget_lines ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.budget_lines TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.budget_lines TO authenticated;

CREATE POLICY "view own-company budget_lines"
  ON public.budget_lines FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company budget_lines"
  ON public.budget_lines FOR INSERT WITH CHECK (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );
CREATE POLICY "update own-company budget_lines"
  ON public.budget_lines FOR UPDATE USING (company_id IN (SELECT user_company_ids()))
  WITH CHECK (company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id));
CREATE POLICY "delete own-company budget_lines"
  ON public.budget_lines FOR DELETE USING (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.budget_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE TRIGGER set_updated_at_budget_lines
  BEFORE UPDATE ON public.budget_lines
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_budget_lines
  AFTER INSERT OR UPDATE OR DELETE ON public.budget_lines
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- A line's month lies inside its budget's räkenskapsår, and an archived
-- budget takes no new or changed amounts. A year that starts mid-month (a
-- first year from the registration day) owns that whole month.
CREATE OR REPLACE FUNCTION public.enforce_budget_line_month()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_name     text;
  v_archived timestamptz;
  v_start    date;
  v_end      date;
BEGIN
  -- Wait for a re-date of the year in flight (guard_fiscal_period_redate_budgets
  -- locks the year's budgets FOR UPDATE), then read the dates it left.
  PERFORM 1 FROM public.budgets WHERE id = NEW.budget_id FOR KEY SHARE;

  SELECT b.name, b.archived_at, fp.period_start, fp.period_end
    INTO v_name, v_archived, v_start, v_end
    FROM public.budgets b
    JOIN public.fiscal_periods fp ON fp.id = b.fiscal_period_id
   WHERE b.id = NEW.budget_id;

  -- No budget the caller can see: the foreign key refuses the row.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_archived IS NOT NULL THEN
    RAISE EXCEPTION 'Budgeten "%" är arkiverad och kan inte ändras. Återställ den först.', v_name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.month < date_trunc('month', v_start::timestamp)::date OR NEW.month > v_end THEN
    RAISE EXCEPTION 'Månaden % ligger utanför räkenskapsåret % till % som budgeten "%" gäller.',
      to_char(NEW.month, 'YYYY-MM'), v_start, v_end, v_name
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_budget_line_month() FROM PUBLIC, anon;

CREATE TRIGGER enforce_budget_line_month
  BEFORE INSERT OR UPDATE OF budget_id, month, amount ON public.budget_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_budget_line_month();

COMMENT ON FUNCTION public.enforce_budget_line_month() IS
  'A budget line''s month lies inside its budget''s räkenskapsår (the start month in full), and an archived budget takes no new or changed amounts.';

-- 3 ---------------------------------------------------------------------------

-- The grid save's rules and counts, without writing: the dry run (the v1
-- preview and the MCP staging preview read it) and the first step of the
-- save itself. p_lines: [{account_number, month (YYYY-MM-01), dimensions?,
-- amount}], amount in the SIE sign; 0 removes the cell. STABLE, so it can
-- write nothing. SECURITY INVOKER: a session reads under its own RLS; the v1
-- and MCP doors call it with the service role after their own company check.
CREATE OR REPLACE FUNCTION public.upsert_budget_lines_preview(
  p_budget_id uuid,
  p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_budget     public.budgets%ROWTYPE;
  v_start      date;
  v_end        date;
  v_lines      jsonb;
  v_total      integer;
  v_distinct   integer;
  v_invalid    text[];
  v_missing    text[];
  v_outside    text[];
  v_inserted   integer := 0;
  v_updated    integer := 0;
  v_deleted    integer := 0;
  v_unchanged  integer := 0;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR', 'message', 'lines must be a JSON array');
  END IF;

  SELECT * INTO v_budget FROM public.budgets WHERE id = p_budget_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_NOT_FOUND');
  END IF;
  IF v_budget.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_ARCHIVED', 'budget_name', v_budget.name);
  END IF;

  SELECT fp.period_start, fp.period_end INTO v_start, v_end
    FROM public.fiscal_periods fp WHERE fp.id = v_budget.fiscal_period_id;

  -- Normalise once: the month as a date, the amount in whole öre, an absent
  -- tag as {}. Every statement below reads this array.
  BEGIN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'account_number', e->>'account_number',
             'month', (e->>'month')::date,
             'dimensions', coalesce(e->'dimensions', '{}'::jsonb),
             'amount', round((e->>'amount')::numeric, 2))), '[]'::jsonb)
      INTO v_lines
      FROM jsonb_array_elements(p_lines) AS e;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR', 'message', 'every line needs a month (YYYY-MM-01) and a numeric amount');
  END;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(v_lines) AS i(account_number text, month date, dimensions jsonb, amount numeric)
     WHERE i.account_number IS NULL OR i.month IS NULL OR i.amount IS NULL
        OR jsonb_typeof(i.dimensions) <> 'object'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR', 'message', 'every line needs account_number, month and amount; dimensions is an object');
  END IF;

  -- What the table's CHECKs refuse, answered here so the dry run and the
  -- save agree: a resultatkonto, a well-formed tag (the journal lines'
  -- contract), a real number.
  SELECT array_agg(DISTINCT i.account_number ORDER BY i.account_number)
    INTO v_invalid
    FROM jsonb_to_recordset(v_lines) AS i(account_number text, month date, dimensions jsonb, amount numeric)
   WHERE i.account_number !~ '^[3-8][0-9]{3}$';
  IF v_invalid IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'a budget covers resultatkonton 3000-8999 only', 'account_numbers', to_jsonb(v_invalid));
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(v_lines) AS i(account_number text, month date, dimensions jsonb, amount numeric)
     WHERE i.amount = 'NaN'
        OR i.dimensions @? 'strict $.keyvalue() ? (!(@.key like_regex "^[1-9][0-9]*$") || @.value.type() != "string" || !(@.value like_regex "^[^\"{}]{1,40}$" flag "s"))'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'message', 'every amount is a number and every dimension tag maps a SIE dimension number to a code of 1-40 characters');
  END IF;

  SELECT count(*), count(DISTINCT (i.account_number, i.month, i.dimensions))
    INTO v_total, v_distinct
    FROM jsonb_to_recordset(v_lines) AS i(account_number text, month date, dimensions jsonb, amount numeric);
  IF v_total <> v_distinct THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_LINES_DUPLICATE');
  END IF;

  SELECT array_agg(DISTINCT i.account_number ORDER BY i.account_number)
    INTO v_missing
    FROM jsonb_to_recordset(v_lines) AS i(account_number text, month date, dimensions jsonb, amount numeric)
   WHERE i.amount <> 0
     AND NOT EXISTS (
       SELECT 1 FROM public.chart_of_accounts c
        WHERE c.company_id = v_budget.company_id
          AND c.account_number = i.account_number
     );
  IF v_missing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUDGET_ACCOUNT_NOT_FOUND', 'account_numbers', to_jsonb(v_missing));
  END IF;

  SELECT array_agg(DISTINCT to_char(i.month, 'YYYY-MM-DD') ORDER BY to_char(i.month, 'YYYY-MM-DD'))
    INTO v_outside
    FROM jsonb_to_recordset(v_lines) AS i(account_number text, month date, dimensions jsonb, amount numeric)
   WHERE extract(day FROM i.month) <> 1
      OR i.month < date_trunc('month', v_start::timestamp)::date
      OR i.month > v_end;
  IF v_outside IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'BUDGET_MONTH_OUTSIDE_YEAR',
      'months', to_jsonb(v_outside),
      'period_start', to_char(v_start, 'YYYY-MM-DD'),
      'period_end', to_char(v_end, 'YYYY-MM-DD'));
  END IF;

  SELECT count(*) FILTER (WHERE i.amount <> 0 AND b.id IS NULL),
         count(*) FILTER (WHERE i.amount <> 0 AND b.id IS NOT NULL AND b.amount <> i.amount),
         count(*) FILTER (WHERE i.amount = 0 AND b.id IS NOT NULL),
         count(*) FILTER (WHERE (i.amount <> 0 AND b.amount = i.amount) OR (i.amount = 0 AND b.id IS NULL))
    INTO v_inserted, v_updated, v_deleted, v_unchanged
    FROM jsonb_to_recordset(v_lines) AS i(account_number text, month date, dimensions jsonb, amount numeric)
    LEFT JOIN public.budget_lines b
      ON b.budget_id = p_budget_id
     AND b.account_number = i.account_number
     AND b.month = i.month
     AND b.dimensions = i.dimensions;

  RETURN jsonb_build_object(
    'ok', true,
    'budget_id', v_budget.id,
    'company_id', v_budget.company_id,
    'lines', v_lines,
    'inserted', v_inserted,
    'updated', v_updated,
    'deleted', v_deleted,
    'unchanged', v_unchanged);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_budget_lines_preview(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_budget_lines_preview(uuid, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.upsert_budget_lines_preview(uuid, jsonb) IS
  'The budget grid save''s refusals (archived budget, account outside the kontoplan, month outside the räkenskapsår, a repeated cell) and its counts, without writing: the dry run, and the first step of upsert_budget_lines. accounted#134.';

-- The grid save: every cell of p_lines is written or none is. The budget row
-- is locked first, so two saves of one budget run one after the other and
-- the budget cannot be archived or deleted under a save; then the preview
-- decides under that lock, and the cells are written.
CREATE OR REPLACE FUNCTION public.upsert_budget_lines(
  p_budget_id uuid,
  p_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_preview jsonb;
  v_company uuid;
BEGIN
  SELECT company_id INTO v_company FROM public.budgets WHERE id = p_budget_id FOR UPDATE;

  -- A session that may read but not write the company (a viewer) is refused
  -- here: the DELETE policy would otherwise filter a removal to nothing, and
  -- the answer would count a change that never happened.
  IF v_company IS NOT NULL
     AND public.jwt_caller_is_end_user()
     AND NOT public.caller_can_write_company(v_company) THEN
    RAISE EXCEPTION 'row-level security: no write access to company % for upsert_budget_lines', v_company
      USING ERRCODE = '42501';
  END IF;

  v_preview := public.upsert_budget_lines_preview(p_budget_id, p_lines);
  IF NOT (v_preview->>'ok')::boolean THEN
    RETURN v_preview;
  END IF;

  DELETE FROM public.budget_lines b
   USING jsonb_to_recordset(v_preview->'lines') AS i(account_number text, month date, dimensions jsonb, amount numeric)
   WHERE b.budget_id = p_budget_id
     AND i.amount = 0
     AND b.account_number = i.account_number
     AND b.month = i.month
     AND b.dimensions = i.dimensions;

  INSERT INTO public.budget_lines (budget_id, company_id, account_number, month, dimensions, amount)
  SELECT p_budget_id, (v_preview->>'company_id')::uuid, i.account_number, i.month, i.dimensions, i.amount
    FROM jsonb_to_recordset(v_preview->'lines') AS i(account_number text, month date, dimensions jsonb, amount numeric)
   WHERE i.amount <> 0
  ON CONFLICT (budget_id, account_number, month, dimensions)
  DO UPDATE SET amount = EXCLUDED.amount
   WHERE budget_lines.amount IS DISTINCT FROM EXCLUDED.amount;

  RETURN v_preview - 'lines' - 'company_id';
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_budget_lines(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_budget_lines(uuid, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.upsert_budget_lines(uuid, jsonb) IS
  'Atomic budget grid save: writes every cell of p_lines (amount 0 removes the cell) or none, under a lock on the budget, after the refusals of upsert_budget_lines_preview. accounted#134.';

-- 4 ---------------------------------------------------------------------------

-- The booked result per resultatkonto and month of one räkenskapsår, in the
-- SIE sign (debit minus credit), with the resultatrapport's exclusions
-- ('exclude-all-year-end': year_end_chain_entry_ids). p_from/p_to bound the
-- entry dates; p_dimensions keeps the lines carrying every pair of the bag.
-- The summaries answer no filter and a filter on one value; several values
-- (a line must carry all of them) read the lines, as
-- get_trial_balance_aggregates does. SECURITY INVOKER: RLS applies to the
-- caller.
CREATE OR REPLACE FUNCTION public.get_account_month_actuals(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_dimensions jsonb DEFAULT NULL
)
RETURNS TABLE (account_number text, month date, amount numeric)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
  v_exclude_ids uuid[];
  v_dim_no text;
  v_code text;
  v_summary boolean := false;
BEGIN
  IF p_dimensions IS NOT NULL AND jsonb_typeof(p_dimensions) <> 'object' THEN
    RAISE EXCEPTION 'get_account_month_actuals: p_dimensions must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.fiscal_periods fp
     WHERE fp.id = p_fiscal_period_id AND fp.company_id = p_company_id
  ) THEN
    RETURN;
  END IF;

  v_exclude_ids := public.year_end_chain_entry_ids(p_company_id, p_fiscal_period_id);

  IF public.ledger_account_days_ready(p_company_id) THEN
    IF p_dimensions IS NULL OR p_dimensions = '{}'::jsonb THEN
      v_summary := true;
    ELSIF (SELECT count(*) FROM jsonb_object_keys(p_dimensions)) = 1 THEN
      SELECT d.key, d.value #>> '{}' INTO v_dim_no, v_code
        FROM jsonb_each(p_dimensions) d
       WHERE jsonb_typeof(d.value) = 'string';
      v_summary := v_dim_no IS NOT NULL;
    END IF;
  END IF;

  IF v_summary THEN
    RETURN QUERY
    SELECT s.account_number,
           date_trunc('month', s.entry_date::timestamp)::date,
           sum(s.debit - s.credit)
      FROM (
        SELECT a.account_number, a.entry_date, a.debit, a.credit, a.line_count
          FROM public.ledger_period_account_days(p_company_id, p_fiscal_period_id, v_exclude_ids) a
         WHERE v_dim_no IS NULL
        UNION ALL
        SELECT m.account_number, m.entry_date, m.debit, m.credit, m.line_count
          FROM public.ledger_period_dimension_days(p_company_id, p_fiscal_period_id, v_dim_no, v_code, v_exclude_ids) m
         WHERE v_dim_no IS NOT NULL
      ) s
     WHERE s.account_number >= '3000' AND s.account_number <= '8999'
       AND (p_from IS NULL OR s.entry_date >= p_from)
       AND (p_to IS NULL OR s.entry_date <= p_to)
     GROUP BY s.account_number, date_trunc('month', s.entry_date::timestamp)
    HAVING sum(s.line_count) > 0
     ORDER BY 1, 2;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT l.account_number,
         date_trunc('month', e.entry_date::timestamp)::date,
         sum(coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0))
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
   WHERE e.company_id = p_company_id
     AND e.fiscal_period_id = p_fiscal_period_id
     AND e.status IN ('posted', 'reversed')
     AND e.id <> ALL (v_exclude_ids)
     AND (p_from IS NULL OR e.entry_date >= p_from)
     AND (p_to IS NULL OR e.entry_date <= p_to)
     AND l.account_number >= '3000' AND l.account_number <= '8999'
     AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
   GROUP BY l.account_number, date_trunc('month', e.entry_date::timestamp)
   ORDER BY 1, 2;
END;
$$;

REVOKE ALL ON FUNCTION public.get_account_month_actuals(uuid, uuid, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_month_actuals(uuid, uuid, date, date, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_account_month_actuals(uuid, uuid, date, date, jsonb) IS
  'Booked result per resultatkonto (3000-8999) and month of one räkenskapsår, debit minus credit, without the year-end chain (the resultatrapport''s exclusions). Reads ledger_account_days once built, the journal lines otherwise. accounted#134.';

-- 5 ---------------------------------------------------------------------------

-- Which accounts a budget uses, for the kontoplan's delete paths (the single
-- delete and "Rensa oanvända konton"): an account with budget lines is not
-- unused. Kept apart from get_account_usage_counts, which is the kontoplan's
-- Verifikat column and must keep counting journal lines only.
CREATE OR REPLACE FUNCTION public.get_account_budget_line_counts(p_company_id uuid)
RETURNS TABLE (account_number text, budget_line_count bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT b.account_number, count(*)::bigint
    FROM public.budget_lines b
   WHERE b.company_id = p_company_id
   GROUP BY b.account_number;
$$;

REVOKE ALL ON FUNCTION public.get_account_budget_line_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_budget_line_counts(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_account_budget_line_counts(uuid) IS
  'Budget lines per account of the company: an account a budget uses is not deleted as unused. accounted#134.';

NOTIFY pgrst, 'reload schema';
