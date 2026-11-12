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
--   bank rows. Production, read-only as a member: 1 071 rows took 1 532 ms and
--   993 725 buffers; the company with the most rows (4 657) did not finish in
--   15 s, and the authenticated limit is 8 s. Six companies are past that
--   limit today, 38 pay 1.5 s or more per call, and 199 have 300 rows or more.
--   lib/reconciliation/service.ts catches the error, so for those companies
--   the bank balance check silently goes missing. 205 642 calls since
--   2026-09-11 (a cancelled call is never counted).
--
--   cash_account_booked_rows: EXISTS (anchored x JOIN journal_entry_lines)
--   per bank row. The planner joined every anchor to its lines first and
--   filtered on the row afterwards, once per row: rows x anchors line probes.
--   1 071 rows with 181 anchors took 1 971 ms and 1 494 469 buffers. A company
--   with 2 000 booked rows is 4 million probes: it never answers.
--
-- The fix is the shape, not the plan mode: each function now reads its set
-- once into a MATERIALIZED CTE and tests membership through a hashed subplan
-- in the select list, which the planner cannot turn back into a join.
--   get_bank_balance_facts: the open rows' ids, once.
--   cash_account_booked_rows: the company's anchors, once; then one line
--   probe per anchor by (journal_entry_id, account_number), written as a
--   scalar subquery so it stays a probe by key. Written as a join it started
--   from every company's lines on that account number and ran past 12 s on
--   the same data (tested read-only on production before this was written).
-- Same body on production with a generic plan forced, as a member:
--   get_bank_balance_facts, 4 657 rows: 17 ms (was: over 15 s)
--   cash_account_booked_rows, 1 071 rows / 181 anchors: 83 ms (was 1 971 ms)
--   cash_account_booked_rows, 2 047 rows / 2 021 anchors: 60 ms warm
-- Results compared with the old functions on production: identical facts for
-- four argument sets, identical count. Cost is now linear in the company's
-- bank rows and anchors: ten times the largest is still well under a second.
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
