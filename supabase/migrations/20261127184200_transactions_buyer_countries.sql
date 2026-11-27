-- transactions.billing_country and transactions.card_country: the buyer's two
-- countries on a Stripe sale, as Stripe states them on the charge behind the
-- balance transaction (the Stripe feed, src/extensions/general/stripe/lib/transaction-sync.ts):
-- the country of the billing address (billing_details.address.country) and
-- the country of the card (payment_method_details.card.country). Kept apart,
-- never folded into one: they can say different things, and the moms of the
-- sale needs to see when they do. ISO 3166-1 alpha-2, upper case, NULL when
-- Stripe states none, on every row of every other feed, and on Stripe rows
-- synced before this column existed. Nothing reads them to choose a moms
-- treatment: they are shown to the agent and in the transaction list.
--
-- insert_bank_transaction stores every source field of a bank row, these two
-- with them: body of 20261013190000 plus the two columns, same signature and
-- checks. No bank feed sends them today.
--
-- The views over SELECT t.* take a new column by a CREATE OR REPLACE with the
-- definition of 20261101180100 unchanged: the new columns come last, and the
-- views keep their grants (bank-row-anchors.pg asserts the same columns).
--
-- pg-test: covered-by tests/pg/bank-row-anchors.pg.test.ts, tests/pg/bank-ingest-route.pg.test.ts

-- transactions is written by every feed sync: fail the migration job instead
-- of queueing writes behind a long lock.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS billing_country text,
  ADD COLUMN IF NOT EXISTS card_country text;

COMMENT ON COLUMN public.transactions.billing_country IS
  'Stripe feed: the country of the buyer''s billing address on the charge (ISO 3166-1 alpha-2). Never folded with card_country.';
COMMENT ON COLUMN public.transactions.card_country IS
  'Stripe feed: the country of the buyer''s card on the charge (ISO 3166-1 alpha-2). Never folded with billing_country.';

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
    is_enriched, enriched_at, billing_country, card_country
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
    v_input.balance_after, v_input.is_enriched, v_input.enriched_at,
    v_input.billing_country, v_input.card_country
  ) RETURNING * INTO v_transaction;
  RETURN to_jsonb(v_transaction);
END;
$$;

CREATE OR REPLACE VIEW public.unbooked_bank_rows WITH (security_invoker = true) AS
  SELECT t.*
  FROM public.transactions t
  WHERE t.journal_entry_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.bank_row_anchors a
      WHERE a.company_id = t.company_id AND a.transaction_id = t.id AND a.via <> 'pointer'
    )
  UNION ALL
  SELECT t.*
  FROM public.journal_entries e
  JOIN public.transactions t ON t.journal_entry_id = e.id AND t.company_id = e.company_id
  WHERE e.status <> 'posted'
    AND NOT EXISTS (
      SELECT 1 FROM public.bank_row_anchors a
      WHERE a.company_id = t.company_id AND a.transaction_id = t.id
    );

CREATE OR REPLACE VIEW public.open_bank_rows WITH (security_invoker = true) AS
  SELECT u.*
  FROM public.unbooked_bank_rows u
  WHERE NOT u.is_ignored
    AND u.is_business IS NOT FALSE;

NOTIFY pgrst, 'reload schema';
