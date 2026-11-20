-- Bank reconciliation in a few round trips instead of thousands.
--
-- Why: getReconciliationStatus and listAccountItems paged every bank row of
-- the window and every verifikat line on the bank account through PostgREST
-- (1 000 rows a page, offset paging, then .in() chunks of 150 ids) and
-- aligned the two sides in JS. A 50 000-verifikat year took ~7 s and 4 200
-- statements for the reconciliation list, ~9 s for one account's items, and
-- the bokslut readiness and bokslutsbilagor paid the same again per bank
-- account. The candidate RPCs (get_unlinked_gl_lines,
-- get_account_gl_lines_for_matching) evaluated their correlated subqueries
-- for every line on the account (~30 000 lines a year, 300+ ms per call,
-- read in two pages).
--
-- 1. The two candidate RPCs keep their signatures, security and results.
--    Each is now a narrowing (bank_account_unlinked_entries,
--    bank_account_candidate_entries) and the old predicate run on what the
--    narrowing leaves (bank_account_unlinked_lines,
--    bank_account_candidate_lines). The narrowing takes the window's
--    verifikat on the account (ledger_account_entries, 20261023093900, once
--    the company's ledger summaries are built; else every verifikat of the
--    window) that no bank row's pointer settles (one scan of the company's
--    bank rows, where the old body probed transactions once per line). Every
--    verifikat it drops is one the old predicate drops too, so the result
--    set is the same row for row.
-- 2. get_bank_reconciliation_facts answers the rest of the bank status in one
--    call: the opening-balance floor, the ledger sums with the IB and the
--    storno/rättelse activity split out, the bank side, the first day of the
--    bank's history, the inputs of the saldo comparison and the ledger-only
--    lines. The bank side counts each row once: a row without a link on its
--    own date, a linked row on the date of the latest live (posted or
--    reversed) verifikat with a line on the account that it is linked to,
--    through its pointer or transaction_voucher_links, and on its own date
--    when it is linked to none. Once the company's ledger summaries are
--    built the ledger sums come from ledger_account_days, the verifikat on
--    the account from ledger_account_entries and the IB and storno/rättelse
--    verifikat from journal_entries_adjustment_idx (below).
-- 3. get_bank_reconciliation_items lists the same rows for one account's
--    bridge table: the open ones in full, the matched ones as a count and the
--    page's slice, and on request the ledger side.
-- 4. get_unexplained_bank_legs answers the covering-set search
--    (detectExplainingVoucherSets) in one read instead of a leg scan and
--    chunked anchor lookups.
--
-- The readers are SECURITY INVOKER: RLS scopes every read, and every read
-- also names the company. The narrowing and lines functions keep the
-- candidate RPCs' SECURITY DEFINER with their JWT tenant guard.

-- ---------------------------------------------------------------------------
-- 0. The IB, storno and rättelse verifikat of a company, by date
-- ---------------------------------------------------------------------------

-- The status floors its window at the latest IB on the account and splits
-- the IB and the storno/rättelse activity out of the ledger sums.
-- ledger_account_days has the sums but not the verifikat behind them, and
-- finding these few among a year's 50 000 verifikat meant reading the source
-- of every verifikat on the account (~80 ms). Partial: a handful of rows per
-- company, and a write of any other verifikat only evaluates the predicate.
-- Built here, so journal_entries writes wait for the build (~0.2 s for 1.9
-- million rows locally).
CREATE INDEX journal_entries_adjustment_idx
  ON public.journal_entries (company_id, entry_date)
  WHERE source_type IN ('opening_balance', 'storno', 'correction');

-- ---------------------------------------------------------------------------
-- 1a. get_unlinked_gl_lines: narrowing, predicate, the RPC
-- ---------------------------------------------------------------------------

-- The verifikat of a window that can be on get_unlinked_gl_lines' list:
-- posted or reversed with a line on the account, and pointed at by no bank
-- row of the company. A superset (the reversed ones, the IB and the storno
-- are among them): the lines function decides.
CREATE OR REPLACE FUNCTION public.bank_account_unlinked_entries(
  p_company_id     uuid,
  p_account_number text,
  p_date_from      date,
  p_date_to        date
)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_indexed boolean := public.ledger_account_days_ready(p_company_id);
  v_ids uuid[];
BEGIN
  -- The lines functions' JWT tenant guard, up front: a signed-in caller
  -- learns nothing, not even ids, about a company it is not a member of.
  IF coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
       IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RETURN '{}'::uuid[];
  END IF;

  WITH pointed AS MATERIALIZED (
    SELECT t.journal_entry_id AS id
    FROM public.transactions t
    WHERE t.company_id = p_company_id
      AND t.journal_entry_id IS NOT NULL
  )
  SELECT array_agg(x.id ORDER BY x.id) INTO v_ids
  FROM (
    -- Posted and reversed verifikat with a line on the account: the lines
    -- function drops the reversed ones, the IB and the storno.
    SELECT a.journal_entry_id AS id
    FROM public.ledger_account_entries a
    WHERE v_indexed
      AND a.company_id = p_company_id
      AND a.fiscal_period_id IN (SELECT fp.id FROM public.fiscal_periods fp WHERE fp.company_id = p_company_id)
      AND a.account_number = p_account_number
      AND a.entry_date >= coalesce(p_date_from, '-infinity'::date)
      AND a.entry_date <= coalesce(p_date_to, 'infinity'::date)
      -- A hashed lookup; pointed holds no NULL, so NOT IN is NOT EXISTS.
      AND a.journal_entry_id NOT IN (SELECT p.id FROM pointed p)
    UNION ALL
    SELECT e.id
    FROM public.journal_entries e
    WHERE NOT v_indexed
      AND e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND e.entry_date >= coalesce(p_date_from, '-infinity'::date)
      AND e.entry_date <= coalesce(p_date_to, 'infinity'::date)
      AND NOT EXISTS (SELECT 1 FROM pointed p WHERE p.id = e.id)
  ) x;
  RETURN coalesce(v_ids, '{}'::uuid[]);
END;
$$;

-- get_unlinked_gl_lines' predicate, verbatim from
-- 20261006121002_gl_lines_partially_allocated_remaining.sql, run on the lines
-- on the account of the given verifikat only. Any verifikat the caller
-- passes is judged in full (window, status, links, tenant guard), so an id
-- list can only narrow the answer, never widen it.
CREATE OR REPLACE FUNCTION public.bank_account_unlinked_lines(
  p_company_id     uuid,
  p_account_number text,
  p_date_from      date,
  p_date_to        date,
  p_entry_ids      uuid[]
)
RETURNS TABLE (
  line_id            UUID,
  journal_entry_id   UUID,
  debit_amount       NUMERIC,
  credit_amount      NUMERIC,
  line_description   TEXT,
  entry_date         DATE,
  voucher_number     INT,
  voucher_series     TEXT,
  entry_description  TEXT,
  source_type        TEXT,
  remaining_amount   NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT c.id AS entry_id, x.id, x.debit_amount, x.credit_amount, x.line_description
    FROM unnest(p_entry_ids) AS c(id)
    CROSS JOIN LATERAL (
      SELECT l.id, l.debit_amount, l.credit_amount, l.line_description
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = c.id
        AND l.account_number = p_account_number
      OFFSET 0
    ) x
  )
  SELECT
    jel.id AS line_id,
    je.id AS journal_entry_id,
    jel.debit_amount,
    jel.credit_amount,
    jel.line_description,
    je.entry_date,
    je.voucher_number,
    je.voucher_series,
    je.description AS entry_description,
    je.source_type,
    r.remaining_amount
  FROM hits jel
  CROSS JOIN LATERAL (
    SELECT x.id, x.company_id, x.entry_date, x.voucher_number, x.voucher_series,
           x.description, x.source_type, x.status
    FROM public.journal_entries x
    WHERE x.id = jel.entry_id
    OFFSET 0
  ) je
  CROSS JOIN LATERAL (
    SELECT
      count(*) AS link_count,
      bool_and(COALESCE(
        l.role = 'bank_line' AND ca.ledger_account = p_account_number AND ca.currency = 'SEK',
        false)) AS slices_here,
      sum(l.allocated_amount) AS allocated
    FROM public.transaction_voucher_links l
    JOIN public.transactions t ON t.id = l.transaction_id
    LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
    WHERE l.journal_entry_id = je.id
      AND l.company_id = p_company_id
  ) k
  CROSS JOIN LATERAL (
    SELECT CASE WHEN k.link_count > 0 AND k.slices_here THEN round(
      (SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
         FROM public.journal_entry_lines jel3
        WHERE jel3.journal_entry_id = je.id
          AND jel3.account_number = p_account_number)
      - k.allocated, 2) END AS remaining_amount
  ) r
  WHERE je.company_id = p_company_id
    AND je.status = 'posted'
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    AND je.source_type IS DISTINCT FROM 'storno'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to   IS NULL OR je.entry_date <= p_date_to)
    AND NOT EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
    )
    AND (k.link_count = 0 OR abs(r.remaining_amount) >= 0.005)
    AND (
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_unlinked_gl_lines(
  p_company_id      UUID,
  p_account_number  TEXT DEFAULT '1930',
  p_date_from       DATE DEFAULT NULL,
  p_date_to         DATE DEFAULT NULL
)
RETURNS TABLE (
  line_id            UUID,
  journal_entry_id   UUID,
  debit_amount       NUMERIC,
  credit_amount      NUMERIC,
  line_description   TEXT,
  entry_date         DATE,
  voucher_number     INT,
  voucher_series     TEXT,
  entry_description  TEXT,
  source_type        TEXT,
  remaining_amount   NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT g.*
  FROM public.bank_account_unlinked_lines(
    p_company_id, p_account_number, p_date_from, p_date_to,
    public.bank_account_unlinked_entries(p_company_id, p_account_number, p_date_from, p_date_to)
  ) g;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1b. get_account_gl_lines_for_matching: narrowing, predicate, the RPC
-- ---------------------------------------------------------------------------

-- The verifikat of a window that can be on get_account_gl_lines_for_matching's
-- list: posted or reversed with a line on the account, and not settled on it
-- by a bank row's pointer. A superset, never a subset (the reversed ones, the
-- IB and the storno are among them): bank_account_candidate_lines decides.
-- With p_include_matched nothing is settled, every verifikat of the window on
-- the account qualifies.
CREATE OR REPLACE FUNCTION public.bank_account_candidate_entries(
  p_company_id      uuid,
  p_account_number  text,
  p_date_from       date,
  p_date_to         date,
  p_include_matched boolean
)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_indexed boolean := public.ledger_account_days_ready(p_company_id);
  v_ids uuid[];
BEGIN
  -- The lines functions' JWT tenant guard, up front: a signed-in caller
  -- learns nothing, not even ids, about a company it is not a member of.
  IF coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
       IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RETURN '{}'::uuid[];
  END IF;

  WITH legacy AS MATERIALIZED (
    SELECT NOT EXISTS (
      SELECT 1
      FROM public.cash_accounts pca
      WHERE pca.company_id = p_company_id
        AND pca.is_primary
        AND pca.ledger_account <> p_account_number
    ) AS legacy_null_ok
  ),
  -- Verifikat a bank row on this account (or an unassigned row, where those
  -- settle every account) points at: the old predicate's first NOT EXISTS
  -- holds for all of them, whatever else is true.
  settled_here AS MATERIALIZED (
    SELECT t.journal_entry_id AS id
    FROM public.transactions t
    LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
    WHERE NOT p_include_matched
      AND t.company_id = p_company_id
      AND t.journal_entry_id IS NOT NULL
      AND (
        ca.ledger_account = p_account_number
        OR (ca.ledger_account IS NULL AND (SELECT g.legacy_null_ok FROM legacy g))
      )
  )
  SELECT array_agg(x.id ORDER BY x.id) INTO v_ids
  FROM (
    -- Posted and reversed verifikat with a line on the account: the lines
    -- function drops the reversed ones, the IB and the storno.
    SELECT a.journal_entry_id AS id
    FROM public.ledger_account_entries a
    WHERE v_indexed
      AND a.company_id = p_company_id
      AND a.fiscal_period_id IN (SELECT fp.id FROM public.fiscal_periods fp WHERE fp.company_id = p_company_id)
      AND a.account_number = p_account_number
      AND a.entry_date >= coalesce(p_date_from, '-infinity'::date)
      AND a.entry_date <= coalesce(p_date_to, 'infinity'::date)
      -- A hashed lookup; settled_here holds no NULL, so NOT IN is NOT EXISTS.
      AND a.journal_entry_id NOT IN (SELECT s.id FROM settled_here s)
    UNION ALL
    SELECT e.id
    FROM public.journal_entries e
    WHERE NOT v_indexed
      AND e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND e.entry_date >= coalesce(p_date_from, '-infinity'::date)
      AND e.entry_date <= coalesce(p_date_to, 'infinity'::date)
      AND NOT EXISTS (SELECT 1 FROM settled_here s WHERE s.id = e.id)
  ) x;
  RETURN coalesce(v_ids, '{}'::uuid[]);
END;
$$;

-- get_account_gl_lines_for_matching's predicate from
-- 20261006121002_gl_lines_partially_allocated_remaining.sql, run on the lines
-- on the account of the given verifikat only. The expressions are the same;
-- the per-verifikat values the old body computed up front for every line
-- (legacy_null_ok, single_bank_leg, account_net in its lateral v) are
-- evaluated where a condition reads them, which for a verifikat no bank row
-- touches is never. Any verifikat the caller passes is judged in full
-- (window, status, links, tenant guard), so an id list can only narrow the
-- answer, never widen it.
CREATE OR REPLACE FUNCTION public.bank_account_candidate_lines(
  p_company_id      uuid,
  p_account_number  text,
  p_date_from       date,
  p_date_to         date,
  p_include_matched boolean,
  p_entry_ids       uuid[]
)
RETURNS TABLE (
  line_id                  UUID,
  journal_entry_id         UUID,
  debit_amount             NUMERIC,
  credit_amount            NUMERIC,
  line_description         TEXT,
  entry_date               DATE,
  voucher_number           INT,
  voucher_series           TEXT,
  entry_description        TEXT,
  source_type              TEXT,
  linked_transaction_count INT,
  remaining_amount         NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT c.id AS entry_id, x.id, x.debit_amount, x.credit_amount, x.line_description
    FROM unnest(p_entry_ids) AS c(id)
    CROSS JOIN LATERAL (
      SELECT l.id, l.debit_amount, l.credit_amount, l.line_description
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = c.id
        AND l.account_number = p_account_number
      OFFSET 0
    ) x
  )
  SELECT
    jel.id AS line_id,
    je.id AS journal_entry_id,
    jel.debit_amount,
    jel.credit_amount,
    jel.line_description,
    je.entry_date,
    je.voucher_number,
    je.voucher_series,
    je.description AS entry_description,
    je.source_type,
    (
      (
        SELECT count(*)
        FROM public.transactions t
        LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
        WHERE t.journal_entry_id = je.id
          AND t.company_id = p_company_id
          AND (
            ca.ledger_account = p_account_number
            OR (
              ca.ledger_account IS NULL
              AND (
                (NOT EXISTS (
                SELECT 1
                FROM public.cash_accounts pca
                WHERE pca.company_id = p_company_id
                  AND pca.is_primary
                  AND pca.ledger_account <> p_account_number
              ))
                OR ((
                SELECT count(DISTINCT ca4.ledger_account)
                FROM public.journal_entry_lines jel2
                JOIN public.cash_accounts ca4
                  ON ca4.company_id = p_company_id
                 AND ca4.ledger_account = jel2.account_number
                WHERE jel2.journal_entry_id = je.id
              ) < 2)
                OR sign(t.amount) = 0
                OR sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              )) = 0
                OR sign(t.amount) = sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ))
              )
            )
          )
      ) + (
        SELECT count(*)
        FROM public.transaction_voucher_links l
        JOIN public.transactions t ON t.id = l.transaction_id
        LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
        WHERE l.journal_entry_id = je.id
          AND l.company_id = p_company_id
          AND t.journal_entry_id IS DISTINCT FROM je.id
          AND (
            ca.ledger_account = p_account_number
            OR (
              ca.ledger_account IS NULL
              AND (
                (NOT EXISTS (
                SELECT 1
                FROM public.cash_accounts pca
                WHERE pca.company_id = p_company_id
                  AND pca.is_primary
                  AND pca.ledger_account <> p_account_number
              ))
                OR ((
                SELECT count(DISTINCT ca4.ledger_account)
                FROM public.journal_entry_lines jel2
                JOIN public.cash_accounts ca4
                  ON ca4.company_id = p_company_id
                 AND ca4.ledger_account = jel2.account_number
                WHERE jel2.journal_entry_id = je.id
              ) < 2)
                OR sign(t.amount) = 0
                OR sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              )) = 0
                OR sign(t.amount) = sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ))
              )
            )
          )
      )
    )::int AS linked_transaction_count,
    r.remaining_amount
  FROM hits jel
  CROSS JOIN LATERAL (
    SELECT x.id, x.company_id, x.entry_date, x.voucher_number, x.voucher_series,
           x.description, x.source_type, x.status
    FROM public.journal_entries x
    WHERE x.id = jel.entry_id
    OFFSET 0
  ) je
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN count(*) > 0
        AND bool_and(COALESCE(
          l.role = 'bank_line' AND ca.ledger_account = p_account_number AND ca.currency = 'SEK',
          false))
      THEN round((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ) - sum(l.allocated_amount), 2)
    END AS remaining_amount
    FROM public.transaction_voucher_links l
    JOIN public.transactions t ON t.id = l.transaction_id
    LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
    WHERE l.journal_entry_id = je.id
      AND l.company_id = p_company_id
  ) r
  WHERE je.company_id = p_company_id
    AND je.status = 'posted'
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    AND je.source_type IS DISTINCT FROM 'storno'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to   IS NULL OR je.entry_date <= p_date_to)
    AND (
      p_include_matched
      OR (
        NOT EXISTS (
          SELECT 1
          FROM public.transactions t
          LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
          WHERE t.journal_entry_id = je.id
            AND t.company_id = p_company_id
            AND (
              ca.ledger_account = p_account_number
              OR (
                ca.ledger_account IS NULL
                AND (
                  (NOT EXISTS (
                SELECT 1
                FROM public.cash_accounts pca
                WHERE pca.company_id = p_company_id
                  AND pca.is_primary
                  AND pca.ledger_account <> p_account_number
              ))
                  OR ((
                SELECT count(DISTINCT ca4.ledger_account)
                FROM public.journal_entry_lines jel2
                JOIN public.cash_accounts ca4
                  ON ca4.company_id = p_company_id
                 AND ca4.ledger_account = jel2.account_number
                WHERE jel2.journal_entry_id = je.id
              ) < 2)
                  OR sign(t.amount) = 0
                  OR sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              )) = 0
                  OR sign(t.amount) = sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ))
                )
              )
            )
        )
        AND (
          NOT EXISTS (
            SELECT 1
            FROM public.transaction_voucher_links l
            JOIN public.transactions t ON t.id = l.transaction_id
            LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
            WHERE l.journal_entry_id = je.id
              AND l.company_id = p_company_id
              AND (
                ca.ledger_account = p_account_number
                OR (
                  ca.ledger_account IS NULL
                  AND (
                    (NOT EXISTS (
                SELECT 1
                FROM public.cash_accounts pca
                WHERE pca.company_id = p_company_id
                  AND pca.is_primary
                  AND pca.ledger_account <> p_account_number
              ))
                    OR ((
                SELECT count(DISTINCT ca4.ledger_account)
                FROM public.journal_entry_lines jel2
                JOIN public.cash_accounts ca4
                  ON ca4.company_id = p_company_id
                 AND ca4.ledger_account = jel2.account_number
                WHERE jel2.journal_entry_id = je.id
              ) < 2)
                    OR sign(t.amount) = 0
                    OR sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              )) = 0
                    OR sign(t.amount) = sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ))
                  )
                )
              )
          )
          OR abs(r.remaining_amount) >= 0.005
        )
      )
    )
    AND (
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_account_gl_lines_for_matching(
  p_company_id      UUID,
  p_account_number  TEXT DEFAULT '1930',
  p_date_from       DATE DEFAULT NULL,
  p_date_to         DATE DEFAULT NULL,
  p_include_matched BOOLEAN DEFAULT false
)
RETURNS TABLE (
  line_id                  UUID,
  journal_entry_id         UUID,
  debit_amount             NUMERIC,
  credit_amount            NUMERIC,
  line_description         TEXT,
  entry_date               DATE,
  voucher_number           INT,
  voucher_series           TEXT,
  entry_description        TEXT,
  source_type              TEXT,
  linked_transaction_count INT,
  remaining_amount         NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT g.*
  FROM public.bank_account_candidate_lines(
    p_company_id, p_account_number, p_date_from, p_date_to, p_include_matched,
    public.bank_account_candidate_entries(p_company_id, p_account_number, p_date_from, p_date_to, p_include_matched)
  ) g;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. get_bank_reconciliation_facts
-- ---------------------------------------------------------------------------

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
    counted AS (
      SELECT tx.date, tx.amount, tx.is_ignored,
             (tx.journal_entry_id IS NOT NULL OR lk.transaction_id IS NOT NULL) AS linked,
             coalesce(
               CASE
                 WHEN lk.transaction_id IS NULL THEN be.entry_date
                 ELSE (
                   SELECT max(x.entry_date)
                   FROM entries x
                   WHERE x.id IN (
                     SELECT k.journal_entry_id FROM links k WHERE k.transaction_id = tx.id
                     UNION ALL
                     SELECT tx.journal_entry_id
                   )
                 )
               END,
               tx.date
             ) AS anchor_date
      FROM tx
      LEFT JOIN (SELECT DISTINCT k.transaction_id FROM links k) lk ON lk.transaction_id = tx.id
      LEFT JOIN entries be ON be.id = tx.journal_entry_id
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
    counted AS (
      SELECT tx.date, tx.amount, tx.is_ignored,
             (tx.journal_entry_id IS NOT NULL OR lk.transaction_id IS NOT NULL) AS linked,
             coalesce(
               CASE
                 WHEN lk.transaction_id IS NULL THEN be.entry_date
                 ELSE (
                   SELECT max(x.entry_date)
                   FROM entries x
                   WHERE x.id IN (
                     SELECT k.journal_entry_id FROM links k WHERE k.transaction_id = tx.id
                     UNION ALL
                     SELECT tx.journal_entry_id
                   )
                 )
               END,
               tx.date
             ) AS anchor_date
      FROM tx
      LEFT JOIN (SELECT DISTINCT k.transaction_id FROM links k) lk ON lk.transaction_id = tx.id
      LEFT JOIN entries be ON be.id = tx.journal_entry_id
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

-- ---------------------------------------------------------------------------
-- 3. get_bank_reconciliation_items
-- ---------------------------------------------------------------------------

-- The rows behind one bank account's bridge for listAccountItems
-- (lib/reconciliation/items.ts): every bank row of the window that is not
-- matched (ignored or open) in full, the matched ones as a count and the
-- slice [p_matched_offset, +p_matched_limit) of them, newest first, and on
-- request the ledger side (the bank's history start, the ledger-only lines,
-- the fiscal years' first days). The listing's window rule: a row dated
-- inside the window counts its links only while it has no pointer and is not
-- ignored, a row dated outside it counts every link (it is in the listing
-- only through one), and every row counts on the date of the latest live
-- verifikat with a line on the account among those it counts, else on its
-- own date. With p_matched_after_open the slice is shortened by the open
-- rows: a listing that shows them first reaches only that far into the
-- matched ones on a page that ends at p_matched_limit.
CREATE OR REPLACE FUNCTION public.get_bank_reconciliation_items(
  p_company_id uuid,
  p_account_number text,
  p_currency text,
  p_cash_account_id uuid,
  p_include_unassigned boolean,
  p_date_from date,
  p_date_to date,
  p_with_rows boolean,
  p_with_ledger boolean,
  p_matched_offset integer,
  p_matched_limit integer,
  p_matched_after_open boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
DECLARE
  v_lo date := coalesce(p_date_from, '-infinity'::date);
  v_hi date := coalesce(p_date_to, 'infinity'::date);
  v_indexed boolean := public.ledger_account_days_ready(p_company_id);
  v_rows jsonb;
  v_history_start date;
  v_unlinked uuid[];
  v_lines jsonb;
  v_year_starts jsonb;
BEGIN
  IF p_with_rows OR p_with_ledger THEN
    WITH company_tx AS MATERIALIZED (
      SELECT t.id, t.date, t.amount, t.journal_entry_id, t.potential_journal_entry_id, t.is_ignored,
             t.currency, t.cash_account_id
      FROM public.transactions t
      WHERE t.company_id = p_company_id
    ),
    tx AS MATERIALIZED (
      SELECT t.id, t.date, t.journal_entry_id, t.is_ignored,
             (t.date >= v_lo AND t.date <= v_hi) AS own_in
      FROM company_tx t
      WHERE t.currency = p_currency
        AND (
          p_cash_account_id IS NULL
          OR t.cash_account_id = p_cash_account_id
          OR (p_include_unassigned AND t.cash_account_id IS NULL)
        )
    ),
    links AS MATERIALIZED (
      SELECT l.id, l.transaction_id, l.journal_entry_id, l.role, l.created_at
      FROM public.transaction_voucher_links l
      WHERE l.company_id = p_company_id
    ),
    -- Live (posted or reversed) verifikat with a line on the account, and
    -- their dates.
    bank_entries AS MATERIALIZED (
      SELECT a.journal_entry_id AS id, a.entry_date
      FROM public.ledger_account_entries a
      WHERE v_indexed
        AND a.company_id = p_company_id
        AND a.fiscal_period_id IN (SELECT fp.id FROM public.fiscal_periods fp WHERE fp.company_id = p_company_id)
        AND a.account_number = p_account_number
      UNION ALL
      SELECT e.id, e.entry_date
      FROM public.journal_entries e
      WHERE NOT v_indexed
        AND e.id IN (
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
    link_anchor AS (
      SELECT k.transaction_id, max(be.entry_date) AS entry_date
      FROM links k
      JOIN bank_entries be ON be.id = k.journal_entry_id
      GROUP BY k.transaction_id
    ),
    -- A row's first link, bank_line anchors before supplementary ones.
    first_link AS (
      SELECT DISTINCT ON (k.transaction_id) k.transaction_id, k.journal_entry_id
      FROM links k
      ORDER BY k.transaction_id, (k.role <> 'bank_line'), k.created_at, k.id
    ),
    listed AS (
      SELECT tx.id, tx.date, tx.journal_entry_id, tx.is_ignored,
             (NOT tx.own_in OR (tx.journal_entry_id IS NULL AND NOT tx.is_ignored)) AS reads_links,
             fl.journal_entry_id AS first_link_id,
             greatest(
               bp.entry_date,
               CASE WHEN NOT tx.own_in OR (tx.journal_entry_id IS NULL AND NOT tx.is_ignored)
                    THEN la.entry_date END
             ) AS anchor_date
      FROM tx
      LEFT JOIN bank_entries bp ON bp.id = tx.journal_entry_id
      LEFT JOIN link_anchor la ON la.transaction_id = tx.id
      LEFT JOIN first_link fl ON fl.transaction_id = tx.id
    ),
    member AS MATERIALIZED (
      SELECT x.id, x.date, x.is_ignored,
             (x.journal_entry_id IS NOT NULL OR (x.reads_links AND x.first_link_id IS NOT NULL)) AS linked,
             coalesce(x.journal_entry_id, CASE WHEN x.reads_links THEN x.first_link_id END) AS linked_journal_entry_id
      FROM listed x
      WHERE p_with_rows
        AND coalesce(x.anchor_date, x.date) >= v_lo
        AND coalesce(x.anchor_date, x.date) <= v_hi
    ),
    picked AS (
      SELECT m.*, false AS matched_slice
      FROM member m
      WHERE m.is_ignored OR NOT m.linked
      UNION ALL
      SELECT s.*, true
      FROM (
        SELECT m.*
        FROM member m
        WHERE NOT m.is_ignored AND m.linked
        ORDER BY m.date DESC, m.id
        OFFSET greatest(p_matched_offset, 0)
        LIMIT greatest(
          p_matched_limit - CASE WHEN p_matched_after_open
            THEN (SELECT count(*) FROM member o WHERE o.is_ignored OR NOT o.linked) ELSE 0 END,
          0
        )
      ) s
    ),
    -- The listing's columns, read for the rows it returns only.
    shown AS (
      SELECT p.matched_slice,
             jsonb_build_object(
               'id', t.id, 'date', t.date, 'description', t.description, 'merchant_name', t.merchant_name,
               'amount', t.amount, 'currency', t.currency, 'journal_entry_id', t.journal_entry_id,
               'potential_journal_entry_id', t.potential_journal_entry_id,
               'potential_match_method', t.potential_match_method,
               'potential_match_confidence', t.potential_match_confidence,
               'is_ignored', t.is_ignored, 'reconciliation_method', t.reconciliation_method,
               'linked', p.linked, 'linked_journal_entry_id', p.linked_journal_entry_id) AS row,
             p.date, p.id
      FROM picked p
      JOIN public.transactions t ON t.id = p.id AND t.company_id = p_company_id
    )
    SELECT
      CASE WHEN p_with_rows THEN jsonb_build_object(
        'open_rows', coalesce((
          SELECT jsonb_agg(x.row ORDER BY x.date DESC, x.id) FROM shown x WHERE NOT x.matched_slice
        ), '[]'::jsonb),
        'matched_count', (SELECT count(*) FROM member m WHERE NOT m.is_ignored AND m.linked),
        'matched_rows', coalesce((
          SELECT jsonb_agg(x.row ORDER BY x.date DESC, x.id) FROM shown x WHERE x.matched_slice
        ), '[]'::jsonb)
      ) END,
      -- The first day the bank side covers on this account (crm#1221),
      -- ignored rows included, as fetchBankHistoryStart reads it.
      CASE WHEN p_with_ledger THEN (SELECT min(tx.date) FROM tx) END,
      -- get_unlinked_gl_lines' narrowing (bank_account_unlinked_entries) on
      -- the rows already read: the window's verifikat on the account that no
      -- bank row of the company points at (the lines function drops the
      -- reversed ones, the IB and the storno).
      CASE WHEN p_with_ledger AND v_indexed THEN (
        SELECT coalesce(array_agg(be.id ORDER BY be.id), '{}'::uuid[])
        FROM bank_entries be
        WHERE be.entry_date >= v_lo
          AND be.entry_date <= v_hi
          -- A hashed lookup; the subquery holds no NULL, so NOT IN is NOT EXISTS.
          AND be.id NOT IN (
            SELECT t.journal_entry_id FROM company_tx t WHERE t.journal_entry_id IS NOT NULL
          )
      ) END
    INTO v_rows, v_history_start, v_unlinked;
  END IF;

  IF p_with_ledger THEN
    IF v_unlinked IS NULL THEN
      v_unlinked := public.bank_account_unlinked_entries(p_company_id, p_account_number, p_date_from, p_date_to);
    END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.entry_date, g.voucher_number, g.line_id), '[]'::jsonb)
      INTO v_lines
    FROM public.bank_account_unlinked_lines(p_company_id, p_account_number, p_date_from, p_date_to, v_unlinked) g;

    IF jsonb_array_length(v_lines) > 0 THEN
      SELECT coalesce(jsonb_agg(fp.period_start), '[]'::jsonb) INTO v_year_starts
      FROM public.fiscal_periods fp
      WHERE fp.company_id = p_company_id;
    END IF;
  END IF;

  RETURN coalesce(v_rows, '{}'::jsonb) || jsonb_build_object(
    'history_start', v_history_start,
    'ledger_lines', coalesce(v_lines, '[]'::jsonb),
    'fiscal_year_starts', coalesce(v_year_starts, '[]'::jsonb)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. get_unexplained_bank_legs
-- ---------------------------------------------------------------------------

-- The bank legs a covering-set search may use (detectExplainingVoucherSets,
-- lib/invoices/duplicate-payment-detection.ts): the lines on the settlement
-- account (or, with none, on 1910-1949) of the posted verifikat dated in
-- [p_low, p_high] that are no reversal, rättelse or opening balance and that
-- nothing explains yet: no invoice or supplier-invoice payment through a bank
-- row, no bank row other than the searched ones pointing at it, no
-- transaction_voucher_links row. The detector read every leg of the window
-- and then every anchor in chunks of 100; the verdict per verifikat is the
-- same.
CREATE OR REPLACE FUNCTION public.get_unexplained_bank_legs(
  p_company_id uuid,
  p_account_number text,
  p_low date,
  p_high date,
  p_own_transaction_ids uuid[]
)
RETURNS TABLE (
  journal_entry_id uuid,
  entry_date date,
  description text,
  voucher_series text,
  voucher_number integer,
  status text,
  source_type text,
  account_number text,
  debit_amount numeric,
  credit_amount numeric
)
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
#variable_conflict use_column
DECLARE
  v_indexed boolean := p_account_number IS NOT NULL
    AND public.ledger_account_days_ready(p_company_id);
  v_ids uuid[];
BEGIN
  -- Bank rows other than the searched ones that point at a verifikat: one
  -- scan, the common reason a verifikat is explained, before the per-verifikat
  -- checks of the payment tables run on what is left.
  WITH pointed AS MATERIALIZED (
    SELECT t.journal_entry_id AS id
    FROM public.transactions t
    WHERE t.company_id = p_company_id
      AND t.journal_entry_id IS NOT NULL
      AND t.id <> ALL (coalesce(p_own_transaction_ids, '{}'::uuid[]))
  ),
  -- Posted and reversed verifikat with a line on the account; their status
  -- and source are read below, for the few no bank row points at.
  candidates AS MATERIALIZED (
    SELECT a.journal_entry_id AS id
    FROM public.ledger_account_entries a
    WHERE v_indexed
      AND a.company_id = p_company_id
      AND a.fiscal_period_id IN (SELECT fp.id FROM public.fiscal_periods fp WHERE fp.company_id = p_company_id)
      AND a.account_number = p_account_number
      AND a.entry_date >= p_low
      AND a.entry_date <= p_high
    UNION ALL
    SELECT e.id
    FROM public.journal_entries e
    WHERE NOT v_indexed
      AND e.company_id = p_company_id
      AND e.status = 'posted'
      AND e.entry_date >= p_low
      AND e.entry_date <= p_high
      AND e.source_type NOT IN ('storno', 'correction', 'opening_balance')
      AND EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND CASE WHEN p_account_number IS NOT NULL THEN l.account_number = p_account_number
                   ELSE l.account_number >= '1910' AND l.account_number <= '1949' END
      )
  ),
  unpointed AS MATERIALIZED (
    SELECT c.id
    FROM candidates c
    WHERE NOT EXISTS (SELECT 1 FROM pointed p WHERE p.id = c.id)
  ),
  -- Ordinary posted verifikat only: no storno, rättelse or IB.
  live AS MATERIALIZED (
    SELECT u.id
    FROM unpointed u
    JOIN public.journal_entries e ON e.id = u.id
    WHERE e.status = 'posted'
      AND e.source_type NOT IN ('storno', 'correction', 'opening_balance')
  )
  SELECT array_agg(c.id) INTO v_ids
  FROM live c
  WHERE NOT EXISTS (
      SELECT 1 FROM public.invoice_payments ip
      WHERE ip.company_id = p_company_id AND ip.journal_entry_id = c.id AND ip.transaction_id IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments sp
      WHERE sp.company_id = p_company_id AND sp.journal_entry_id = c.id AND sp.transaction_id IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.transaction_voucher_links k
      WHERE k.company_id = p_company_id AND k.journal_entry_id = c.id
    );

  RETURN QUERY
  SELECT e.id, e.entry_date, e.description, e.voucher_series, e.voucher_number, e.status, e.source_type,
         l.account_number, l.debit_amount, l.credit_amount
  FROM unnest(coalesce(v_ids, '{}'::uuid[])) AS c(id)
  JOIN public.journal_entries e ON e.id = c.id
  JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
  WHERE CASE WHEN p_account_number IS NOT NULL THEN l.account_number = p_account_number
             ELSE l.account_number >= '1910' AND l.account_number <= '1949' END
  -- The order the detector read its legs in (fetchEntryLines: line id), so
  -- a verifikat with equal legs on two accounts keeps the same one.
  ORDER BY l.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bank_account_unlinked_entries(uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_account_unlinked_entries(uuid, text, date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bank_account_unlinked_lines(uuid, text, date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_account_unlinked_lines(uuid, text, date, date, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bank_account_candidate_entries(uuid, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_account_candidate_entries(uuid, text, date, date, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bank_account_candidate_lines(uuid, text, date, date, boolean, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_account_candidate_lines(uuid, text, date, date, boolean, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_bank_reconciliation_facts(uuid, text, text, uuid, boolean, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bank_reconciliation_facts(uuid, text, text, uuid, boolean, date, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_bank_reconciliation_items(uuid, text, text, uuid, boolean, date, date, boolean, boolean, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bank_reconciliation_items(uuid, text, text, uuid, boolean, date, date, boolean, boolean, integer, integer, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_unexplained_bank_legs(uuid, text, date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unexplained_bank_legs(uuid, text, date, date, uuid[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
