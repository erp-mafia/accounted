-- pg-test: covered-by tests/pg/payment-match-log-actions.pg.test.ts
-- Widen payment_match_log.action with 'auto_matched'.
--
-- The debit of a bank payment order Accounted initiated (payment_orders) now
-- books the supplier payment without a person confirming it: the owner
-- approved and BankID-signed exactly that payment, so the bank's matching
-- debit is the confirmation (lib/payments/orders/auto-settle.ts). The match
-- log must say that the booking was automatic, as 'auto_suggested' already
-- does for suggestions, and logMatchEvent is fire-and-forget: a value the
-- CHECK lacks is dropped silently (the 20260813210000 gap).
--
-- NOT VALID + VALIDATE, as in 20260813210000: both ALTERs take brief
-- metadata-only locks and the validation scan does not block inserts. The
-- new set is a strict superset of the old one, so validation cannot fail.

ALTER TABLE public.payment_match_log
  DROP CONSTRAINT payment_match_log_action_check;

ALTER TABLE public.payment_match_log
  ADD CONSTRAINT payment_match_log_action_check CHECK (action IN (
    'matched',
    'unmatched',
    'auto_suggested',
    'suggestion_cleared',
    'storno_conflict_resolved',
    'linked_to_existing_voucher',
    'auto_matched'
  )) NOT VALID;

ALTER TABLE public.payment_match_log
  VALIDATE CONSTRAINT payment_match_log_action_check;

NOTIFY pgrst, 'reload schema';
