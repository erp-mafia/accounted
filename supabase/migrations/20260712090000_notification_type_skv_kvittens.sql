-- Extend notification_log's notification_type CHECK with 'skv_kvittens'
-- (push/email confirmation when a Skatteverket kvittens lands for a filed
-- VAT or AGI declaration).
--
-- Also adds 'missing_underlag', which has existed in the NotificationType
-- TS union but was never added to this constraint: any attempt to log one
-- would have violated the CHECK.

ALTER TABLE public.notification_log
  DROP CONSTRAINT IF EXISTS notification_log_notification_type_check;

ALTER TABLE public.notification_log
  ADD CONSTRAINT notification_log_notification_type_check
  CHECK (notification_type IN (
    'tax_deadline',
    'invoice_due',
    'invoice_overdue',
    'period_locked',
    'period_year_closed',
    'invoice_sent',
    'receipt_extracted',
    'receipt_matched',
    'missing_underlag',
    'skv_kvittens'
  )) NOT VALID;

ALTER TABLE public.notification_log
  VALIDATE CONSTRAINT notification_log_notification_type_check;

NOTIFY pgrst, 'reload schema';
