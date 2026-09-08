-- Offert -> kundorder (issue #2224): the sale behind a quote must never
-- exist twice. The services check for a live converted invoice and a live
-- kundorder before converting, but those reads are not serialized: two
-- conversions of an already-accepted quote (order + order, or order +
-- invoice) both pass their pre-checks, and the quote's compare-and-set
-- (accepted -> accepted) matches for both. Only the database can close
-- that window.
--
-- 1. One live kundorder per source document (partial unique index). A
--    cancelled order frees the source again, matching the service rule.
-- 2. A kundorder whose source is a quote cannot become live (insert, or
--    reopen from cancelled) while a live invoice was converted from that
--    quote. The trigger locks the quote row first (FOR UPDATE), so a
--    concurrent converted-invoice insert queues behind it and sees the
--    committed order.
-- 3. The mirror: an invoice with converted_from_id = a quote cannot become
--    live while a live kundorder points at that quote. Same lock, same
--    serialization, raised with the registry code the services map to 409
--    INVOICE_QUOTE_ALREADY_ORDERED.
--
-- Both triggers exit before the lock on every update that does not make a
-- row live (the common status changes), and never touch proformas: the
-- proforma path cancels its source, which its compare-and-set already
-- serializes.

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_orders_one_live_per_source
  ON public.sales_orders (source_invoice_id)
  WHERE source_invoice_id IS NOT NULL AND status <> 'cancelled';

CREATE OR REPLACE FUNCTION public.sales_orders_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_source_type text;
BEGIN
  IF NEW.source_invoice_id IS NULL OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  -- Only a row that BECOMES live is checked: an insert, a reopen from
  -- cancelled, or a re-pointed source.
  IF TG_OP = 'UPDATE'
     AND OLD.status <> 'cancelled'
     AND OLD.source_invoice_id IS NOT DISTINCT FROM NEW.source_invoice_id THEN
    RETURN NEW;
  END IF;

  SELECT i.document_type INTO v_source_type
  FROM public.invoices i
  WHERE i.id = NEW.source_invoice_id
  FOR UPDATE;

  IF v_source_type = 'quote' AND EXISTS (
    SELECT 1 FROM public.invoices c
    WHERE c.converted_from_id = NEW.source_invoice_id
      AND c.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'INVOICE_QUOTE_ALREADY_INVOICED: quote % has a live converted invoice', NEW.source_invoice_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sales_orders_source_guard ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_source_guard
  BEFORE INSERT OR UPDATE OF status, source_invoice_id ON public.sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.sales_orders_source_guard();

CREATE OR REPLACE FUNCTION public.invoices_converted_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_source_type text;
BEGIN
  IF NEW.converted_from_id IS NULL OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status <> 'cancelled'
     AND OLD.converted_from_id IS NOT DISTINCT FROM NEW.converted_from_id THEN
    RETURN NEW;
  END IF;

  SELECT i.document_type INTO v_source_type
  FROM public.invoices i
  WHERE i.id = NEW.converted_from_id
  FOR UPDATE;

  IF v_source_type = 'quote' AND EXISTS (
    SELECT 1 FROM public.sales_orders o
    WHERE o.source_invoice_id = NEW.converted_from_id
      AND o.status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'INVOICE_QUOTE_ALREADY_ORDERED: quote % has a live kundorder', NEW.converted_from_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_invoices_converted_source_guard ON public.invoices;
CREATE TRIGGER trg_invoices_converted_source_guard
  BEFORE INSERT OR UPDATE OF status, converted_from_id ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.invoices_converted_source_guard();

COMMENT ON FUNCTION public.sales_orders_source_guard() IS
  'A kundorder created from a quote cannot become live while a live invoice was converted from that quote. Locks the quote row so concurrent conversions serialize. Raises INVOICE_QUOTE_ALREADY_INVOICED.';
COMMENT ON FUNCTION public.invoices_converted_source_guard() IS
  'An invoice converted from a quote cannot become live while a live kundorder was created from that quote. Locks the quote row so concurrent conversions serialize. Raises INVOICE_QUOTE_ALREADY_ORDERED.';

NOTIFY pgrst, 'reload schema';
