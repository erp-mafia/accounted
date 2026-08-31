-- Admit 'pending' to notification_log's delivery_status CHECK.
--
-- The bookkeeping digest (20260831100000) uses a recoverable claim: the row
-- is inserted as 'pending' BEFORE the email is handed to the provider and
-- flipped to 'sent' only after the provider accepted it. A 'pending' claim
-- whose sent_at lease has gone stale marks a run that died mid-send and can
-- be taken over by a later run. The prior senders (kvittens,
-- connection-expired) insert 'sent' up front and lose the day's mail if the
-- worker dies between claim and send; the digest closes that gap, which
-- needs the intermediate state to be representable.
--
-- The original CHECK was defined inline in 20240101000008
-- (('sent','delivered','failed')); same drop-and-recreate pattern as the
-- notification_type constraint migrations.

ALTER TABLE public.notification_log
  DROP CONSTRAINT IF EXISTS notification_log_delivery_status_check;

ALTER TABLE public.notification_log
  ADD CONSTRAINT notification_log_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'failed')) NOT VALID;

ALTER TABLE public.notification_log
  VALIDATE CONSTRAINT notification_log_delivery_status_check;

NOTIFY pgrst, 'reload schema';
