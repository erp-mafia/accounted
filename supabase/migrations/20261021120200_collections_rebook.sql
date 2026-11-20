-- The collections rebook ("Bokför om"): correct a booked payment the
-- collections provider collected (step C).
-- pg-test: tests/pg/collections-rebook.pg.test.ts
--
-- A generic storno of a C voucher is refused (reverseEntry,
-- CANNOT_REVERSE_COLLECTED_PAYMENT) and its payment row cannot be deleted
-- (block_delete_collected_payment, 20261012030300). The rebook service
-- (src/lib/collections/rebook.ts) is the one sanctioned path:
--
--   1. it claims the collected payment (its booking lease) and stornos the C
--      voucher through reverseEntry with the rebook option, which reverses the
--      voucher, reopens the invoice and leaves the collections payment row;
--   2. collections_rebook_release (below) then, in one transaction and only
--      for a C voucher reversed by a posted storno, sets
--      gnubok.collections_rebook, deletes that payment row and puts the
--      collected payment back to pending, remembering the reversed voucher;
--   3. the service books the payment again (settleInvoicePayment).
--
-- A run that dies after 1 finds the voucher reversed and goes on with 2; a
-- run that dies after 2 finds the payment pending and books it.

ALTER TABLE public.collection_collected_payments
  ADD COLUMN rebooked_entry_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.collection_collected_payments.rebooked_entry_ids IS
  'Earlier C vouchers of this payment that the rebook reversed, oldest first; each keeps its storno and its payment record.';

CREATE OR REPLACE FUNCTION public.collections_rebook_release(
  p_company_id uuid,
  p_collected_payment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.collection_collected_payments%ROWTYPE;
  v_entry public.journal_entries%ROWTYPE;
  v_storno_status text;
  v_payment_id uuid;
BEGIN
  SELECT * INTO v_row
    FROM public.collection_collected_payments
   WHERE id = p_collected_payment_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COLLECTIONS_REBOOK_NOT_FOUND: no such collected payment in this company'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status <> 'booked' OR v_row.journal_entry_id IS NULL OR v_row.invoice_payment_id IS NULL THEN
    RAISE EXCEPTION 'COLLECTIONS_REBOOK_NOT_BOOKED: only a booked collected payment can be rebooked'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A payout already cleared this capital: the payout voucher is reversed
  -- first, which unties the payment (settlement-reversal.ts).
  IF v_row.settlement_id IS NOT NULL THEN
    RAISE EXCEPTION 'COLLECTIONS_REBOOK_SETTLED: the payment is part of a booked payout; reverse the payout voucher first'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_entry
    FROM public.journal_entries
   WHERE id = v_row.journal_entry_id AND company_id = p_company_id;
  SELECT s.status INTO v_storno_status
    FROM public.journal_entries s
   WHERE s.id = v_entry.reversed_by_id AND s.company_id = p_company_id AND s.source_type = 'storno';
  IF v_entry.status IS DISTINCT FROM 'reversed' OR v_storno_status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'COLLECTIONS_REBOOK_NOT_REVERSED: the voucher of the collected payment must be reversed by a posted storno first'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT p.id INTO v_payment_id
    FROM public.invoice_payments p
   WHERE p.id = v_row.invoice_payment_id
     AND p.company_id = p_company_id
     AND p.invoice_id = v_row.invoice_id
     AND p.journal_entry_id = v_row.journal_entry_id
     AND p.source = 'collections'
     AND p.external_ref = v_row.provider_payment_ref
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COLLECTIONS_REBOOK_PAYMENT_MISMATCH: the payment row of the collected payment is not the one on its voucher'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The one window block_delete_collected_payment opens, for this statement.
  PERFORM set_config('gnubok.collections_rebook', 'true', true);
  DELETE FROM public.invoice_payments WHERE id = v_payment_id;
  PERFORM set_config('gnubok.collections_rebook', 'false', true);

  UPDATE public.collection_collected_payments
     SET status = 'pending',
         invoice_payment_id = NULL,
         journal_entry_id = NULL,
         payment_record_document_id = NULL,
         booked_by = NULL,
         booked_at = NULL,
         review_reason = NULL,
         booking_lease_until = NULL,
         rebooked_entry_ids = array_append(rebooked_entry_ids, v_row.journal_entry_id)
   WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'reversed_entry_id', v_row.journal_entry_id,
    'storno_entry_id', v_entry.reversed_by_id,
    'invoice_id', v_row.invoice_id
  );
END;
$$;

COMMENT ON FUNCTION public.collections_rebook_release(uuid, uuid) IS
  'Collections rebook step 2: for a collected payment whose C voucher a posted storno reversed, delete its collections payment row (inside the gnubok.collections_rebook window) and put it back to pending. Service role only.';

REVOKE ALL ON FUNCTION public.collections_rebook_release(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collections_rebook_release(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
