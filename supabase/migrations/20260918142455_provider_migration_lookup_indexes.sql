-- Keep register adoption and cross-batch voucher checks bounded by a source
-- identity, instead of rescanning an ever-growing company register per row.
CREATE INDEX idx_customers_company_name ON public.customers(company_id,name);
CREATE INDEX idx_suppliers_company_name ON public.suppliers(company_id,name);
CREATE INDEX idx_customers_company_normalized_org ON public.customers
  (company_id,(regexp_replace(COALESCE(org_number,''),'[^[:alnum:]]','','g')));
CREATE INDEX idx_suppliers_company_normalized_org ON public.suppliers
  (company_id,(regexp_replace(COALESCE(org_number,''),'[^[:alnum:]]','','g')));
CREATE INDEX migration_chunks_registration_ref ON public.migration_job_chunks
  (job_id,(receipt->'link'->'sourceVoucher')) WHERE target_id IS NOT NULL;
CREATE INDEX migration_chunks_payment_ref ON public.migration_job_chunks
  (job_id,(receipt->'payment'->>'journal_entry_id'));
NOTIFY pgrst,'reload schema';
