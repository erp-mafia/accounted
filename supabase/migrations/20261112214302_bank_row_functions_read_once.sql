-- get_bank_balance_facts and cash_account_booked_rows read the company's bank
-- rows once (2026-11-12).
--
-- Both are LANGUAGE sql with a SET clause: never inlined, and their body is
-- planned without the argument values (a generic plan), so the planner sizes
-- every join for an average company. For a join against a view or a CTE it
-- then picks a nested loop that runs the inner side again for every bank row:
--
--   get_bank_balance_facts: LEFT JOIN open_bank_rows o ON o.id = t.id. The
--   whole open_bank_rows view (two arms, four anchor tables, an anti join)
--   re-ran once per bank row of the cash account: quadratic in the company's
--   bank rows. With a few thousand rows on one cash account the call
--   passes the 8 s limit of the authenticated role and is cancelled.
--   lib/reconciliation/service.ts catches the error, so for such a
--   company the bank balance check silently goes missing. A cancelled
--   call is never counted in the statement statistics either, so the
--   companies that are hit hardest are the ones the statistics show
--   least.
--
--   cash_account_booked_rows: EXISTS (anchored x JOIN journal_entry_lines)
--   per bank row. The planner joined every anchor to its lines first and
--   filtered on the row afterwards, once per row: rows x anchors line probes.
--   The cost grows with the product, not the sum: a company with 2 000
--   booked rows is 4 million probes, and it never answers.
--
-- The fix is the shape, not the plan mode: each function now reads its set
-- once into a MATERIALIZED CTE and tests membership through a hashed subplan
-- in the select list, which the planner cannot turn back into a join.
--   get_bank_balance_facts: the open rows' ids, once.
--   cash_account_booked_rows: the company's anchors, once; then one line
--   probe per anchor by (journal_entry_id, account_number), written as a
--   scalar subquery so it stays a probe by key. Written as a join it started
--   from every company's lines on that account number, not from this
--   company's anchors, and was slower than the form it replaces.
--
-- With a generic plan forced, as the functions run, each call is now one
-- read of its set and one hash probe per bank row (get_bank_balance_facts)
-- or one line probe per anchor (cash_account_booked_rows): linear in the
-- company's bank rows and anchors, where it grew with their product.
--
-- The results equal the old functions': same facts, same count.
--
-- Signatures, return types, security (invoker) and grants are unchanged.

CREATE OR REPLACE FUNCTION public.get_bank_balance_facts(p_company_id uuid, p_cash_account_id uuid, p_include_unassigned boolean, p_currency text, p_through date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  WITH open_rows AS MATERIALIZED (
    SELECT o.id
    FROM public.open_bank_rows o
    WHERE o.company_id = p_company_id
  ),
  scoped AS (
    SELECT
      t.date,
      t.amount,
      t.is_ignored,
      -- In the select list on purpose: an uncorrelated IN here is a hashed
      -- subplan, built once. As a join it re-ran the view per row.
      (t.id IN (SELECT r.id FROM open_rows r)) AS unbooked
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
$function$;

CREATE OR REPLACE FUNCTION public.cash_account_booked_rows(p_company_id uuid, p_cash_account_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  WITH anchored AS MATERIALIZED (
    SELECT a.transaction_id, a.journal_entry_id
    FROM public.bank_row_anchors a
    WHERE a.company_id = p_company_id
  ),
  -- The bank rows whose live verifikat books on the cash account's ledger
  -- account. One probe per anchor; the scalar subquery keeps it a probe.
  booked AS MATERIALIZED (
    SELECT x.transaction_id
    FROM anchored x
    WHERE (
      SELECT true
      FROM public.journal_entry_lines jel
      WHERE jel.journal_entry_id = x.journal_entry_id
        AND jel.account_number = (
          SELECT ca.ledger_account
          FROM public.cash_accounts ca
          WHERE ca.company_id = p_company_id
            AND ca.id = p_cash_account_id
        )
      LIMIT 1
    )
  )
  SELECT (count(*) FILTER (WHERE t.id IN (SELECT b.transaction_id FROM booked b)))::integer
  FROM public.transactions t
  WHERE t.company_id = p_company_id
    AND t.cash_account_id = p_cash_account_id;
$function$;

NOTIFY pgrst, 'reload schema';
