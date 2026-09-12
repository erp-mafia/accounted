-- The same bounded read lease protects downloaded financial reports.
ALTER TABLE public.sie_period_read_leases
  DROP CONSTRAINT sie_period_read_leases_purpose_check;
ALTER TABLE public.sie_period_read_leases
  ADD CONSTRAINT sie_period_read_leases_purpose_check
  CHECK (purpose IN ('sie_export','vat_submission','report_export'));

NOTIFY pgrst, 'reload schema';
