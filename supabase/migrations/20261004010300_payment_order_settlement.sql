-- pg-test: covered-by tests/pg/payment-order-settlement.pg.test.ts
-- Settling bank payments: from "the bank executed it" to "the ledger shows it".
--
-- 1. transactions carry what a PSD2 aggregator reports beyond the booking
--    date: the value date, the end-to-end id the paying side sent (a bank
--    payment order's end_to_end_id comes back on its own debit), and the
--    provider's transaction id (traceability only; the ledger still computes
--    its own dedupe key, external_id). All nullable: Enable Banking rows and
--    file imports leave them empty.
--
-- 2. A bank payment order is settled by the payment row that books it. Every
--    path that records a supplier payment writes supplier_invoice_payments
--    (dashboard and v1 bank match, batch allocation, link to an existing
--    voucher, mark paid), so a trigger there settles the order whichever path
--    the person or the agent took, and deleting that row (an undone match)
--    opens the order again. Booking stays where it is: this only links.
--
--    An order is settled only by a payment of the same amount (within one
--    öre) that either comes from a bank row or lands on an order the bank has
--    reported executed. A manual mark-paid of a different amount, or before
--    the bank has anything, leaves the order alone.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS value_date date,
  ADD COLUMN IF NOT EXISTS end_to_end_id text,
  ADD COLUMN IF NOT EXISTS provider_transaction_id text;

COMMENT ON COLUMN public.transactions.value_date IS
  'Value date as the bank reports it (PSD2 valueDate); date stays the booking date.';
COMMENT ON COLUMN public.transactions.end_to_end_id IS
  'End-to-end id the paying side sent. On the debit of a bank payment it equals payment_orders.end_to_end_id.';
COMMENT ON COLUMN public.transactions.provider_transaction_id IS
  'The aggregator''s own id for the row, kept for traceability. Never a dedupe key: external_id is computed by the ledger.';

CREATE INDEX IF NOT EXISTS idx_transactions_company_end_to_end
  ON public.transactions (company_id, end_to_end_id)
  WHERE end_to_end_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.settle_payment_order_on_supplier_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_order public.payment_orders%ROWTYPE;
BEGIN
  IF NEW.supplier_invoice_id IS NULL OR NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_order
    FROM public.payment_orders po
   WHERE po.company_id = NEW.company_id
     AND po.supplier_invoice_id = NEW.supplier_invoice_id
     AND po.supplier_invoice_payment_id IS NULL
     AND po.status IN ('accepted', 'awaiting_second_signer', 'executed')
     AND abs(po.amount - NEW.amount) <= 0.01
   ORDER BY po.created_at DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NEW.transaction_id IS NULL AND v_order.status <> 'executed' THEN
    RETURN NEW;
  END IF;

  UPDATE public.payment_orders
     SET status = 'executed',
         executed_at = COALESCE(executed_at, now()),
         supplier_invoice_payment_id = NEW.id,
         matched_transaction_id = NEW.transaction_id,
         matched_at = now()
   WHERE id = v_order.id;

  INSERT INTO public.payment_order_events
    (company_id, payment_order_id, event_type, from_status, to_status, detail)
  VALUES
    (NEW.company_id, v_order.id, 'matched', v_order.status, 'executed',
     jsonb_build_object('supplier_invoice_payment_id', NEW.id, 'transaction_id', NEW.transaction_id));
  RETURN NEW;
END;
$$;

CREATE TRIGGER settle_payment_order_on_supplier_payment
  AFTER INSERT ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.settle_payment_order_on_supplier_payment();

-- The FK (ON DELETE SET NULL) already clears supplier_invoice_payment_id when
-- the payment row goes; this clears the rest of the settlement and says so.
CREATE OR REPLACE FUNCTION public.unsettle_payment_order_on_supplier_payment_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_order_id uuid;
BEGIN
  FOR v_order_id IN
    UPDATE public.payment_orders
       SET matched_transaction_id = NULL,
           matched_at = NULL
     WHERE company_id = OLD.company_id
       AND supplier_invoice_id = OLD.supplier_invoice_id
       AND supplier_invoice_payment_id IS NULL
       AND matched_at IS NOT NULL
       AND matched_transaction_id IS NOT DISTINCT FROM OLD.transaction_id
    RETURNING id
  LOOP
    INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, detail)
    VALUES (OLD.company_id, v_order_id, 'unmatched', jsonb_build_object('supplier_invoice_payment_id', OLD.id));
  END LOOP;
  RETURN OLD;
END;
$$;

CREATE TRIGGER unsettle_payment_order_on_supplier_payment_delete
  AFTER DELETE ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.unsettle_payment_order_on_supplier_payment_delete();

REVOKE ALL ON FUNCTION public.settle_payment_order_on_supplier_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unsettle_payment_order_on_supplier_payment_delete() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
