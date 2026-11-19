-- Archive a bank account that came from a mistaken connection but cannot be
-- removed (PH 222).
--
-- remove_cash_account (20260927212000) deletes an account together with its
-- unbooked rows only when nothing at all ties it to the books. A mistaken
-- connection often fails that test for reasons that have nothing to do with
-- the account itself: the ledger account it was given already holds the
-- company's own history (ledger_history), or a row on it was booked, ignored
-- or matched by mistake. Those rows may be the bank statement behind posted
-- vouchers, so they must not be deleted, and until now the account then
-- stayed in Konton for good: disabling it is refused while any row is open
-- (CASH_ACCOUNT_DISABLE_UNRESOLVED).
--
-- archive_cash_account turns such an account off (enabled = false): it leaves
-- Konton and the booking flows, which already read enabled accounts only, and
-- every row stays exactly as it is. Nothing is deleted, no posted entry is
-- touched, and the account can be turned on again later.
--
-- What qualifies is remove_cash_account's own dry run, so the two never
-- disagree: archive only when removal is refused for booked, ignored,
-- match_history, in_use or ledger_history. Refused with a reason, changing
-- nothing:
--
--   not_found         no such account in p_company_id
--   already_archived  the account is already turned off
--   bank_connected    a live bank connection holds the row (disconnect first;
--                     the sync would turn it on again)
--   primary           the company's primary: make another account primary
--                     first (make_cash_account_primary)
--   invoice_payee     customer invoices print it (payee flag or a
--                     per-currency default); turning it off would change what
--                     invoices print
--   removable         nothing ties it to the books: remove it instead
--
-- Attribution: audit_cash_accounts_routing logs the enabled flip itself; one
-- more audit_log row says why (the removal refusal) and how many open rows
-- were kept, with the actor that p_user_id names for the service role.
--
-- Actor gate and locking: the remove_cash_account shape. p_user_id is honored
-- only for the service role; every other caller is its own auth.uid(), and
-- must be owner or admin. A real call takes the company cash lock, then the
-- row. A dry run reads, checks and reports without locking or writing.
--
-- pg-test: tests/pg/archive-cash-account.pg.test.ts

CREATE OR REPLACE FUNCTION public.archive_cash_account(
  p_company_id uuid,
  p_cash_account_id uuid,
  p_user_id uuid DEFAULT NULL,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
-- remove_cash_account's dry run below reads every row of the account; same
-- budget as that function.
SET statement_timeout TO '290s'
AS $function$
DECLARE
  v_actor    uuid;
  v_role     text;
  v_row      public.cash_accounts;
  v_removal  jsonb;
  v_reason   text;
  v_open     integer := 0;
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
    RAISE EXCEPTION 'CASH_ACCOUNT_ARCHIVE_ADMIN_ONLY: only company owners and admins can archive a bank account'
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

  IF NOT v_row.enabled THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_archived');
  END IF;

  -- The same reading of "held by a live connection" as remove_cash_account.
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

  IF v_row.invoice_payee OR EXISTS (
    SELECT 1 FROM public.invoice_payee_defaults d
     WHERE d.company_id = p_company_id AND d.cash_account_id = v_row.id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invoice_payee');
  END IF;

  -- One rule for both paths: removal's own checks decide whether the
  -- account must be kept. Its dry run neither locks nor writes.
  v_removal := public.remove_cash_account(p_company_id, p_cash_account_id, p_user_id, true);

  IF COALESCE((v_removal ->> 'ok')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'removable');
  END IF;

  v_reason := v_removal ->> 'reason';
  IF v_reason IS NULL OR v_reason NOT IN ('booked', 'ignored', 'match_history', 'in_use', 'ledger_history') THEN
    -- not_found, bank_connected or primary as removal reads them.
    RETURN v_removal;
  END IF;

  SELECT count(*) INTO v_open
    FROM public.transactions t
   WHERE t.company_id = p_company_id
     AND t.cash_account_id = p_cash_account_id
     AND t.journal_entry_id IS NULL
     AND NOT COALESCE(t.is_ignored, false);

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'cash_account_id', v_row.id,
      'ledger_account', v_row.ledger_account,
      'kept_because', v_reason,
      'open_transactions', v_open
    );
  END IF;

  UPDATE public.cash_accounts
     SET enabled = false
   WHERE company_id = p_company_id
     AND id = p_cash_account_id;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description
  ) VALUES (
    v_actor, p_company_id, 'UPDATE', 'cash_accounts', v_row.id, v_actor,
    jsonb_build_object('enabled', true),
    jsonb_build_object(
      'enabled', false,
      'archived', true,
      'name', v_row.name,
      'ledger_account', v_row.ledger_account,
      'kept_because', v_reason,
      'open_transactions', v_open
    ),
    'Bank account archived: turned off, every transaction kept (removal refused: ' || v_reason || ')'
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'cash_account_id', v_row.id,
    'ledger_account', v_row.ledger_account,
    'kept_because', v_reason,
    'open_transactions', v_open
  );
END;
$function$;

-- Same discipline as remove_cash_account: PUBLIC and anon revoked, the
-- session client (scoped by the owner/admin gate) and the service role kept.
REVOKE EXECUTE ON FUNCTION public.archive_cash_account(uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_cash_account(uuid, uuid, uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.archive_cash_account(uuid, uuid, uuid, boolean) IS
  'Archives (enabled = false) a bank account remove_cash_account must keep (booked, ignored, match_history, in_use, ledger_history), keeping every row (PH 222). Refuses with a reason (not_found, already_archived, bank_connected, primary, invoice_payee, removable). Owner/admin; p_user_id is honored only for service_role. p_dry_run checks and reports without locking or writing. Writes one audit_log row besides the routing audit trigger.';

NOTIFY pgrst, 'reload schema';
