-- Issue #2835: bank rows released by a SIE re-import are never matched against
-- the re-imported verifikat.
--
-- A replacement SIE import stornos the old batch and releases the bank rows
-- that were matched to it (undo_sie_import_chunk), which is the honest state.
-- The new batch then posts the same bank events again on new verifikat, and
-- nothing runs the verifikat matcher over the period: the two unattended
-- sweeps that exist fire when BANK ROWS arrive into an imported period, never
-- when VERIFIKAT arrive into a period that already holds bank rows. The user
-- is left with "unbooked" rows whose bookkeeping exists, one click from a
-- double booking. SIE carries no bank transaction ids and no reskontra, so a
-- re-imported verifikat has no provenance to re-attach by: date, signed amount
-- and account are all there is, which is exactly what the matcher keys on.
--
-- Two things live here. Both are new objects; nothing existing is replaced.
--
-- 1. sie_imports.bank_sweep plus a claim/record pair. The matcher itself stays
--    in lib/reconciliation (one rule set, no SQL twin). It can only run AFTER
--    complete_sie_import_job, because guard_sie_held_bank_pointer refuses a
--    bank link to a batch that still holds its period, so it cannot be a phase
--    of the job. A post-step with no receipt is lost if the function dies
--    after completion; the receipt is what lets the every-minute worker cron
--    finish it. service_role cannot write sie_imports rows that carry a
--    job_state (guard_sie_execution_metadata), hence the two definer RPCs.
--
-- 2. relink_stranded_transactions: the one-off for rows stranded BEFORE
--    #2820 by the retired hard-delete replace (is_business = true, no anchor,
--    hidden from Att bokfora) whose bank event sits in the re-imported ledger.
--    Sibling of repair_stranded_transactions (20260906170107), which RELEASES
--    such rows; releasing these would invite the double booking, so this one
--    re-links instead. Dry run by default, one company per call, a write needs
--    an actor, service_role only, never run by a loop.
--
--    Rule: the matcher's auto_exact tier (same signed amount to the ore, same
--    date, the row's own cash account's ledger account, posted verifikat that
--    no bank row is linked to yet), and ONLY when the pairing is not a guess:
--      unique          one unbooked row and one unlinked line share the key
--      balanced_group  n rows and exactly n lines share the key, no other
--                      unbooked row competes. Every pairing gives the same
--                      reconciled state, but which verifikat a row lands on is
--                      arbitrary, so it is opt-in (p_pair_balanced_groups).
--      ambiguous       rows and lines differ in number: left for a human.
--      no_counterpart  the ledger holds no such line: a genuinely missing
--                      booking, which repair_stranded_transactions may release.
--    The link is a write on the transaction side only. No journal entry or
--    line is touched, so period locks do not apply (the matcher and manual
--    link behave the same way); lock_state is reported for information.
--    Every written row gets one BankTransactionStrandedRelinked event carrying
--    the correlation id and the previous state, so a run can be found and
--    reversed (journal_entry_id back to NULL, reconciliation_method back to
--    the logged value).

-- ------------------------------------------------------------------
-- 1. Post-import bank sweep receipt
-- ------------------------------------------------------------------

ALTER TABLE public.sie_imports ADD COLUMN bank_sweep jsonb;

COMMENT ON COLUMN public.sie_imports.bank_sweep IS
  'Receipt of the verifikat matcher run that follows a completed SIE import (issue #2835). NULL: not run. {state: running, started_at, attempt}: claimed. {state: done, ...SieSweepSummary}: finished. Written only by claim_sie_import_bank_sweep / record_sie_import_bank_sweep.';

CREATE FUNCTION public.claim_sie_import_bank_sweep(p_company_id uuid, p_import_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- A claim older than ten minutes is a dead function (max duration is five),
  -- so it may be taken over; five attempts bound a sweep that keeps dying.
  UPDATE public.sie_imports
    SET bank_sweep = jsonb_build_object(
      'state', 'running',
      'started_at', clock_timestamp(),
      'attempt', coalesce((bank_sweep->>'attempt')::integer, 0) + 1)
    WHERE id = p_import_id AND company_id = p_company_id
      AND job_state = 'completed' AND job_kind = 'import'
      AND (bank_sweep IS NULL OR (
        bank_sweep->>'state' = 'running'
        AND (bank_sweep->>'started_at')::timestamptz < clock_timestamp() - interval '10 minutes'
        AND coalesce((bank_sweep->>'attempt')::integer, 0) < 5));
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_sie_import_bank_sweep(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sie_import_bank_sweep(uuid, uuid) TO service_role;

CREATE FUNCTION public.record_sie_import_bank_sweep(p_company_id uuid, p_import_id uuid, p_summary jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_summary IS NULL OR jsonb_typeof(p_summary) <> 'object' THEN
    RAISE EXCEPTION 'record_sie_import_bank_sweep: p_summary must be a JSON object' USING ERRCODE = '22023';
  END IF;
  -- Only a claimed sweep can be recorded, and the receipt keeps its attempt.
  UPDATE public.sie_imports
    SET bank_sweep = p_summary || jsonb_build_object(
      'state', 'done',
      'attempt', coalesce((bank_sweep->>'attempt')::integer, 1))
    WHERE id = p_import_id AND company_id = p_company_id
      AND bank_sweep->>'state' = 'running';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.record_sie_import_bank_sweep(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sie_import_bank_sweep(uuid, uuid, jsonb) TO service_role;

-- ------------------------------------------------------------------
-- 2. One-off re-link for rows stranded before #2820
-- ------------------------------------------------------------------

INSERT INTO public.processing_event_types (event_type) VALUES
  ('BankTransactionStrandedRelinked')
ON CONFLICT (event_type) DO NOTHING;

CREATE FUNCTION public.relink_stranded_transactions(
  p_company_id uuid,
  p_dry_run boolean DEFAULT true,
  p_pair_balanced_groups boolean DEFAULT false,
  p_actor jsonb DEFAULT NULL,
  p_correlation_id uuid DEFAULT NULL
)
RETURNS TABLE (
  transaction_id uuid,
  transaction_date date,
  amount numeric,
  currency text,
  ledger_account text,
  lock_state text,
  competing_rows integer,
  candidate_lines integer,
  outcome text,
  journal_entry_id uuid,
  selected boolean,
  relinked boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
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
$$;

COMMENT ON FUNCTION public.relink_stranded_transactions(uuid, boolean, boolean, jsonb, uuid) IS
  'Issue #2835. Lists (dry run, default) or re-links, for ONE company, bank rows stranded as is_business = true with no verifikat anchor whose bank event sits on an unlinked posted 19xx line of the same signed amount and date. Links only a unique pairing, plus balanced n:n groups when p_pair_balanced_groups is true; everything else is reported and left alone. Writes transactions.journal_entry_id and reconciliation_method only, never a journal entry, and logs one BankTransactionStrandedRelinked event per row. service_role only; a write requires p_actor.';

REVOKE ALL ON FUNCTION public.relink_stranded_transactions(uuid, boolean, boolean, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relink_stranded_transactions(uuid, boolean, boolean, jsonb, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
