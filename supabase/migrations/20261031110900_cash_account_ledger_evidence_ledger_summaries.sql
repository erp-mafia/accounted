-- cash_account_ledger_evidence: the balance kind reads the ledger summaries.
--
-- What happened. The bank-account suggestion on Transaktioner and the bank
-- settings (lib/cash-accounts/ledger-suggestions.ts) calls this function for
-- every company with a connected bank account. Its balance kind summed every
-- 19xx line of every verifikat up to the last bank row (ledger_days), each
-- line policy-checked under RLS. 20261028042147 narrowed that read to the
-- 19xx lines, but the cost still grew with the whole history: for a company
-- with a very large ledger a cold call ran past the 8 s statement timeout
-- of the authenticated role, and warm ones were the slowest RPC users wait
-- on.
--
-- What changes. A company whose ledger summaries are built
-- (ledger_account_days_ready, 20261023093900) reads ledger_account_days
-- instead: the same
-- posted and reversed lines per account and day, already summed. The two
-- things the summaries do not tell apart are read from the journal, and
-- only where they are needed: the posted opening balances (the floor), a
-- handful of verifikat; and whether a day holds a posted line (has_posted),
-- asked in candidates for the latest days of each account only, newest
-- first, until one has one. A company without summaries keeps the line read
-- unchanged. Same rows out: the new body and 20261028042147 were compared
-- for every company with a connected bank account and gave identical
-- results. A call for a very large ledger now takes tens of milliseconds.
--
-- Everything else in the body is copied from 20261028042147, the latest
-- migration that defines the function. SECURITY INVOKER, the grants and the
-- comment stay as they are (CREATE OR REPLACE keeps grants and comment).

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
  -- over all history up to the last bank row. The opening balances of each
  -- day are kept apart for the floor rule below.
  --
  -- A company whose ledger summaries are built (ledger_account_days_ready,
  -- 20261023093900) reads them: one row per 19xx account and day, the
  -- posted and reversed lines already summed, instead of every 19xx line of
  -- the history. The posted opening balances, which the summaries do not
  -- tell apart, come from the journal (a partial index on source_type holds
  -- them): a handful of verifikat. Whether a day holds a posted line
  -- (has_posted) is left NULL here and asked in candidates, only for the
  -- latest days. Any other company keeps the line read.
  ledger_days AS MATERIALIZED (
    SELECT
      u.account_number,
      u.entry_date,
      sum(u.net) AS net,
      NULL::boolean AS has_posted,
      sum(u.opening_entries) AS opening_entries,
      sum(u.opening_net) AS opening_net
    FROM (
      SELECT
        d.account_number,
        d.entry_date,
        d.debit - d.credit AS net,
        0 AS opening_entries,
        NULL::numeric AS opening_net
      FROM (SELECT max(b.last_day) AS last_day FROM bank b) span
      JOIN public.ledger_account_days d
        ON d.company_id = p_company_id
       AND d.entry_date <= span.last_day
       AND d.account_number >= '1900'
       AND d.account_number < '2000'
       AND d.account_number ~ '^19[0-9]{2}$'
      UNION ALL
      SELECT
        jel.account_number,
        je.entry_date,
        0,
        count(DISTINCT je.id),
        sum(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0))
      FROM (SELECT max(b.last_day) AS last_day FROM bank b) span
      JOIN public.journal_entries je
        ON je.company_id = p_company_id
       AND je.entry_date <= span.last_day
       AND je.status = 'posted'
       AND je.source_type = 'opening_balance'
      JOIN public.journal_entry_lines jel
        ON jel.journal_entry_id = je.id
       AND jel.account_number >= '1900'
       AND jel.account_number < '2000'
       AND jel.account_number ~ '^19[0-9]{2}$'
      GROUP BY jel.account_number, je.entry_date
    ) u
    WHERE public.ledger_account_days_ready(p_company_id)
    GROUP BY u.account_number, u.entry_date
    UNION ALL
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
    WHERE NOT public.ledger_account_days_ready(p_company_id)
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
      -- The latest day a posted line moved the account. A summary day mixes
      -- posted and reversed lines, so for those the journal is asked, newest
      -- day first, until one has a posted line on the account: usually the
      -- first one asked.
      (
        SELECT p.entry_date
        FROM (
          SELECT d.entry_date, d.has_posted
          FROM ledger_days d
          WHERE d.account_number = g.account_number
            AND d.entry_date <= b.last_day
          ORDER BY d.entry_date DESC
          OFFSET 0
        ) p
        WHERE COALESCE(p.has_posted, EXISTS (
          SELECT 1
          FROM public.journal_entries je
          JOIN public.journal_entry_lines jel
            ON jel.journal_entry_id = je.id
           AND jel.account_number = g.account_number
          WHERE je.company_id = p_company_id
            AND je.entry_date = p.entry_date
            AND je.status = 'posted'
        ))
        LIMIT 1
      )
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
