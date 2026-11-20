-- pg-test: covered-by tests/pg/bank-ingest-route.pg.test.ts
-- A bank line keeps what the bank sent.
--
-- 1. transactions.raw_document_id links a bank line to the archived raw
--    provider response it arrived in (the PSD2 page uploadDocument stored as
--    räkenskapsinformation). A column of its own: document_id is the receipt
--    a person pinned to the line, a different thing.
--
-- 2. insert_bank_transaction copied a fixed list of source fields, so the
--    value date, end-to-end id and provider id added in 20261010090100 were
--    dropped on every bank-feed row, and the payment-order settlement trigger
--    never saw an end-to-end id. Same signature and checks; the insert now
--    reads those three plus raw_document_id. The document must belong to the
--    company the row is written for: a caller cannot link another company's
--    archive.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS raw_document_id uuid
  REFERENCES public.document_attachments(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.transactions.raw_document_id IS
  'The archived raw bank response this row arrived in. Not the receipt link (document_id).';

CREATE INDEX IF NOT EXISTS idx_transactions_raw_document_id
  ON public.transactions (raw_document_id)
  WHERE raw_document_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.insert_bank_transaction(
  p_company_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_account_uid text,
  p_currency text,
  p_route_token text,
  p_transaction jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_route jsonb;
  v_input public.transactions;
  v_transaction public.transactions;
BEGIN
  v_route := public.resolve_bank_ingest_route(p_company_id, p_connection_id, p_account_uid, p_currency, true);
  IF p_route_token IS DISTINCT FROM v_route->>'token' THEN
    RAISE EXCEPTION 'BANK_INGEST_ROUTE_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF auth.role() = 'authenticated' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'BANK_INGEST_ACTOR_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_transaction) IS DISTINCT FROM 'object'
     OR upper(p_transaction->>'currency') IS DISTINCT FROM upper(p_currency) THEN
    RAISE EXCEPTION 'BANK_INGEST_TRANSACTION_INVALID' USING ERRCODE = '22023';
  END IF;
  v_input := jsonb_populate_record(NULL::public.transactions, p_transaction);
  IF v_input.raw_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_attachments d
     WHERE d.id = v_input.raw_document_id AND d.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'BANK_INGEST_TRANSACTION_INVALID' USING ERRCODE = '22023';
  END IF;
  -- Only source fields may enter this boundary. Company, actor and destination
  -- come from checked context; callers cannot inject a journal/invoice anchor.
  INSERT INTO public.transactions(
    company_id, user_id, bank_connection_id, cash_account_id, external_id, date,
    description, original_description, transaction_method, bank_transaction_code,
    proprietary_bank_transaction_code, amount, currency, amount_sek, exchange_rate,
    exchange_rate_date, category, is_business, mcc_code, merchant_name, reference,
    import_source, counterparty_iban, counterparty_account, value_date,
    end_to_end_id, provider_transaction_id, raw_document_id
  ) VALUES (
    p_company_id, p_user_id, p_connection_id, (v_route->>'cashAccountId')::uuid,
    v_input.external_id, v_input.date, v_input.description, v_input.original_description,
    v_input.transaction_method, v_input.bank_transaction_code, v_input.proprietary_bank_transaction_code,
    v_input.amount, upper(p_currency), v_input.amount_sek, v_input.exchange_rate,
    v_input.exchange_rate_date, 'uncategorized', NULL, v_input.mcc_code,
    v_input.merchant_name, v_input.reference, 'enable_banking',
    v_input.counterparty_iban, v_input.counterparty_account, v_input.value_date,
    v_input.end_to_end_id, v_input.provider_transaction_id, v_input.raw_document_id
  ) RETURNING * INTO v_transaction;
  RETURN to_jsonb(v_transaction);
END;
$$;

NOTIFY pgrst, 'reload schema';
