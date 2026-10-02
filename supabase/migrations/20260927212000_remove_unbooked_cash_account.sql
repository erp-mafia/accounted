-- Let a user remove a bank account that never became bookkeeping (#3130).
--
-- A company that connects a bank and picks the wrong account (a private
-- account, a co-holder's account) could not get rid of it: every delete path
-- is guarded for booked data, and none of them fits a row that never was.
-- PATCH enabled=false refuses open rows (CASH_ACCOUNT_DISABLE_UNRESOLVED), the
-- single-row DELETE refuses imported rows (TRANSACTION_DELETE_IMPORTED) and
-- undo_bank_file_import is keyed on bank_file_import_id, NULL for PSD2 rows.
-- Support deleted the rows by hand twice in three days (crm#153, crm#193).
--
-- remove_cash_account checks and deletes in one transaction: the account's
-- transactions and the cash_accounts row go together or not at all. It only
-- acts on an account nothing booked depends on, and says why otherwise:
--
--   not_found       no such account in p_company_id (another company's id too)
--   bank_connected  a live bank connection still holds the row. Disconnect
--                   first (disconnect_bank_connection keeps every row);
--                   a row whose connection is already revoked counts as free,
--                   the same reading promote_psd2_cash_account uses.
--   primary         the company's primary: the skattekonto counter leg and
--                   the owner of transactions with no cash_account_id. Make
--                   another account primary first (make_cash_account_primary).
--   booked          a transaction on it is anchored to bookkeeping
--                   (cash_transaction_is_movable() is false: journal_entry_id,
--                   invoice or supplier-invoice link, payment row, voucher
--                   link, a posted verifikat naming it), or a supplier invoice
--                   or a webshop order points at it.
--   ignored         a transaction on it was ignored: a recorded decision that
--                   a bank movement is not a business event. Un-ignore first.
--   match_history   a transaction on it has payment_match_log rows. The log is
--                   append-only (payment_match_log_immutable) and its FK
--                   cascades on delete, so the rows cannot go.
--   in_use          cash_account_retirement_dependencies() is not empty:
--                   invoice payee details or flag, a per-currency payee
--                   default, an invoice that printed it, a reconciliation
--                   sign-off or attachment. The same rule the PSD2 promotion
--                   applies before it retires a row.
--   ledger_history  posted or reversed lines exist on its ledger account.
--                   The row is then the home of booked money; promotion
--                   refuses to move such a row (CASH_ACCOUNT_LEDGER_IN_USE)
--                   and removal refuses to delete it.
--
-- Everything else that references the rows is handled here, never deleted:
--   transactions.document_id / receipt_id, invoice_inbox_items and receipts
--     .matched_transaction_id: the underlag stays in Arkiv; only its pairing
--     with the removed row goes (FK SET NULL, or the pointer on the deleted
--     row itself). Counted and reported as released_underlag.
--   agreement_obligations.transaction_id: an observation, never booked from.
--     Its CHECK ties status 'matched' to a transaction, so SET NULL alone
--     would fail; the obligation goes back to 'expected' and the observer
--     re-derives it (released_obligations).
--   transaction_assistant_reads: cascades (assistant read markers).
--
-- Attribution: one audit_log row (who, when, which account, how many rows),
-- the same shape undo_bank_file_import writes. old_state keeps the account's
-- identity without the bank's IBAN/BBAN or balances: the account was the
-- wrong one, often a private one, and audit_log is immutable.
--
-- Locking follows the cash-account protocol: company lock first
-- (lock_cash_account_company), then the cash row, then its transactions. The
-- anchor guards take that company lock NOWAIT, so a booking racing this call
-- fails with CASH_ACCOUNT_OPERATION_BUSY instead of landing on a row that is
-- about to go. A dry run reads, checks and reports without locking or
-- writing; the settings page asks it before offering the confirmation.
--
-- Actor gate: the undo_bank_file_import shape. p_user_id is honored only for
-- the service role; every other caller is its own auth.uid(). Owner or admin.
--
-- pg-test: tests/pg/remove-cash-account.pg.test.ts

CREATE OR REPLACE FUNCTION public.remove_cash_account(
  p_company_id uuid,
  p_cash_account_id uuid,
  p_user_id uuid DEFAULT NULL,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
-- Same budget as undo_bank_file_import: the authenticated role carries an 8s
-- statement_timeout on hosted Supabase, and an account can hold thousands of
-- synced rows.
SET statement_timeout TO '290s'
AS $function$
DECLARE
  v_actor          uuid;
  v_role           text;
  v_row            public.cash_accounts;
  v_dependencies   text[];
  v_transactions   integer := 0;
  v_booked         integer := 0;
  v_ignored        integer := 0;
  v_match_history  integer := 0;
  v_underlag       integer := 0;
  v_obligations    integer := 0;
  v_deleted        integer := 0;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role INTO v_role
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id
     AND cm.user_id = v_actor;

  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_REMOVE_ADMIN_ONLY: only company owners and admins can remove a bank account'
      USING ERRCODE = '42501';
  END IF;

  IF p_dry_run THEN
    SELECT * INTO v_row
      FROM public.cash_accounts
     WHERE company_id = p_company_id AND id = p_cash_account_id;
  ELSE
    PERFORM public.lock_cash_account_company(p_company_id);
    SELECT * INTO v_row
      FROM public.cash_accounts
     WHERE company_id = p_company_id AND id = p_cash_account_id
       FOR UPDATE;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_row.bank_connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.bank_connections b
     WHERE b.company_id = p_company_id
       AND b.id = v_row.bank_connection_id
       AND b.status = 'revoked'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bank_connected');
  END IF;

  IF v_row.is_primary THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'primary');
  END IF;

  -- Lock every row before any anchor predicate reads it (promotion's order).
  IF NOT p_dry_run THEN
    PERFORM 1 FROM public.transactions
     WHERE company_id = p_company_id AND cash_account_id = p_cash_account_id
     ORDER BY id
       FOR UPDATE;
  END IF;

  SELECT
    count(*),
    count(*) FILTER (
      WHERE NOT public.cash_transaction_is_movable(p_company_id, t.id)
         OR EXISTS (SELECT 1 FROM public.supplier_invoices s
                     WHERE s.company_id = p_company_id AND s.transaction_id = t.id)
         -- No ON DELETE action and no index on legacy_transaction_id: an
         -- uncorrelated IN, so the company's orders are read once.
         OR t.id IN (SELECT w.legacy_transaction_id FROM public.webshop_orders w
                      WHERE w.company_id = p_company_id AND w.legacy_transaction_id IS NOT NULL)
    ),
    count(*) FILTER (WHERE t.is_ignored),
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.payment_match_log p WHERE p.transaction_id = t.id)),
    count(*) FILTER (
      WHERE t.document_id IS NOT NULL
         OR t.receipt_id IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.invoice_inbox_items i
                     WHERE i.company_id = p_company_id AND i.matched_transaction_id = t.id)
         OR EXISTS (SELECT 1 FROM public.receipts r WHERE r.matched_transaction_id = t.id)
    )
    INTO v_transactions, v_booked, v_ignored, v_match_history, v_underlag
    FROM public.transactions t
   WHERE t.company_id = p_company_id
     AND t.cash_account_id = p_cash_account_id;

  IF v_booked > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'booked', 'transactions', v_booked);
  END IF;
  IF v_ignored > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ignored', 'transactions', v_ignored);
  END IF;
  IF v_match_history > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'match_history', 'transactions', v_match_history);
  END IF;

  -- What keeps the row itself alive, once its transactions could go.
  v_dependencies := COALESCE(public.cash_account_retirement_dependencies(p_company_id, p_cash_account_id), '{}');
  IF cardinality(v_dependencies) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'in_use', 'dependencies', to_jsonb(v_dependencies));
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.journal_entry_lines l
      JOIN public.journal_entries e ON e.id = l.journal_entry_id
     WHERE e.company_id = p_company_id
       AND e.status IN ('posted', 'reversed')
       AND l.account_number = v_row.ledger_account
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ledger_history', 'ledger_account', v_row.ledger_account);
  END IF;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'cash_account_id', v_row.id,
      'ledger_account', v_row.ledger_account,
      'transactions', v_transactions,
      'underlag', v_underlag
    );
  END IF;

  UPDATE public.agreement_obligations o
     SET status = 'expected', transaction_id = NULL, matched_basis = NULL, matched_at = NULL
   WHERE o.company_id = p_company_id
     AND o.transaction_id IN (
       SELECT t.id FROM public.transactions t
        WHERE t.company_id = p_company_id AND t.cash_account_id = p_cash_account_id
     );
  GET DIAGNOSTICS v_obligations = ROW_COUNT;

  WITH deleted AS (
    DELETE FROM public.transactions t
     WHERE t.company_id = p_company_id
       AND t.cash_account_id = p_cash_account_id
    RETURNING t.id
  )
  SELECT count(*) INTO v_deleted FROM deleted;

  -- transactions.cash_account_id is ON DELETE SET NULL: a row left behind
  -- would silently move to the primary. Under the locks above none can be.
  IF EXISTS (
    SELECT 1 FROM public.transactions
     WHERE company_id = p_company_id AND cash_account_id = p_cash_account_id
  ) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
  END IF;

  DELETE FROM public.cash_accounts
   WHERE company_id = p_company_id AND id = p_cash_account_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description
  ) VALUES (
    v_actor, p_company_id, 'DELETE', 'cash_accounts', v_row.id, v_actor,
    jsonb_build_object(
      'id', v_row.id,
      'name', v_row.name,
      'ledger_account', v_row.ledger_account,
      'currency', v_row.currency,
      'source', v_row.source,
      'enabled', v_row.enabled,
      'voucher_series', v_row.voucher_series,
      'bank_connection_id', v_row.bank_connection_id,
      'created_at', v_row.created_at
    ),
    jsonb_build_object(
      'name', v_row.name,
      'ledger_account', v_row.ledger_account,
      'deleted_transactions', v_deleted,
      'released_underlag', v_underlag,
      'released_obligations', v_obligations
    ),
    'Bank account removed with its unbooked transactions (none booked, matched, linked or ignored)'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'cash_account_id', v_row.id,
    'ledger_account', v_row.ledger_account,
    'deleted_transactions', v_deleted,
    'released_underlag', v_underlag,
    'released_obligations', v_obligations
  );
END;
$function$;

-- Same discipline as undo_bank_file_import: PUBLIC and anon revoked, the
-- session client (scoped by the owner/admin gate) and the service role kept.
REVOKE EXECUTE ON FUNCTION public.remove_cash_account(uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_cash_account(uuid, uuid, uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.remove_cash_account(uuid, uuid, uuid, boolean) IS
  'Removes a bank account nothing booked depends on, with its transactions, in one transaction (#3130). Refuses with a reason (not_found, bank_connected, primary, booked, ignored, match_history, in_use, ledger_history) instead of deleting part of it. Underlag stays; its pairing with a removed row is released. Owner/admin; p_user_id is honored only for service_role. p_dry_run checks and reports without locking or writing. Writes one audit_log row.';

NOTIFY pgrst, 'reload schema';
