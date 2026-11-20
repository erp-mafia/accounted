-- get_bank_reconciliation_facts: a linked bank row's anchor date in one join.
--
-- Why: the bank side counts a row linked through transaction_voucher_links
-- on the date of the latest verifikat it is linked to (20261023094100). Both
-- branches found that date with a subquery per row over the entries and
-- links CTEs, which have no index: the planner took the CTEs' one-row
-- estimates and probed every link for every verifikat on the account, for
-- each linked row, twice (the window filter reads the anchor once per bound).
-- A company with thousands of verifikat on 1930 and many links per linked
-- row ran past the 8 s statement timeout, so its bank reconciliation failed
-- on every load.
--
-- The anchor is now a grouped join, the shape get_bank_reconciliation_items'
-- link_anchor already has: per row, the latest entry_date among the
-- verifikat it is linked to and the one it points at that are in entries
-- (live, with a line on the account). A linked row with no such verifikat
-- still counts on its own date. The answer is the previous body's
-- (tests/pg/bank-reconciliation-facts.pg.test.ts runs both), and the main
-- query for that company takes 24 ms.
-- pg-test: covered-by tests/pg/bank-reconciliation-facts.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_bank_reconciliation_facts(
  p_company_id uuid,
  p_account_number text,
  p_currency text,
  p_cash_account_id uuid,
  p_include_unassigned boolean,
  p_date_from date,
  p_date_to date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
DECLARE
  v_hi date := coalesce(p_date_to, 'infinity'::date);
  v_read_lo date := coalesce(p_date_from, '-infinity'::date);
  v_sek boolean := p_currency = 'SEK';
  -- ledger_account_days sums the lines' kronor: a foreign account counts its
  -- lines in its own currency, which only the line level can answer.
  v_indexed boolean := v_sek AND public.ledger_account_days_ready(p_company_id);
  v_ib_floor date;
  v_from date;
  v_lo date;
  v_gl jsonb;
  v_bank jsonb;
  v_cash_accounts integer;
  v_candidates jsonb;
  v_candidate_entries uuid[];
  v_entry_amounts jsonb;
  v_saldo jsonb;
  v_balance numeric;
  v_balance_at timestamptz;
  v_balance_date date;
BEGIN
  -- The opening-balance floor (issue #751): the latest posted IB with a line
  -- on the account inside the window. Both sides of the comparison start
  -- there: everything before it is history the IB restates. A stornerad IB
  -- (status 'reversed') is no floor. Read through journal_entries_adjustment_idx.
  SELECT max(e.entry_date) INTO v_ib_floor
  FROM public.journal_entries e
  WHERE e.company_id = p_company_id
    AND e.source_type = 'opening_balance'
    AND e.status = 'posted'
    AND e.entry_date >= v_read_lo
    AND e.entry_date <= v_hi
    AND EXISTS (
      SELECT 1 FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = e.id AND l.account_number = p_account_number
    );

  v_from := CASE
    WHEN p_date_from IS NOT NULL AND v_ib_floor IS NOT NULL THEN greatest(p_date_from, v_ib_floor)
    ELSE coalesce(p_date_from, v_ib_floor)
  END;
  v_lo := coalesce(v_from, '-infinity'::date);

  IF v_indexed THEN
    -- The account's verifikat in ledger_account_entries (posted and
    -- reversed, every date: a row's anchor can lie outside the window) and
    -- one pass over the company's bank rows answer the bank side and the
    -- verifikat that can be ledger-only (bank_account_candidate_entries'
    -- narrowing, on the rows already read); the day sums answer the ledger.
    WITH periods AS MATERIALIZED (
      SELECT fp.id FROM public.fiscal_periods fp WHERE fp.company_id = p_company_id
    ),
    entries AS MATERIALIZED (
      SELECT a.journal_entry_id AS id, a.entry_date
      FROM public.ledger_account_entries a
      WHERE a.company_id = p_company_id
        AND a.fiscal_period_id IN (SELECT p.id FROM periods p)
        AND a.account_number = p_account_number
    ),
    company_tx AS MATERIALIZED (
      SELECT t.id, t.date, t.amount, t.journal_entry_id, t.is_ignored, t.currency, t.cash_account_id,
             ca.ledger_account
      FROM public.transactions t
      LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
      WHERE t.company_id = p_company_id
    ),
    links AS MATERIALIZED (
      SELECT l.transaction_id, l.journal_entry_id
      FROM public.transaction_voucher_links l
      WHERE l.company_id = p_company_id
    ),
    tx AS (
      SELECT t.*
      FROM company_tx t
      WHERE t.currency = p_currency
        AND (
          p_cash_account_id IS NULL
          OR t.cash_account_id = p_cash_account_id
          OR (p_include_unassigned AND t.cash_account_id IS NULL)
        )
    ),
    -- A linked row's anchor: the latest of the verifikat it is linked to and
    -- the one it points at, among those with a line on the account, for every
    -- row in one join.
    link_anchor AS (
      SELECT u.transaction_id, max(x.entry_date) AS entry_date
      FROM (
        SELECT k.transaction_id, k.journal_entry_id FROM links k
        UNION ALL
        SELECT t.id, t.journal_entry_id FROM tx t WHERE t.journal_entry_id IS NOT NULL
      ) u
      JOIN entries x ON x.id = u.journal_entry_id
      GROUP BY u.transaction_id
    ),
    counted AS (
      SELECT tx.date, tx.amount, tx.is_ignored,
             (tx.journal_entry_id IS NOT NULL OR lk.transaction_id IS NOT NULL) AS linked,
             coalesce(
               CASE WHEN lk.transaction_id IS NULL THEN be.entry_date ELSE la.entry_date END,
               tx.date
             ) AS anchor_date
      FROM tx
      LEFT JOIN (SELECT DISTINCT k.transaction_id FROM links k) lk ON lk.transaction_id = tx.id
      LEFT JOIN entries be ON be.id = tx.journal_entry_id
      LEFT JOIN link_anchor la ON la.transaction_id = tx.id
    ),
    legacy AS MATERIALIZED (
      SELECT NOT EXISTS (
        SELECT 1
        FROM public.cash_accounts pca
        WHERE pca.company_id = p_company_id
          AND pca.is_primary
          AND pca.ledger_account <> p_account_number
      ) AS legacy_null_ok
    ),
    settled_here AS (
      SELECT t.journal_entry_id AS id
      FROM company_tx t
      WHERE t.journal_entry_id IS NOT NULL
        AND (
          t.ledger_account = p_account_number
          OR (t.ledger_account IS NULL AND (SELECT g.legacy_null_ok FROM legacy g))
        )
    )
    SELECT
      (
        -- The posted and reversed lines on the account, the set the
        -- balansräkning sums; the IB and the storno/rättelse verifikat among
        -- them (journal_entries_adjustment_idx) read line by line.
        SELECT jsonb_build_object(
          'balance', (
            SELECT coalesce(sum(d.debit - d.credit), 0)
            FROM public.ledger_account_days d
            WHERE d.company_id = p_company_id
              AND d.fiscal_period_id IN (SELECT p.id FROM periods p)
              AND d.account_number = p_account_number
              AND d.entry_date >= v_lo
              AND d.entry_date <= v_hi
          ),
          'opening_balance', coalesce(sum(x.amount)
            FILTER (WHERE x.source_type = 'opening_balance' AND x.status = 'posted'), 0),
          'correction_adjustment', coalesce(sum(x.amount)
            FILTER (WHERE x.source_type IN ('storno', 'correction')), 0),
          'unconvertible_line_count', 0
        )
        FROM (
          SELECT e.status, e.source_type, coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0) AS amount
          FROM public.journal_entries e
          JOIN public.journal_entry_lines l
            ON l.journal_entry_id = e.id AND l.account_number = p_account_number
          WHERE e.company_id = p_company_id
            AND e.source_type IN ('opening_balance', 'storno', 'correction')
            AND e.status IN ('posted', 'reversed')
            AND e.entry_date >= v_lo
            AND e.entry_date <= v_hi
        ) x
      ),
      (
        SELECT jsonb_build_object(
          'count', count(*) FILTER (WHERE NOT m.is_ignored),
          'total', coalesce(sum(m.amount) FILTER (WHERE NOT m.is_ignored), 0),
          'inflow', coalesce(sum(greatest(m.amount, 0)) FILTER (WHERE NOT m.is_ignored), 0),
          'outflow', coalesce(sum(least(m.amount, 0)) FILTER (WHERE NOT m.is_ignored), 0),
          'ignored_count', count(*) FILTER (WHERE m.is_ignored),
          'ignored_total', coalesce(sum(m.amount) FILTER (WHERE m.is_ignored), 0),
          'matched_count', count(*) FILTER (WHERE NOT m.is_ignored AND m.linked),
          'unmatched_count', count(*) FILTER (WHERE NOT m.is_ignored AND NOT m.linked),
          'unmatched_total', coalesce(sum(m.amount) FILTER (WHERE NOT m.is_ignored AND NOT m.linked), 0),
          'history_start', (SELECT min(tx.date) FROM tx)
        )
        FROM counted m
        WHERE m.anchor_date >= v_lo AND m.anchor_date <= v_hi
      ),
      (
        -- A superset, like the narrowing's: the lines function drops the
        -- reversed verifikat, the IB and the storno.
        SELECT array_agg(c.id ORDER BY c.id)
        FROM entries c
        WHERE c.entry_date >= v_lo
          AND c.entry_date <= v_hi
          -- A hashed lookup; settled_here holds no NULL, so NOT IN is NOT EXISTS.
          AND c.id NOT IN (SELECT s.id FROM settled_here s)
      )
    INTO v_gl, v_bank, v_candidate_entries;

    SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.entry_date, g.voucher_number, g.line_id), '[]'::jsonb)
      INTO v_candidates
    FROM public.bank_account_candidate_lines(
      p_company_id, p_account_number, v_from, p_date_to, false, coalesce(v_candidate_entries, '{}'::uuid[])
    ) g;
  ELSE
    -- Ledger side over [v_from, p_date_to]: posted and reversed lines on the
    -- account, the set the balansräkning sums, with the IB and the storno and
    -- rättelse activity split out. A foreign account counts its lines in its
    -- own currency (ledgerLineAmountIn in lib/bookkeeping/ledger-line-amount.ts,
    -- restated), so only the line level can answer it.
    SELECT jsonb_build_object(
      'balance', coalesce(sum(coalesce(x.amount, 0)), 0),
      'opening_balance', coalesce(sum(coalesce(x.amount, 0))
        FILTER (WHERE x.source_type = 'opening_balance' AND x.status = 'posted'), 0),
      'correction_adjustment', coalesce(sum(coalesce(x.amount, 0))
        FILTER (WHERE x.source_type IN ('storno', 'correction')), 0),
      'unconvertible_line_count', count(*) FILTER (WHERE x.amount IS NULL)
    ) INTO v_gl
    FROM (
      SELECT e.status, e.source_type,
             CASE
               WHEN v_sek THEN coalesce(l.debit_amount, 0) - coalesce(l.credit_amount, 0)
               WHEN l.currency IS DISTINCT FROM p_currency
                    OR l.amount_in_currency IS NULL
                    OR l.amount_in_currency = 'NaN'::numeric THEN NULL
               WHEN coalesce(l.debit_amount, 0) > 0 THEN abs(l.amount_in_currency)
               WHEN coalesce(l.credit_amount, 0) > 0 THEN -abs(l.amount_in_currency)
               ELSE 0
             END AS amount
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l
        ON l.journal_entry_id = e.id AND l.account_number = p_account_number
      WHERE e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND e.entry_date >= v_lo
        AND e.entry_date <= v_hi
    ) x;

    -- Bank side, the same rule, with the verifikat a row is linked to probed
    -- for a line on the account.
    WITH links AS MATERIALIZED (
      SELECT l.transaction_id, l.journal_entry_id
      FROM public.transaction_voucher_links l
      WHERE l.company_id = p_company_id
    ),
    tx AS MATERIALIZED (
      SELECT t.id, t.date, t.amount, t.journal_entry_id, t.is_ignored
      FROM public.transactions t
      WHERE t.company_id = p_company_id
        AND t.currency = p_currency
        AND (
          p_cash_account_id IS NULL
          OR t.cash_account_id = p_cash_account_id
          OR (p_include_unassigned AND t.cash_account_id IS NULL)
        )
    ),
    entries AS MATERIALIZED (
      SELECT e.id, e.entry_date
      FROM public.journal_entries e
      WHERE e.id IN (
          SELECT tx.journal_entry_id FROM tx WHERE tx.journal_entry_id IS NOT NULL
          UNION
          SELECT k.journal_entry_id FROM links k
        )
        AND e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND EXISTS (
          SELECT 1 FROM public.journal_entry_lines l
          WHERE l.journal_entry_id = e.id AND l.account_number = p_account_number
        )
    ),
    -- A linked row's anchor: the latest of the verifikat it is linked to and
    -- the one it points at, among those with a line on the account, for every
    -- row in one join.
    link_anchor AS (
      SELECT u.transaction_id, max(x.entry_date) AS entry_date
      FROM (
        SELECT k.transaction_id, k.journal_entry_id FROM links k
        UNION ALL
        SELECT t.id, t.journal_entry_id FROM tx t WHERE t.journal_entry_id IS NOT NULL
      ) u
      JOIN entries x ON x.id = u.journal_entry_id
      GROUP BY u.transaction_id
    ),
    counted AS (
      SELECT tx.date, tx.amount, tx.is_ignored,
             (tx.journal_entry_id IS NOT NULL OR lk.transaction_id IS NOT NULL) AS linked,
             coalesce(
               CASE WHEN lk.transaction_id IS NULL THEN be.entry_date ELSE la.entry_date END,
               tx.date
             ) AS anchor_date
      FROM tx
      LEFT JOIN (SELECT DISTINCT k.transaction_id FROM links k) lk ON lk.transaction_id = tx.id
      LEFT JOIN entries be ON be.id = tx.journal_entry_id
      LEFT JOIN link_anchor la ON la.transaction_id = tx.id
    )
    SELECT jsonb_build_object(
      'count', count(*) FILTER (WHERE NOT m.is_ignored),
      'total', coalesce(sum(m.amount) FILTER (WHERE NOT m.is_ignored), 0),
      'inflow', coalesce(sum(greatest(m.amount, 0)) FILTER (WHERE NOT m.is_ignored), 0),
      'outflow', coalesce(sum(least(m.amount, 0)) FILTER (WHERE NOT m.is_ignored), 0),
      'ignored_count', count(*) FILTER (WHERE m.is_ignored),
      'ignored_total', coalesce(sum(m.amount) FILTER (WHERE m.is_ignored), 0),
      'matched_count', count(*) FILTER (WHERE NOT m.is_ignored AND m.linked),
      'unmatched_count', count(*) FILTER (WHERE NOT m.is_ignored AND NOT m.linked),
      'unmatched_total', coalesce(sum(m.amount) FILTER (WHERE NOT m.is_ignored AND NOT m.linked), 0),
      'history_start', (SELECT min(tx.date) FROM tx)
    ) INTO v_bank
    FROM counted m
    WHERE m.anchor_date >= v_lo AND m.anchor_date <= v_hi;

    -- The ledger-only verifikat on the account over the floored window: the
    -- candidate RPC's own answer, so "unmatched" has one definition.
    SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.entry_date, g.voucher_number, g.line_id), '[]'::jsonb)
      INTO v_candidates
    FROM public.get_account_gl_lines_for_matching(
      p_company_id, p_account_number, v_from, p_date_to, false
    ) g;
  END IF;

  -- Rows read on their own date across several cash accounts: only an
  -- unscoped call can pool them (#1290); the caller logs it.
  IF p_cash_account_id IS NULL THEN
    SELECT count(DISTINCT t.cash_account_id) INTO v_cash_accounts
    FROM public.transactions t
    WHERE t.company_id = p_company_id
      AND t.currency = p_currency
      AND t.date >= v_read_lo
      AND t.date <= v_hi;
  END IF;

  -- The bank's own saldo ahead of its first row (crm#1221): the balance it
  -- last reported less every non-ignored row from the window's start through
  -- that day. The caller uses it only when the bank's history starts inside
  -- the window.
  IF p_cash_account_id IS NOT NULL THEN
    SELECT ca.balance, ca.balance_updated_at INTO v_balance, v_balance_at
    FROM public.cash_accounts ca
    WHERE ca.company_id = p_company_id AND ca.id = p_cash_account_id;
    IF FOUND THEN
      v_balance_date := (v_balance_at AT TIME ZONE 'Europe/Stockholm')::date;
      v_saldo := jsonb_build_object(
        'balance', v_balance,
        'balance_updated_at', v_balance_at,
        'balance_date', v_balance_date,
        'rows_total', CASE WHEN v_balance_date IS NULL THEN NULL ELSE (
          SELECT coalesce(sum(t.amount), 0)
          FROM public.transactions t
          WHERE t.company_id = p_company_id
            AND t.currency = p_currency
            AND (t.cash_account_id = p_cash_account_id
                 OR (p_include_unassigned AND t.cash_account_id IS NULL))
            AND NOT t.is_ignored
            AND t.date >= v_read_lo
            AND t.date <= v_balance_date
        ) END
      );
    END IF;
  END IF;

  -- A foreign account's candidate lines carry no amount in its currency: the
  -- caller needs each candidate verifikat's own amount from its lines.
  IF NOT v_sek AND jsonb_array_length(v_candidates) > 0 THEN
    SELECT jsonb_object_agg(x.journal_entry_id, x.amount) INTO v_entry_amounts
    FROM (
      SELECT l.journal_entry_id,
             CASE WHEN bool_or(a.amount IS NULL) THEN NULL ELSE sum(a.amount) END AS amount
      FROM public.journal_entry_lines l
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN l.currency IS DISTINCT FROM p_currency
                      OR l.amount_in_currency IS NULL
                      OR l.amount_in_currency = 'NaN'::numeric THEN NULL
                 WHEN coalesce(l.debit_amount, 0) > 0 THEN abs(l.amount_in_currency)
                 WHEN coalesce(l.credit_amount, 0) > 0 THEN -abs(l.amount_in_currency)
                 ELSE 0
               END AS amount
      ) a
      WHERE l.account_number = p_account_number
        AND l.journal_entry_id IN (
          SELECT DISTINCT (c ->> 'journal_entry_id')::uuid FROM jsonb_array_elements(v_candidates) c
        )
      GROUP BY l.journal_entry_id
    ) x;
  END IF;

  RETURN jsonb_build_object(
    'ib_floor', v_ib_floor,
    'effective_from', v_from,
    'gl', v_gl,
    'bank', v_bank,
    'read_window_cash_accounts', v_cash_accounts,
    'saldo', v_saldo,
    'candidates', v_candidates,
    'entry_amounts', v_entry_amounts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_bank_reconciliation_facts(uuid, text, text, uuid, boolean, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bank_reconciliation_facts(uuid, text, text, uuid, boolean, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
