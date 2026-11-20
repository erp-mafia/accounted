-- One more event on a payment order: 'recreated_after_expired_signing'.
--
-- Why: a BankID signing the bank let expire (SIGNING_SESSION_EXPIRED, a
-- cancelled app) cannot be started again on the same payment at Open
-- Payments: a second POST authorisation on the payment answers FORMAT_ERROR,
-- so "Signera igen" failed forever. The signing service now cancels such a
-- payment at the bank (a confirmed cancel only, release_payment_order), claims
-- the order again and creates a new payment for it under a new idempotency
-- key, then starts BankID on the new payment. The recreate is recorded on the
-- order, in the new signing, with the previous signing and payment id in the
-- detail, so the trail reads: provider_cancelled, released, submitted,
-- recreated_after_expired_signing, signing_started.
--
-- The event type list is a CHECK on payment_order_events.event_type
-- (20261010090000); this widens it by that one value and changes nothing
-- else. The rules of the lifecycle trigger are untouched: the payment id still
-- leaves the order only on the way back to approved, after the bank confirmed
-- its cancel.

ALTER TABLE public.payment_order_events
  DROP CONSTRAINT IF EXISTS payment_order_events_event_type_check;

ALTER TABLE public.payment_order_events
  ADD CONSTRAINT payment_order_events_event_type_check CHECK (event_type IN (
    'created', 'edited', 'approved', 'unapproved', 'submitted',
    'signing_started', 'status_changed', 'cancel_requested',
    'cancelled', 'matched', 'unmatched', 'error',
    'outcome_unknown', 'provider_cancelled', 'released', 'rebatched',
    'invoice_closed', 'recreated_after_expired_signing'));

NOTIFY pgrst, 'reload schema';
