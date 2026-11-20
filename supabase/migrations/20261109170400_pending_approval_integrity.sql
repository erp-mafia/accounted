-- An interrupted approval reads as unknown (#156).
--
-- The stuck-committing sweep (src/lib/pending-operations/recover-stuck-committing.ts)
-- closed a row it found no posted trace for as 'rejected', which says nothing
-- happened. The approval may have posted before it was cut off. 'unknown' is
-- that outcome: terminal, never replayed, and the person checks the ledger
-- before staging the operation again.
--
-- 1. pending_operations_status_check gains 'unknown'.
-- 2. enforce_pending_operations_immutability (base: 20260722134114) and
--    enforce_pending_operations_no_delete (base: 20260807130000, keeping its
--    gnubok.sandbox_cleanup teardown bypass) treat 'unknown' as terminal.
-- 3. sync_company_suggestion_decision (base: 20261016200600; 20261017100500
--    only widened its trigger) snoozes the suggestion of an 'unknown'
--    operation for 30 days, as a rejected or failed_partial one. Until now the
--    sweep wrote 'rejected', which snoozed it; without this the suggestion
--    would stay open on a settled operation.
--
-- Each function body is its base definition with only 'unknown' added.
--
-- pg-test: tests/pg/pending-operations-committing-recovery.pg.test.ts,
--   tests/pg/company-suggestions.pg.test.ts, tests/pg/sandbox-cleanup.pg.test.ts

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing behind it.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. pending_operations_status_check: add 'unknown'
-- =============================================================================
-- Same drop + re-add pattern as 20260722134114 used for 'failed_partial'.
ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_status_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_status_check
  CHECK (status IN ('pending', 'committing', 'committed', 'rejected', 'failed_partial', 'unknown'));

-- =============================================================================
-- 2. terminal-state immutability: treat 'unknown' as terminal
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_pending_operations_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('committed', 'rejected', 'failed_partial', 'unknown') THEN
    RAISE EXCEPTION
      'pending_operations row % is in terminal state % and cannot be modified (BFL 7 kap.)',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.enforce_pending_operations_no_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Sandbox teardown: transaction-local flag, only set by
  -- cleanup_sandbox_user after its is_sandbox check, plus a per-row
  -- re-verification (same pattern as audit_log_immutable) so the flag alone
  -- can never unlock a real company's rows. cleanup_sandbox_user deletes
  -- these rows explicitly while company_settings still exists.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;
  IF OLD.status IN ('committed', 'rejected', 'failed_partial', 'unknown') THEN
    RAISE EXCEPTION
      'pending_operations row % is in terminal state % and cannot be deleted (BFL 7 kap.)',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 3. The suggestion decision: an 'unknown' operation snoozes its suggestion
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_company_suggestion_decision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'committed' THEN
    UPDATE public.company_suggestions
       SET state = 'accepted', decided_at = now(), snoozed_until = NULL
     WHERE pending_operation_id = NEW.id AND state = 'open';
  ELSIF NEW.status = 'rejected'
        AND lower(btrim(coalesce(NEW.rejection_reason, ''))) IN ('visa aldrig', 'never') THEN
    UPDATE public.company_suggestions
       SET state = 'declined', decided_at = now(), snoozed_until = NULL
     WHERE pending_operation_id = NEW.id AND state = 'open';
  ELSIF NEW.status IN ('rejected', 'failed_partial', 'unknown') THEN
    UPDATE public.company_suggestions
       SET state = 'snoozed', decided_at = now(), snoozed_until = now() + interval '30 days'
     WHERE pending_operation_id = NEW.id AND state = 'open';
  END IF;
  RETURN NULL;
END;
$$;

-- =============================================================================
-- 4. PostgREST schema reload
-- =============================================================================
NOTIFY pgrst, 'reload schema';
