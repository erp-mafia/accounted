-- Enforcement: a staged bank-line categorization commits without a person
-- only when it matches an active grant exactly. Everything here decides
-- "may this go through unattended"; the booking itself is the ordinary
-- approval path (commitPendingOperation, the engine, the triggers).
--
-- 1. categorize_operation_pattern(params, preview, amount): the booking
--    pattern of a staged categorize_transaction, read off what the approver
--    would be shown (the preview's exact lines, in SEK) and what the commit
--    runs (the params): direction, category, VAT treatment, reverse-charge
--    kind, the business account, every account the posting touches, and the
--    posting's total in SEK. NULL when it cannot be read exactly (no lines,
--    unbalanced lines, a missing account): then no grant can match.
--
-- 2. claim_company_grant(operation, api key): the one gate. Under a lock on
--    the operation and on the grant it answers matched with a claimed
--    company_grant_uses row, or a refusal reason, and changes nothing else.
--    It refuses, in this order, and every refusal leaves the operation
--    pending for a person exactly as before:
--      no_grant                    the company has no active grant (cheap, first)
--      operation_not_found / operation_not_pending / operation_type_not_granted
--      batch_staged                staged inside a cross-company batch
--      not_a_key_credential        staged by a person, the system or a cron
--      credential_mismatch         the key is not the one that staged it
--      paused                      the company's kill switch is on
--      credential_revoked          the key or its service account is gone
--      credential_not_live         a test-mode key
--      credential_not_member       the key's person no longer writes in the company
--      allow_duplicate             the agent overrode the duplicate guard
--      vat_amount_override         VAT that differs from rate x amount
--      dimensions                  tags the grant does not name
--      transaction_not_found / transaction_already_booked / transaction_already_claimed
--      unknown_counterparty        the bank text names no one (or only a rail)
--      pattern_unreadable          the preview cannot be read exactly
--      period_locked               no open, unlocked period covers the date,
--                                  or the company lock date covers it
--      no_grant_for_counterparty   no active grant for this counterparty
--      pattern_mismatch            direction, category, VAT, account or the
--                                  set of accounts differ in any way
--      credential_not_allowed      the grant names another key or account
--      above_limit                 the total exceeds the grant's limit
--      above_unattended_limit      the total exceeds the key's own unattended
--                                  ceiling (api_keys.unattended_commit_limit):
--                                  the stricter of the two wins
--      above_monthly_limit         this month's postings under the rule plus
--                                  this one exceed its monthly limit
--    service_role only.
--
-- 3. complete_company_grant_use / release_company_grant_use: the caller's
--    report after the commit. Completing records the verifikat and checks the
--    posted lines against the grant (pattern_verified); releasing frees the
--    claim when the commit refused, so the operation waits for a person and
--    the monthly limit does not count it. service_role only.
--
-- 4. list_company_grant_postings(company, only_unreviewed, limit): the
--    postings grants let through, newest first, with the rule and the
--    verifikat: what Att göra shows under "Bokfört enligt regel" and the
--    agent briefing lists. SECURITY INVOKER: a session reads it under RLS.
--
-- pg-test: tests/pg/company-grants.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. The booking pattern of a staged categorization
-- =============================================================================

CREATE FUNCTION public.categorize_operation_pattern(p_params jsonb, p_preview jsonb, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_direction text;
  v_account text;
  v_accounts text[];
  v_debit numeric := 0;
  v_credit numeric := 0;
  v_line jsonb;
  v_vat text;
  v_rc text;
BEGIN
  IF p_params IS NULL OR p_preview IS NULL OR p_amount IS NULL OR p_amount = 0 THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_preview->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_preview->'lines') < 2 THEN
    RETURN NULL;
  END IF;
  v_direction := CASE WHEN p_amount < 0 THEN 'out' ELSE 'in' END;
  v_account := CASE WHEN v_direction = 'out' THEN p_preview->>'debit_account' ELSE p_preview->>'credit_account' END;
  IF v_account IS NULL OR v_account !~ '^[0-9]{4}$' THEN
    RETURN NULL;
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_preview->'lines') LOOP
    IF coalesce(v_line->>'account_number', '') !~ '^[0-9]{4}$'
       OR jsonb_typeof(v_line->'debit_amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_line->'credit_amount') IS DISTINCT FROM 'number' THEN
      RETURN NULL;
    END IF;
    v_debit := v_debit + (v_line->>'debit_amount')::numeric;
    v_credit := v_credit + (v_line->>'credit_amount')::numeric;
  END LOOP;
  IF v_debit <= 0 OR round(v_debit, 2) <> round(v_credit, 2) THEN
    RETURN NULL;
  END IF;
  SELECT array_agg(DISTINCT l->>'account_number' ORDER BY l->>'account_number')
    INTO v_accounts
    FROM jsonb_array_elements(p_preview->'lines') AS l;
  IF NOT (v_account = ANY (v_accounts)) THEN
    RETURN NULL;
  END IF;
  v_vat := nullif(p_params->>'vat_treatment', '');
  v_rc := nullif(p_params->>'reverse_charge_kind', '');
  RETURN jsonb_build_object(
    'direction', v_direction,
    'category', p_params->>'category',
    'vat_treatment', v_vat,
    'reverse_charge_kind', v_rc,
    'account_number', v_account,
    'line_accounts', to_jsonb(v_accounts),
    'amount_sek', round(v_debit, 2)
  );
END;
$$;

-- =============================================================================
-- 2. claim_company_grant
-- =============================================================================

-- Whether an open, unlocked fiscal period covers the date and the company
-- lock date does not: the same two layers the enforcement triggers check.
-- No covering period counts as not open (the engine would create one; a
-- grant leaves that to a person).
CREATE FUNCTION public.grant_period_open(p_company_id uuid, p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.fiscal_periods fp
            WHERE fp.company_id = p_company_id
              AND p_date BETWEEN fp.period_start AND fp.period_end
              AND NOT coalesce(fp.is_closed, false)
              AND fp.locked_at IS NULL)
     AND NOT EXISTS (
           SELECT 1 FROM public.company_settings cs
            WHERE cs.company_id = p_company_id
              AND cs.bookkeeping_locked_through IS NOT NULL
              AND p_date <= cs.bookkeeping_locked_through);
$$;

REVOKE ALL ON FUNCTION public.grant_period_open(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_period_open(uuid, date) TO service_role;

CREATE FUNCTION public.claim_company_grant(p_pending_operation_id uuid, p_api_key_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op public.pending_operations;
  v_key public.api_keys;
  v_tx public.transactions;
  v_grant public.company_grants;
  v_company uuid;
  v_counterparty text;
  v_pattern jsonb;
  v_amount numeric;
  v_month_used numeric;
  v_use_id uuid;
  v_tx_id uuid;
BEGIN
  -- Cheapest first: a company without an active grant pays one index probe.
  SELECT company_id INTO v_company FROM public.pending_operations WHERE id = p_pending_operation_id;
  IF v_company IS NULL THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'operation_not_found');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.company_grants WHERE company_id = v_company AND revoked_at IS NULL) THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'no_grant');
  END IF;

  SELECT * INTO v_op FROM public.pending_operations WHERE id = p_pending_operation_id FOR UPDATE;
  IF v_op.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'operation_not_pending');
  END IF;
  IF v_op.operation_type IS DISTINCT FROM 'categorize_transaction' THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'operation_type_not_granted');
  END IF;
  IF v_op.batch_id IS NOT NULL THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'batch_staged');
  END IF;
  IF v_op.actor_type IS NULL OR v_op.actor_type NOT IN ('api_key', 'mcp_oauth', 'service_account') THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'not_a_key_credential');
  END IF;
  IF p_api_key_id IS NULL OR v_op.actor_id IS DISTINCT FROM p_api_key_id THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'credential_mismatch');
  END IF;

  -- The kill switch turns every grant off before any grant is read.
  IF EXISTS (SELECT 1 FROM public.company_grant_settings s WHERE s.company_id = v_op.company_id AND s.paused) THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'paused');
  END IF;

  -- The credential, as the database knows it now.
  SELECT * INTO v_key FROM public.api_keys WHERE id = p_api_key_id;
  IF v_key.id IS NULL OR v_key.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'credential_revoked');
  END IF;
  IF v_key.user_id IS DISTINCT FROM v_op.user_id THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'credential_mismatch');
  END IF;
  IF v_key.mode IS DISTINCT FROM 'live' THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'credential_not_live');
  END IF;
  IF v_key.service_account_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.service_accounts sa
                    WHERE sa.id = v_key.service_account_id AND sa.company_id = v_op.company_id AND sa.revoked_at IS NULL)
       OR NOT public.service_account_is_active(v_key.service_account_id) THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'credential_revoked');
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.company_members cm
                     WHERE cm.company_id = v_op.company_id AND cm.user_id = v_key.user_id
                       AND cm.role IN ('owner', 'admin', 'member')) THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'credential_not_member');
  END IF;

  -- What the agent asked for beyond the plain booking: never unattended.
  IF v_op.params->'allow_duplicate' = 'true'::jsonb THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'allow_duplicate');
  END IF;
  IF coalesce(jsonb_typeof(v_op.params->'vat_amount'), 'null') <> 'null' THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'vat_amount_override');
  END IF;
  IF coalesce(jsonb_typeof(v_op.params->'dimensions'), 'null') <> 'null'
     AND v_op.params->'dimensions' <> '{}'::jsonb THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'dimensions');
  END IF;

  IF coalesce(v_op.params->>'transaction_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'transaction_not_found');
  END IF;
  v_tx_id := (v_op.params->>'transaction_id')::uuid;
  SELECT * INTO v_tx FROM public.transactions WHERE id = v_tx_id AND company_id = v_op.company_id;
  IF v_tx.id IS NULL THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'transaction_not_found');
  END IF;
  IF v_tx.journal_entry_id IS NOT NULL OR v_tx.is_business IS NOT NULL OR coalesce(v_tx.is_ignored, false) THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'transaction_already_booked');
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_grant_uses u
              WHERE u.transaction_id = v_tx.id
                AND (u.status = 'committed' OR (u.status = 'claimed' AND u.claimed_at > now() - interval '1 hour'))) THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'transaction_already_claimed');
  END IF;

  v_counterparty := public.grant_counterparty_key(v_tx.merchant_name, v_tx.original_description, v_tx.description);
  IF v_counterparty = '' THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'unknown_counterparty');
  END IF;

  v_pattern := public.categorize_operation_pattern(v_op.params, v_op.preview_data, v_tx.amount);
  IF v_pattern IS NULL OR (v_op.preview_data->>'date') IS DISTINCT FROM v_tx.date::text THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'pattern_unreadable');
  END IF;
  v_amount := (v_pattern->>'amount_sek')::numeric;

  IF NOT public.grant_period_open(v_op.company_id, v_tx.date) THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'period_locked');
  END IF;

  SELECT * INTO v_grant
    FROM public.company_grants
   WHERE company_id = v_op.company_id AND operation_type = 'categorize_transaction'
     AND counterparty_key = v_counterparty AND revoked_at IS NULL AND valid_from <= now()
   FOR UPDATE;
  IF v_grant.id IS NULL THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'no_grant_for_counterparty');
  END IF;

  -- Exact match, field by field. Nothing is inferred, nothing is fuzzy.
  IF v_grant.direction IS DISTINCT FROM v_pattern->>'direction'
     OR v_grant.category IS DISTINCT FROM v_pattern->>'category'
     OR v_grant.vat_treatment IS DISTINCT FROM v_pattern->>'vat_treatment'
     OR v_grant.reverse_charge_kind IS DISTINCT FROM v_pattern->>'reverse_charge_kind'
     OR v_grant.account_number IS DISTINCT FROM v_pattern->>'account_number'
     OR to_jsonb(v_grant.line_accounts) IS DISTINCT FROM v_pattern->'line_accounts' THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'pattern_mismatch', 'grant_id', v_grant.id);
  END IF;

  IF (v_grant.credential_scope = 'api_key' AND v_grant.credential_id IS DISTINCT FROM v_key.id)
     OR (v_grant.credential_scope = 'service_account' AND v_grant.credential_id IS DISTINCT FROM v_key.service_account_id) THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'credential_not_allowed', 'grant_id', v_grant.id);
  END IF;

  IF v_amount > v_grant.amount_limit_sek THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'above_limit', 'grant_id', v_grant.id,
                              'amount_sek', v_amount, 'limit_sek', v_grant.amount_limit_sek);
  END IF;
  -- The key's own ceiling on what it commits without a person still applies.
  IF v_key.unattended_commit_limit IS NOT NULL AND v_key.unattended_commit_limit > 0
     AND v_amount > v_key.unattended_commit_limit THEN
    RETURN jsonb_build_object('matched', false, 'reason', 'above_unattended_limit', 'grant_id', v_grant.id,
                              'amount_sek', v_amount, 'limit_sek', v_key.unattended_commit_limit);
  END IF;
  IF v_grant.monthly_limit_sek IS NOT NULL THEN
    SELECT coalesce(sum(u.amount_sek), 0) INTO v_month_used
      FROM public.company_grant_uses u
      JOIN public.company_grants g ON g.id = u.grant_id
     WHERE g.company_id = v_grant.company_id AND g.operation_type = v_grant.operation_type
       AND g.counterparty_key = v_grant.counterparty_key
       AND date_trunc('month', u.entry_date) = date_trunc('month', v_tx.date)
       AND (u.status = 'committed' OR (u.status = 'claimed' AND u.claimed_at > now() - interval '1 hour'));
    IF v_month_used + v_amount > v_grant.monthly_limit_sek THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'above_monthly_limit', 'grant_id', v_grant.id,
                                'amount_sek', v_amount, 'used_sek', v_month_used, 'limit_sek', v_grant.monthly_limit_sek);
    END IF;
  END IF;

  INSERT INTO public.company_grant_uses (
    company_id, grant_id, grant_version, pending_operation_id, transaction_id, entry_date, amount_sek,
    api_key_id, service_account_id, status
  )
  VALUES (
    v_op.company_id, v_grant.id, v_grant.version, v_op.id, v_tx.id, v_tx.date, v_amount,
    v_key.id, v_key.service_account_id, 'claimed'
  )
  RETURNING id INTO v_use_id;

  RETURN jsonb_build_object(
    'matched', true,
    'company_id', v_op.company_id,
    'grant_id', v_grant.id,
    'grant_version', v_grant.version,
    'use_id', v_use_id,
    'amount_sek', v_amount,
    'counterparty_label', v_grant.counterparty_label,
    'accepted_at', v_grant.accepted_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_company_grant(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_company_grant(uuid, uuid) TO service_role;

-- =============================================================================
-- 3. After the commit
-- =============================================================================

CREATE FUNCTION public.complete_company_grant_use(p_use_id uuid, p_journal_entry_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_use public.company_grant_uses;
  v_grant public.company_grants;
  v_accounts text[];
  v_total numeric;
  v_verified boolean;
BEGIN
  SELECT * INTO v_use FROM public.company_grant_uses WHERE id = p_use_id FOR UPDATE;
  IF v_use.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_USE_NOT_FOUND');
  END IF;
  IF v_use.status = 'committed' THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'pattern_verified', v_use.pattern_verified);
  END IF;
  IF v_use.status <> 'claimed' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_USE_RELEASED');
  END IF;
  SELECT * INTO v_grant FROM public.company_grants WHERE id = v_use.grant_id;

  -- The posted verifikat against the rule: exactly its accounts, within its limit.
  SELECT array_agg(DISTINCT l.account_number ORDER BY l.account_number), sum(l.debit_amount)
    INTO v_accounts, v_total
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
   WHERE l.journal_entry_id = p_journal_entry_id AND je.company_id = v_use.company_id;
  v_verified := v_accounts IS NOT NULL
    AND v_accounts = v_grant.line_accounts
    AND round(v_total, 2) = v_use.amount_sek
    AND v_total <= v_grant.amount_limit_sek;

  UPDATE public.company_grant_uses
     SET status = 'committed', committed_at = now(), journal_entry_id = p_journal_entry_id, pattern_verified = v_verified
   WHERE id = v_use.id;

  RETURN jsonb_build_object('ok', true, 'unchanged', false, 'pattern_verified', v_verified);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_company_grant_use(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_company_grant_use(uuid, uuid) TO service_role;

CREATE FUNCTION public.release_company_grant_use(p_use_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.company_grant_uses
     SET status = 'released', released_at = now(), release_reason = left(coalesce(nullif(p_reason, ''), 'commit_refused'), 100)
   WHERE id = p_use_id AND status = 'claimed';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'released', v_count = 1);
END;
$$;

REVOKE ALL ON FUNCTION public.release_company_grant_use(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_company_grant_use(uuid, text) TO service_role;

-- =============================================================================
-- 4. The postings for review
-- =============================================================================

-- A claim whose operation the grant path committed counts even when the
-- completion report never arrived (the commit wrote the use id into the
-- operation's result_data).
CREATE FUNCTION public.list_company_grant_postings(p_company_id uuid, p_only_unreviewed boolean DEFAULT true, p_limit integer DEFAULT 50)
RETURNS TABLE (
  use_id uuid,
  grant_id uuid,
  grant_version integer,
  counterparty_label text,
  account_number text,
  amount_limit_sek numeric,
  grant_accepted_at timestamptz,
  grant_revoked_at timestamptz,
  pending_operation_id uuid,
  transaction_id uuid,
  journal_entry_id uuid,
  voucher text,
  entry_status text,
  entry_date date,
  amount_sek numeric,
  pattern_verified boolean,
  committed_at timestamptz,
  reviewed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT u.id, u.grant_id, u.grant_version, g.counterparty_label, g.account_number, g.amount_limit_sek,
         g.accepted_at, g.revoked_at, u.pending_operation_id, u.transaction_id,
         coalesce(u.journal_entry_id, nullif(po.result_data->>'journal_entry_id', '')::uuid),
         CASE WHEN je.voucher_number IS NULL THEN NULL ELSE coalesce(je.voucher_series, '') || je.voucher_number END,
         je.status, u.entry_date, u.amount_sek, u.pattern_verified,
         coalesce(u.committed_at, po.resolved_at), u.reviewed_at
    FROM public.company_grant_uses u
    JOIN public.company_grants g ON g.id = u.grant_id
    LEFT JOIN public.pending_operations po ON po.id = u.pending_operation_id
    LEFT JOIN public.journal_entries je
           ON je.id = coalesce(u.journal_entry_id, nullif(po.result_data->>'journal_entry_id', '')::uuid)
   WHERE u.company_id = p_company_id
     AND (u.status = 'committed'
          OR (u.status = 'claimed' AND po.status = 'committed' AND po.result_data->'grant'->>'use_id' = u.id::text))
     AND (NOT coalesce(p_only_unreviewed, true) OR u.reviewed_at IS NULL)
   ORDER BY coalesce(u.committed_at, po.resolved_at) DESC NULLS LAST, u.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.list_company_grant_postings(uuid, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_company_grant_postings(uuid, boolean, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
