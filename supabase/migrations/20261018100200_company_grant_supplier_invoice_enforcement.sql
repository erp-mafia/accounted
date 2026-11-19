-- Grants, slice 2: enforcement for a staged supplier invoice from the inbox.
-- Each function is restated from its latest definition (20261017100300 and
-- 20261017100400) and keeps every bank-line behaviour exactly; what is new
-- is the branch for create_supplier_invoice_from_inbox.
--
-- 1. claim_company_grant: the one gate, now for both types. The shared part
--    is unchanged (no_grant first, the operation pending and of a granted
--    type, not in a batch, staged by this live key whose person still writes
--    in the company or whose service account is active, not paused). A
--    staged supplier invoice then goes through, refusing in this order, and
--    every refusal leaves the operation pending for a person as before:
--      unknown_supplier / no_grant_for_counterparty
--                                  no active rule for the supplier the
--                                  operation names (silent: no rule in play)
--      unknown_supplier            the supplier is not in the company
--      register_booked ... underlag_missing
--                                  supplier_invoice_operation_unfit (20261018100100)
--      inbox_item_not_found        the inbox item is not in the company
--      credit_note                 the inbox item is a credit note
--      inbox_item_already_booked   the item already became a supplier invoice
--      inbox_item_already_claimed  another booking of the item is in progress
--      underlag_missing            the item has no document, another one, or
--                                  the document is not in the archive
--      duplicate_invoice_number    the supplier's invoice number is registered
--      registration_not_booked     the company does not book invoices when
--                                  they are registered (kontantmetoden or
--                                  deferred booking), or the approver was not
--                                  shown a verifikat
--      pattern_unreadable          the lines, the treatment or the total
--                                  cannot be read exactly
--      period_locked               no open, unlocked period covers the
--                                  invoice date, or the lock date covers it
--      pattern_mismatch            VAT treatment, reverse-charge kind or the
--                                  set of line bookings differ in any way
--      credential_not_allowed, above_limit, above_unattended_limit,
--      above_monthly_limit         as for a bank line; the amount is the
--                                  invoice total (2440), the month the
--                                  invoice date's
--    A match answers operation_type beside the grant, for the caller.
--
-- 2. complete_company_grant_use: a supplier invoice's verifikat is checked
--    against the rule by its accounts (exactly the rule's) and its payable
--    (what 2440 is credited equals the claimed total, within the limit): a
--    reverse-charge verifikat's debits include fiktiv moms and the basis
--    pair, so its debit sum is not the invoice.
--
-- 3. list_company_grant_postings: recreated (its columns change) with the
--    operation type, the rule's line bookings, the supplier invoice and the
--    inbox item, and the registration verifikat as the posting when the
--    completion report never arrived.
--
-- 4. revoke_company_grant: the postings it answers name the supplier invoice
--    and the inbox item, and the answer names the operation type.
--
-- pg-test: tests/pg/company-grants-supplier-invoices.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. claim_company_grant
-- =============================================================================

CREATE OR REPLACE FUNCTION public.claim_company_grant(p_pending_operation_id uuid, p_api_key_id uuid)
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
  v_supplier public.suppliers;
  v_inbox public.invoice_inbox_items;
  v_settings public.company_settings;
  v_company uuid;
  v_counterparty text;
  v_pattern jsonb;
  v_amount numeric;
  v_month_used numeric;
  v_use_id uuid;
  v_tx_id uuid;
  v_supplier_id uuid;
  v_inbox_id uuid;
  v_date date;
  v_reason text;
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
  IF v_op.operation_type IS NULL OR v_op.operation_type NOT IN ('categorize_transaction', 'create_supplier_invoice_from_inbox') THEN
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

  IF v_op.operation_type = 'categorize_transaction' THEN
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
    v_date := v_tx.date;

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
  ELSE
    -- A supplier invoice from the inbox. The rule for the supplier the
    -- operation names comes first: without one nothing below concerns a grant.
    IF coalesce(v_op.params->>'supplier_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'unknown_supplier');
    END IF;
    v_supplier_id := (v_op.params->>'supplier_id')::uuid;
    SELECT * INTO v_grant
      FROM public.company_grants
     WHERE company_id = v_op.company_id AND operation_type = 'create_supplier_invoice_from_inbox'
       AND counterparty_key = 'supplier:' || v_supplier_id::text AND revoked_at IS NULL AND valid_from <= now()
     FOR UPDATE;
    IF v_grant.id IS NULL THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'no_grant_for_counterparty');
    END IF;
    SELECT * INTO v_supplier FROM public.suppliers WHERE id = v_supplier_id AND company_id = v_op.company_id;
    IF v_supplier.id IS NULL THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'unknown_supplier', 'grant_id', v_grant.id);
    END IF;

    -- What the operation asks for beyond a plain registration: never unattended.
    v_reason := public.supplier_invoice_operation_unfit(v_op.params, v_op.preview_data);
    IF v_reason IS NOT NULL THEN
      RETURN jsonb_build_object('matched', false, 'reason', v_reason, 'grant_id', v_grant.id);
    END IF;

    IF coalesce(v_op.params->>'inbox_item_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'inbox_item_not_found', 'grant_id', v_grant.id);
    END IF;
    v_inbox_id := (v_op.params->>'inbox_item_id')::uuid;
    SELECT * INTO v_inbox FROM public.invoice_inbox_items WHERE id = v_inbox_id AND company_id = v_op.company_id;
    IF v_inbox.id IS NULL THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'inbox_item_not_found', 'grant_id', v_grant.id);
    END IF;
    -- The item's own reading (resolveInboxKind, src/lib/documents/inbox-kind.ts):
    -- a credit note never becomes a payable of its own.
    IF v_inbox.extracted_data->>'documentKind' = 'credit_note'
       AND (v_inbox.kind_hint IS NULL OR v_inbox.kind_hint = 'supplier_invoice') THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'credit_note', 'grant_id', v_grant.id);
    END IF;
    IF v_inbox.created_supplier_invoice_id IS NOT NULL THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'inbox_item_already_booked', 'grant_id', v_grant.id);
    END IF;
    IF EXISTS (SELECT 1 FROM public.company_grant_uses u
                WHERE u.inbox_item_id = v_inbox.id
                  AND (u.status = 'committed' OR (u.status = 'claimed' AND u.claimed_at > now() - interval '1 hour'))) THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'inbox_item_already_claimed', 'grant_id', v_grant.id);
    END IF;
    -- The underlag: the item's own document, in the archive.
    IF v_inbox.document_id IS NULL
       OR v_inbox.document_id::text IS DISTINCT FROM lower(v_op.params->>'document_id')
       OR NOT EXISTS (SELECT 1 FROM public.document_attachments d
                       WHERE d.id = v_inbox.document_id AND d.company_id = v_op.company_id) THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'underlag_missing', 'grant_id', v_grant.id);
    END IF;
    IF EXISTS (SELECT 1 FROM public.supplier_invoices si
                WHERE si.company_id = v_op.company_id AND si.supplier_id = v_supplier.id
                  AND si.supplier_invoice_number = v_op.params->>'supplier_invoice_number'
                  AND si.status NOT IN ('credited', 'reversed')) THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'duplicate_invoice_number', 'grant_id', v_grant.id);
    END IF;
    -- Booked when registered (booksInvoicesOnIssue): faktureringsmetoden
    -- without deferred booking, and the approver was shown the verifikat.
    SELECT * INTO v_settings FROM public.company_settings WHERE company_id = v_op.company_id;
    IF coalesce(v_settings.accounting_method, 'accrual') <> 'accrual'
       OR coalesce(v_settings.defer_invoice_booking, false)
       OR v_op.preview_data->'will_post_journal_entry' IS DISTINCT FROM 'true'::jsonb THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'registration_not_booked', 'grant_id', v_grant.id);
    END IF;

    v_pattern := public.supplier_invoice_operation_pattern(v_op.params, v_op.preview_data, v_supplier.supplier_type);
    IF v_pattern IS NULL THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'pattern_unreadable', 'grant_id', v_grant.id);
    END IF;
    v_amount := (v_pattern->>'amount_sek')::numeric;
    v_date := (v_pattern->>'invoice_date')::date;

    IF NOT public.grant_period_open(v_op.company_id, v_date) THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'period_locked', 'grant_id', v_grant.id);
    END IF;

    -- Exact match, field by field. Nothing is inferred, nothing is fuzzy.
    IF v_grant.vat_treatment IS DISTINCT FROM v_pattern->>'vat_treatment'
       OR v_grant.reverse_charge_kind IS DISTINCT FROM v_pattern->>'reverse_charge_kind'
       OR to_jsonb(v_grant.item_lines) IS DISTINCT FROM v_pattern->'item_lines' THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'pattern_mismatch', 'grant_id', v_grant.id);
    END IF;
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
       AND date_trunc('month', u.entry_date) = date_trunc('month', v_date)
       AND (u.status = 'committed' OR (u.status = 'claimed' AND u.claimed_at > now() - interval '1 hour'));
    IF v_month_used + v_amount > v_grant.monthly_limit_sek THEN
      RETURN jsonb_build_object('matched', false, 'reason', 'above_monthly_limit', 'grant_id', v_grant.id,
                                'amount_sek', v_amount, 'used_sek', v_month_used, 'limit_sek', v_grant.monthly_limit_sek);
    END IF;
  END IF;

  INSERT INTO public.company_grant_uses (
    company_id, grant_id, grant_version, pending_operation_id, transaction_id, inbox_item_id, entry_date, amount_sek,
    api_key_id, service_account_id, status
  )
  VALUES (
    v_op.company_id, v_grant.id, v_grant.version, v_op.id, v_tx.id, v_inbox.id, v_date, v_amount,
    v_key.id, v_key.service_account_id, 'claimed'
  )
  RETURNING id INTO v_use_id;

  RETURN jsonb_build_object(
    'matched', true,
    'company_id', v_op.company_id,
    'operation_type', v_op.operation_type,
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
-- 2. complete_company_grant_use
-- =============================================================================

CREATE OR REPLACE FUNCTION public.complete_company_grant_use(p_use_id uuid, p_journal_entry_id uuid)
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
  v_payable numeric;
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
  SELECT array_agg(DISTINCT l.account_number ORDER BY l.account_number),
         sum(l.debit_amount),
         sum(CASE WHEN l.account_number = '2440' THEN l.credit_amount - l.debit_amount ELSE 0 END)
    INTO v_accounts, v_total, v_payable
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
   WHERE l.journal_entry_id = p_journal_entry_id AND je.company_id = v_use.company_id;
  IF v_grant.operation_type = 'create_supplier_invoice_from_inbox' THEN
    -- A supplier invoice: what 2440 is credited is the invoice total.
    v_verified := v_accounts IS NOT NULL
      AND v_accounts = v_grant.line_accounts
      AND round(v_payable, 2) = v_use.amount_sek
      AND v_payable <= v_grant.amount_limit_sek;
  ELSE
    v_verified := v_accounts IS NOT NULL
      AND v_accounts = v_grant.line_accounts
      AND round(v_total, 2) = v_use.amount_sek
      AND v_total <= v_grant.amount_limit_sek;
  END IF;

  UPDATE public.company_grant_uses
     SET status = 'committed', committed_at = now(), journal_entry_id = p_journal_entry_id, pattern_verified = v_verified
   WHERE id = v_use.id;

  RETURN jsonb_build_object('ok', true, 'unchanged', false, 'pattern_verified', v_verified);
END;
$$;

REVOKE ALL ON FUNCTION public.complete_company_grant_use(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_company_grant_use(uuid, uuid) TO service_role;

-- =============================================================================
-- 3. list_company_grant_postings: recreated with more columns
-- =============================================================================

DROP FUNCTION public.list_company_grant_postings(uuid, boolean, integer);

-- A claim whose operation the grant path committed counts even when the
-- completion report never arrived (the commit wrote the use id into the
-- operation's result_data, beside the verifikat: journal_entry_id for a bank
-- line, registration_journal_entry_id for a supplier invoice).
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
  reviewed_at timestamptz,
  operation_type text,
  item_lines text[],
  supplier_invoice_id uuid,
  inbox_item_id uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT u.id, u.grant_id, u.grant_version, g.counterparty_label, g.account_number, g.amount_limit_sek,
         g.accepted_at, g.revoked_at, u.pending_operation_id, u.transaction_id,
         coalesce(u.journal_entry_id, nullif(po.result_data->>'journal_entry_id', '')::uuid,
                  nullif(po.result_data->>'registration_journal_entry_id', '')::uuid),
         CASE WHEN je.voucher_number IS NULL THEN NULL ELSE coalesce(je.voucher_series, '') || je.voucher_number END,
         je.status, u.entry_date, u.amount_sek, u.pattern_verified,
         coalesce(u.committed_at, po.resolved_at), u.reviewed_at,
         g.operation_type, g.item_lines,
         CASE WHEN g.operation_type = 'create_supplier_invoice_from_inbox'
              THEN nullif(po.result_data->>'supplier_invoice_id', '')::uuid END,
         u.inbox_item_id
    FROM public.company_grant_uses u
    JOIN public.company_grants g ON g.id = u.grant_id
    LEFT JOIN public.pending_operations po ON po.id = u.pending_operation_id
    LEFT JOIN public.journal_entries je
           ON je.id = coalesce(u.journal_entry_id, nullif(po.result_data->>'journal_entry_id', '')::uuid,
                               nullif(po.result_data->>'registration_journal_entry_id', '')::uuid)
   WHERE u.company_id = p_company_id
     AND (u.status = 'committed'
          OR (u.status = 'claimed' AND po.status = 'committed' AND po.result_data->'grant'->>'use_id' = u.id::text))
     AND (NOT coalesce(p_only_unreviewed, true) OR u.reviewed_at IS NULL)
   ORDER BY coalesce(u.committed_at, po.resolved_at) DESC NULLS LAST, u.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.list_company_grant_postings(uuid, boolean, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_company_grant_postings(uuid, boolean, integer) TO authenticated, service_role;

-- =============================================================================
-- 4. revoke_company_grant
-- =============================================================================

CREATE OR REPLACE FUNCTION public.revoke_company_grant(
  p_company_id uuid,
  p_grant_id uuid,
  p_decided_by uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL,
  p_pending_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.company_grants;
  v_new public.company_grants;
  v_actor_type text;
  v_postings jsonb;
  v_count integer;
BEGIN
  IF p_decided_by IS NULL OR NOT public.service_account_actor_is_admin(p_company_id, p_decided_by) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_ADMIN_REQUIRED');
  END IF;

  SELECT * INTO v_old FROM public.company_grants WHERE id = p_grant_id AND company_id = p_company_id FOR UPDATE;
  IF v_old.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_NOT_FOUND');
  END IF;

  v_actor_type := CASE
    WHEN p_actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account') THEN p_actor_type
    ELSE 'user'
  END;

  IF v_old.revoked_at IS NULL THEN
    UPDATE public.company_grants
       SET revoked_at = now(), revoked_by = p_decided_by, revoked_reason = 'revoked',
           revoked_pending_operation_id = p_pending_operation_id
     WHERE id = v_old.id
    RETURNING * INTO v_new;

    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                  description, actor_type, actor_label)
    VALUES (
      p_decided_by, p_company_id, 'UPDATE', 'company_grants', v_new.id, p_decided_by, to_jsonb(v_old), to_jsonb(v_new),
      'Grant revoked: ' || v_new.counterparty_label, v_actor_type, nullif(left(p_actor_label, 200), '')
    );
  ELSE
    v_new := v_old;
  END IF;

  -- What the grant let through: every committed use, newest first (at most 500 listed).
  SELECT count(*) INTO v_count FROM public.company_grant_uses u WHERE u.grant_id = v_old.id AND u.status = 'committed';
  SELECT coalesce(jsonb_agg(p ORDER BY p->>'committed_at' DESC), '[]'::jsonb) INTO v_postings
    FROM (
      SELECT jsonb_build_object(
               'use_id', u.id,
               'journal_entry_id', u.journal_entry_id,
               'transaction_id', u.transaction_id,
               'inbox_item_id', u.inbox_item_id,
               'supplier_invoice_id', CASE WHEN v_old.operation_type = 'create_supplier_invoice_from_inbox'
                                           THEN nullif(po.result_data->>'supplier_invoice_id', '')::uuid END,
               'voucher', CASE WHEN je.voucher_number IS NULL THEN NULL ELSE coalesce(je.voucher_series, '') || je.voucher_number END,
               'entry_status', je.status,
               'entry_date', u.entry_date,
               'amount_sek', u.amount_sek,
               'committed_at', u.committed_at,
               'reviewed_at', u.reviewed_at
             ) AS p
        FROM public.company_grant_uses u
        LEFT JOIN public.journal_entries je ON je.id = u.journal_entry_id
        LEFT JOIN public.pending_operations po ON po.id = u.pending_operation_id
       WHERE u.grant_id = v_old.id AND u.status = 'committed'
       ORDER BY u.committed_at DESC
       LIMIT 500
    ) s;

  RETURN jsonb_build_object(
    'ok', true,
    'unchanged', v_old.revoked_at IS NOT NULL,
    'grant_id', v_new.id,
    'version', v_new.version,
    'operation_type', v_new.operation_type,
    'counterparty_label', v_new.counterparty_label,
    'revoked_at', v_new.revoked_at,
    'revoked_reason', v_new.revoked_reason,
    'postings_count', v_count,
    'postings', v_postings
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_company_grant(uuid, uuid, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_company_grant(uuid, uuid, uuid, text, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
