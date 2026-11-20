-- The customer's own words with an answer to a reminder (accounted#104,
-- phase 2). The answer page (/invoice-action/[token]) lets the customer say
-- "Jag har betalat" or "Något stämmer inte" and, optionally, why; the note is
-- shown with the reminder on the invoice page and in the daily batch.
--
-- Written only by the public answer endpoint with the service role
-- (src/lib/reminders/answer.ts). Members of the company may read it, like
-- response_type: every invoice_reminders column but action_token is readable
-- by authenticated (tests/pg/credential-columns.pg.test.ts).
--
-- pg-test: tests/pg/invoice-reminders-engine.pg.test.ts

ALTER TABLE public.invoice_reminders
  ADD COLUMN IF NOT EXISTS response_note text;

ALTER TABLE public.invoice_reminders
  DROP CONSTRAINT IF EXISTS invoice_reminders_response_note_length;
ALTER TABLE public.invoice_reminders
  ADD CONSTRAINT invoice_reminders_response_note_length
  CHECK (response_note IS NULL OR char_length(response_note) BETWEEN 1 AND 1000);

COMMENT ON COLUMN public.invoice_reminders.response_note IS
  'The customer''s note with their answer to the reminder (answer page), at most 1000 characters.';

GRANT SELECT (response_note) ON public.invoice_reminders TO authenticated;

NOTIFY pgrst, 'reload schema';
