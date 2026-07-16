-- Validate separately from ADD CONSTRAINT so the table scan does not run while
-- the stronger ALTER TABLE lock from the first migration is still held.
ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_credit_note_not_paid;

NOTIFY pgrst, 'reload schema';
