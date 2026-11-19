-- A bank_line junction slice is checked in its own direction.
--
-- 20260921183218 (guard_cash_transaction_anchor, validate_journal_bank_anchors)
-- asserts that a verifikat anchored to a bank row books on the row's bank
-- ledger in the ROW's direction. That is right for every whole-row anchor: the
-- pointer (transactions.journal_entry_id), the invoice and supplier-invoice
-- payment rows, and the bank_line junction row bulk_book_transactions writes
-- with allocated_amount = the row amount. It is wrong for a 1:N split
-- (linkTransactionToVouchers): a bulk payment that nets a credit note, or a
-- card-processor payout net of its fee, settles verifikat booked in BOTH
-- directions. The split already refuses a slice whose sign differs from its
-- verifikat's net line on the account, so the trigger refused exactly the
-- splits the engine had validated: the insert raised
-- BANK_ANCHOR_SETTLEMENT_CHANGED on the opposite-sign slice and the caller saw
-- a generic write failure (agent feedback seq 853921, 877706).
--
-- Now a bank_line junction row asserts the direction of its own slice
-- (allocated_amount). Whole-row anchors keep the row's direction, and every
-- other bank_line writer stores allocated_amount = the row amount, so nothing
-- they write is judged differently. A slice whose sign contradicts its
-- verifikat still raises, as does a wrong-direction 1:1 link. Flipping a
-- slice's sign on UPDATE is re-checked like a changed journal reference.
--
-- Bodies are the latest definitions: 20260921183218 as rewritten in place by
-- 20260922102109 (observe_cash_account_company instead of the exclusive
-- company lock). assert_bank_anchor_journal is unchanged.

CREATE OR REPLACE FUNCTION public.guard_cash_transaction_anchor()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_transaction public.transactions%ROWTYPE; v_ledger text; v_bank_line boolean := true; v_amount numeric;
BEGIN
  IF NEW.transaction_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
    AND NEW.transaction_id IS NOT DISTINCT FROM OLD.transaction_id
    AND NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id
    AND (TG_TABLE_NAME <> 'transaction_voucher_links' OR (
      to_jsonb(NEW)->'role' IS NOT DISTINCT FROM to_jsonb(OLD)->'role'
      AND sign((to_jsonb(NEW)->>'allocated_amount')::numeric)
        IS NOT DISTINCT FROM sign((to_jsonb(OLD)->>'allocated_amount')::numeric)))
  THEN RETURN NEW; END IF;
  PERFORM public.observe_cash_account_company(NEW.company_id);
  PERFORM 1 FROM public.cash_accounts WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  SELECT * INTO v_transaction FROM public.transactions
    WHERE company_id = NEW.company_id AND id = NEW.transaction_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_ANCHOR_TRANSACTION_NOT_FOUND' USING ERRCODE = '23503'; END IF;
  v_ledger := public.bank_anchor_settlement_account(NEW.company_id, v_transaction.cash_account_id, v_transaction.currency);
  v_amount := v_transaction.amount;
  IF TG_TABLE_NAME = 'transaction_voucher_links' THEN
    v_bank_line := NEW.role = 'bank_line';
    -- The slice this verifikat settles, in its own direction: a 1:N split
    -- may net verifikat booked in both directions into one bank row.
    v_amount := NEW.allocated_amount;
  END IF;
  PERFORM public.assert_bank_anchor_journal(NEW.company_id, v_transaction.id, NEW.journal_entry_id,
    v_ledger, v_amount, v_bank_line);
  RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$;

-- Posting a draft that already carries bank links re-validates them: the
-- whole-row anchors in the row's direction, each bank_line slice in its own.
CREATE OR REPLACE FUNCTION public.validate_journal_bank_anchors(p_company_id uuid, p_entry_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_transaction public.transactions%ROWTYPE; v_ledger text; v_slice numeric;
BEGIN
  PERFORM public.observe_cash_account_company(p_company_id);
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
    IF v_transaction.journal_entry_id = p_entry_id
       OR EXISTS (SELECT 1 FROM public.invoice_payments
         WHERE company_id = p_company_id AND journal_entry_id = p_entry_id AND transaction_id = v_transaction.id)
       OR EXISTS (SELECT 1 FROM public.supplier_invoice_payments
         WHERE company_id = p_company_id AND journal_entry_id = p_entry_id AND transaction_id = v_transaction.id)
    THEN
      PERFORM public.assert_bank_anchor_journal(p_company_id, v_transaction.id, p_entry_id, v_ledger, v_transaction.amount, true);
    END IF;
    FOR v_slice IN
      SELECT allocated_amount FROM public.transaction_voucher_links
        WHERE company_id = p_company_id AND journal_entry_id = p_entry_id
          AND transaction_id = v_transaction.id AND role = 'bank_line'
    LOOP
      PERFORM public.assert_bank_anchor_journal(p_company_id, v_transaction.id, p_entry_id, v_ledger, v_slice, true);
    END LOOP;
  END LOOP;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$;

-- CREATE OR REPLACE keeps the ACLs; re-asserted so this file stands alone on a
-- fresh replay (20260921183218).
REVOKE ALL ON FUNCTION public.validate_journal_bank_anchors(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_journal_bank_anchors(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_cash_transaction_anchor() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
