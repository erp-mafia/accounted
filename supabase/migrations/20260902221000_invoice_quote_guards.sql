-- Quote guards that belong in the database, not in every writer.
--
-- 1. quote_status defaults to 'open' for a new quote. invoices_quote_columns_check
--    (20260902220000) pairs quote_status with document_type = 'quote', so every
--    creator (dashboard, v1, bulk-create, MCP) had to remember the column, and
--    every UPDATE that spread the shared write-builder's fields re-wrote 'open'
--    over a recorded accept/decline. The decision now lives only where it is
--    made: creators leave the column NULL and the trigger opens the quote;
--    updaters never carry it.
--    valid_until likewise falls back to due_date on insert, and both dates are
--    kept equal on quotes (the NOT NULL due_date mirrors the authoritative
--    valid_until so date-ordered readers keep working).
--
-- 2. One live invoice per source: a partial unique index on converted_from_id
--    over non-cancelled rows. convertToInvoice() checks before inserting, but
--    two concurrent conversions could both pass the check and mint two
--    F-numbers for one quote (or proforma). A cancelled converted invoice
--    still frees the source for another attempt. Prod had zero duplicates
--    when this was written (read-only check 2026-09-02).

CREATE OR REPLACE FUNCTION public.invoices_quote_defaults()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.document_type = 'quote' THEN
    IF NEW.quote_status IS NULL THEN
      NEW.quote_status := 'open';
    END IF;
    IF NEW.valid_until IS NULL THEN
      NEW.valid_until := NEW.due_date;
    END IF;
    -- Keep the mirror honest whichever side a writer touched.
    IF TG_OP = 'UPDATE' AND NEW.valid_until IS DISTINCT FROM OLD.valid_until THEN
      NEW.due_date := NEW.valid_until;
    ELSIF TG_OP = 'UPDATE' AND NEW.due_date IS DISTINCT FROM OLD.due_date THEN
      NEW.valid_until := NEW.due_date;
    ELSE
      NEW.due_date := NEW.valid_until;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_invoices_quote_defaults ON public.invoices;
CREATE TRIGGER trg_invoices_quote_defaults
  BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.invoices_quote_defaults();

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_one_live_conversion
  ON public.invoices (converted_from_id)
  WHERE converted_from_id IS NOT NULL AND status <> 'cancelled';

COMMENT ON FUNCTION public.invoices_quote_defaults() IS
  'Quotes: quote_status defaults to open, valid_until defaults to due_date, and the two dates stay equal (valid_until wins when both change). No-op for every other document type.';

NOTIFY pgrst, 'reload schema';
