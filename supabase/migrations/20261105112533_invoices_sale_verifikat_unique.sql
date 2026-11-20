DROP INDEX IF EXISTS public.idx_invoices_journal_entry_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_journal_entry_id_unique
  ON public.invoices (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
