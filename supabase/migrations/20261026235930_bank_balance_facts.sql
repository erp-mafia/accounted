-- get_bank_balance_facts: the bank's side of the balance check.
--
-- Why: the reconciliation page judges a bank account by its movements in a
-- window (get_bank_reconciliation_facts) and shows the balance the bank
-- reported beside them, never against the books. An account whose opening
-- balance never reached the books, or whose real payments were ignored, reads
-- "Banken och bokföringen stämmer" while its balance is off by the whole
-- amount. Prod 2026-10-26: 993 of 1,479 bank accounts differ from the bank's
-- own balance, 160 of them only by the opening balance or ignored rows, which
-- the movement verdict cannot see.
--
-- The balance check (lib/reconciliation/bank-balance-check.ts) compares the
-- balance the bank reported with the booked balance on the same day and
-- splits the difference. Its bank side needs, through that day: the first day
-- of the bank's history, the sum of the bank's rows, the rows without a
-- verifikat and the ignored rows. One read of the account's rows answers all
-- of them, where get_bank_reconciliation_facts also reads every candidate
-- verifikat line of its window.
--
-- Rows are scoped as get_bank_reconciliation_facts scopes them: the cash
-- account's own rows in its currency, and on the primary account the rows
-- that have no cash account. Ignored rows stay out of the sum and are counted
-- apart: a duplicate moved nothing, so the bank's balance holds it once. "No
-- verifikat" is lib/transactions/unbooked.ts's definition: not ignored, not
-- marked private, anchored to no verifikat (public.is_transaction_booked).
--
-- SECURITY INVOKER: RLS on transactions scopes the read to the caller's
-- companies, and the company is named as well.
-- pg-test: covered-by tests/pg/bank-balance-facts.pg.test.ts

CREATE FUNCTION public.get_bank_balance_facts(
  p_company_id uuid,
  p_cash_account_id uuid,
  p_include_unassigned boolean,
  p_currency text,
  p_through date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH scoped AS (
    SELECT
      t.date,
      t.amount,
      t.is_ignored,
      (
        NOT t.is_ignored
        AND t.is_business IS DISTINCT FROM false
        AND t.journal_entry_id IS NULL
        AND NOT public.is_transaction_booked(t.id)
      ) AS unbooked
    FROM public.transactions t
    WHERE t.company_id = p_company_id
      AND t.currency = p_currency
      AND (
        t.cash_account_id = p_cash_account_id
        OR (p_include_unassigned AND t.cash_account_id IS NULL)
      )
      AND t.date <= p_through
  )
  SELECT jsonb_build_object(
    'history_start', min(s.date) FILTER (WHERE NOT s.is_ignored),
    'rows_count', count(*) FILTER (WHERE NOT s.is_ignored),
    'rows_total', coalesce(sum(s.amount) FILTER (WHERE NOT s.is_ignored), 0),
    'unbooked_count', count(*) FILTER (WHERE s.unbooked),
    'unbooked_total', coalesce(sum(s.amount) FILTER (WHERE s.unbooked), 0),
    'ignored_count', count(*) FILTER (WHERE s.is_ignored),
    'ignored_total', coalesce(sum(s.amount) FILTER (WHERE s.is_ignored), 0)
  )
  FROM scoped s;
$$;

COMMENT ON FUNCTION public.get_bank_balance_facts(uuid, uuid, boolean, text, date) IS
  'The bank side of the balance check through p_through: first day of the bank''s history, sum of the non-ignored rows, rows without a verifikat and ignored rows, scoped like get_bank_reconciliation_facts.';

REVOKE EXECUTE ON FUNCTION public.get_bank_balance_facts(uuid, uuid, boolean, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bank_balance_facts(uuid, uuid, boolean, text, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
