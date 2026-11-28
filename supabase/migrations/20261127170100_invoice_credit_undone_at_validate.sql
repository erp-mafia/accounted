-- Validate invoices_credit_undone_is_cancelled_credit_note, added NOT VALID
-- in 20261127170000. Kept separate so the full-table scan runs under the
-- weaker lock (the split of 20261125180000 / 20261125180100). The column is
-- new and NULL on every row, so every existing row passes.

ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_credit_undone_is_cancelled_credit_note;
