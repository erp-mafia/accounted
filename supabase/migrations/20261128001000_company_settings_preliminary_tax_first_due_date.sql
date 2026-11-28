-- The first förfallodag of the company's debiterad preliminärskatt, as
-- Skatteverket's decision states it. A company approved for F-skatt during
-- the year often has its first debitering months later; the deadline
-- generator (src/lib/tax/deadline-config.ts, f_skatt) creates no payment
-- deadline for a month before the month of this date. NULL: no first date,
-- every month with a debited amount gets its deadline, as before.
--
-- A plain nullable date: the doors validate it with the shared sane-date
-- schema, and any calendar day is a valid answer, so no CHECK is added.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS preliminary_tax_first_due_date date;

COMMENT ON COLUMN public.company_settings.preliminary_tax_first_due_date IS
  'First förfallodag of debiterad preliminärskatt per Skatteverket''s decision. No F-skatt payment deadline is generated for a month before this date''s month. NULL: none.';

NOTIFY pgrst, 'reload schema';
