-- Reconciliation can replace a non-posted pointer and bind to the voucher's
-- sibling ledger in one UPDATE. Keep that existing explicit operation, while
-- automatic promotion still preserves every non-null pointer. A separate
-- payment, invoice, junction or posted origin remains a binding claim.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.guard_cash_transaction_binding()'::regprocedure);
  v_old text := $old$  IF v_binding_changed AND OLD.cash_account_id IS NOT NULL
     AND NOT public.cash_transaction_is_movable(OLD.company_id, OLD.id) THEN$old$;
  v_new text := $new$  IF v_binding_changed AND OLD.cash_account_id IS NOT NULL
     AND NOT public.cash_transaction_is_movable(OLD.company_id, OLD.id)
     AND NOT (
       OLD.journal_entry_id IS NOT NULL
       AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       AND EXISTS (SELECT 1 FROM public.journal_entries j
         WHERE j.company_id = OLD.company_id AND j.id = OLD.journal_entry_id
           AND j.status IN ('draft', 'cancelled', 'reversed'))
       AND EXISTS (SELECT 1 FROM public.journal_entries j
         WHERE j.company_id = NEW.company_id AND j.id = NEW.journal_entry_id AND j.status = 'posted')
       AND OLD.invoice_id IS NULL AND OLD.supplier_invoice_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links a WHERE a.transaction_id = OLD.id)
       AND NOT EXISTS (SELECT 1 FROM public.invoice_payments a WHERE a.transaction_id = OLD.id)
       AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_payments a WHERE a.transaction_id = OLD.id)
       AND NOT EXISTS (SELECT 1 FROM public.journal_entries j
         WHERE j.company_id = OLD.company_id AND j.status = 'posted'
           AND ((j.source_type = 'bank_transaction' AND j.source_id = OLD.id)
             OR j.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', OLD.id))))
     ) THEN$new$;
BEGIN
  IF position(v_old IN v_definition) = 0 THEN RAISE EXCEPTION 'Unexpected bank binding guard'; END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
