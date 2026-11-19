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
--    the person or the agent took. Booking stays where it is: this only links.
--
--    Only proof moves an order to executed: a bank row that carries the
--    order's own end-to-end id (the current one, or one an earlier claim of
--    the order used, kept in its 'submitted' events; compared without regard
--    to case, banks may upper-case it) settles it from any state the bank may
--    still be reporting (a second signer pending, accepted, even an outcome
--    nobody knew). Without that proof only an order the bank already reported
--    executed settles, by a payment of the same amount (within one öre), and
--    never by a bank row that names another of our payments. A manual
--    netbank debit of the same amount therefore never settles an order the
--    bank has not executed.
--
--    Both triggers lock the invoice before the order, the order every other
--    writer of orders takes them in (the claim, the rebatch, an invoice
--    UPDATE), so an undone match never deadlocks with a claim.
--
-- 3. Deleting that payment row (an undone match) clears the settlement in a
--    BEFORE DELETE trigger, which knows exactly which order the row settled
--    (payment_orders.supplier_invoice_payment_id is ON DELETE NO ACTION for
--    this). The order reopens, unless another order covers the invoice by
--    then: it then keeps matched_at, stays out of the one-open-order index
--    and still blocks new orders until its debit is matched again.

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

-- Partial: almost every row has no end-to-end id, so the index stays small.
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
  v_order  public.payment_orders%ROWTYPE;
  v_found  boolean := false;
  v_e2e    text;
  v_by     text;
BEGIN
  IF NEW.supplier_invoice_id IS NULL OR NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payment_orders po
                  WHERE po.company_id = NEW.company_id
                    AND po.supplier_invoice_id = NEW.supplier_invoice_id
                    AND po.supplier_invoice_payment_id IS NULL) THEN
    RETURN NEW;
  END IF;
  IF NEW.transaction_id IS NOT NULL THEN
    SELECT t.end_to_end_id INTO v_e2e
      FROM public.transactions t
     WHERE t.id = NEW.transaction_id AND t.company_id = NEW.company_id;
  END IF;

  -- The invoice before the order.
  PERFORM si.id
     FROM public.supplier_invoices si
    WHERE si.id = NEW.supplier_invoice_id AND si.company_id = NEW.company_id
      FOR UPDATE;

  -- The bank row names this order: proof the bank executed it.
  IF v_e2e IS NOT NULL THEN
    SELECT * INTO v_order
      FROM public.payment_orders po
     WHERE po.company_id = NEW.company_id
       AND po.supplier_invoice_id = NEW.supplier_invoice_id
       AND (lower(po.end_to_end_id) = lower(v_e2e)
            OR EXISTS (SELECT 1 FROM public.payment_order_events e
                        WHERE e.payment_order_id = po.id
                          AND e.company_id = po.company_id
                          AND e.event_type = 'submitted'
                          AND lower(e.detail ->> 'previous_end_to_end_id') = lower(v_e2e)))
       AND po.supplier_invoice_payment_id IS NULL
       AND po.status IN ('submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed')
       AND abs(po.amount - NEW.amount) <= 0.01
     FOR UPDATE;
    v_found := FOUND;
    v_by := 'end_to_end_id';
  END IF;

  -- Otherwise only an order the bank reported executed, and never by a row
  -- that carries another of our end-to-end ids.
  IF NOT v_found AND (v_e2e IS NULL OR v_e2e !~* '^ACC[0-9a-f]{32}$') THEN
    SELECT * INTO v_order
      FROM public.payment_orders po
     WHERE po.company_id = NEW.company_id
       AND po.supplier_invoice_id = NEW.supplier_invoice_id
       AND po.supplier_invoice_payment_id IS NULL
       AND po.status = 'executed'
       AND abs(po.amount - NEW.amount) <= 0.01
     ORDER BY po.created_at DESC
     LIMIT 1
     FOR UPDATE;
    v_found := FOUND;
    v_by := 'amount';
  END IF;
  IF NOT v_found THEN
    RETURN NEW;
  END IF;

  UPDATE public.payment_orders
     SET status = 'executed',
         executed_at = COALESCE(executed_at, now()),
         outcome_unknown_at = NULL,
         supplier_invoice_payment_id = NEW.id,
         matched_transaction_id = NEW.transaction_id,
         matched_at = now()
   WHERE id = v_order.id;

  INSERT INTO public.payment_order_events
    (company_id, payment_order_id, event_type, from_status, to_status, detail)
  VALUES
    (NEW.company_id, v_order.id, 'matched', v_order.status, 'executed',
     jsonb_build_object('supplier_invoice_payment_id', NEW.id, 'transaction_id', NEW.transaction_id, 'by', v_by));
  RETURN NEW;
END;
$$;

CREATE TRIGGER settle_payment_order_on_supplier_payment
  AFTER INSERT ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.settle_payment_order_on_supplier_payment();

CREATE OR REPLACE FUNCTION public.unsettle_payment_order_on_supplier_payment_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_order public.payment_orders%ROWTYPE;
  v_other uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.payment_orders po WHERE po.supplier_invoice_payment_id = OLD.id) THEN
    RETURN OLD;
  END IF;
  -- The invoices before the orders. A caller that locks the invoice after
  -- deleting its payment row (delete_last_voucher) then finds it already held.
  PERFORM si.id
     FROM public.supplier_invoices si
    WHERE si.id IN (SELECT po.supplier_invoice_id FROM public.payment_orders po
                     WHERE po.supplier_invoice_payment_id = OLD.id)
    ORDER BY si.id
    FOR UPDATE;

  FOR v_order IN
    SELECT * FROM public.payment_orders po
     WHERE po.supplier_invoice_payment_id = OLD.id
     ORDER BY po.id
     FOR UPDATE
  LOOP
    -- Another order open for the invoice, in the one-open-order index's sense.
    -- Under the invoice lock, so an order being created for it is either
    -- committed and seen here, or waits and then sees this one reopened.
    SELECT po.id INTO v_other
      FROM public.payment_orders po
     WHERE po.company_id = v_order.company_id
       AND po.supplier_invoice_id = v_order.supplier_invoice_id
       AND po.id <> v_order.id
       AND (po.status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                          'awaiting_second_signer', 'accepted')
            OR (po.status = 'executed' AND po.supplier_invoice_payment_id IS NULL AND po.matched_at IS NULL))
     LIMIT 1;

    IF v_other IS NULL THEN
      UPDATE public.payment_orders
         SET supplier_invoice_payment_id = NULL,
             matched_transaction_id = NULL,
             matched_at = NULL
       WHERE id = v_order.id;
      INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, detail)
      VALUES (v_order.company_id, v_order.id, 'unmatched',
              jsonb_build_object('supplier_invoice_payment_id', OLD.id));
    ELSE
      -- Kept out of the open index (matched_at stays) so the other order
      -- can continue; it still blocks new orders until its debit is matched.
      UPDATE public.payment_orders
         SET supplier_invoice_payment_id = NULL,
             matched_transaction_id = NULL
       WHERE id = v_order.id;
      INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, detail)
      VALUES (v_order.company_id, v_order.id, 'unmatched',
              jsonb_build_object('supplier_invoice_payment_id', OLD.id, 'kept_closed', true,
                                 'open_payment_order_id', v_other));
    END IF;
    v_other := NULL;
  END LOOP;
  RETURN OLD;
END;
$$;

CREATE TRIGGER unsettle_payment_order_on_supplier_payment_delete
  BEFORE DELETE ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.unsettle_payment_order_on_supplier_payment_delete();

REVOKE ALL ON FUNCTION public.settle_payment_order_on_supplier_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unsettle_payment_order_on_supplier_payment_delete() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
