-- Issue #2057: one-shot, re-runnable repair for bank rows that were marked as
-- business before #1990 (categorize fails closed, 2026-08-27) but never got a
-- verifikat. Shape: is_business = true, journal_entry_id IS NULL,
-- is_ignored = false and no anchor in any of the three booking locations
-- (transactions.journal_entry_id, invoice_payments /
-- supplier_invoice_payments, transaction_voucher_links). The canonical
-- "att bokfora" predicate is is_business IS NULL AND is_ignored = false
-- (lib/worklist/categories.ts), so these rows are unbooked AND invisible:
-- silent missing lopande bokforing (BFL 5 kap 2 §).
--
-- The repair resets exactly the triple the engine's storno path resets
-- (lib/bookkeeping/engine.ts reverseEntry: is_business, category,
-- reconciliation_method) so the row returns to "Att bokfora" whole. It never
-- touches journal entries, never creates one, and leaves is_ignored alone.
--
-- Why an RPC and not a script-side UPDATE: PostgREST cannot express the
-- three NOT EXISTS legs inside an UPDATE's WHERE, so a script that selects
-- ids and then updates by id could clobber a row that was booked in between.
-- Here the UPDATE re-asserts the full predicate (via is_transaction_booked)
-- in the same statement, and the behandlingshistorik rows land in the same
-- transaction (BFL 5 kap 11 §: a bulk change to processing is logged, one
-- BankTransactionStrandedRepaired event per row, ids only).
--
-- Callable by service_role only: this is an operator repair driven by
-- scripts/repair-stranded-categorized-transactions.ts, never by a user
-- session, an API key or a loop. Dry run by default; a write requires a
-- single company id and an actor, so no call can reset the whole database.
-- Rows dated in a locked or closed period, or behind the company lock date,
-- are listed but left alone unless p_skip_locked is passed as false: a row
-- returned to Att bokfora there cannot be booked in place (BFL 5 kap 5 §
-- keeps closed periods on the rattelse track), so reopening it for triage
-- is an explicit operator choice, not the default.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('BankTransactionStrandedRepaired')
ON CONFLICT (event_type) DO NOTHING;

CREATE OR REPLACE FUNCTION public.repair_stranded_transactions(
  p_company_id uuid DEFAULT NULL,
  p_dry_run boolean DEFAULT true,
  p_skip_locked boolean DEFAULT true,
  p_actor jsonb DEFAULT NULL,
  p_correlation_id uuid DEFAULT NULL
)
RETURNS TABLE (
  transaction_id uuid,
  company_id uuid,
  is_sandbox boolean,
  transaction_date date,
  amount numeric,
  currency text,
  previous_category text,
  lock_state text,
  repaired boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_correlation_id uuid := COALESCE(p_correlation_id, gen_random_uuid());
BEGIN
  IF NOT p_dry_run THEN
    IF p_company_id IS NULL THEN
      RAISE EXCEPTION 'repair_stranded_transactions: p_company_id is required for a write'
        USING ERRCODE = '22023';
    END IF;
    IF p_actor IS NULL
       OR jsonb_typeof(p_actor) <> 'object'
       OR COALESCE(p_actor->>'type', '') = ''
       OR COALESCE(p_actor->>'id', '') = '' THEN
      RAISE EXCEPTION 'repair_stranded_transactions: p_actor {type, id} is required for a write'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      t.id,
      t.company_id,
      COALESCE(cs.is_sandbox, false) AS is_sandbox,
      t.date,
      t.amount,
      t.currency,
      t.category,
      t.reconciliation_method,
      CASE
        WHEN cs.bookkeeping_locked_through IS NOT NULL
             AND t.date <= cs.bookkeeping_locked_through THEN 'company_lock_date'
        WHEN fp.id IS NULL THEN 'no_period'
        WHEN fp.is_closed THEN 'closed'
        WHEN fp.locked_at IS NOT NULL THEN 'locked'
        ELSE 'open'
      END AS lock_state
    FROM public.transactions t
    LEFT JOIN public.company_settings cs ON cs.company_id = t.company_id
    LEFT JOIN LATERAL (
      SELECT p.id, p.is_closed, p.locked_at
      FROM public.fiscal_periods p
      WHERE p.company_id = t.company_id
        AND p.period_start <= t.date
        AND p.period_end >= t.date
      ORDER BY p.period_start DESC
      LIMIT 1
    ) fp ON true
    WHERE (p_company_id IS NULL OR t.company_id = p_company_id)
      AND t.is_business = true
      AND t.is_ignored = false
      AND t.journal_entry_id IS NULL
      AND NOT public.is_transaction_booked(t.id)
  ),
  targets AS (
    SELECT c.*
    FROM candidates c
    WHERE NOT p_dry_run
      AND (NOT p_skip_locked OR c.lock_state = 'open')
  ),
  updated AS (
    UPDATE public.transactions t
    SET is_business = NULL,
        category = NULL,
        reconciliation_method = NULL,
        updated_at = now()
    FROM targets g
    WHERE t.id = g.id
      -- Re-asserted inside the write: a row booked between the scan and the
      -- update keeps its booking.
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
      g.company_id,
      v_correlation_id,
      'BankTransaction',
      g.id,
      'BankTransactionStrandedRepaired',
      jsonb_build_object(
        'issue', 2057,
        'lock_state', g.lock_state,
        'previous', jsonb_build_object(
          'is_business', true,
          'category', g.category,
          'reconciliation_method', g.reconciliation_method
        ),
        'after', jsonb_build_object(
          'is_business', NULL,
          'category', NULL,
          'reconciliation_method', NULL
        )
      ),
      p_actor,
      now()
    FROM targets g
    JOIN updated u ON u.id = g.id
    RETURNING aggregate_id
  )
  SELECT
    c.id,
    c.company_id,
    c.is_sandbox,
    c.date,
    c.amount,
    c.currency,
    c.category,
    c.lock_state,
    (u.id IS NOT NULL) AS repaired
  FROM candidates c
  LEFT JOIN updated u ON u.id = c.id
  ORDER BY c.company_id, c.date, c.id;
END;
$$;

COMMENT ON FUNCTION public.repair_stranded_transactions(uuid, boolean, boolean, jsonb, uuid) IS
  'Issue #2057. Lists (dry run, default) or repairs, per company, bank rows stranded as is_business = true with no verifikat anchor, resetting is_business/category/reconciliation_method to NULL so they return to Att bokfora, and logs one BankTransactionStrandedRepaired event per row. Rows in locked or closed periods are skipped unless p_skip_locked = false. service_role only; a write requires p_company_id and p_actor.';

REVOKE ALL ON FUNCTION public.repair_stranded_transactions(uuid, boolean, boolean, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repair_stranded_transactions(uuid, boolean, boolean, jsonb, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
