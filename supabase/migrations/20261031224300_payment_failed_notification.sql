-- The mail when the bank rejects a payment or it fails (accounted#143).
--
-- notifyFailedPayments (src/lib/payments/orders/outcome-notify.ts) tells the
-- people who created, approved, sent or signed a bank payment that the bank
-- did not carry it out. Before it sends, it claims one notification_log row
-- per person and payment order and sends only when its insert won. This
-- partial unique index makes the claim atomic: a status sync that runs again,
-- or two that overlap, never mails the same person twice about the same
-- payment. A send that fails deletes its claims, so a later run tries again.
--
-- The type list is the newest redefinition's (20261012100400) with
-- 'payment_failed' added, the same drop-and-recreate pattern. Vercel ships
-- the code before CI applies this: until then the claim insert answers 23514,
-- nothing is sent, and the sweep's window picks the payment up afterwards.

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
    'skv_kvittens',
    'skv_connection_expired',
    'payment_failed'
  )) NOT VALID;
ALTER TABLE public.notification_log
  VALIDATE CONSTRAINT notification_log_notification_type_check;

-- Plain CREATE INDEX (not CONCURRENTLY): migrations run inside a transaction.
-- No row of the type exists yet, so the build cannot fail on a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_payment_failed_dedup
  ON public.notification_log (user_id, reference_id)
  WHERE notification_type = 'payment_failed';

NOTIFY pgrst, 'reload schema';
