-- cash_account_ledger_evidence: a verifikat a bank row is already linked to
-- is no evidence.
--
-- What happened. The 'transactions' kind counts a connected account's open
-- bank rows that have a posted verifikat on the same day with a 19xx line
-- for the same signed amount, and says it is the exact tier of the
-- verifikat matcher. The matcher links only a verifikat no bank row is
-- linked to: bank_account_unlinked_lines leaves out every verifikat a
-- transactions.journal_entry_id points at, and every one with a
-- transaction_voucher_links row but a part payment's open rest, which
-- runReconciliation (lib/reconciliation/bank-reconciliation.ts) never
-- links either. This function did not ask. A bank movement delivered twice leaves one copy
-- booked and one open, and the open copy then matched its twin's verifikat.
-- When the account had booked on one ledger account for a while and was
-- later moved to another on purpose, every such twin pointed back at the
-- old account, and the bank page kept suggesting the move back, with
-- nothing the matcher could ever link.
--
-- What changes. The verifikat read for the 'transactions' kind leaves out
-- a verifikat a bank row is linked to, by its pointer or through
-- transaction_voucher_links, as the matcher does. Both lookups are indexed
-- (idx_transactions_journal_entry_id,
-- idx_transaction_voucher_links_journal_entry_id) and run only for the
-- verifikat of a day that has open bank rows. The 'balance' kind is
-- unchanged.
--
-- Everything else in the body is copied from 20261031110900, the latest
-- migration that defines the function. SECURITY INVOKER, the grants and the
-- comment stay as they are (CREATE OR REPLACE keeps grants and comment).
--
-- pg-test: tests/pg/cash-account-ledger-evidence.pg.test.ts

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
          -- A verifikat a bank row is already linked to, by its pointer or
          -- through transaction_voucher_links, is no candidate for another
          -- row: the matcher's own rule (bank_account_unlinked_lines and
          -- runReconciliation). Its
          -- twin row, the same bank movement delivered twice, says nothing
          -- about where the account belongs.
          AND NOT EXISTS (
            SELECT 1
            FROM public.transactions linked
            WHERE linked.journal_entry_id = je.id
              AND linked.company_id = p_company_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.transaction_voucher_links l
            WHERE l.journal_entry_id = je.id
              AND l.company_id = p_company_id
          )
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
