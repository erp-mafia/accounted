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
-- insert_bank_transaction, the boundary of the bank feeds, is left as it is:
-- only a bank row's own source fields enter there, and no bank states a
-- buyer's country. The Stripe feed writes them through the plain insert.
--
-- The views over SELECT t.* take a new column by a CREATE OR REPLACE with the
-- definition of 20261101180100 unchanged: the new columns come last, and the
-- views keep their grants (bank-row-anchors.pg asserts the same columns).
--
-- pg-test: covered-by tests/pg/bank-row-anchors.pg.test.ts

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
