-- Adoption of a matching, previously unbound manual row is a bank write too.
-- Acquire connection, cash account, then transaction locks in that order.
CREATE FUNCTION public.bind_bank_transaction(
  p_company_id uuid,
  p_connection_id uuid,
  p_account_uid text,
  p_currency text,
  p_route_token text,
  p_transaction_id uuid,
  p_expected_date date,
  p_expected_amount numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_route jsonb;
  v_transaction public.transactions;
  v_destination public.cash_accounts;
  v_existing public.cash_accounts;
  v_entry_id uuid;
BEGIN
  v_route := public.resolve_bank_ingest_route(p_company_id, p_connection_id, p_account_uid, p_currency, true);
  IF p_route_token IS DISTINCT FROM v_route->>'token' THEN
    RAISE EXCEPTION 'BANK_INGEST_ROUTE_CHANGED' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_destination FROM public.cash_accounts WHERE id = (v_route->>'cashAccountId')::uuid AND company_id = p_company_id;
  SELECT * INTO v_transaction FROM public.transactions WHERE id = p_transaction_id AND company_id = p_company_id FOR UPDATE;
  IF v_transaction.id IS NULL OR upper(v_transaction.currency) IS DISTINCT FROM upper(p_currency)
     OR v_transaction.date IS DISTINCT FROM p_expected_date OR v_transaction.amount IS DISTINCT FROM p_expected_amount THEN
    RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = '40001';
  END IF;
  IF v_transaction.cash_account_id IS NOT NULL THEN
    IF v_transaction.cash_account_id = v_destination.id THEN RETURN v_destination.id; END IF;
    SELECT * INTO v_existing FROM public.cash_accounts WHERE id = v_transaction.cash_account_id AND company_id = p_company_id;
    -- Another writer may have bound the row to a retained twin. The same
    -- physical account is still a valid dedup match; never overwrite its anchor.
    IF nullif(regexp_replace(v_existing.iban, '\s', '', 'g'), '') IS NOT NULL
       AND upper(regexp_replace(v_existing.iban, '\s', '', 'g')) = upper(regexp_replace(v_destination.iban, '\s', '', 'g'))
       AND upper(v_existing.currency) = upper(v_destination.currency) THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = '40001';
  END IF;
  -- The candidate was a manual row. If it became a feed row while this batch
  -- was deduplicating, the caller must reconsider the match on a fresh read.
  IF v_transaction.bank_connection_id IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = '40001';
  END IF;
  -- Revalidate accounting anchors AFTER locking the transaction. An earlier
  -- application-side read cannot prove which ledger an anchor now explains.
  FOR v_entry_id IN
    SELECT v_transaction.journal_entry_id WHERE v_transaction.journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM public.transaction_voucher_links
      WHERE transaction_id = p_transaction_id AND company_id = p_company_id AND role = 'bank_line'
    UNION SELECT journal_entry_id FROM public.invoice_payments
      WHERE transaction_id = p_transaction_id AND company_id = p_company_id
    UNION SELECT journal_entry_id FROM public.supplier_invoice_payments
      WHERE transaction_id = p_transaction_id AND company_id = p_company_id
  LOOP
    IF v_entry_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.journal_entries j JOIN public.journal_entry_lines l ON l.journal_entry_id = j.id
       WHERE j.company_id = p_company_id AND j.id = v_entry_id AND l.account_number = v_destination.ledger_account
    ) THEN
      RAISE EXCEPTION 'BANK_INGEST_ADOPTION_ANCHOR_CHANGED' USING ERRCODE = '40001';
    END IF;
  END LOOP;
  UPDATE public.transactions SET cash_account_id = v_destination.id
   WHERE id = p_transaction_id AND company_id = p_company_id AND cash_account_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = '40001'; END IF;
  RETURN v_destination.id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.bind_bank_transaction(uuid, uuid, text, text, text, uuid, date, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bind_bank_transaction(uuid, uuid, text, text, text, uuid, date, numeric) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
