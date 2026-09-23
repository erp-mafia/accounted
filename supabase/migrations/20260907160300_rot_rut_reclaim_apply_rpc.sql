-- Rot & rut: atomic, idempotent apply of one reclaimed share to its invoice.
--
-- lib/invoices/rot-rut-reclaim.ts books the reclaim voucher (debit 1510 /
-- credit 1513), attaches it to the begäran, and then reopens every invoice
-- for its refused share. Those last writes used to be two UPDATEs per invoice
-- (invoices, then rot_rut_payout_request_items). A failure between the
-- voucher and the invoice update left the ledger reclaimed while the invoice
-- still read as paid, and the next call was refused as already done
-- (CodeRabbit on #2397). This function makes the per-invoice step one
-- transaction with the item row as the idempotency marker:
--
--   reclaimed_amount IS NULL on the item  ->  apply both writes, return true
--   already set                            ->  touch nothing, return false
--
-- so the service can resume after a partial failure by re-applying every
-- leg: applied legs are no-ops, missing legs complete. SECURITY INVOKER so
-- RLS still scopes the rows; the company id is checked explicitly on the
-- invoice as defense in depth (service-role callers have no RLS).

CREATE OR REPLACE FUNCTION public.apply_rot_rut_reclaim_invoice(
  p_item_id uuid,
  p_invoice_id uuid,
  p_company_id uuid,
  p_reclaimed_amount numeric,
  p_remaining_amount numeric,
  p_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF p_reclaimed_amount IS NULL OR p_reclaimed_amount <= 0 THEN
    RAISE EXCEPTION 'apply_rot_rut_reclaim_invoice: reclaimed amount must be positive';
  END IF;

  UPDATE public.rot_rut_payout_request_items
  SET reclaimed_amount = p_reclaimed_amount
  WHERE id = p_item_id
    AND invoice_id = p_invoice_id
    AND reclaimed_amount IS NULL;

  IF NOT FOUND THEN
    -- Already applied (marker set) or not this invoice's item: nothing to do.
    RETURN false;
  END IF;

  UPDATE public.invoices
  SET deduction_reclaimed_total = COALESCE(deduction_reclaimed_total, 0) + p_reclaimed_amount,
      remaining_amount = p_remaining_amount,
      status = p_status
  WHERE id = p_invoice_id
    AND company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_rot_rut_reclaim_invoice: invoice % not found in company %',
      p_invoice_id, p_company_id;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_rot_rut_reclaim_invoice(uuid, uuid, uuid, numeric, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_rot_rut_reclaim_invoice(uuid, uuid, uuid, numeric, numeric, text) TO service_role;

NOTIFY pgrst, 'reload schema';
