-- Rot & rut reclaim RPCs: the database owns the accounting values.
--
-- 20260907160300 let the caller supply remaining_amount and status. Review
-- (#2397, CWE-862): any writer-role member could call the function with
-- arbitrary values for an invoice they can see. This migration replaces it
-- with a function that takes only the reclaimed amount, VALIDATES it against
-- the locked item, request and invoice rows, and DERIVES remaining_amount and
-- status from the same formula as the INSERT guard
-- (invoices_derive_remaining_amount: total - paid - deduction + reclaimed),
-- and adds the mirror used when the reclaim voucher is reversed. Both are
-- idempotent through the item marker (reclaimed_amount): a second call is a
-- no-op, so a failed batch can be re-run leg by leg.
--
-- Returns jsonb { applied, remaining_amount, status } so the caller can
-- report what the row now says without a second read.

DROP FUNCTION IF EXISTS public.apply_rot_rut_reclaim_invoice(uuid, uuid, uuid, numeric, numeric, text);

CREATE OR REPLACE FUNCTION public.rot_rut_customer_outstanding(
  p_total numeric,
  p_paid numeric,
  p_deduction numeric,
  p_reclaimed numeric
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT GREATEST(0, ROUND((COALESCE(p_total, 0) - COALESCE(p_paid, 0)
                            - COALESCE(p_deduction, 0) + COALESCE(p_reclaimed, 0))::numeric, 2));
$$;

CREATE OR REPLACE FUNCTION public.apply_rot_rut_reclaim_invoice(
  p_item_id uuid,
  p_invoice_id uuid,
  p_company_id uuid,
  p_reclaimed_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item          public.rot_rut_payout_request_items%ROWTYPE;
  v_request       public.rot_rut_payout_requests%ROWTYPE;
  v_invoice       public.invoices%ROWTYPE;
  v_paid          numeric;
  v_remaining     numeric;
  v_status        text;
  v_request_refused numeric;
BEGIN
  IF p_reclaimed_amount IS NULL OR p_reclaimed_amount <= 0 THEN
    RAISE EXCEPTION 'apply_rot_rut_reclaim_invoice: reclaimed amount must be positive';
  END IF;

  SELECT * INTO v_item
  FROM public.rot_rut_payout_request_items
  WHERE id = p_item_id AND invoice_id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_rot_rut_reclaim_invoice: item % not found for invoice %', p_item_id, p_invoice_id;
  END IF;
  IF v_item.reclaimed_amount IS NOT NULL THEN
    -- Already applied: idempotent no-op.
    RETURN jsonb_build_object('applied', false);
  END IF;

  SELECT * INTO v_request
  FROM public.rot_rut_payout_requests
  WHERE id = v_item.request_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_rot_rut_reclaim_invoice: request for item % not found in company %', p_item_id, p_company_id;
  END IF;
  IF v_request.decided_at IS NULL OR v_request.decided_total IS NULL THEN
    RAISE EXCEPTION 'apply_rot_rut_reclaim_invoice: no beslut recorded on request %', v_request.id;
  END IF;
  IF v_request.reclaim_journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'apply_rot_rut_reclaim_invoice: request % has no reclaim voucher', v_request.id;
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_rot_rut_reclaim_invoice: invoice % not found in company %', p_invoice_id, p_company_id;
  END IF;

  -- The refused share can never exceed what the item requested, what the
  -- beslut refused for the whole request, or what the invoice still carries
  -- on 1513.
  v_request_refused := GREATEST(0, v_request.requested_total - v_request.decided_total);
  IF p_reclaimed_amount > v_item.requested_amount + 0.005
     OR p_reclaimed_amount > v_request_refused + 0.005
     OR p_reclaimed_amount > COALESCE(v_invoice.deduction_total, 0) - COALESCE(v_invoice.deduction_reclaimed_total, 0) + 0.005 THEN
    RAISE EXCEPTION 'apply_rot_rut_reclaim_invoice: reclaimed amount % exceeds the refused share for item %', p_reclaimed_amount, p_item_id;
  END IF;

  -- A paid invoice with NULL paid_amount (older settlement paths) has settled
  -- its customer share: that share stands in for the missing figure.
  v_paid := COALESCE(
    v_invoice.paid_amount,
    CASE WHEN v_invoice.status = 'paid'
         THEN v_invoice.total - COALESCE(v_invoice.deduction_total, 0)
         ELSE 0 END
  );
  v_remaining := public.rot_rut_customer_outstanding(
    v_invoice.total, v_paid, v_invoice.deduction_total,
    COALESCE(v_invoice.deduction_reclaimed_total, 0) + p_reclaimed_amount
  );
  v_status := v_invoice.status;
  IF v_remaining > 0 THEN
    IF v_paid > 0 THEN
      v_status := 'partially_paid';
    ELSIF v_invoice.status = 'overdue' THEN
      v_status := 'overdue';
    ELSE
      v_status := 'sent';
    END IF;
  END IF;

  UPDATE public.rot_rut_payout_request_items
  SET reclaimed_amount = p_reclaimed_amount
  WHERE id = p_item_id;

  UPDATE public.invoices
  SET deduction_reclaimed_total = COALESCE(deduction_reclaimed_total, 0) + p_reclaimed_amount,
      remaining_amount = v_remaining,
      status = v_status
  WHERE id = p_invoice_id AND company_id = p_company_id;

  RETURN jsonb_build_object('applied', true, 'remaining_amount', v_remaining, 'status', v_status);
END;
$$;

-- Mirror for a reversed reclaim voucher: the item marker is the amount to
-- hand back; a NULL marker means this leg is already reverted (no-op).
CREATE OR REPLACE FUNCTION public.revert_rot_rut_reclaim_invoice(
  p_item_id uuid,
  p_invoice_id uuid,
  p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_item      public.rot_rut_payout_request_items%ROWTYPE;
  v_invoice   public.invoices%ROWTYPE;
  v_paid      numeric;
  v_reclaimed numeric;
  v_remaining numeric;
  v_status    text;
BEGIN
  SELECT * INTO v_item
  FROM public.rot_rut_payout_request_items
  WHERE id = p_item_id AND invoice_id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revert_rot_rut_reclaim_invoice: item % not found for invoice %', p_item_id, p_invoice_id;
  END IF;
  IF v_item.reclaimed_amount IS NULL THEN
    RETURN jsonb_build_object('reverted', false);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rot_rut_payout_requests
    WHERE id = v_item.request_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'revert_rot_rut_reclaim_invoice: request for item % not found in company %', p_item_id, p_company_id;
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revert_rot_rut_reclaim_invoice: invoice % not found in company %', p_invoice_id, p_company_id;
  END IF;

  v_reclaimed := GREATEST(0, COALESCE(v_invoice.deduction_reclaimed_total, 0) - v_item.reclaimed_amount);
  v_paid := COALESCE(v_invoice.paid_amount, 0);
  v_remaining := public.rot_rut_customer_outstanding(
    v_invoice.total, v_paid, v_invoice.deduction_total, v_reclaimed
  );
  v_status := v_invoice.status;
  IF v_invoice.status IN ('sent', 'overdue', 'partially_paid', 'paid') THEN
    IF v_remaining <= 0 AND v_paid > 0 THEN
      v_status := 'paid';
    ELSIF v_paid > 0 THEN
      v_status := 'partially_paid';
    ELSIF v_invoice.due_date IS NOT NULL AND v_invoice.due_date < CURRENT_DATE THEN
      v_status := 'overdue';
    ELSE
      v_status := 'sent';
    END IF;
  END IF;

  UPDATE public.rot_rut_payout_request_items
  SET reclaimed_amount = NULL
  WHERE id = p_item_id;

  UPDATE public.invoices
  SET deduction_reclaimed_total = v_reclaimed,
      remaining_amount = v_remaining,
      status = v_status
  WHERE id = p_invoice_id AND company_id = p_company_id;

  RETURN jsonb_build_object('reverted', true, 'remaining_amount', v_remaining, 'status', v_status);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rot_rut_customer_outstanding(numeric, numeric, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_rot_rut_reclaim_invoice(uuid, uuid, uuid, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revert_rot_rut_reclaim_invoice(uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
