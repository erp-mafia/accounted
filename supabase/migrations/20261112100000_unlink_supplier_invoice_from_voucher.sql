-- pg-test: tests/pg/unlink-supplier-invoice-voucher.pg.test.ts
-- Undo a link between a supplier invoice and an existing verifikat.
--
-- link_supplier_invoice_to_voucher marks an invoice paid by pointing a
-- supplier_invoice_payments row at a verifikat that is already in the books
-- (the person's "Befintlig verifikation", the auto-linker, the provider
-- migration). It writes no bookkeeping on a SEK invoice. Nothing could take
-- such a link back: when the wrong verifikat was linked the invoice stayed
-- paid, and the verifikat itself is right, so a storno is the wrong tool.
--
-- unlink_supplier_invoice_from_voucher is the exact inverse for that one kind
-- of row: it deletes the payment row and gives the invoice its amount back.
-- It never creates, changes or deletes a journal entry.
--
-- Only a plain link is taken back. Everything else that can sit in
-- supplier_invoice_payments with a verifikat and no bank row is refused, with
-- its own code and nothing written:
--   - a row booked from a bank row (transaction_id): the match is undone
--     where it was made;
--   - a row without a verifikat (the reskontra import, a deleted verifikat);
--   - the row of a kvittning (counterparty_setoffs points at it): the
--     set-off's storno gives both invoices back;
--   - a settlement-evidence row (attach_supplier_invoice_settlement_voucher):
--     it never advanced the invoice, so there is no amount to give back;
--   - a row whose verifikat is a payment verifikat (invoice_paid,
--     invoice_cash_payment, supplier_invoice_paid,
--     supplier_invoice_cash_payment: PAYMENT_SOURCE_TYPES in
--     src/lib/bookkeeping/payment-sync.ts), an utlägg, or the invoice's own
--     payment_journal_entry_id: those payments are undone by a storno of the
--     verifikat, which reverts the invoice itself;
--   - a foreign-currency invoice or row, or a row that carries a settlement
--     rate: the link may have booked a kursdifferens verifikat with it
--     (20260830140000), and that one is not undone here;
--   - an invoice that is no longer paid or partially paid (credited since);
--   - a posted kontantmetod cut-off that counted the invoice as paid at the
--     year end: the same predicate the link and the attach refuse on.
--
-- What hangs on the row and is handled:
--   - payment_orders.supplier_invoice_payment_id: the BEFORE DELETE trigger
--     unsettle_payment_order_on_supplier_payment_delete (20261010090100)
--     clears the order's settlement, as it does for any undone match;
--   - transactions.supplier_invoice_id: the link's TypeScript wrapper
--     reconciles the verifikat's bank row to the verifikat and tags the row
--     with the invoice. The reconciliation says which bank row the verifikat
--     books and stays; the tag says the row paid this invoice and is cleared.
--
-- Locks and authorisation are the link's: the tenant guard, the company's
-- cash-account lock, the advisory lock on the verifikat, then the invoice row.
-- A closed or locked period does not refuse, as on the link: the row is
-- reskontra and no verifikat is written.
--
-- supplier_invoice_payments has no audit trigger, so the removed row is kept
-- whole in audit_log; the invoice's own change is logged by its trigger.

CREATE OR REPLACE FUNCTION public.unlink_supplier_invoice_from_voucher(
  p_company_id uuid,
  p_user_id uuid,
  p_supplier_invoice_id uuid,
  p_payment_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_acting_user uuid := p_user_id;
  v_invoice RECORD;
  v_payment RECORD;
  v_voucher RECORD;
  v_entry_id uuid;
  v_amount numeric;
  v_total numeric;
  v_remaining numeric;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_cleared_tags integer := 0;
  v_document_on_voucher boolean := false;
BEGIN
  -- Tenant guard, as in link_supplier_invoice_to_voucher: anon/authenticated
  -- may only act on their own companies and answer for themselves.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_NOT_FOUND');
    END IF;
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  END IF;

  IF p_payment_id IS NULL OR p_supplier_invoice_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_NOT_FOUND');
  END IF;

  PERFORM public.lock_cash_account_company(p_company_id);

  -- The verifikat the row points at names the advisory lock, so it is read
  -- once before the locks and checked again under them.
  SELECT p.journal_entry_id INTO v_entry_id
  FROM public.supplier_invoice_payments p
  WHERE p.id = p_payment_id
    AND p.company_id = p_company_id
    AND p.supplier_invoice_id = p_supplier_invoice_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_NOT_FOUND');
  END IF;

  -- Verifikat first, then the invoice row: the link's key and the link's order.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('si-settlement-voucher:' || COALESCE(v_entry_id::text, ''), 0)
  );

  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_NOT_FOUND');
  END IF;

  SELECT * INTO v_payment
  FROM public.supplier_invoice_payments
  WHERE id = p_payment_id
    AND company_id = p_company_id
    AND supplier_invoice_id = p_supplier_invoice_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_NOT_FOUND');
  END IF;
  -- The row was re-pointed between the read and the locks: the advisory lock
  -- taken above is not the one for the verifikat it names now.
  IF v_payment.journal_entry_id IS DISTINCT FROM v_entry_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_NOT_FOUND');
  END IF;

  -- ===== Refusals: nothing below this block runs unless all of them pass =====

  IF v_payment.transaction_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_NOT_A_LINK',
      'details', jsonb_build_object('reason', 'bank_transaction'));
  END IF;

  IF v_payment.journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_NOT_A_LINK',
      'details', jsonb_build_object('reason', 'no_voucher'));
  END IF;

  SELECT id, source_type, source_id, voucher_series, voucher_number, entry_date
    INTO v_voucher
  FROM public.journal_entries
  WHERE id = v_payment.journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_NOT_A_LINK',
      'details', jsonb_build_object('reason', 'no_voucher'));
  END IF;

  -- A kvittning: the set-off row points at this payment row, and its storno
  -- (reverse_counterparty_setoff) is what gives both invoices back.
  IF v_voucher.source_type = 'counterparty_setoff'
     OR EXISTS (
       SELECT 1 FROM public.counterparty_setoffs cs
       WHERE cs.company_id = p_company_id
         AND cs.supplier_invoice_payment_id = p_payment_id
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_SETOFF');
  END IF;

  -- attach_supplier_invoice_settlement_voucher marks every row it writes with
  -- this prefix. Such a row explains a settlement that already stood: it
  -- never moved paid_amount, so taking the amount back would be wrong.
  IF v_payment.notes LIKE 'settlement-evidence%' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_SETTLEMENT_EVIDENCE');
  END IF;

  -- The payment's own verifikat: undone by its storno, which reverts the
  -- invoice (payment-sync.ts, delete_last_voucher).
  IF v_voucher.source_type IN ('invoice_paid', 'invoice_cash_payment',
                               'supplier_invoice_paid', 'supplier_invoice_cash_payment',
                               'expense_claim')
     OR v_invoice.payment_journal_entry_id = v_payment.journal_entry_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_PAYMENT_VOUCHER',
      'details', jsonb_build_object(
        'source_type', v_voucher.source_type,
        'voucher_series', v_voucher.voucher_series,
        'voucher_number', v_voucher.voucher_number));
  END IF;

  -- A foreign-currency link may have booked a kursdifferens verifikat
  -- (3960 / 7960) beside the row. That verifikat is not undone here, so the
  -- whole case is refused: the row's rate is the marker the link leaves, the
  -- currency the wider net around it.
  IF COALESCE(v_invoice.currency, 'SEK') <> 'SEK'
     OR COALESCE(v_payment.currency, 'SEK') <> 'SEK'
     OR v_payment.payment_exchange_rate IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_FOREIGN_CURRENCY',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'payment_currency', v_payment.currency));
  END IF;

  -- Only an invoice the link still holds settled. A credited (or disputed)
  -- invoice has moved on, and its status is not this function's to rewrite.
  IF v_invoice.status NOT IN ('paid', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_INVOICE_NOT_SETTLED',
      'details', jsonb_build_object('status', v_invoice.status));
  END IF;

  -- A posted kontantmetod cut-off for a year ending on E counted this invoice
  -- as paid when the invoice is dated on or before E and this row is too.
  -- Taking the row away would make a recomputation disagree with that posted
  -- verifikat. Same predicate as the link (20261011153000) and the attach
  -- (20260921084700); the cut-off is corrected first.
  IF EXISTS (
    SELECT 1
    FROM public.kontantmetod_cutoff_entries k
    JOIN public.journal_entries cje ON cje.id = k.journal_entry_id
    JOIN public.fiscal_periods fp ON fp.id = k.fiscal_period_id
    WHERE k.company_id = p_company_id
      AND k.kind = 'payable'
      AND cje.status = 'posted'
      AND fp.period_end >= v_payment.payment_date
      AND fp.period_end >= v_invoice.invoice_date
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED',
      'details', jsonb_build_object(
        'payment_date', v_payment.payment_date,
        'invoice_date', v_invoice.invoice_date));
  END IF;

  -- ===== The undo =====

  v_amount := ROUND(COALESCE(v_payment.amount, 0) * 100) / 100;
  v_total := ROUND(COALESCE(v_invoice.total, 0) * 100) / 100;
  v_remaining := COALESCE(v_invoice.remaining_amount, v_invoice.total - COALESCE(v_invoice.paid_amount, 0));

  -- The link added the row's amount to paid_amount and took it off
  -- remaining_amount; this takes it back the same way. Never below zero paid,
  -- never more left than the invoice's total.
  v_new_paid := GREATEST(0, ROUND((COALESCE(v_invoice.paid_amount, 0) - v_amount) * 100) / 100);
  v_new_remaining := LEAST(v_total, ROUND((COALESCE(v_remaining, 0) + v_amount) * 100) / 100);

  -- Back to what the row's own facts say, as delete_last_voucher and
  -- reverse_counterparty_setoff do: 'approved' only if someone attested it.
  v_new_status := CASE
    WHEN v_new_paid > 0 THEN 'partially_paid'
    WHEN v_invoice.due_date IS NOT NULL
         AND v_invoice.due_date < public.stockholm_today()
         AND NOT COALESCE(v_invoice.is_credit_note, false) THEN 'overdue'
    WHEN v_invoice.approved_at IS NOT NULL THEN 'approved'
    ELSE 'registered'
  END;

  -- Fires unsettle_payment_order_on_supplier_payment_delete for a bank payment
  -- order this row had settled.
  DELETE FROM public.supplier_invoice_payments
  WHERE id = p_payment_id AND company_id = p_company_id;

  UPDATE public.supplier_invoices
  SET status = v_new_status,
      paid_at = NULL,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      updated_at = now()
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id;

  -- The bank row the link's wrapper reconciled to this verifikat keeps that
  -- reconciliation (it is the verifikat's bank row whichever invoice it
  -- pays), but no longer says it paid this invoice. A bank row another of the
  -- invoice's payment rows was booked from keeps its tag.
  UPDATE public.transactions t
  SET supplier_invoice_id = NULL
  WHERE t.company_id = p_company_id
    AND t.supplier_invoice_id = p_supplier_invoice_id
    AND t.journal_entry_id = v_payment.journal_entry_id
    AND NOT EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments o
      WHERE o.company_id = p_company_id
        AND o.supplier_invoice_id = p_supplier_invoice_id
        AND o.transaction_id = t.id
    );
  GET DIAGNOSTICS v_cleared_tags = ROW_COUNT;

  -- The link may have anchored the invoice's floating document on the
  -- verifikat (anchorSupplierInvoiceDocument). A document on a posted
  -- verifikat is never moved (BFL 5 kap 6 §), so it stays; the caller is told.
  IF v_invoice.document_id IS NOT NULL THEN
    v_document_on_voucher := EXISTS (
      SELECT 1 FROM public.document_attachments d
      WHERE d.id = v_invoice.document_id
        AND d.company_id = p_company_id
        AND d.journal_entry_id = v_payment.journal_entry_id
    );
  END IF;

  INSERT INTO public.audit_log
    (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    COALESCE(v_acting_user, v_payment.user_id),
    p_company_id,
    'DELETE',
    'supplier_invoice_payments',
    p_payment_id,
    v_acting_user,
    to_jsonb(v_payment),
    NULL,
    'Unlinked verifikat ' || COALESCE(v_voucher.voucher_series, '') || COALESCE(v_voucher.voucher_number::text, '')
      || ' from supplier invoice (unlink_supplier_invoice_from_voucher)',
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', p_payment_id,
    'journal_entry_id', v_payment.journal_entry_id,
    'unlinked_amount', v_amount,
    'invoice_status', v_new_status,
    'paid_amount', v_new_paid,
    'remaining_amount', v_new_remaining,
    'cleared_transaction_tags', v_cleared_tags,
    'document_on_voucher', v_document_on_voucher
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.unlink_supplier_invoice_from_voucher(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_supplier_invoice_from_voucher(uuid, uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.unlink_supplier_invoice_from_voucher(uuid, uuid, uuid, uuid) IS
  'Undo a plain link made by link_supplier_invoice_to_voucher: deletes the supplier_invoice_payments row (journal_entry_id set, transaction_id NULL) and gives the invoice its amount back (paid_amount, remaining_amount, paid_at NULL, status partially_paid / overdue / approved / registered from the row''s own facts). Never writes to the journal. Refuses, with nothing written: a row booked from a bank row or without a verifikat (UNLINK_SI_VOUCHER_NOT_A_LINK), a kvittning row (UNLINK_SI_VOUCHER_SETOFF), a settlement-evidence row (UNLINK_SI_VOUCHER_SETTLEMENT_EVIDENCE), a row on a payment verifikat or the invoice''s own payment_journal_entry_id (UNLINK_SI_VOUCHER_PAYMENT_VOUCHER: storno it), a foreign-currency invoice or row (UNLINK_SI_VOUCHER_FOREIGN_CURRENCY: a kursdifferens verifikat may hang on it), an invoice no longer paid or partially paid (UNLINK_SI_VOUCHER_INVOICE_NOT_SETTLED) and a posted kontantmetod cut-off the row was counted in (UNLINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED). A payment order the row settled is unsettled by the row''s BEFORE DELETE trigger; the invoice tag on the verifikat''s bank row is cleared, the row''s reconciliation to the verifikat stays. The removed row is kept in audit_log.';

NOTIFY pgrst, 'reload schema';
