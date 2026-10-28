-- cash_account_ledger_evidence: read only the bank lines of each verifikat.
--
-- What happened. The function (20261010210000, crm#1066) joins every
-- verifikat of the company to its lines and keeps the 19xx ones with a regex,
-- account_number ~ '^19[0-9]{2}$'. A regex match is not an index condition,
-- and it is not leakproof, so under RLS the planner must run the policy on
-- journal_entry_lines (an EXISTS back to journal_entries, one lookup per line)
-- before it may apply the regex. Every line of every verifikat up to the last
-- bank row was fetched and policy-checked, more than half of them only to be
-- thrown away. On production (read only, 2026-10-28) the largest company
-- (34 600 verifikat, 61 700 bank lines out of 147 600) took 2.0 s warm
-- through RLS and 4.1 s on a first, cold run without RLS; the call peaks at 7.8 s,
-- next to the 8 s statement timeout of the authenticated role, and four
-- "Ledger evidence: canceling statement due to statement timeout" reached
-- PostHog on 2026-10-26 and 2026-10-27.
--
-- What changes. Both joins onto journal_entry_lines also say
-- account_number >= '1900' AND account_number < '2000'. Text comparison is
-- leakproof, so it becomes an index condition on the existing
-- idx_journal_entry_lines_entry_account (journal_entry_id, account_number):
-- only the 19xx lines are fetched and policy-checked. The regex stays, so the
-- set of lines read is exactly the one before (every value it matches lies
-- in that range, in the database's ICU en-US collation as in C). Measured on
-- the same company as a generic plan through RLS: the ledger read
-- policy-checked 147 600 lines over 736 000 buffers and now checks 61 700
-- over 411 000; the whole call went from 2.0 s to 0.97 s. Nothing else in
-- the body changes; it is copied from 20261010210000, the only migration that
-- defines the function. SECURITY INVOKER, the grants and the comment stay as
-- they are (CREATE OR REPLACE keeps grants and comment).

CREATE OR REPLACE FUNCTION public.cash_account_ledger_evidence(p_company_id uuid)
RETURNS TABLE (
  cash_account_id uuid,
  kind            text,
  ledger_account  text,
  hits            integer,
  balance_date    date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH accounts AS MATERIALIZED (
    SELECT ca.id, ca.currency, ca.balance
    FROM public.cash_accounts ca
    WHERE ca.company_id = p_company_id
      AND ca.enabled
      AND ca.bank_connection_id IS NOT NULL
  ),
  -- Every bank row of those accounts per account and day, read once.
  row_days AS MATERIALIZED (
    SELECT
      a.id AS cash_account_id,
      a.currency,
      a.balance,
      t.date AS day,
      sum(t.amount) AS net,
      bool_and(COALESCE(t.currency = a.currency, false)) AS in_currency,
      -- The day's unbooked rows: what the verifikat matcher would try.
      array_agg(round(t.amount, 2)) FILTER (
        WHERE t.journal_entry_id IS NULL
          AND t.is_ignored = false
          AND t.currency = a.currency
          AND t.amount <> 0
      ) AS unbooked
    FROM accounts a
    JOIN public.transactions t
      ON t.company_id = p_company_id
     AND t.cash_account_id = a.id
    GROUP BY a.id, a.currency, a.balance, t.date
  ),
  -- 'transactions'.
  overlap AS (
    SELECT d.cash_account_id, day_lines.account_number AS ledger_account, sum(day_lines.hits)::integer AS hits
    FROM row_days d
    CROSS JOIN LATERAL (
      -- The day's distinct (ledger account, amount) pairs that some unbooked
      -- row of the day carries, each worth the number of rows with that
      -- amount.
      SELECT k.account_number, sum(cardinality(array_positions(d.unbooked, k.amount))) AS hits
      FROM (
        SELECT DISTINCT
          jel.account_number,
          round(
            CASE
              WHEN d.currency = 'SEK' THEN COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)
              WHEN jel.currency = d.currency AND jel.amount_in_currency IS NOT NULL THEN
                CASE
                  WHEN COALESCE(jel.debit_amount, 0) > 0 THEN abs(jel.amount_in_currency)
                  WHEN COALESCE(jel.credit_amount, 0) > 0 THEN -abs(jel.amount_in_currency)
                END
            END, 2) AS amount
        FROM public.journal_entries je
        JOIN public.journal_entry_lines jel
          ON jel.journal_entry_id = je.id
         AND jel.account_number >= '1900'
         AND jel.account_number < '2000'
         AND jel.account_number ~ '^19[0-9]{2}$'
        WHERE je.company_id = p_company_id
          AND je.entry_date = d.day
          AND je.status = 'posted'
          AND je.source_type NOT IN ('opening_balance', 'storno')
      ) k
      WHERE k.amount = ANY (d.unbooked)
      GROUP BY k.account_number
    ) day_lines
    WHERE d.unbooked IS NOT NULL
    GROUP BY d.cash_account_id, day_lines.account_number
  ),
  -- 'balance', from here on. SEK accounts with a stored balance and every
  -- bank row in SEK.
  bank AS MATERIALIZED (
    SELECT d.cash_account_id, d.balance, min(d.day) AS first_day, max(d.day) AS last_day
    FROM row_days d
    WHERE d.currency = 'SEK'
      AND d.balance IS NOT NULL
    GROUP BY d.cash_account_id, d.balance
    HAVING bool_and(d.in_currency)
  ),
  -- The ledger per day, in SEK (the unit of the debit and credit columns),
  -- over all history up to the last bank row: one index range. The opening
  -- balances of each day are kept apart for the floor rule below.
  ledger_days AS MATERIALIZED (
    SELECT
      jel.account_number,
      je.entry_date,
      sum(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)) AS net,
      bool_or(je.status = 'posted') AS has_posted,
      count(DISTINCT je.id) FILTER (
        WHERE je.status = 'posted' AND je.source_type = 'opening_balance'
      ) AS opening_entries,
      sum(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)) FILTER (
        WHERE je.status = 'posted' AND je.source_type = 'opening_balance'
      ) AS opening_net
    FROM (SELECT max(b.last_day) AS last_day FROM bank b) span
    CROSS JOIN LATERAL (
      SELECT e.id, e.entry_date, e.status, e.source_type
      FROM public.journal_entries e
      WHERE e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND e.entry_date <= span.last_day
    ) je
    JOIN public.journal_entry_lines jel
      ON jel.journal_entry_id = je.id
     AND jel.account_number >= '1900'
     AND jel.account_number < '2000'
     AND jel.account_number ~ '^19[0-9]{2}$'
    GROUP BY jel.account_number, je.entry_date
  ),
  -- Opening balances that restate the years before them, as
  -- findOpeningBalanceFloor reads them: posted, on the first day of a fiscal
  -- year, and not two or more on one day that cancel on the account.
  opening_floors AS MATERIALIZED (
    SELECT d.account_number, d.entry_date AS day
    FROM ledger_days d
    WHERE d.opening_entries > 0
      AND NOT (d.opening_entries >= 2 AND round(d.opening_net, 2) = 0)
      AND EXISTS (
        SELECT 1
        FROM public.fiscal_periods fp
        WHERE fp.company_id = p_company_id
          AND fp.period_start = d.entry_date
      )
  ),
  candidates AS (
    SELECT DISTINCT b.cash_account_id, b.balance, g.account_number AS ledger_account, c.day
    FROM bank b
    CROSS JOIN (SELECT DISTINCT d.account_number FROM ledger_days d) g
    CROSS JOIN LATERAL (
      SELECT b.first_day - 1 AS day
      UNION ALL
      SELECT b.first_day
      UNION ALL
      SELECT max(d.entry_date)
      FROM ledger_days d
      WHERE d.account_number = g.account_number
        AND d.has_posted
        AND d.entry_date <= b.last_day
    ) c
    WHERE c.day IS NOT NULL
  ),
  balance_match AS (
    SELECT c.cash_account_id, c.ledger_account, min(c.day) AS balance_date
    FROM candidates c
    CROSS JOIN LATERAL (
      SELECT max(f.day) AS day
      FROM opening_floors f
      WHERE f.account_number = c.ledger_account
        AND f.day <= c.day
    ) ledger_floor
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(d.net), 0) AS balance
      FROM ledger_days d
      WHERE d.account_number = c.ledger_account
        AND d.entry_date <= c.day
        AND (ledger_floor.day IS NULL OR d.entry_date >= ledger_floor.day)
    ) ledger
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(d.net), 0) AS moved
      FROM row_days d
      WHERE d.cash_account_id = c.cash_account_id
        AND d.day > c.day
    ) later
    WHERE round(ledger.balance, 2) <> 0
      AND round(c.balance - later.moved, 2) = round(ledger.balance, 2)
    GROUP BY c.cash_account_id, c.ledger_account
  )
  SELECT o.cash_account_id, 'transactions'::text, o.ledger_account, o.hits, NULL::date
  FROM overlap o
  UNION ALL
  SELECT m.cash_account_id, 'balance'::text, m.ledger_account, NULL::integer, m.balance_date
  FROM balance_match m
  ORDER BY 1, 2, 3;
$$;

NOTIFY pgrst, 'reload schema';
