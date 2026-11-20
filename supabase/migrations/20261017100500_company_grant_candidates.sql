-- The grant suggestion: "Samma motpart bokad på samma sätt N gånger:
-- godkänn automatiskt nästa gång, upp till X kr?"
--
-- 1. company_grant_candidate(company, transaction, min_count): the input of
--    the grant-suggestion detector (src/lib/suggestions/detectors/
--    grant-candidate.ts, behind GRANT_SUGGESTIONS, default off). For the
--    counterparty of the bank line just booked, it reads the company's latest
--    min_count staged categorizations of that counterparty a person approved
--    (committed categorize_transaction operations, never one a grant let
--    through) whose verifikat is still posted and touches exactly the accounts
--    the operation showed. It answers a candidate only when all of them carry
--    the identical booking pattern (categorize_operation_pattern, without the
--    amount), none asked for anything a grant never covers (a duplicate
--    override, a VAT amount, dimensions), the counterparty has an identity,
--    the company has no active grant for it and grants are not paused. The
--    evidence (how many, the largest amount, the last date) rides along for
--    the proposal and the grant's evidence column. service_role only.
--
-- 2. The suggestion decision trigger (20261016200600) also follows
--    create_grant, so "Inte nu" and "Visa aldrig" on a grant suggestion are
--    remembered like on a package switch. CREATE OR REPLACE TRIGGER: one
--    statement, the trigger is never absent.
--
-- pg-test: tests/pg/company-grants.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. company_grant_candidate
-- =============================================================================

CREATE FUNCTION public.company_grant_candidate(
  p_company_id uuid,
  p_transaction_id uuid,
  p_min_count integer DEFAULT 5,
  p_window_months integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx public.transactions;
  v_key text;
  v_count integer;
  v_distinct integer;
  v_unfit integer;
  v_pattern jsonb;
  v_max numeric;
  v_last date;
  v_label text;
  v_min integer := greatest(coalesce(p_min_count, 5), 2);
BEGIN
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_transaction_id AND company_id = p_company_id;
  IF v_tx.id IS NULL THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'transaction_not_found');
  END IF;
  v_key := public.grant_counterparty_key(v_tx.merchant_name, v_tx.original_description, v_tx.description);
  IF v_key = '' THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'unknown_counterparty');
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_grant_settings s WHERE s.company_id = p_company_id AND s.paused) THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'paused');
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_grants g
              WHERE g.company_id = p_company_id AND g.operation_type = 'categorize_transaction'
                AND g.counterparty_key = v_key AND g.revoked_at IS NULL) THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'has_grant');
  END IF;

  WITH booked AS (
    SELECT po.params, po.created_at, t.date,
           coalesce(nullif(btrim(t.merchant_name), ''), nullif(btrim(t.original_description), ''), t.description) AS label,
           public.categorize_operation_pattern(po.params, po.preview_data, t.amount) AS pattern,
           (SELECT array_agg(DISTINCT l.account_number ORDER BY l.account_number)
              FROM public.journal_entry_lines l WHERE l.journal_entry_id = je.id) AS posted_accounts
      FROM public.pending_operations po
      JOIN public.transactions t
        ON t.id = CASE WHEN po.params->>'transaction_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       THEN (po.params->>'transaction_id')::uuid END
       AND t.company_id = p_company_id
      JOIN public.journal_entries je
        ON je.id = t.journal_entry_id AND je.status = 'posted' AND je.committed_at >= po.created_at
     WHERE po.company_id = p_company_id
       AND po.operation_type = 'categorize_transaction'
       AND po.status IN ('committed', 'committing')
       AND po.created_at > now() - make_interval(months => greatest(coalesce(p_window_months, 12), 1))
       AND NOT EXISTS (SELECT 1 FROM public.company_grant_uses u WHERE u.pending_operation_id = po.id)
       AND public.grant_counterparty_key(t.merchant_name, t.original_description, t.description) = v_key
     ORDER BY po.created_at DESC
     LIMIT v_min
  ),
  judged AS (
    SELECT b.pattern - 'amount_sek' AS pattern,
           (b.pattern->>'amount_sek')::numeric AS amount_sek,
           b.date, b.label, b.created_at,
           b.pattern IS NOT NULL
             AND coalesce(jsonb_typeof(b.params->'vat_amount'), 'null') = 'null'
             AND b.params->'allow_duplicate' IS DISTINCT FROM 'true'::jsonb
             AND (coalesce(jsonb_typeof(b.params->'dimensions'), 'null') = 'null' OR b.params->'dimensions' = '{}'::jsonb)
             AND to_jsonb(b.posted_accounts) = b.pattern->'line_accounts' AS fit
      FROM booked b
  )
  SELECT count(*), count(DISTINCT pattern), count(*) FILTER (WHERE NOT fit), max(amount_sek), max(date),
         (array_agg(pattern ORDER BY created_at DESC))[1], (array_agg(label ORDER BY created_at DESC))[1]
    INTO v_count, v_distinct, v_unfit, v_max, v_last, v_pattern, v_label
    FROM judged;

  IF v_count < v_min THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'not_enough', 'booking_count', v_count);
  END IF;
  IF v_unfit > 0 OR v_distinct <> 1 THEN
    RETURN jsonb_build_object('candidate', false, 'reason', 'not_consistent', 'booking_count', v_count);
  END IF;

  RETURN jsonb_build_object(
    'candidate', true,
    'counterparty_key', v_key,
    'counterparty_label', left(coalesce(nullif(btrim(v_label), ''), v_key), 200),
    'pattern', v_pattern,
    'booking_count', v_count,
    'max_amount_sek', v_max,
    'last_booked', v_last
  );
END;
$$;

REVOKE ALL ON FUNCTION public.company_grant_candidate(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_grant_candidate(uuid, uuid, integer, integer) TO service_role;

-- =============================================================================
-- 2. The suggestion decision also follows create_grant
-- =============================================================================

CREATE OR REPLACE TRIGGER pending_operations_sync_suggestion
  AFTER UPDATE OF status ON public.pending_operations
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.operation_type IN ('enable_package', 'disable_package', 'create_grant'))
  EXECUTE FUNCTION public.sync_company_suggestion_decision();

NOTIFY pgrst, 'reload schema';
