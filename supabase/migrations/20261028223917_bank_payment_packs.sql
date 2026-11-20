-- Bank payment packs (issue #132): above the 10 bank payments a month that
-- are included, a company's owner buys packs of 100 more a month on the
-- company's Stripe subscription, instead of asking support to raise the cap
-- by hand.
--
-- purchased_packs is the quantity of the pack item (STRIPE_PRICE_PAYMENTS_PACK)
-- on the company's subscription, as Stripe last reported it. Only the server
-- writes it, as the service role: the Stripe webhook
-- (src/lib/stripe/subscription-sync.ts) on every subscription event, and the
-- purchase route (POST /api/billing/payment-packs) right after Stripe accepted
-- an increase, through the same function. A subscription that no longer
-- grants access writes 0: a lapsed plan takes its packs with it.
--
-- The cap becomes (monthly_payments, else 10) + purchased_packs x 100
-- (src/lib/payments/usage.ts, where the pack size lives). monthly_payments
-- stays the founder's override of the base and turns nullable: a row that
-- exists only for its packs has no override, and NULL reads as the default,
-- exactly as a missing row does. A founder who stops a company's bank
-- payments sets 0 here and checks that it holds no packs.
--
-- No grant changes: a browser session keeps SELECT only (the members'
-- policy, no write policy and no write grant), so no company can raise its
-- own packs; service_role keeps its DML.
--
-- pg-test: covered-by tests/pg/bank-payment-allowances.pg.test.ts

ALTER TABLE public.company_bank_payment_allowances
  ALTER COLUMN monthly_payments DROP NOT NULL;

ALTER TABLE public.company_bank_payment_allowances
  ADD COLUMN purchased_packs integer NOT NULL DEFAULT 0 CHECK (purchased_packs >= 0);

COMMENT ON TABLE public.company_bank_payment_allowances IS
  'Bank payments (payment initiation) a company may send per Stockholm calendar month: the base (a founder''s override, else 10) plus 100 per pack bought on the Stripe subscription. Written by the server as the service role; members read their own row, never write it.';
COMMENT ON COLUMN public.company_bank_payment_allowances.monthly_payments IS
  'Base payments per calendar month when a founder set one; NULL means the default (10). Packs come on top. A signing that would pass the cap is refused (BANK_PAYMENTS_ALLOWANCE_EXCEEDED).';
COMMENT ON COLUMN public.company_bank_payment_allowances.purchased_packs IS
  'Packs of 100 bank payments a month on the company''s Stripe subscription, as Stripe last reported them (webhook and purchase route, service role). 0 once the plan no longer grants access.';

NOTIFY pgrst, 'reload schema';
