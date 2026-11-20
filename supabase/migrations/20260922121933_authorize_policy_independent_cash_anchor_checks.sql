-- Anchor visibility is an integrity decision, independent of caller RLS.
-- Authorize the company before inspecting privileged cross-table state.
CREATE OR REPLACE FUNCTION public.cash_transaction_is_movable(p_company_id uuid, p_transaction_id uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = p_transaction_id AND t.company_id = p_company_id
      AND t.journal_entry_id IS NULL AND t.invoice_id IS NULL AND t.supplier_invoice_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links a WHERE a.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM public.invoice_payments a WHERE a.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_payments a WHERE a.transaction_id = t.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entries j WHERE j.company_id = p_company_id AND j.status = 'posted'
          AND ((j.source_type = 'bank_transaction' AND j.source_id = t.id)
            OR j.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', t.id)))
      )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cash_transaction_is_movable(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_transaction_is_movable(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
