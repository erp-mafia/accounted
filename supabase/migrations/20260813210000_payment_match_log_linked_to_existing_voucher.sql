-- Migration: widen payment_match_log.action CHECK with 'linked_to_existing_voucher'
--
-- The code has emitted action = 'linked_to_existing_voucher' since the
-- existing-voucher link paths shipped (lib/transactions/link-journal-entry.ts,
-- lib/reconciliation/bank-reconciliation.ts / autoReconcileTransactionForLinkedVoucher),
-- but the CHECK from 20260323120000 never included the value. logMatchEvent is
-- fire-and-forget, so every such insert failed the constraint silently and the
-- link went unlogged: a BFL 7:1 audit-trail gap, since match/unmatch events are
-- rakenskapsinformation. This restores logging for existing-voucher links.
--
-- Backfill of the silently dropped rows is NOT possible (the inserts never
-- landed anywhere); the transactions themselves still carry the link via
-- journal_entry_id + reconciliation_method. A one-off count of affected links
-- since 2026-03-23 can be estimated on prod from transactions rows with
-- reconciliation_method = 'manual' joined against the absence of a matching
-- payment_match_log row; left as an ops follow-up, not a migration concern.

-- NOT VALID + VALIDATE: the plain ADD CONSTRAINT would scan the table under
-- an ACCESS EXCLUSIVE lock. NOT VALID makes both ALTERs brief metadata-only
-- locks, and VALIDATE scans under SHARE UPDATE EXCLUSIVE, which does not
-- block concurrent match-log inserts. The new set is a strict superset of the
-- old CHECK, so validation cannot fail on existing rows.

ALTER TABLE public.payment_match_log
  DROP CONSTRAINT payment_match_log_action_check;

ALTER TABLE public.payment_match_log
  ADD CONSTRAINT payment_match_log_action_check CHECK (action IN (
    'matched',
    'unmatched',
    'auto_suggested',
    'suggestion_cleared',
    'storno_conflict_resolved',
    'linked_to_existing_voucher'
  )) NOT VALID;

ALTER TABLE public.payment_match_log
  VALIDATE CONSTRAINT payment_match_log_action_check;

NOTIFY pgrst, 'reload schema';
