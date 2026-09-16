-- Undo a supplier-invoice payment that only LINKS an existing verifikat.
--
-- link_supplier_invoice_to_voucher (20260529130000, current shape in
-- 20260726140000) settles a payable against a voucher that already exists in
-- the ledger: it writes a supplier_invoice_payments row and advances the
-- invoice, and creates no journal entry. Nothing could undo it. A wrong link,
-- including one the migration reconcile pass made unattended, could only be
-- removed by someone with database access (issue #2673): the payment history
-- in the UI is read-only, the invoice cannot be deleted while a payment row
-- exists, and reverseEntry's cleanup (lib/bookkeeping/payment-sync.ts) skips
-- these rows because it only runs for entries whose source_type is a payment
-- type. Stornoing the linked voucher would also be wrong: it is a real
-- payment to someone, merely pointed at the wrong payable.
--
-- The complement is exact, and is what makes this safe to expose:
--
--   * a payment row whose journal entry IS a payment Accounted booked
--     (source_type in supplier_invoice_paid / supplier_invoice_cash_payment,
--     and the customer-side pair) is owned by the storno path, which reverses
--     the entry and the row together. This function refuses those.
--   * a payment row whose journal entry is anything else (an SIE-imported
--     voucher, a manual one) is a pure subledger pointer. Deleting it changes
--     no bookkeeping at all, because the link never wrote any.
--
-- Every payment row is therefore reversible by exactly one path, and the two
-- cannot overlap. No journal entry, line or document is touched here, so no
-- enforcement trigger is involved and no period lock applies: the ledger the
-- locks protect is not what changes.
--
-- Scoped to the supplier side on purpose. The customer twin
-- (link_invoice_to_voucher) has the same gap, but invoices.remaining_amount is
-- the ROT/RUT-NET customer share, whose single definition lives in
-- lib/invoices/customer-share.ts; re-deriving it in PL/pgSQL would duplicate a
-- definition rather than reuse one. See the PR body.

CREATE OR REPLACE FUNCTION public.unlink_supplier_invoice_from_voucher(
  p_payment_id uuid,
  p_supplier_invoice_id uuid,
  p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payment RECORD;
  v_invoice RECORD;
  v_voucher RECORD;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_now timestamptz := now();
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  -- The four source types whose reversal reverseEntry / the DELETE voucher
  -- route already own (lib/bookkeeping/payment-sync.ts PAYMENT_SOURCE_TYPES).
  -- Both customer values are listed too: the set is the shared definition, and
  -- a supplier payment row pointing at one of them is corrupt either way.
  v_booked_payment_types text[] := ARRAY[
    'invoice_paid', 'invoice_cash_payment',
    'supplier_invoice_paid', 'supplier_invoice_cash_payment'
  ];
BEGIN
  -- Tenant guard, verbatim in shape from link_supplier_invoice_to_voucher
  -- (20260615120000): anon/authenticated may only act on their own companies;
  -- service_role and direct access bypass it.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id NOT IN (SELECT public.user_company_ids()) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_FOUND');
    END IF;
  END IF;

  -- Scoped by the invoice as well as the payment: the caller addresses this
  -- through /supplier-invoices/[id]/payments/[paymentId], and a payment id that
  -- belongs to a different payable in the same company must miss, not succeed
  -- against the wrong parent.
  SELECT * INTO v_payment
  FROM public.supplier_invoice_payments
  WHERE id = p_payment_id
    AND supplier_invoice_id = p_supplier_invoice_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_FOUND');
  END IF;

  -- A row with no verifikat was not written by the link path, which always
  -- names one. Refusing keeps this function to the one shape it can reason
  -- about instead of becoming a general payment-row eraser.
  IF v_payment.journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_A_LINK');
  END IF;

  SELECT * INTO v_voucher
  FROM public.journal_entries
  WHERE id = v_payment.journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_A_LINK');
  END IF;

  IF v_voucher.source_type = ANY (v_booked_payment_types) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNLINK_SI_PAYMENT_BOOKED_PAYMENT',
      'details', jsonb_build_object(
        'source_type', v_voucher.source_type,
        'journal_entry_id', v_voucher.id
      )
    );
  END IF;

  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = v_payment.supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNLINK_SI_PAYMENT_NOT_FOUND');
  END IF;

  -- 'credited' and 'reversed' mean another lifecycle step has already decided
  -- this invoice's fate; restoring a payable status would contradict it.
  IF v_invoice.status NOT IN ('paid', 'partially_paid') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'UNLINK_SI_PAYMENT_INVOICE_NOT_SETTLED',
      'details', jsonb_build_object('status', v_invoice.status)
    );
  END IF;

  v_new_paid := GREATEST(0, ROUND((COALESCE(v_invoice.paid_amount, 0) - v_payment.amount) * 100) / 100);
  v_new_remaining := GREATEST(0, ROUND((v_invoice.total - v_new_paid) * 100) / 100);

  -- Restore the payable status the invoice would have had. payment-sync falls
  -- back to 'approved' unconditionally; reading approved_at instead keeps an
  -- invoice that was never approved from being silently approved by an undo.
  v_new_status := CASE
    WHEN v_new_paid > 0.005 THEN 'partially_paid'
    WHEN v_invoice.due_date IS NOT NULL AND v_invoice.due_date < current_date THEN 'overdue'
    WHEN v_invoice.approved_at IS NOT NULL THEN 'approved'
    ELSE 'registered'
  END;

  UPDATE public.supplier_invoices
  SET status = v_new_status,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      paid_at = CASE WHEN v_new_paid > 0.005 THEN paid_at ELSE NULL END,
      payment_journal_entry_id = CASE
        WHEN payment_journal_entry_id = v_payment.journal_entry_id THEN NULL
        ELSE payment_journal_entry_id
      END,
      updated_at = v_now
  WHERE id = v_invoice.id;

  -- Hard delete, as the storno path does: a soft-deleted row would still trip
  -- the uniqueness the link checks (invoice + entry) and double-count a
  -- re-match. The audit trail is written by the caller into audit_log, which
  -- behandlingshistorik reads.
  DELETE FROM public.supplier_invoice_payments WHERE id = v_payment.id;

  RETURN jsonb_build_object(
    'ok', true,
    'supplier_invoice_id', v_invoice.id,
    'journal_entry_id', v_payment.journal_entry_id,
    'transaction_id', v_payment.transaction_id,
    'payment_amount', v_payment.amount,
    'invoice_status', v_new_status,
    'paid_amount', v_new_paid,
    'remaining_amount', v_new_remaining
  );
END;
$$;

COMMENT ON FUNCTION public.unlink_supplier_invoice_from_voucher(uuid, uuid, uuid) IS
  'Removes a supplier_invoice_payments row that only links an existing verifikat, and restores the invoice status/paid/remaining. Refuses rows whose entry is a payment Accounted booked (storno owns those) and rows with no entry. Touches no journal entry.';

REVOKE ALL ON FUNCTION public.unlink_supplier_invoice_from_voucher(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_supplier_invoice_from_voucher(uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
