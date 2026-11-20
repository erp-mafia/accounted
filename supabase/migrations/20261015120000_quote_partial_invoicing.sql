-- A quote (offert) can be invoiced in parts (crm#1196): a fixed-price job
-- billed 50 % at acceptance and 50 % at delivery, from one quote.
--
-- Until now one source document could have one live converted invoice,
-- enforced by the partial unique index idx_invoices_one_live_conversion
-- (20260902221000). That rule now holds for proformas only. A quote may have
-- several live converted invoices as long as together they bill at most the
-- quote's net (subtotal, excl. VAT); invoiced so far is derived from those
-- invoices (converted_from_id), so no new column or counter is added.
--
-- The unique index cannot express a sum, so the rule moves into the existing
-- converted-source guard, which already locks the source row FOR UPDATE
-- before it decides: concurrent conversions of one source serialize there,
-- and the later one sees the earlier one's committed row (each statement in
-- the function takes a fresh snapshot under READ COMMITTED). The guard now
-- refuses an invoice that becomes live (insert, reopen or re-point) when:
--   - the source is a proforma and another live invoice was converted from
--     it: INVOICE_CONVERT_SOURCE_CHANGED (the index's old meaning);
--   - the source is a quote already fully invoiced by its live conversions:
--     INVOICE_QUOTE_ALREADY_INVOICED;
--   - the source is a quote and this invoice would take the live conversions
--     past the quote's net: INVOICE_QUOTE_PART_OUT_OF_RANGE;
--   - the source is a quote with a live kundorder: INVOICE_QUOTE_ALREADY_ORDERED
--     (unchanged).
-- Editing a live converted draft afterwards is not re-checked (the trigger
-- only fires on status and converted_from_id), as before.
--
-- Existing rows satisfy the new rule: until now the unique index guaranteed
-- at most one live conversion per source, and no live conversion bills
-- more than its quote's net. No row is rewritten and none is left in a
-- state the guard would refuse.
--
-- The plain index idx_invoices_converted_from_id stays and serves the sum.

CREATE OR REPLACE FUNCTION public.invoices_converted_source_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_source_type text;
  v_source_company uuid;
  v_source_subtotal numeric;
  v_live_count integer;
  v_invoiced numeric;
BEGIN
  IF NEW.converted_from_id IS NULL OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status <> 'cancelled'
     AND OLD.converted_from_id IS NOT DISTINCT FROM NEW.converted_from_id THEN
    RETURN NEW;
  END IF;

  SELECT i.document_type, i.company_id, i.subtotal
    INTO v_source_type, v_source_company, v_source_subtotal
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

  SELECT count(*), COALESCE(sum(c.subtotal), 0)
    INTO v_live_count, v_invoiced
  FROM public.invoices c
  WHERE c.converted_from_id = NEW.converted_from_id
    AND c.status <> 'cancelled'
    AND c.id <> NEW.id;

  IF v_source_type = 'quote' THEN
    IF v_live_count > 0 AND v_invoiced >= COALESCE(v_source_subtotal, 0) THEN
      RAISE EXCEPTION 'INVOICE_QUOTE_ALREADY_INVOICED: quote % is fully invoiced', NEW.converted_from_id
        USING ERRCODE = 'P0001';
    END IF;
    IF v_invoiced + COALESCE(NEW.subtotal, 0) > COALESCE(v_source_subtotal, 0) THEN
      RAISE EXCEPTION 'INVOICE_QUOTE_PART_OUT_OF_RANGE: invoice % would bill % of quote % with % left', NEW.id, NEW.subtotal, NEW.converted_from_id, COALESCE(v_source_subtotal, 0) - v_invoiced
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF v_live_count > 0 THEN
    RAISE EXCEPTION 'INVOICE_CONVERT_SOURCE_CHANGED: source document % already has a live converted invoice', NEW.converted_from_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.invoices_converted_source_guard() IS
  'An invoice converted from a source document becomes live only if: the source belongs to the same company; a quote source has no live kundorder and its live conversions plus this invoice bill at most the quote''s net (parts, crm#1196); a proforma source has no other live conversion. Runs as definer and locks the source row so concurrent conversions serialize. Raises INVOICE_CONVERT_SOURCE_COMPANY_MISMATCH / INVOICE_QUOTE_ALREADY_ORDERED / INVOICE_QUOTE_ALREADY_INVOICED / INVOICE_QUOTE_PART_OUT_OF_RANGE / INVOICE_CONVERT_SOURCE_CHANGED.';

DROP INDEX IF EXISTS public.idx_invoices_one_live_conversion;

NOTIFY pgrst, 'reload schema';
