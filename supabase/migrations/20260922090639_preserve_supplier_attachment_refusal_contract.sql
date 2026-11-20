-- The invoker attachment historically returns a not-found result when RLS
-- prevents locking its invoice, including a viewer or another company's user.
-- Preserve that contract when the company-first lock refuses the same caller.
DO $contract$
DECLARE
  v_definition text := pg_get_functiondef('public.attach_supplier_invoice_settlement_voucher(uuid,uuid,uuid,uuid,text,boolean)'::regprocedure);
  v_old text := '  PERFORM public.lock_cash_account_company(p_company_id);';
  v_new text := $replacement$  BEGIN
    PERFORM public.lock_cash_account_company(p_company_id);
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND');
  END;$replacement$;
BEGIN
  IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Unexpected supplier attachment definition; lock refusal boundary is ambiguous';
  END IF;
  EXECUTE replace(v_definition,v_old,v_new);
END;
$contract$;
NOTIFY pgrst, 'reload schema';
