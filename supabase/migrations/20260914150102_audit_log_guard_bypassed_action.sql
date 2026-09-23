-- audit_log gains a GUARD_BYPASSED action.
--
-- A guard that warns before a booking and can be overridden ("bokför ändå")
-- currently leaves its override only in the server log, so the books carry no
-- trace that the user was warned and chose to book anyway. BFNAR 2013:2 p. 9.16
-- wants the behandlingshistorik to show it, and behandlingshistorik is reported
-- out of audit_log (see DECISIONS 2026-08-21), so the override has to land here
-- and nowhere else.
--
-- The first writer is the supplier-invoice duplicate-payment guard bypassed
-- with `force: true` (lib/invoices/duplicate-guard-history.ts). The action is
-- deliberately guard-agnostic: which guard was overridden, what it would have
-- flagged, and the payment voucher it was overridden for live in new_state, so
-- a second guard needs no further DDL.
--
-- NOT VALID skips the full-table validation scan: every existing row satisfies
-- the previous, strictly narrower constraint, and NOT VALID still enforces all
-- new rows. Same pattern as migration 20260825150000 (RESET_SNAPSHOT).

ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action = ANY (ARRAY[
    'INSERT','UPDATE','DELETE','COMMIT','REVERSE','CORRECT',
    'LOCK_PERIOD','CLOSE_PERIOD','DOCUMENT_DELETE_BLOCKED',
    'RETENTION_BLOCK','SECURITY_EVENT','INTEGRITY_FAILURE',
    'COMMITTED_AT_OVERRIDE','RESET_SNAPSHOT','GUARD_BYPASSED'
  ])) NOT VALID;

NOTIFY pgrst, 'reload schema';
