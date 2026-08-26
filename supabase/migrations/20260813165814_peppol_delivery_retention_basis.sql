-- A Peppol archive record must inherit the legally corrected BFL retention
-- date from the fiscal period containing the invoice. Refuse staging when the
-- period is missing instead of guessing from the invoice date.

CREATE OR REPLACE FUNCTION public.enforce_peppol_delivery_retention_basis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_retention date;
BEGIN
  SELECT period.retention_expires_at
  INTO expected_retention
  FROM public.invoices AS invoice
  JOIN public.fiscal_periods AS period
    ON period.company_id = invoice.company_id
   AND invoice.invoice_date BETWEEN period.period_start AND period.period_end
  WHERE invoice.id = NEW.invoice_id
    AND invoice.company_id = NEW.company_id
  ORDER BY period.period_end DESC
  LIMIT 1;

  IF expected_retention IS NULL THEN
    RAISE EXCEPTION 'Peppol delivery requires a fiscal period retention basis'
      USING ERRCODE = 'P0002';
  END IF;

  IF NEW.retention_expires_at IS DISTINCT FROM expected_retention THEN
    RAISE EXCEPTION 'Peppol retention date must match the invoice fiscal period'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_peppol_delivery_retention_basis
  BEFORE INSERT ON public.peppol_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_peppol_delivery_retention_basis();

REVOKE ALL ON FUNCTION public.enforce_peppol_delivery_retention_basis()
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
