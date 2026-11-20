-- relink_stranded_transactions records why it relinks a bank row (link
-- basis, src/lib/links/link-basis.ts).
-- pg-test: tests/pg/link-basis-sql-writers.pg.test.ts
--
-- The function pairs a stranded bank row with the one free 19xx line of the
-- same signed amount, date and ledger account (or a balanced group, when
-- asked), and nobody chooses the pair: the rule does. The pointer it writes
-- records rule_amount_date, the basis linkBasisForReconciliationMethod gives
-- the 'auto_exact' method it already sets, with the rule it applied as
-- evidence: rule_id auto_exact_unique or auto_exact_balanced_group, the same
-- names its processing_history row carries. A rule basis does not depend on
-- who started the run, so public.resolve_link_basis (20261016180100) returns
-- it as named.
--
-- What does not change: the signature, SECURITY INVOKER, search_path, owner,
-- grants (service_role only) and comment (CREATE OR REPLACE keeps them), the
-- selection, the locks, the dry-run default and the processing_history
-- record. The body below is the newest definition,
-- 20261012100100_restate_patched_functions, copied byte for byte; the only
-- edit is the two columns added to the transactions update.

CREATE OR REPLACE FUNCTION public.relink_stranded_transactions(p_company_id uuid, p_dry_run boolean DEFAULT true, p_pair_balanced_groups boolean DEFAULT false, p_actor jsonb DEFAULT NULL::jsonb, p_correlation_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(transaction_id uuid, transaction_date date, amount numeric, currency text, ledger_account text, lock_state text, competing_rows integer, candidate_lines integer, outcome text, journal_entry_id uuid, selected boolean, relinked boolean)
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
-- The result columns share names with table columns (amount, currency,
-- journal_entry_id, ...); inside the query a bare name always means the column.
#variable_conflict use_column
DECLARE
  v_correlation_id uuid := COALESCE(p_correlation_id, gen_random_uuid());
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'relink_stranded_transactions: p_company_id is required, this never runs across companies'
      USING ERRCODE = '22023';
  END IF;
  IF NOT p_dry_run AND (
       p_actor IS NULL
       OR jsonb_typeof(p_actor) <> 'object'
       OR COALESCE(p_actor->>'type', '') = ''
       OR COALESCE(p_actor->>'id', '') = '') THEN
    RAISE EXCEPTION 'relink_stranded_transactions: p_actor {type, id} is required for a write'
      USING ERRCODE = '22023';
  END IF;

  IF NOT p_dry_run THEN
    PERFORM public.lock_cash_account_company(p_company_id);
  END IF;

  RETURN QUERY
  WITH primary_account AS (
    SELECT ca.ledger_account
    FROM public.cash_accounts ca
    WHERE ca.company_id = p_company_id AND ca.is_primary
    LIMIT 1
  ),
  -- Every bank row that still needs a verifikat, stranded or not: an open row
  -- with the same key competes for the same line and makes the pairing a guess.
  unbooked AS (
    SELECT
      t.id,
      t.date,
      t.amount,
      t.currency,
      t.category,
      t.reconciliation_method,
      (t.is_business IS TRUE) AS is_stranded,
      -- Same attribution as the unattended sweep: a row with no cash account
      -- belongs to the primary account; a company with none reconciles on 1930.
      COALESCE(ca.ledger_account, (SELECT pa.ledger_account FROM primary_account pa), '1930') AS ledger_account,
      (t.currency = 'SEK' AND COALESCE(ca.currency, 'SEK') = 'SEK') AS is_sek
    FROM public.transactions t
    LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id AND ca.company_id = t.company_id
    WHERE t.company_id = p_company_id
      AND t.is_ignored = false
      AND t.journal_entry_id IS NULL
      AND NOT public.is_transaction_booked(t.id)
  ),
  -- The matcher's candidate set (get_unlinked_gl_lines), for every 19xx account.
  free_lines AS (
    SELECT
      jel.id AS line_id,
      je.id AS entry_id,
      jel.account_number,
      je.entry_date,
      je.voucher_series,
      je.voucher_number,
      round(jel.debit_amount - jel.credit_amount, 2) AS signed_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.source_type IS DISTINCT FROM 'opening_balance'
      AND je.source_type IS DISTINCT FROM 'storno'
      AND je.source_type IS DISTINCT FROM 'correction'
      AND jel.account_number LIKE '19%'
      AND round(jel.debit_amount - jel.credit_amount, 2) <> 0
      AND NOT EXISTS (
        SELECT 1 FROM public.transactions lt
        WHERE lt.journal_entry_id = je.id AND lt.company_id = p_company_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.transaction_voucher_links l
        WHERE l.journal_entry_id = je.id AND l.company_id = p_company_id)
  ),
  ranked_rows AS (
    SELECT u.*,
      count(*) OVER w AS competing_rows,
      bool_and(u.is_stranded) OVER w AS all_stranded,
      row_number() OVER (PARTITION BY u.ledger_account, u.date, round(u.amount, 2) ORDER BY u.id) AS pair_no
    FROM unbooked u
    WINDOW w AS (PARTITION BY u.ledger_account, u.date, round(u.amount, 2))
  ),
  ranked_lines AS (
    SELECT f.*,
      count(*) OVER (PARTITION BY f.account_number, f.entry_date, f.signed_amount) AS candidate_lines,
      row_number() OVER (PARTITION BY f.account_number, f.entry_date, f.signed_amount
        ORDER BY f.voucher_series, f.voucher_number, f.line_id) AS pair_no
    FROM free_lines f
  ),
  line_counts AS (
    SELECT DISTINCT f.account_number, f.entry_date, f.signed_amount, f.candidate_lines
    FROM ranked_lines f
  ),
  judged AS (
    SELECT
      r.id,
      r.date,
      r.amount,
      r.currency,
      r.category,
      r.reconciliation_method,
      r.ledger_account,
      r.competing_rows::integer AS competing_rows,
      COALESCE(lc.candidate_lines, 0)::integer AS candidate_lines,
      CASE
        WHEN NOT r.is_sek THEN 'unsupported_currency'
        WHEN COALESCE(lc.candidate_lines, 0) = 0 THEN 'no_counterpart'
        WHEN r.competing_rows = 1 AND lc.candidate_lines = 1 THEN 'unique'
        WHEN r.competing_rows = lc.candidate_lines AND r.all_stranded THEN 'balanced_group'
        ELSE 'ambiguous'
      END AS outcome,
      r.pair_no
    FROM ranked_rows r
    LEFT JOIN line_counts lc
      ON lc.account_number = r.ledger_account
     AND lc.entry_date = r.date
     AND lc.signed_amount = round(r.amount, 2)
    WHERE r.is_stranded
  ),
  paired AS (
    SELECT j.*,
      CASE WHEN j.outcome IN ('unique', 'balanced_group') THEN rl.entry_id END AS entry_id,
      (j.outcome = 'unique' OR (j.outcome = 'balanced_group' AND p_pair_balanced_groups)) AS selected,
      CASE
        WHEN cs.bookkeeping_locked_through IS NOT NULL
             AND j.date <= cs.bookkeeping_locked_through THEN 'company_lock_date'
        WHEN fp.id IS NULL THEN 'no_period'
        WHEN fp.is_closed THEN 'closed'
        WHEN fp.locked_at IS NOT NULL THEN 'locked'
        ELSE 'open'
      END AS lock_state
    FROM judged j
    LEFT JOIN ranked_lines rl
      ON rl.account_number = j.ledger_account
     AND rl.entry_date = j.date
     AND rl.signed_amount = round(j.amount, 2)
     AND rl.pair_no = j.pair_no
    LEFT JOIN public.company_settings cs ON cs.company_id = p_company_id
    LEFT JOIN LATERAL (
      SELECT p.id, p.is_closed, p.locked_at
      FROM public.fiscal_periods p
      WHERE p.company_id = p_company_id
        AND p.period_start <= j.date
        AND p.period_end >= j.date
      ORDER BY p.period_start DESC
      LIMIT 1
    ) fp ON true
  ),
  updated AS (
    UPDATE public.transactions t
    SET journal_entry_id = g.entry_id,
        reconciliation_method = 'auto_exact',
        link_basis = public.resolve_link_basis('rule_amount_date'),
        link_evidence = jsonb_build_object('rule_id',
          CASE g.outcome WHEN 'unique' THEN 'auto_exact_unique' ELSE 'auto_exact_balanced_group' END),
        updated_at = now()
    FROM paired g
    WHERE NOT p_dry_run
      AND g.selected
      AND g.entry_id IS NOT NULL
      AND t.id = g.id
      AND t.company_id = p_company_id
      -- Re-asserted inside the write: a row that was booked, released or
      -- ignored between the scan and the update is left exactly as it is.
      AND t.is_business = true
      AND t.is_ignored = false
      AND t.journal_entry_id IS NULL
      AND NOT public.is_transaction_booked(t.id)
    RETURNING t.id
  ),
  logged AS (
    INSERT INTO public.processing_history
      (company_id, correlation_id, aggregate_type, aggregate_id, event_type,
       payload, actor, occurred_at)
    SELECT
      p_company_id,
      v_correlation_id,
      'BankTransaction',
      g.id,
      'BankTransactionStrandedRelinked',
      jsonb_build_object(
        'issue', 2835,
        'rule', CASE g.outcome WHEN 'unique' THEN 'auto_exact_unique' ELSE 'auto_exact_balanced_group' END,
        'lock_state', g.lock_state,
        'previous', jsonb_build_object(
          'journal_entry_id', NULL,
          'reconciliation_method', g.reconciliation_method
        ),
        'after', jsonb_build_object(
          'journal_entry_id', g.entry_id,
          'reconciliation_method', 'auto_exact'
        )
      ),
      p_actor,
      now()
    FROM paired g
    JOIN updated u ON u.id = g.id
    RETURNING aggregate_id
  )
  SELECT
    g.id,
    g.date,
    g.amount,
    g.currency,
    g.ledger_account,
    g.lock_state,
    g.competing_rows,
    g.candidate_lines,
    g.outcome,
    g.entry_id,
    g.selected,
    (u.id IS NOT NULL) AS relinked
  FROM paired g
  LEFT JOIN updated u ON u.id = g.id
  ORDER BY g.date, g.id;
END;
$function$
;
