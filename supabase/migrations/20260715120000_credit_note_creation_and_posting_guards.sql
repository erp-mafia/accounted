-- Keep partially-created credit notes invisible and prevent duplicate credit
-- relationships or posted vouchers under concurrent requests.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS creation_complete boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_company_credited_invoice
  ON public.invoices (company_id, credited_invoice_id)
  WHERE credited_invoice_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_posted_credit_note_journal_source
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'credit_note'
    AND source_id IS NOT NULL
    AND status = 'posted';

COMMENT ON COLUMN public.invoices.creation_complete IS
  'False only while a credit-note parent and its items are being assembled. API reads must expose only complete credit notes.';

NOTIFY pgrst, 'reload schema';
