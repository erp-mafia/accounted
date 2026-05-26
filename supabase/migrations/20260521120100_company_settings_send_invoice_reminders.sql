-- Per-company kill switch for automated invoice reminder emails.
-- Default true preserves current behavior. When false, the daily
-- /api/invoices/reminders/cron run skips this company entirely
-- (see lib/invoices/reminder-processor.ts).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS send_invoice_reminders boolean DEFAULT true;

NOTIFY pgrst, 'reload schema';
