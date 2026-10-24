-- get_general_ledger_account_page: where a huvudbok page ends is read from
-- the locator table itself.
--
-- Why: that boundary query went through ledger_located_entries, whose UNION
-- ALL of the two locator tables hides the index order from the planner. It
-- read and sorted every locator of the account in the period to keep the
-- first v_need, whatever the page size: for the largest company's 2440 on
-- prod that is 26 898 rows and about 27 000 buffers per page, 2.6 s when they
-- are not cached and 55 ms when they are. Read from the table, the index
-- order answers ORDER BY ... LIMIT and the same boundary reads 201 rows.
--
-- Only that query changes. The page and the movement before it keep the
-- helper: their ranges are bounded, so their plans are fine (200 locators,
-- 4 ms, for the same page). Restated from 20261023093940.
--
-- The huvudbok pages read to the end on both paths, with and without a
-- dimension filter, walk both branches of the boundary query:
-- pg-test: covered-by tests/pg/ledger-account-days.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_general_ledger_account_page(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_account_number text,
  p_from_date date,
  p_to_date date,
  p_exclude_entry_id uuid,
  p_dimensions jsonb,
  p_after_date date,
  p_after_voucher integer,
  p_after_line_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
-- Every call is planned for its own values: the right plan for one
-- account, one day or one window is not the right plan for another.
SET plan_cache_mode TO force_custom_plan
AS $$
DECLARE
  v_exclude uuid[] := CASE WHEN p_exclude_entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_exclude_entry_id] END;
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  -- The summaries answer a filter on one dimension value.
  v_dim_no text;
  v_code text;
  v_summary_dims boolean := false;
  -- The locator walked: the account's, or the first filter value's.
  v_walk_dim text;
  v_walk_code text;
  v_before_day date := coalesce(p_after_date, p_from_date);
  v_lines_from date;
  v_lines jsonb := '[]'::jsonb;
  v_chunk jsonb;
  v_need integer;
  -- Read position: the lines after (date, voucher, line id).
  v_pos_date date := p_after_date;
  v_pos_voucher integer := p_after_voucher;
  v_pos_line uuid := p_after_line_id;
  v_end_date date;
  v_end_voucher integer;
  v_before_debit numeric := 0;
  v_before_credit numeric := 0;
BEGIN
  IF NOT public.ledger_account_days_ready(p_company_id) THEN
    IF v_before_day IS NOT NULL THEN
      SELECT coalesce(sum(coalesce(l.debit_amount, 0)), 0), coalesce(sum(coalesce(l.credit_amount, 0)), 0)
        INTO v_before_debit, v_before_credit
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.status IN ('posted', 'reversed')
        AND (p_exclude_entry_id IS NULL OR e.id <> p_exclude_entry_id)
        AND e.entry_date <= v_before_day
        AND l.account_number = p_account_number
        AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
        AND CASE WHEN p_after_date IS NOT NULL
                 THEN (e.entry_date, e.voucher_number, l.id) <= (p_after_date, p_after_voucher, p_after_line_id)
                 ELSE e.entry_date < p_from_date
            END;
    END IF;

    SELECT coalesce(jsonb_agg(r.line ORDER BY r.entry_date, r.voucher_number, r.line_id), '[]'::jsonb) INTO v_lines
    FROM (
      SELECT e.entry_date, e.voucher_number, l.id AS line_id, jsonb_build_object(
               'line_id', l.id,
               'account_number', l.account_number,
               'debit_amount', l.debit_amount,
               'credit_amount', l.credit_amount,
               'dimensions', l.dimensions,
               'journal_entry_id', e.id,
               'entry_date', e.entry_date,
               'voucher_series', e.voucher_series,
               'voucher_number', e.voucher_number,
               'description', e.description,
               'source_type', e.source_type) AS line
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.status IN ('posted', 'reversed')
        AND (p_exclude_entry_id IS NULL OR e.id <> p_exclude_entry_id)
        AND (p_from_date IS NULL OR e.entry_date >= p_from_date)
        AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
        AND l.account_number = p_account_number
        AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
        AND (p_after_date IS NULL OR (e.entry_date, e.voucher_number, l.id) > (p_after_date, p_after_voucher, p_after_line_id))
      ORDER BY e.entry_date, e.voucher_number, l.id
      LIMIT v_limit
    ) r;

    RETURN jsonb_build_object('before_debit', v_before_debit, 'before_credit', v_before_credit, 'lines', v_lines);
  END IF;

  IF jsonb_typeof(p_dimensions) = 'object' THEN
    SELECT d.key, d.value #>> '{}' INTO v_walk_dim, v_walk_code
    FROM jsonb_each(p_dimensions) d
    WHERE jsonb_typeof(d.value) = 'string'
    ORDER BY d.key
    LIMIT 1;
  END IF;

  -- The movement before the page: whole days before the page's first day
  -- from the summaries when they can answer the filter (none, or one
  -- dimension value), the rest from the lines.
  IF v_before_day IS NOT NULL THEN
    IF p_dimensions IS NULL OR p_dimensions = '{}'::jsonb THEN
      v_summary_dims := true;
    ELSIF jsonb_typeof(p_dimensions) = 'object' AND (SELECT count(*) FROM jsonb_object_keys(p_dimensions)) = 1 THEN
      v_dim_no := v_walk_dim;
      v_code := v_walk_code;
      v_summary_dims := v_dim_no IS NOT NULL;
    END IF;

    IF v_summary_dims THEN
      SELECT coalesce(sum(x.debit), 0), coalesce(sum(x.credit), 0) INTO v_before_debit, v_before_credit
      FROM (
        SELECT a.entry_date, a.debit, a.credit
        FROM public.ledger_period_account_days(p_company_id, p_fiscal_period_id, v_exclude) a
        WHERE v_dim_no IS NULL AND a.account_number = p_account_number
        UNION ALL
        SELECT m.entry_date, m.debit, m.credit
        FROM public.ledger_period_dimension_days(p_company_id, p_fiscal_period_id, v_dim_no, v_code, v_exclude) m
        WHERE v_dim_no IS NOT NULL AND m.account_number = p_account_number
      ) x
      WHERE x.entry_date < v_before_day;
      v_lines_from := v_before_day;
    END IF;

    IF p_after_date IS NOT NULL OR NOT v_summary_dims THEN
      SELECT v_before_debit + coalesce(sum(coalesce(l.debit_amount, 0)), 0),
             v_before_credit + coalesce(sum(coalesce(l.credit_amount, 0)), 0)
        INTO v_before_debit, v_before_credit
      FROM public.ledger_located_entries(p_company_id, p_fiscal_period_id, p_account_number, v_walk_dim, v_walk_code) a
      JOIN public.journal_entry_lines l
        ON l.journal_entry_id = a.journal_entry_id AND l.account_number = p_account_number
      WHERE (v_lines_from IS NULL OR a.entry_date >= v_lines_from)
        AND a.entry_date <= v_before_day
        AND (p_exclude_entry_id IS NULL OR a.journal_entry_id <> p_exclude_entry_id)
        AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
        AND CASE WHEN p_after_date IS NOT NULL
                 THEN (a.entry_date, a.voucher_number, l.id) <= (p_after_date, p_after_voucher, p_after_line_id)
                 ELSE a.entry_date < p_from_date
            END;
    END IF;
  END IF;

  -- The page.
  LOOP
    v_need := v_limit - jsonb_array_length(v_lines);

    -- The (day, number) group where the lines after the read position's
    -- group reach what the page still needs; none: the account ends first.
    -- Read from the locator table itself, not through ledger_located_entries:
    -- its UNION ALL hides the index order, so the planner sorted every
    -- locator of the account to keep v_need of them (20261024120000).
    IF v_walk_dim IS NULL THEN
      SELECT x.entry_date, x.voucher_number INTO v_end_date, v_end_voucher
      FROM (
        SELECT a.entry_date, a.voucher_number,
               sum(a.line_count) OVER (ORDER BY a.entry_date, a.voucher_number, a.journal_entry_id) AS lines_so_far
        FROM public.ledger_account_entries a
        WHERE a.company_id = p_company_id
          AND a.fiscal_period_id = p_fiscal_period_id
          AND a.account_number = p_account_number
          AND (p_from_date IS NULL OR a.entry_date >= p_from_date)
          AND (p_to_date IS NULL OR a.entry_date <= p_to_date)
          AND (p_exclude_entry_id IS NULL OR a.journal_entry_id <> p_exclude_entry_id)
          AND (v_pos_date IS NULL OR (a.entry_date, a.voucher_number) > (v_pos_date, v_pos_voucher))
        ORDER BY a.entry_date, a.voucher_number, a.journal_entry_id
        LIMIT v_need
      ) x
      WHERE x.lines_so_far >= v_need
      ORDER BY x.lines_so_far
      LIMIT 1;
    ELSE
      SELECT x.entry_date, x.voucher_number INTO v_end_date, v_end_voucher
      FROM (
        SELECT d.entry_date, d.voucher_number,
               sum(d.line_count) OVER (ORDER BY d.entry_date, d.voucher_number, d.journal_entry_id) AS lines_so_far
        FROM public.ledger_dimension_entries d
        WHERE d.company_id = p_company_id
          AND d.fiscal_period_id = p_fiscal_period_id
          AND d.dim_no = v_walk_dim
          AND d.code = v_walk_code
          AND d.account_number = p_account_number
          AND (p_from_date IS NULL OR d.entry_date >= p_from_date)
          AND (p_to_date IS NULL OR d.entry_date <= p_to_date)
          AND (p_exclude_entry_id IS NULL OR d.journal_entry_id <> p_exclude_entry_id)
          AND (v_pos_date IS NULL OR (d.entry_date, d.voucher_number) > (v_pos_date, v_pos_voucher))
        ORDER BY d.entry_date, d.voucher_number, d.journal_entry_id
        LIMIT v_need
      ) x
      WHERE x.lines_so_far >= v_need
      ORDER BY x.lines_so_far
      LIMIT 1;
    END IF;

    SELECT coalesce(jsonb_agg(r.line ORDER BY r.entry_date, r.voucher_number, r.line_id), '[]'::jsonb) INTO v_chunk
    FROM (
      SELECT a.entry_date, a.voucher_number, l.id AS line_id, jsonb_build_object(
               'line_id', l.id,
               'account_number', l.account_number,
               'debit_amount', l.debit_amount,
               'credit_amount', l.credit_amount,
               'dimensions', l.dimensions,
               'journal_entry_id', e.id,
               'entry_date', e.entry_date,
               'voucher_series', e.voucher_series,
               'voucher_number', e.voucher_number,
               'description', e.description,
               'source_type', e.source_type) AS line
      FROM public.ledger_located_entries(p_company_id, p_fiscal_period_id, p_account_number, v_walk_dim, v_walk_code) a
      JOIN public.journal_entries e ON e.id = a.journal_entry_id
      JOIN public.journal_entry_lines l
        ON l.journal_entry_id = a.journal_entry_id AND l.account_number = p_account_number
      WHERE (p_from_date IS NULL OR a.entry_date >= p_from_date)
        AND (p_to_date IS NULL OR a.entry_date <= p_to_date)
        AND (p_exclude_entry_id IS NULL OR a.journal_entry_id <> p_exclude_entry_id)
        AND (v_pos_date IS NULL OR (a.entry_date, a.voucher_number) >= (v_pos_date, v_pos_voucher))
        AND (v_end_date IS NULL OR (a.entry_date, a.voucher_number) <= (v_end_date, v_end_voucher))
        AND (v_pos_date IS NULL OR (a.entry_date, a.voucher_number, l.id) > (v_pos_date, v_pos_voucher, v_pos_line))
        AND e.company_id = p_company_id
        AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
      ORDER BY a.entry_date, a.voucher_number, l.id
      LIMIT v_need
    ) r;

    v_lines := v_lines || v_chunk;
    EXIT WHEN v_end_date IS NULL OR jsonb_array_length(v_lines) >= v_limit;
    -- Past the end group: every line of it was read.
    v_pos_date := v_end_date;
    v_pos_voucher := v_end_voucher;
    v_pos_line := 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid;
  END LOOP;

  RETURN jsonb_build_object('before_debit', v_before_debit, 'before_credit', v_before_credit, 'lines', v_lines);
END;
$$;

REVOKE ALL ON FUNCTION public.get_general_ledger_account_page(uuid, uuid, text, date, date, uuid, jsonb, date, integer, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_general_ledger_account_page(uuid, uuid, text, date, date, uuid, jsonb, date, integer, uuid, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
