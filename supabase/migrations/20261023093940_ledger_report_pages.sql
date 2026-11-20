-- Huvudbok and grundbok in pages: line counts per account, one account's
-- lines a page at a time, all lines of an account range in one call, and the
-- grundbok's verifikat a page at a time with its period totals.
--
-- Why: both reports read every verifikat and line of the period through
-- PostgREST, 1 000 rows a page and the lines 100 verifikat a chunk (~550
-- round trips for 50 000 verifikat), and returned all of it: 37 MB of JSON
-- for the huvudbok and 25 MB for the grundbok, 3-4 s before the browser
-- started to render it. No form of that answers in 200 ms. The functions
-- below let the views ask for an overview (per account opening, movements,
-- closing and line count, all from ledger_account_days) and fetch lines when
-- an account is opened, a page at a time (through ledger_account_entries);
-- the exports still get every line, in one call instead of ~550.
--
-- Line order everywhere: entry date, voucher number, line id, the order the
-- reports already sorted into (by date, then voucher number, stable over line
-- id). A cursor is the last row's (entry_date, voucher_number, line id).
--
-- SECURITY INVOKER: RLS applies to the caller; the company_id predicates are
-- defence in depth for service-role callers.

-- Lines per account inside [p_from_date, p_to_date] of the period's posted
-- and reversed entries, without p_exclude_entry_id (the IB entry), under an
-- optional dimension filter. From the summaries when the company is built and
-- the filter is at most one value, from the lines otherwise.
CREATE OR REPLACE FUNCTION public.get_ledger_line_counts(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_from_date date,
  p_to_date date,
  p_exclude_entry_id uuid,
  p_dimensions jsonb
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
  v_dim_no text;
  v_code text;
  v_summary boolean := false;
BEGIN
  IF public.ledger_account_days_ready(p_company_id) THEN
    IF p_dimensions IS NULL OR p_dimensions = '{}'::jsonb THEN
      v_summary := true;
    ELSIF jsonb_typeof(p_dimensions) = 'object' AND (SELECT count(*) FROM jsonb_object_keys(p_dimensions)) = 1 THEN
      SELECT d.key, d.value #>> '{}' INTO v_dim_no, v_code
      FROM jsonb_each(p_dimensions) d
      WHERE jsonb_typeof(d.value) = 'string';
      v_summary := v_dim_no IS NOT NULL;
    END IF;
  END IF;

  IF v_summary THEN
    RETURN (
      SELECT coalesce(jsonb_agg(jsonb_build_object('account_number', t.account_number, 'line_count', t.n)
                                ORDER BY t.account_number), '[]'::jsonb)
      FROM (
        SELECT x.account_number, sum(x.line_count) AS n
        FROM (
          SELECT a.account_number, a.entry_date, a.line_count
          FROM public.ledger_period_account_days(p_company_id, p_fiscal_period_id, v_exclude) a
          WHERE v_dim_no IS NULL
          UNION ALL
          SELECT m.account_number, m.entry_date, m.line_count
          FROM public.ledger_period_dimension_days(p_company_id, p_fiscal_period_id, v_dim_no, v_code, v_exclude) m
          WHERE v_dim_no IS NOT NULL
        ) x
        WHERE (p_from_date IS NULL OR x.entry_date >= p_from_date)
          AND (p_to_date IS NULL OR x.entry_date <= p_to_date)
        GROUP BY x.account_number
        HAVING sum(x.line_count) > 0
      ) t
    );
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object('account_number', t.account_number, 'line_count', t.n)
                              ORDER BY t.account_number), '[]'::jsonb)
    FROM (
      SELECT l.account_number, count(*) AS n
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.status IN ('posted', 'reversed')
        AND (p_exclude_entry_id IS NULL OR e.id <> p_exclude_entry_id)
        AND (p_from_date IS NULL OR e.entry_date >= p_from_date)
        AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
        AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
      GROUP BY l.account_number
    ) t
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_ledger_line_counts(uuid, uuid, date, date, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_line_counts(uuid, uuid, date, date, uuid, jsonb) TO authenticated, service_role;

-- Every window line of the accounts in [p_account_from, p_account_to]
-- (either bound open when NULL), in report order: account, then line order.
-- Each row carries its entry's date, series, number, id, description and
-- source type. For the exports and for an overview small enough to show its
-- lines at once. Once the company is built, a bounded range is read through
-- ledger_account_entries, so it costs its own lines, not the year's verifikat.
CREATE OR REPLACE FUNCTION public.get_general_ledger_lines(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_account_from text,
  p_account_to text,
  p_from_date date,
  p_to_date date,
  p_exclude_entry_id uuid,
  p_dimensions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
-- Every call is planned for its own values: the right plan for one
-- account, one day or one window is not the right plan for another.
SET plan_cache_mode TO force_custom_plan
AS $$
BEGIN
  IF (p_account_from IS NOT NULL OR p_account_to IS NOT NULL)
     AND public.ledger_account_days_ready(p_company_id) THEN
    RETURN (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
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
               'source_type', e.source_type)
             ORDER BY l.account_number, e.entry_date, e.voucher_number, l.id), '[]'::jsonb)
      FROM public.ledger_account_entries a
      JOIN public.journal_entries e ON e.id = a.journal_entry_id
      JOIN public.journal_entry_lines l
        ON l.journal_entry_id = a.journal_entry_id AND l.account_number = a.account_number
      WHERE a.company_id = p_company_id
        AND a.fiscal_period_id = p_fiscal_period_id
        AND (p_account_from IS NULL OR a.account_number >= p_account_from)
        AND (p_account_to IS NULL OR a.account_number <= p_account_to)
        AND (p_from_date IS NULL OR a.entry_date >= p_from_date)
        AND (p_to_date IS NULL OR a.entry_date <= p_to_date)
        AND (p_exclude_entry_id IS NULL OR a.journal_entry_id <> p_exclude_entry_id)
        AND e.company_id = p_company_id
        AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
    );
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(jsonb_build_object(
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
             'source_type', e.source_type)
           ORDER BY l.account_number, e.entry_date, e.voucher_number, l.id), '[]'::jsonb)
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed')
      AND (p_exclude_entry_id IS NULL OR e.id <> p_exclude_entry_id)
      AND (p_from_date IS NULL OR e.entry_date >= p_from_date)
      AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
      AND (p_account_from IS NULL OR l.account_number >= p_account_from)
      AND (p_account_to IS NULL OR l.account_number <= p_account_to)
      AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_general_ledger_lines(uuid, uuid, text, text, date, date, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_general_ledger_lines(uuid, uuid, text, text, date, date, uuid, jsonb) TO authenticated, service_role;

-- The verifikat with lines on one account in a period, each with how many,
-- or with p_dim_no set, those whose lines on it are tagged with that
-- dimension value, each with how many of those. No SET clause, so it is
-- inlined into the caller's query, where the branch not asked for is planned
-- away and the other reads its locator in index order.
CREATE OR REPLACE FUNCTION public.ledger_located_entries(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_account_number text,
  p_dim_no text,
  p_code text
)
RETURNS TABLE (entry_date date, voucher_number integer, journal_entry_id uuid, line_count integer)
LANGUAGE sql
STABLE
AS $$
  SELECT a.entry_date, a.voucher_number, a.journal_entry_id, a.line_count
  FROM public.ledger_account_entries a
  WHERE p_dim_no IS NULL
    AND a.company_id = p_company_id
    AND a.fiscal_period_id = p_fiscal_period_id
    AND a.account_number = p_account_number
  UNION ALL
  SELECT d.entry_date, d.voucher_number, d.journal_entry_id, d.line_count
  FROM public.ledger_dimension_entries d
  WHERE p_dim_no IS NOT NULL
    AND d.company_id = p_company_id
    AND d.fiscal_period_id = p_fiscal_period_id
    AND d.dim_no = p_dim_no
    AND d.code = p_code
    AND d.account_number = p_account_number
$$;

REVOKE ALL ON FUNCTION public.ledger_located_entries(uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_located_entries(uuid, uuid, text, text, text) TO authenticated, service_role;

-- One account's window lines from a cursor on, at most p_limit, in line
-- order, plus the account's movement before the page so the page carries the
-- running balance on: every period line (without p_exclude_entry_id, under
-- the filter) before the page's first line, so up to and including the
-- cursor, or before p_from_date on the first page. The cursor is the last
-- line already shown: (entry_date, voucher_number, line id); NULL starts at
-- the window's first line.
--
-- Once the company is built, the page is read through the locators: the
-- verifikat with lines on the account (under a dimension filter, those with
-- lines tagged with its first value), in (day, voucher number) order, each
-- with its line count. Lines of verifikat sharing a day and a number (two
-- series) interleave by line id, so the page takes whole (day, number)
-- groups: the cursor's group (for its lines after the cursor) and the groups
-- after it until their lines fill the page. A filter on several values can
-- leave such a stretch short, so it is read again from where it ended until
-- the page is full or the account ends. The movement before the page's
-- first day comes from the summaries when they can answer the filter.
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
    SELECT x.entry_date, x.voucher_number INTO v_end_date, v_end_voucher
    FROM (
      SELECT a.entry_date, a.voucher_number,
             sum(a.line_count) OVER (ORDER BY a.entry_date, a.voucher_number, a.journal_entry_id) AS lines_so_far
      FROM public.ledger_located_entries(p_company_id, p_fiscal_period_id, p_account_number, v_walk_dim, v_walk_code) a
      WHERE (p_from_date IS NULL OR a.entry_date >= p_from_date)
        AND (p_to_date IS NULL OR a.entry_date <= p_to_date)
        AND (p_exclude_entry_id IS NULL OR a.journal_entry_id <> p_exclude_entry_id)
        AND (v_pos_date IS NULL OR (a.entry_date, a.voucher_number) > (v_pos_date, v_pos_voucher))
      ORDER BY a.entry_date, a.voucher_number, a.journal_entry_id
      LIMIT v_need
    ) x
    WHERE x.lines_so_far >= v_need
    ORDER BY x.lines_so_far
    LIMIT 1;

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

-- The grundbok's verifikat in registration order (series, then number; a
-- missing series counts as A, like everywhere else), from the cursor on
-- (exclusive: the last verifikat shown, as series, number and id), at most
-- p_limit, each with its lines ordered by account. The period's posted and
-- reversed entries, the IB entry included: it is a voucher in registration
-- order like any other.
CREATE OR REPLACE FUNCTION public.get_journal_register_page(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_after_series text,
  p_after_number integer,
  p_after_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  WITH page AS (
    SELECT e.id, coalesce(nullif(e.voucher_series, ''), 'A') AS series, e.voucher_series, e.voucher_number,
           e.entry_date, e.description, e.source_type, e.status
    FROM public.journal_entries e
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed')
      AND (p_after_series IS NULL
           OR (coalesce(nullif(e.voucher_series, ''), 'A'), e.voucher_number, e.id)
              > (p_after_series, p_after_number, p_after_id))
    ORDER BY coalesce(nullif(e.voucher_series, ''), 'A'), e.voucher_number, e.id
    LIMIT least(greatest(coalesce(p_limit, 200), 1), 2000)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'voucher_series', p.series,
           'voucher_number', p.voucher_number,
           'entry_date', p.entry_date,
           'description', p.description,
           'source_type', p.source_type,
           'status', p.status,
           'lines', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'account_number', l.account_number,
                      'debit_amount', l.debit_amount,
                      'credit_amount', l.credit_amount)
                    ORDER BY l.account_number, l.id)
             FROM public.journal_entry_lines l
             WHERE l.journal_entry_id = p.id
           ), '[]'::jsonb))
         ORDER BY p.series, p.voucher_number, p.id), '[]'::jsonb)
  FROM page p
$$;

REVOKE ALL ON FUNCTION public.get_journal_register_page(uuid, uuid, text, integer, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_journal_register_page(uuid, uuid, text, integer, uuid, integer) TO authenticated, service_role;

-- The grundbok's period totals: how many verifikat, and their debit and
-- credit, the IB entry included.
CREATE OR REPLACE FUNCTION public.get_journal_register_totals(
  p_company_id uuid,
  p_fiscal_period_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
DECLARE
  v_entries bigint;
  v_debit numeric;
  v_credit numeric;
BEGIN
  SELECT count(*) INTO v_entries
  FROM public.journal_entries e
  WHERE e.company_id = p_company_id
    AND e.fiscal_period_id = p_fiscal_period_id
    AND e.status IN ('posted', 'reversed');

  IF public.ledger_account_days_ready(p_company_id) THEN
    SELECT coalesce(sum(d.debit), 0), coalesce(sum(d.credit), 0) INTO v_debit, v_credit
    FROM public.ledger_account_days d
    WHERE d.company_id = p_company_id
      AND d.fiscal_period_id = p_fiscal_period_id;
  ELSE
    SELECT coalesce(sum(coalesce(l.debit_amount, 0)), 0), coalesce(sum(coalesce(l.credit_amount, 0)), 0)
      INTO v_debit, v_credit
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed');
  END IF;

  RETURN jsonb_build_object('total_entries', v_entries, 'total_debit', v_debit, 'total_credit', v_credit);
END;
$$;

REVOKE ALL ON FUNCTION public.get_journal_register_totals(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_journal_register_totals(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
