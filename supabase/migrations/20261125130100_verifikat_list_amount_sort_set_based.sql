-- Merged first as 20261125130000, the version
-- cash_account_ledger_evidence_skip_linked_verifikat also holds, so production
-- recorded only that one and these functions were never created. Renamed to
-- 20261125130100; the body is unchanged except CREATE OR REPLACE, so it
-- applies both where the functions are missing and where they exist.
--
-- The verifikat list sorted by Belopp: the amounts of the whole scope in one
-- set-based pass, not one function call per verifikat.
--
-- The list's amount sort ordered by the display_amount computed column
-- (20261018135300). That is a SECURITY DEFINER SQL function, so Postgres
-- never inlines it: it called it once for every verifikat in scope before it
-- could take the first page, and every call ran its guard,
-- user_company_ids(), again. A fiscal year of a large ledger took seconds,
-- and every year of one passed the 8 s statement timeout, for the first page
-- and for every "Nästa" after it.
--
-- 1. verifikat_display_amounts(company, ids): display_amount's rule for a set
--    of verifikat in one statement, with the company's cash ledgers read
--    once. It mirrors voucherDisplayAmount
--    (src/lib/bookkeeping/voucher-display-amount.ts) as display_amount does;
--    tests/pg/verifikat-list-amount-sort.pg.test.ts runs every voucher shape
--    of that helper through both and requires the same amount. Internal: it
--    checks no membership itself, so only list_verifikat_by_amount (which
--    does) and service_role may call it.
-- 2. list_verifikat_by_amount: the list's page when a sort key is Belopp. It
--    checks the caller's membership once, applies the list's filters as the
--    direct query does (lib/bookkeeping/verifikat-search.ts reads the search
--    needle in TypeScript and passes each reading as its own parameter),
--    computes the amounts of the matching set with (1), orders by the list's
--    complete sort (missingUnderlagOrder, the same allowlisted tokens as
--    list_verifikat_missing_underlag) and returns the full total and one page
--    of ids. The route reads the page's rows itself, under the caller's RLS.
--
-- display_amount itself is unchanged: list_verifikat_missing_underlag still
-- orders its (smaller) set by it per row.
--
-- pg-test: tests/pg/verifikat-list-amount-sort.pg.test.ts

-- 1. The Belopp rule for a set of verifikat ------------------------------

CREATE OR REPLACE FUNCTION public.verifikat_display_amounts(p_company_id uuid, p_entry_ids uuid[])
RETURNS TABLE (journal_entry_id uuid, display_amount numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  -- The rule (voucherDisplayAmount):
  --   * the omslutning (sum of debit lines, rounded to öre) is the fallback;
  --   * an opening-balance voucher always shows the omslutning;
  --   * money accounts are BAS 19xx plus every ledger the company keeps a
  --     cash account on (cash_accounts.ledger_account, e.g. 1686);
  --   * exactly one line on a money account, with a non-zero net, shows that
  --     line's absolute net, unless another class 1 (asset) line sits on the
  --     money line's side (a split settlement), which falls back.
  -- With exactly one money line, "every other line" is "every non-money
  -- line", so one aggregate per verifikat answers all of it.
  --
  -- The company's cash ledgers are read once (at most one cash account per
  -- company and ledger, cash_accounts_company_id_ledger_account_key), not
  -- probed per line. The aggregate is LATERAL on purpose: whatever the
  -- planner estimates, each verifikat's lines are read through their
  -- journal_entry_id index, and never by scanning every company's lines.
  SELECT
    e.id,
    CASE
      WHEN e.source_type = 'opening_balance' THEN t.debit_total
      WHEN t.money_lines <> 1 THEN t.debit_total
      WHEN round(abs(t.money_net), 2) = 0 THEN t.debit_total
      WHEN t.money_net > 0 AND t.other_asset_debit THEN t.debit_total
      WHEN t.money_net < 0 AND t.other_asset_credit THEN t.debit_total
      ELSE round(abs(t.money_net), 2)
    END
  FROM (
    SELECT ARRAY(
      SELECT ca.ledger_account
      FROM public.cash_accounts ca
      WHERE ca.company_id = p_company_id
        AND ca.ledger_account IS NOT NULL
    ) AS ledgers
  ) cash
  CROSS JOIN public.journal_entries e
  CROSS JOIN LATERAL (
    SELECT
      round(coalesce(sum(l.debit), 0), 2) AS debit_total,
      count(*) FILTER (WHERE l.is_money) AS money_lines,
      sum(l.debit - l.credit) FILTER (WHERE l.is_money) AS money_net,
      coalesce(bool_or(NOT l.is_money AND l.debit > 0 AND left(l.account_number, 1) = '1'), false)
        AS other_asset_debit,
      coalesce(bool_or(NOT l.is_money AND l.credit > 0 AND left(l.account_number, 1) = '1'), false)
        AS other_asset_credit
    FROM (
      SELECT
        jel.account_number,
        coalesce(jel.debit_amount, 0) AS debit,
        coalesce(jel.credit_amount, 0) AS credit,
        (jel.account_number ~ '^19[0-9]{2}$' OR jel.account_number = ANY (cash.ledgers)) AS is_money
      FROM public.journal_entry_lines jel
      WHERE jel.journal_entry_id = e.id
    ) l
  ) t
  WHERE e.company_id = p_company_id
    AND e.id = ANY (p_entry_ids)
$$;

COMMENT ON FUNCTION public.verifikat_display_amounts(uuid, uuid[]) IS
  'The amount the verifikat list shows (the single money line, else the omslutning) for each given verifikat of the company, in one statement: display_amount for a set. Mirrors src/lib/bookkeeping/voucher-display-amount.ts. Internal: checks no membership; list_verifikat_by_amount calls it after its own check.';

REVOKE ALL ON FUNCTION public.verifikat_display_amounts(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verifikat_display_amounts(uuid, uuid[]) TO service_role;

-- 2. The list's page when it is sorted by Belopp ----------------------------

CREATE OR REPLACE FUNCTION public.list_verifikat_by_amount(
  p_company_id uuid,
  p_period_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_exclude_draft boolean DEFAULT false,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_series text DEFAULT NULL,
  p_search_pattern text DEFAULT NULL,
  p_search_voucher_series text DEFAULT NULL,
  p_search_voucher_number integer DEFAULT NULL,
  p_search_account text DEFAULT NULL,
  p_search_amount numeric DEFAULT NULL,
  p_search_date_from date DEFAULT NULL,
  p_search_date_to date DEFAULT NULL,
  p_hide_reversed boolean DEFAULT false,
  p_collapse_corrections boolean DEFAULT false,
  p_order text[] DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  -- 1,000 = the most rows one list request carries (MAX_ROWS_PER_REQUEST).
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 1000);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_token text;
  v_fragment text;
  v_terms text[] := ARRAY[]::text[];
  v_order_sql text;
  v_result jsonb;
BEGIN
  -- Membership once, for the whole statement: every read below is filtered
  -- to this company by its own column.
  IF v_jwt_role IN ('anon', 'authenticated') AND NOT public.caller_is_company_member(p_company_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LIST_VERIFIKAT_BY_AMOUNT_FORBIDDEN');
  END IF;

  IF coalesce(array_length(p_order, 1), 0) > 8 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LIST_VERIFIKAT_BY_AMOUNT_INVALID_ORDER');
  END IF;

  -- The order tokens map to constant SQL fragments: no caller text ever
  -- reaches the statement.
  FOREACH v_token IN ARRAY coalesce(p_order, ARRAY[]::text[]) LOOP
    v_fragment := CASE v_token
      WHEN 'entry_date.asc' THEN 'entry_date ASC'
      WHEN 'entry_date.desc' THEN 'entry_date DESC'
      WHEN 'voucher_series.asc' THEN 'voucher_series ASC'
      WHEN 'voucher_series.desc' THEN 'voucher_series DESC'
      WHEN 'voucher_number.asc' THEN 'voucher_number ASC'
      WHEN 'voucher_number.desc' THEN 'voucher_number DESC'
      WHEN 'description.asc' THEN 'description ASC'
      WHEN 'description.desc' THEN 'description DESC'
      WHEN 'display_amount.asc' THEN 'display_amount ASC'
      WHEN 'display_amount.desc' THEN 'display_amount DESC'
      WHEN 'id.asc' THEN 'id ASC'
      WHEN 'id.desc' THEN 'id DESC'
    END;
    IF v_fragment IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LIST_VERIFIKAT_BY_AMOUNT_INVALID_ORDER');
    END IF;
    v_terms := v_terms || v_fragment;
  END LOOP;
  -- A total order whatever the caller sent: ids are unique.
  v_order_sql := array_to_string(v_terms || 'id ASC'::text, ', ');

  -- The filters are the direct list query's (the journal-entries route), one
  -- for one, with its NULL semantics: a status that is NULL fails `<>` there
  -- as it does here.
  EXECUTE format($sql$
    WITH folded AS MATERIALIZED (
      -- The originals a posted correction replaced, when the caller folds
      -- them: the route's corrections read, over every year.
      SELECT x.correction_of_id AS id
      FROM public.journal_entries x
      WHERE $16
        AND x.company_id = $1
        AND x.source_type = 'correction'
        AND x.status = 'posted'
        AND x.correction_of_id IS NOT NULL
    ),
    matching AS MATERIALIZED (
      SELECT je.id, je.entry_date, je.voucher_series, je.voucher_number, je.description
      FROM public.journal_entries je
      WHERE je.company_id = $1
        AND ($2::uuid IS NULL OR je.fiscal_period_id = $2)
        -- An explicit status, else everything but cancelled (and drafts when
        -- excluded).
        AND ($3::text IS NULL OR je.status = $3)
        AND ($3::text IS NOT NULL OR je.status <> 'cancelled')
        AND ($3::text IS NOT NULL OR NOT $4 OR je.status <> 'draft')
        AND ($5::date IS NULL OR je.entry_date >= $5)
        AND ($6::date IS NULL OR je.entry_date <= $6)
        AND ($7::text IS NULL OR je.voucher_series = $7)
        -- The search: the text, and each other reading of the needle as an
        -- arm next to it (applyVerifikatSearch).
        AND (
          $8::text IS NULL
          OR je.description ILIKE $8
          OR ($9::text IS NOT NULL AND je.voucher_series = $9 AND je.voucher_number = $10)
          OR ($11::text IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.journal_entry_lines l
            WHERE l.journal_entry_id = je.id AND l.account_number = $11
          ))
          OR ($12::numeric IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.journal_entry_lines l
            WHERE l.journal_entry_id = je.id AND (l.debit_amount = $12 OR l.credit_amount = $12)
          ))
          OR ($13::date IS NOT NULL AND je.entry_date >= $13 AND je.entry_date <= $14)
        )
        -- Every makulerad pair hidden: the reversed original and the storno.
        AND (NOT $15 OR (je.status <> 'reversed' AND je.source_type <> 'storno'))
        -- A corrected original and its storno folded; a storno nothing
        -- corrected stays.
        AND (NOT $16 OR (
          je.id NOT IN (SELECT f.id FROM folded f)
          AND (je.source_type <> 'storno' OR je.reverses_id IS NULL
               OR je.reverses_id NOT IN (SELECT f.id FROM folded f))
        ))
    ),
    ranked AS (
      SELECT m.id, m.entry_date, m.voucher_series, m.voucher_number, m.description, a.display_amount
      FROM matching m
      LEFT JOIN public.verifikat_display_amounts($1, ARRAY(SELECT mm.id FROM matching mm)) a
        ON a.journal_entry_id = m.id
    ),
    page AS (
      SELECT * FROM ranked
      ORDER BY %1$s
      LIMIT $17 OFFSET $18
    )
    SELECT jsonb_build_object(
      'ok', true,
      'total_count', (SELECT count(*) FROM matching),
      'ids', coalesce((SELECT jsonb_agg(id ORDER BY %1$s) FROM page), '[]'::jsonb)
    )
  $sql$, v_order_sql)
  INTO v_result
  USING
    p_company_id,
    p_period_id,
    p_status,
    coalesce(p_exclude_draft, false),
    p_date_from,
    p_date_to,
    p_series,
    p_search_pattern,
    p_search_voucher_series,
    p_search_voucher_number,
    p_search_account,
    p_search_amount,
    p_search_date_from,
    p_search_date_to,
    coalesce(p_hide_reversed, false),
    coalesce(p_collapse_corrections, false),
    v_limit,
    v_offset;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.list_verifikat_by_amount(uuid, uuid, text, boolean, date, date, text, text, text, integer, text, numeric, date, date, boolean, boolean, text[], integer, integer) IS
  'The verifikat list sorted by Belopp: the list''s filters, the amounts of the matching set in one pass (verifikat_display_amounts), the list''s sort and one page. Returns {ok, total_count, ids}.';

REVOKE ALL ON FUNCTION public.list_verifikat_by_amount(uuid, uuid, text, boolean, date, date, text, text, text, integer, text, numeric, date, date, boolean, boolean, text[], integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_verifikat_by_amount(uuid, uuid, text, boolean, date, date, text, text, text, integer, text, numeric, date, date, boolean, boolean, text[], integer, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
