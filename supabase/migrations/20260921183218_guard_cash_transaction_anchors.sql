-- Row guards can run after a caller already owns a source/invoice row lock.
-- They must never wait for the company lock held by a repair waiting for that
-- row. The two-argument helper shares authorization and supports a NOWAIT
-- conflict; ordinary atomic RPCs retain the existing blocking one-arg call.
CREATE FUNCTION public.lock_cash_account_company(p_company_id uuid, p_wait boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
BEGIN
  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;
  IF p_wait THEN
    PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  ELSE
    PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE NOWAIT;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$;

CREATE OR REPLACE FUNCTION public.lock_cash_account_company(p_company_id uuid)
RETURNS void LANGUAGE sql SECURITY INVOKER SET search_path = ''
AS $function$ SELECT public.lock_cash_account_company(p_company_id, true) $function$;

CREATE FUNCTION public.bank_anchor_settlement_account(p_company_id uuid, p_cash_account_id uuid, p_currency text)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_ledger text; v_count integer;
BEGIN
  IF p_cash_account_id IS NOT NULL THEN
    SELECT ledger_account INTO v_ledger FROM public.cash_accounts
      WHERE company_id = p_company_id AND id = p_cash_account_id AND currency = COALESCE(p_currency, 'SEK');
    IF NOT FOUND THEN RAISE EXCEPTION 'BANK_ANCHOR_CASH_ACCOUNT_CHANGED' USING ERRCODE = 'PT409'; END IF;
  ELSE
    SELECT count(*), min(ledger_account) INTO v_count, v_ledger FROM public.cash_accounts
      WHERE company_id = p_company_id AND enabled AND currency = COALESCE(p_currency, 'SEK');
    IF v_count <> 1 THEN v_ledger := '1930'; END IF;
  END IF;
  RETURN v_ledger;
END;
$function$;

-- Called with the company/cash/source locks held. Check the bank direction,
-- not the whole amount: one payment can consume only part of a transaction,
-- and invoice-currency amounts differ from the bank-currency amount.
CREATE FUNCTION public.assert_bank_anchor_journal(
  p_company_id uuid, p_transaction_id uuid, p_journal_entry_id uuid,
  p_settlement_account text, p_amount numeric, p_bank_line boolean
)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_context jsonb;
BEGIN
  IF p_journal_entry_id IS NULL THEN RETURN; END IF;
  SELECT bank_booking_context INTO v_context FROM public.journal_entries
    WHERE company_id = p_company_id AND id = p_journal_entry_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_ANCHOR_JOURNAL_NOT_FOUND' USING ERRCODE = '23503'; END IF;
  IF NOT p_bank_line THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_context) c
    WHERE c->>'transaction_id' = p_transaction_id::text
      AND c->>'settlement_account' IS DISTINCT FROM p_settlement_account
  ) OR NOT EXISTS (
    SELECT 1 FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = p_journal_entry_id AND l.account_number = p_settlement_account
      AND ((p_amount < 0 AND l.credit_amount > 0) OR (p_amount > 0 AND l.debit_amount > 0)
        OR (p_amount = 0 AND (l.credit_amount > 0 OR l.debit_amount > 0)))
  ) THEN
    RAISE EXCEPTION 'BANK_ANCHOR_SETTLEMENT_CHANGED' USING ERRCODE = 'PT409';
  END IF;
END;
$function$;

CREATE FUNCTION public.guard_cash_transaction_binding()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  v_binding_changed boolean := false;
  v_ledger text;
  v_entry uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'BANK_ANCHOR_COMPANY_CHANGED' USING ERRCODE = '23514';
    END IF;
    v_binding_changed := NEW.cash_account_id IS DISTINCT FROM OLD.cash_account_id;
    IF NOT v_binding_changed
      AND (NEW.journal_entry_id IS NULL OR NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id)
      AND (NEW.invoice_id IS NULL OR NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id)
      AND (NEW.supplier_invoice_id IS NULL OR NEW.supplier_invoice_id IS NOT DISTINCT FROM OLD.supplier_invoice_id)
    THEN RETURN NEW; END IF;
  ELSIF NEW.journal_entry_id IS NULL AND NEW.invoice_id IS NULL AND NEW.supplier_invoice_id IS NULL THEN
    -- Ordinary source inserts keep the FK/ingest protocol. No new anchor is
    -- attached here, and taking a company lock would invert ingest's order.
    RETURN NEW;
  END IF;

  PERFORM public.lock_cash_account_company(NEW.company_id, false);
  PERFORM 1 FROM public.cash_accounts WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  IF v_binding_changed AND OLD.cash_account_id IS NOT NULL
     AND NOT public.cash_transaction_is_movable(OLD.company_id, OLD.id) THEN
    RAISE EXCEPTION 'BANK_ANCHOR_BINDING_IN_USE' USING ERRCODE = 'PT409';
  END IF;
  v_ledger := public.bank_anchor_settlement_account(NEW.company_id, NEW.cash_account_id, NEW.currency);

  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.invoices WHERE company_id = NEW.company_id AND id = NEW.invoice_id
  ) THEN RAISE EXCEPTION 'BANK_ANCHOR_INVOICE_NOT_FOUND' USING ERRCODE = '23503'; END IF;
  IF NEW.supplier_invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.supplier_invoices WHERE company_id = NEW.company_id AND id = NEW.supplier_invoice_id
  ) THEN RAISE EXCEPTION 'BANK_ANCHOR_INVOICE_NOT_FOUND' USING ERRCODE = '23503'; END IF;
  PERFORM public.assert_bank_anchor_journal(NEW.company_id, NEW.id, NEW.journal_entry_id, v_ledger, NEW.amount, true);

  IF v_binding_changed THEN
    -- NULL-to-cash adoption must preserve every existing bank claim, including
    -- a posted origin whose final payment/direct/junction link has not arrived.
    FOR v_entry IN
      SELECT journal_entry_id FROM public.transaction_voucher_links
        WHERE company_id = NEW.company_id AND transaction_id = NEW.id AND role = 'bank_line'
      UNION SELECT journal_entry_id FROM public.invoice_payments
        WHERE company_id = NEW.company_id AND transaction_id = NEW.id
      UNION SELECT journal_entry_id FROM public.supplier_invoice_payments
        WHERE company_id = NEW.company_id AND transaction_id = NEW.id
      UNION SELECT j.id FROM public.journal_entries j
        WHERE j.company_id = NEW.company_id AND j.status = 'posted'
          AND ((j.source_type = 'bank_transaction' AND j.source_id = NEW.id)
            OR j.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', NEW.id)))
    LOOP
      PERFORM public.assert_bank_anchor_journal(NEW.company_id, NEW.id, v_entry, v_ledger, NEW.amount, true);
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$;

CREATE FUNCTION public.guard_cash_transaction_anchor()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_transaction public.transactions%ROWTYPE; v_ledger text; v_bank_line boolean := true;
BEGIN
  IF NEW.transaction_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
    AND NEW.transaction_id IS NOT DISTINCT FROM OLD.transaction_id
    AND NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id
    AND (TG_TABLE_NAME <> 'transaction_voucher_links' OR to_jsonb(NEW)->'role' IS NOT DISTINCT FROM to_jsonb(OLD)->'role')
  THEN RETURN NEW; END IF;
  PERFORM public.lock_cash_account_company(NEW.company_id, false);
  PERFORM 1 FROM public.cash_accounts WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  SELECT * INTO v_transaction FROM public.transactions
    WHERE company_id = NEW.company_id AND id = NEW.transaction_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_ANCHOR_TRANSACTION_NOT_FOUND' USING ERRCODE = '23503'; END IF;
  v_ledger := public.bank_anchor_settlement_account(NEW.company_id, v_transaction.cash_account_id, v_transaction.currency);
  IF TG_TABLE_NAME = 'transaction_voucher_links' THEN v_bank_line := NEW.role = 'bank_line'; END IF;
  PERFORM public.assert_bank_anchor_journal(NEW.company_id, v_transaction.id, NEW.journal_entry_id,
    v_ledger, v_transaction.amount, v_bank_line);
  RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$;

CREATE TRIGGER cash_transaction_binding_guard BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_transaction_binding();
CREATE TRIGGER cash_transaction_anchor_guard BEFORE INSERT OR UPDATE ON public.transaction_voucher_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_transaction_anchor();
CREATE TRIGGER cash_transaction_anchor_guard BEFORE INSERT OR UPDATE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_transaction_anchor();
CREATE TRIGGER cash_transaction_anchor_guard BEFORE INSERT OR UPDATE ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_cash_transaction_anchor();

-- A bank link attached while a voucher is a draft must remain valid when its
-- edited lines are posted, including old/manual drafts without stored context.
CREATE FUNCTION public.validate_journal_bank_anchors(p_company_id uuid, p_entry_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_transaction public.transactions%ROWTYPE; v_ledger text;
BEGIN
  PERFORM public.lock_cash_account_company(p_company_id, false);
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR SHARE NOWAIT;
  FOR v_transaction IN
    SELECT t.* FROM public.transactions t WHERE t.company_id = p_company_id AND (
      t.journal_entry_id = p_entry_id
      OR t.id IN (SELECT transaction_id FROM public.transaction_voucher_links
          WHERE company_id = p_company_id AND journal_entry_id = p_entry_id AND role = 'bank_line'
        UNION SELECT transaction_id FROM public.invoice_payments
          WHERE company_id = p_company_id AND journal_entry_id = p_entry_id
        UNION SELECT transaction_id FROM public.supplier_invoice_payments
          WHERE company_id = p_company_id AND journal_entry_id = p_entry_id)
    ) ORDER BY t.id FOR UPDATE OF t NOWAIT
  LOOP
    v_ledger := public.bank_anchor_settlement_account(p_company_id, v_transaction.cash_account_id, v_transaction.currency);
    PERFORM public.assert_bank_anchor_journal(p_company_id, v_transaction.id, p_entry_id, v_ledger, v_transaction.amount, true);
  END LOOP;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$;

DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.guard_bank_booking_context()'::regprocedure);
  v_old text := '  IF jsonb_array_length(NEW.bank_booking_context) = 0 THEN RETURN NEW; END IF;';
BEGIN
  IF position(v_old IN v_definition) = 0 THEN RAISE EXCEPTION 'Unexpected booking context guard'; END IF;
  v_definition := replace(v_definition, v_old,
    E'  PERFORM public.validate_journal_bank_anchors(NEW.company_id, NEW.id);\n' || v_old);
  EXECUTE v_definition;
END;
$migration$;

REVOKE ALL ON FUNCTION public.lock_cash_account_company(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_anchor_settlement_account(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.assert_bank_anchor_journal(uuid, uuid, uuid, text, numeric, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.validate_journal_bank_anchors(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_cash_account_company(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_anchor_settlement_account(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_bank_anchor_journal(uuid, uuid, uuid, text, numeric, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.validate_journal_bank_anchors(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_cash_transaction_binding() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_cash_transaction_anchor() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
