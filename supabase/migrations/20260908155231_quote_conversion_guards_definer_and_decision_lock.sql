-- Follow-up to 20260908152555_quote_source_conversion_guards (issue #2224).
--
-- 1. The two source guards run their SELECT ... FOR UPDATE on the quote row
--    as the invoker. Under RLS a FOR UPDATE also applies the UPDATE policy,
--    and invoices_update requires the row's company to be the caller's
--    ACTIVE company. A member of several companies writing through raw
--    PostgREST for a non-active company therefore got zero rows back: no
--    lock, v_source_type NULL, guard skipped. SECURITY DEFINER makes the
--    lookup see the row regardless (the guards read document_type and
--    liveness only; they grant nothing). Because a definer lookup sees every
--    company's rows, both guards now also require the source document to
--    belong to the same company as the row being written: a foreign
--    source_invoice_id / converted_from_id is refused outright instead of
--    locking and inspecting another tenant's quote.
-- 2. A quote with a live kundorder is the customer's accepted agreement
--    behind that order. The decision guard only knew converted invoices, so
--    the quote could still be moved to open or declined while the order was
--    being delivered and invoiced. It now also refuses leaving 'accepted'
--    while a live kundorder points at the quote, raising the registry code
--    the decision writers map to 409 INVOICE_QUOTE_ALREADY_ORDERED. Same
--    definer treatment for the same reason.

CREATE OR REPLACE FUNCTION public.sales_orders_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_source_type text;
  v_source_company uuid;
BEGIN
  IF NEW.source_invoice_id IS NULL OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status <> 'cancelled'
     AND OLD.source_invoice_id IS NOT DISTINCT FROM NEW.source_invoice_id THEN
    RETURN NEW;
  END IF;

  SELECT i.document_type, i.company_id INTO v_source_type, v_source_company
  FROM public.invoices i
  WHERE i.id = NEW.source_invoice_id
  FOR UPDATE;

  IF v_source_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'SALES_ORDER_SOURCE_COMPANY_MISMATCH: source document % does not belong to company %', NEW.source_invoice_id, NEW.company_id
      USING ERRCODE = '42501';
  END IF;

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

CREATE OR REPLACE FUNCTION public.invoices_converted_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_source_type text;
  v_source_company uuid;
BEGIN
  IF NEW.converted_from_id IS NULL OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status <> 'cancelled'
     AND OLD.converted_from_id IS NOT DISTINCT FROM NEW.converted_from_id THEN
    RETURN NEW;
  END IF;

  SELECT i.document_type, i.company_id INTO v_source_type, v_source_company
  FROM public.invoices i
  WHERE i.id = NEW.converted_from_id
  FOR UPDATE;

  IF v_source_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'INVOICE_CONVERT_SOURCE_COMPANY_MISMATCH: source document % does not belong to company %', NEW.converted_from_id, NEW.company_id
      USING ERRCODE = '42501';
  END IF;

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

COMMENT ON FUNCTION public.sales_orders_source_guard() IS
  'A kundorder created from a quote cannot become live while a live invoice was converted from that quote. Runs as definer, locks the quote row so concurrent conversions serialize, and refuses a source from another company. Raises INVOICE_QUOTE_ALREADY_INVOICED / SALES_ORDER_SOURCE_COMPANY_MISMATCH.';
COMMENT ON FUNCTION public.invoices_converted_source_guard() IS
  'An invoice converted from a quote cannot become live while a live kundorder was created from that quote. Runs as definer, locks the quote row so concurrent conversions serialize, and refuses a source from another company. Raises INVOICE_QUOTE_ALREADY_ORDERED / INVOICE_CONVERT_SOURCE_COMPANY_MISMATCH.';

CREATE OR REPLACE FUNCTION public.invoices_quote_decision_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF OLD.document_type = 'quote'
     AND OLD.quote_status = 'accepted'
     AND NEW.quote_status IS DISTINCT FROM 'accepted'
  THEN
    IF EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.converted_from_id = OLD.id
        AND i.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION 'INVOICE_QUOTE_ALREADY_INVOICED: quote % has a live converted invoice', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.sales_orders o
      WHERE o.source_invoice_id = OLD.id
        AND o.status <> 'cancelled'
    ) THEN
      RAISE EXCEPTION 'INVOICE_QUOTE_ALREADY_ORDERED: quote % has a live kundorder', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.invoices_quote_decision_guard() IS
  'A quote in accepted cannot leave accepted while a live invoice was converted from it (INVOICE_QUOTE_ALREADY_INVOICED) or a live kundorder was created from it (INVOICE_QUOTE_ALREADY_ORDERED).';

NOTIFY pgrst, 'reload schema';
