-- pg-test: covered-by tests/pg/bank-ingest-route.pg.test.ts
-- Open Payments enriches an account's transactions once a day (ISO/Bankgirot
-- enrichment: payer names, organisationsnummer, OCR references, the split).
-- A row imported before that day's enrichment ran is re-read by the next sync
-- (7-day lookback) and, from this migration on, updated with what the bank
-- added (lib/transactions/ingest.ts, enrichmentPatch). The columns below hold
-- the fields the enrichment carries that the row had no place for.
--
-- 1. transactions: the counterparty's organisationsnummer, the instructed
--    amount and currency of a payment made in another currency than the
--    account's, the balance after the row, the bank's enriched flag and when
--    the row last took an enriched version. No new table: the Bankgirot split
--    (parts) is parsed through the contract and stored by a later migration.
-- 2. bank_connections.last_enriched_at: what the last sync's account details
--    reported as the bank's enrichment time, so a reader can tell whether a
--    window carries today's enrichment.
-- 3. insert_bank_transaction stores the new source fields. Body of
--    20261012120000 plus the six columns; same signature and checks.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS counterparty_org_number text,
  ADD COLUMN IF NOT EXISTS instructed_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS instructed_currency char(3),
  ADD COLUMN IF NOT EXISTS balance_after numeric(14,2),
  ADD COLUMN IF NOT EXISTS is_enriched boolean,
  ADD COLUMN IF NOT EXISTS enriched_at timestamptz;

COMMENT ON COLUMN public.transactions.counterparty_org_number IS
  'The counterparty''s organisationsnummer, digits only (10 digits; a 12-digit form drops the 16 prefix), from the bank''s enrichment. Null when the bank names none.';
COMMENT ON COLUMN public.transactions.instructed_amount IS
  'The amount in the currency the payment was made in, when that differs from the account currency (a card purchase abroad). Null for a row in the account currency.';
COMMENT ON COLUMN public.transactions.instructed_currency IS
  'The ISO 4217 currency of instructed_amount.';
COMMENT ON COLUMN public.transactions.exchange_rate IS
  'SEK per unit of currency for a foreign-currency row (Riksbanken, fetched at ingest). On a SEK account''s row with an instructed_currency: the bank''s rate from that currency into SEK. Every SEK resolver short-circuits on currency = SEK before reading it.';
COMMENT ON COLUMN public.transactions.balance_after IS
  'The account balance after this row as the bank reports it. Never stored for a personal (PRIV) account.';
COMMENT ON COLUMN public.transactions.is_enriched IS
  'The bank''s isEnriched flag: the row has been through Open Payments'' daily enrichment. Null when the bank sends none.';
COMMENT ON COLUMN public.transactions.enriched_at IS
  'When the row last took an enriched version: at insert when it arrived enriched, else on the re-read that flipped is_enriched to true.';

ALTER TABLE public.bank_connections
  ADD COLUMN IF NOT EXISTS last_enriched_at timestamptz;

COMMENT ON COLUMN public.bank_connections.last_enriched_at IS
  'The bank''s enrichment time for the connection''s accounts as the last sync''s account details reported it (the latest across the accounts). Null until a sync reports one.';

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
  v_source text;
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
  -- The channel is the connection's aggregator. An injected import_source is
  -- ignored like every other non-source field, so an Enable Banking connection
  -- writes 'enable_banking' exactly as before and nothing can relabel a row.
  SELECT aggregator INTO v_source FROM public.bank_connections
   WHERE company_id = p_company_id AND id = p_connection_id;
  -- Only source fields may enter this boundary. Company, actor and destination
  -- come from checked context; callers cannot inject a journal/invoice anchor.
  INSERT INTO public.transactions(
    company_id, user_id, bank_connection_id, cash_account_id, external_id, date,
    description, original_description, transaction_method, bank_transaction_code,
    proprietary_bank_transaction_code, amount, currency, amount_sek, exchange_rate,
    exchange_rate_date, category, is_business, mcc_code, merchant_name, reference,
    import_source, counterparty_iban, counterparty_account, value_date,
    end_to_end_id, provider_transaction_id, raw_document_id,
    counterparty_org_number, instructed_amount, instructed_currency, balance_after,
    is_enriched, enriched_at
  ) VALUES (
    p_company_id, p_user_id, p_connection_id, (v_route->>'cashAccountId')::uuid,
    v_input.external_id, v_input.date, v_input.description, v_input.original_description,
    v_input.transaction_method, v_input.bank_transaction_code, v_input.proprietary_bank_transaction_code,
    v_input.amount, upper(p_currency), v_input.amount_sek, v_input.exchange_rate,
    v_input.exchange_rate_date, 'uncategorized', NULL, v_input.mcc_code,
    v_input.merchant_name, v_input.reference, coalesce(v_source, 'enable_banking'),
    v_input.counterparty_iban, v_input.counterparty_account, v_input.value_date,
    v_input.end_to_end_id, v_input.provider_transaction_id, v_input.raw_document_id,
    v_input.counterparty_org_number, v_input.instructed_amount, upper(v_input.instructed_currency),
    v_input.balance_after, v_input.is_enriched, v_input.enriched_at
  ) RETURNING * INTO v_transaction;
  RETURN to_jsonb(v_transaction);
END;
$$;

NOTIFY pgrst, 'reload schema';
