-- Which 19xx ledger account the books say a connected bank account belongs on
-- (crm#1066).
--
-- What happened. A bank account gets its ledger account from a fixed rule when
-- the bank is connected: the currency default (SEK on 1930), then the next
-- free 1931 to 1959 slot (lib/cash-accounts/ledger-slots.ts). The rule never
-- reads the books. A company that moved in with imported bookkeeping already
-- books each bank account on a 19xx account of its own choosing (a PlusGiro
-- account on 1920, a second account on 1940), so the connected account can
-- land on another number. The sweep that links bank rows to the imported
-- verifikat is scoped to the cash account's ledger account and then finds
-- nothing: hundreds of bank rows read as unbooked although their bookkeeping
-- exists.
--
-- What this adds. Two read-only functions. They decide nothing and write
-- nothing: lib/cash-accounts/ledger-evidence.ts turns the evidence into a
-- suggestion, and a change still goes through save_bank_account_selection,
-- the one writer of cash_accounts.ledger_account.
--
-- 1. cash_account_ledger_evidence(company): what the books say, for every
--    enabled cash account a bank connection syncs onto. Two kinds of row.
--
--    'transactions'  hits = the account's unbooked, not ignored bank rows
--      that have a posted verifikat on the same date with a line on
--      ledger_account for the same signed amount (money in is a debit on the
--      bank account). This is the exact tier of the verifikat matcher
--      (lib/reconciliation/bank-reconciliation.ts), opening balances and
--      stornos left out as there, but read across every 19xx account instead
--      of the mapped one. A row counts once per ledger account. The amount
--      is compared in the cash account's own currency by the rule of
--      lib/bookkeeping/ledger-line-amount.ts: SEK is debit minus credit; a
--      foreign account reads amount_in_currency of a line labelled with that
--      currency, signed by the side it is booked on, and nothing else.
--
--    'balance'  the bank's balance, rolled back to the end of balance_date,
--      equals the ledger balance of ledger_account on that date to the ore.
--      It answers the case with no overlap at all: books imported up to a
--      year end and a bank feed that starts the day after.
--        Bank side: cash_accounts.balance (the booked balance the sync
--        stores) minus every bank row of the account dated after the day:
--        booked, unbooked and ignored alike, because each moved the balance.
--        Ledger side: the product's own balance of an account on a day,
--        lib/reconciliation/gl-balance.ts (findOpeningBalanceFloor and
--        sumAccountBalance): posted and reversed lines from the account's
--        opening-balance floor (that day included, so the opening balance
--        itself counts) through the day, and over all history when the
--        account has no floor. The floor is the latest day on or before the
--        day that is the first day of a fiscal year and holds a posted
--        opening_balance verifikat with a line on the account. An opening
--        balance restates every earlier year, so a sum across it would count
--        those years twice. Two or more opening balances on one day that
--        cancel on the account are no floor (a duplicated import and the
--        entry that undoes it), and an opening_balance verifikat dated inside
--        a year is an ordinary entry. A company imported as several years
--        with one opening balance at the start therefore reads from that
--        start; one with an opening balance every year reads from the
--        latest.
--      Three days are tried per account and ledger account: the day before
--      the account's first bank row, the day of that row, and the latest day
--      with a posted line on the ledger account on or before the account's
--      last bank row. The earliest day that matches is returned: with books
--      that end before the feed starts, that is the last booked day. Equal
--      to the ore or nothing, and never a zero balance. SEK accounts only,
--      with a stored balance and every bank row in SEK: a foreign balance
--      cannot be read off the SEK ledger columns. A feed with a gap, a
--      balance older than the newest rows or a duplicate row makes the two
--      sides differ, which reads as no evidence.
--
-- 2. cash_account_booked_rows(company, cash account): how many of the
--    account's bank rows are linked to a verifikat with a line on the
--    account's current ledger account. A change of ledger account leaves
--    those verifikat where they are, so a suggestion says how many there
--    are. Asked only for an account that gets a suggestion.
--
-- SECURITY INVOKER: RLS on cash_accounts, transactions, journal_entries,
-- journal_entry_lines and fiscal_periods applies as on the PostgREST path, so
-- a caller outside the company gets no rows. The explicit company_id
-- predicates are defence in depth for service-role callers.
--
-- Cost. Nothing is read for a company with no connected cash account.
-- Otherwise the bank rows of the connected accounts are read once. The
-- transactions kind then reads the verifikat of the days that have unbooked
-- bank rows, one index range per account and day
-- (idx_journal_entries_company_posted_date_id). The balance kind reads the
-- 19xx lines of the company's whole history up to the last bank row, once,
-- through the same index, and only when a SEK account with a stored balance
-- has bank rows. It cannot start later: an account without an opening
-- balance has its whole history as its balance, and whether such an account
-- has lines before any given day is only known by reading them. Every join
-- onto the journal is written as a lateral index lookup on purpose. The
-- planner estimates "this company and this cash account" as about one row
-- (it multiplies the two selectivities), and with a plain join it then loops
-- over the whole ledger once per bank row. Measured on a test database with
-- 3 000 bank rows: against 60 000 verifikat over 20 seconds that way and
-- about 0.15 seconds as written (0.4 through RLS); against 300 000 verifikat
-- with one opening balance at the start about 0.6 seconds (1.2 to 2 through
-- RLS, where the policy on journal_entry_lines is checked per line).

CREATE FUNCTION public.cash_account_ledger_evidence(p_company_id uuid)
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

REVOKE ALL ON FUNCTION public.cash_account_ledger_evidence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_account_ledger_evidence(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.cash_account_ledger_evidence(uuid) IS
  'Read-only evidence for which 19xx ledger account a connected bank account belongs on (crm#1066): transactions (unbooked bank rows matching a posted line by date and signed amount, per ledger account) and balance (the rolled-back bank balance equals the ledger balance on balance_date to the ore). Decided in lib/cash-accounts/ledger-evidence.ts; never writes.';

CREATE FUNCTION public.cash_account_booked_rows(p_company_id uuid, p_cash_account_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT count(*)::integer
  FROM public.cash_accounts ca
  JOIN public.transactions t
    ON t.company_id = ca.company_id
   AND t.cash_account_id = ca.id
   AND t.journal_entry_id IS NOT NULL
  WHERE ca.company_id = p_company_id
    AND ca.id = p_cash_account_id
    AND EXISTS (
      SELECT 1
      FROM public.journal_entries je
      JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.id = t.journal_entry_id
        AND je.company_id = p_company_id
        AND jel.account_number = ca.ledger_account
    );
$$;

REVOKE ALL ON FUNCTION public.cash_account_booked_rows(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_account_booked_rows(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.cash_account_booked_rows(uuid, uuid) IS
  'How many of a cash account''s bank rows are linked to a verifikat with a line on its current ledger account: the verifikat a change of ledger account leaves where they are (crm#1066). Read-only.';

NOTIFY pgrst, 'reload schema';
