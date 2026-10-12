-- Payment provenance on invoice_payments: where a recorded customer payment
-- came from, and the outside reference that identifies it there.
-- pg-test: tests/pg/collection-payment-forwards.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts
--
-- source
--   manual       "Markera som betald" (dashboard, v1, MCP)
--   bank         a bank transaction matched to the invoice (dashboard, v1,
--                pending-operation commit)
--   stripe       the Stripe payment sync
--   link         an existing voucher linked to the invoice
--   collections  the debtor paid the collections provider, which pays the
--                company out in a settlement
--   import       a payment carried over from another system
--   NULL         rows written before this migration and the SQL RPCs that
--                insert directly (match_batch_allocate, the link-voucher
--                RPCs, coordinate_cash_history); NULL means "not from the
--                collections provider", the safe default for forwarding.
--
-- Forwarding (20261012030400_collection_payment_forwards.sql) reports every
-- payment on an invoice under collection to the provider EXCEPT those the
-- provider collected itself (source = 'collections'): it already holds them.
--
-- A collections row is the books' record of money the provider holds for the
-- company. Deleting it would make the provider's payout unexplained and,
-- through forwarding, could even report the payment back to the provider. So
-- it is never deleted, except by the collections rebook service (which sets
-- gnubok.collections_rebook in its own transaction) and by the sandbox
-- teardown. The trigger covers the app, the storno path
-- (lib/bookkeeping/payment-sync.ts deletePaymentRows), cascades and every RPC.

ALTER TABLE public.invoice_payments
  ADD COLUMN source text
    CONSTRAINT invoice_payments_source_check
    CHECK (source IN ('manual', 'bank', 'stripe', 'collections', 'link', 'import')),
  ADD COLUMN external_ref text
    CONSTRAINT invoice_payments_external_ref_check
    CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 200);

COMMENT ON COLUMN public.invoice_payments.source IS
  'Where the payment came from: manual, bank, stripe, link, collections (paid to the collections provider), import. NULL for legacy and SQL-RPC rows (not from the collections provider).';
COMMENT ON COLUMN public.invoice_payments.external_ref IS
  'The payment''s reference in the system it came from (for collections: the provider''s payment reference).';

CREATE OR REPLACE FUNCTION public.block_delete_collected_payment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF OLD.source IS DISTINCT FROM 'collections' THEN
    RETURN OLD;
  END IF;
  -- The collections rebook service reopens and re-settles the invoice in the
  -- same transaction.
  IF current_setting('gnubok.collections_rebook', true) = 'true' THEN
    RETURN OLD;
  END IF;
  -- The sandbox teardown: flag set, running as its owner, and the row's
  -- company still marked as a sandbox.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
          WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::pg_catalog.regprocedure)
     AND (SELECT pg_catalog.bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
          WHERE cs.company_id = OLD.company_id) IS TRUE THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'COLLECTED_PAYMENT_DELETE_BLOCKED: a payment the collections provider collected cannot be removed; rebook it through the collections settlement instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER block_delete_collected_payment
  BEFORE DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.block_delete_collected_payment();

-- The source of a collections row cannot be changed either: re-labelling it
-- would open the delete above. Nor can another row become one. A legacy row
-- (NULL) may still be given another source.
CREATE OR REPLACE FUNCTION public.guard_collected_payment_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF COALESCE(OLD.source = 'collections', false) <> COALESCE(NEW.source = 'collections', false)
     AND current_setting('gnubok.collections_rebook', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'COLLECTED_PAYMENT_SOURCE_LOCKED: the source of a payment collected by the collections provider cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_collected_payment_source
  BEFORE UPDATE OF source ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_collected_payment_source();

NOTIFY pgrst, 'reload schema';
