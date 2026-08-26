-- Swedbank MIG rule PFH_222 (Validex round 2, 2026-08-10): when a creditor
-- postal address is present, TwnNm is mandatory from November 2026. IBAN-
-- debited payments require the address (rule 237), so items snapshot the
-- supplier's city at creation, same immutability rules as the other payee
-- fields. Nullable: suppliers without a city keep working (BGNR-debited
-- payments carry no creditor address at all).
--
-- pg-test: covered-by tests/pg/supplier-payment-batches.pg.test.ts
ALTER TABLE public.supplier_payment_batch_items
  ADD COLUMN payee_city text;

NOTIFY pgrst, 'reload schema';
