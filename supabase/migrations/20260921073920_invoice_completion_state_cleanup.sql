-- Recovery metadata must not become a new blocker for an otherwise allowed
-- invoice, sandbox or company cleanup. Accounting retention stays on its
-- existing invoice/company guards and processing_history, never these cursors.
ALTER TABLE public.invoice_completion_work
  DROP CONSTRAINT invoice_completion_work_company_id_fkey,
  ADD CONSTRAINT invoice_completion_work_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;
ALTER TABLE public.invoice_completion_entries
  DROP CONSTRAINT invoice_completion_entries_company_id_fkey,
  ADD CONSTRAINT invoice_completion_entries_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.invoice_completion_work(company_id) ON DELETE CASCADE,
  DROP CONSTRAINT invoice_completion_entries_invoice_id_fkey,
  ADD CONSTRAINT invoice_completion_entries_invoice_id_fkey
    FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;
NOTIFY pgrst, 'reload schema';
