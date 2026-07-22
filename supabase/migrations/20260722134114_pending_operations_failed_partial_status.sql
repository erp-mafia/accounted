-- Migration: add 'failed_partial' terminal status to pending_operations.
--
-- Issue #842 (follow-up deferred from PR #841): several multi-step executors
-- post an irreversible voucher and then perform a later fallible step (e.g.
-- match_transaction_invoice posts a storno before building the payment JE;
-- credit_invoice persists the credit note before posting its JE). When the
-- later step failed, the dispatcher marked the WHOLE op 'rejected', which
-- misrepresents reality: an immutable voucher/credit note already exists.
--
-- 'failed_partial' is the honest terminal state for that case: the operation
-- did NOT complete, but side-effects were posted and their ids are recorded
-- in result_data.posted_ids so an operator can find the orphaned voucher.
--
-- Semantics:
--   - terminal: rows are immutable and undeletable once in this state, same
--     as 'committed'/'rejected' (BFL 7 kap.: the posted underlag and the
--     record of what happened must be unalterable)
--   - NOT re-committable: the CAS claim only picks up status = 'pending',
--     which already excludes it; the immutability trigger below additionally
--     blocks any status rewrite
--   - NOT pending work: worklist/pending counts filter on 'pending' only

-- =============================================================================
-- 1. pending_operations_status_check: add 'failed_partial'
-- =============================================================================
-- Same drop + re-add pattern as 20260504100000 used when adding 'committing'.
ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_status_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_status_check
  CHECK (status IN ('pending', 'committing', 'committed', 'rejected', 'failed_partial'));

-- =============================================================================
-- 2. terminal-state immutability: treat 'failed_partial' as terminal
-- =============================================================================
-- Replaces the functions from 20260504100000 (never edit that migration) so
-- the UPDATE/DELETE blockers cover the new terminal state too.

CREATE OR REPLACE FUNCTION public.enforce_pending_operations_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('committed', 'rejected', 'failed_partial') THEN
    RAISE EXCEPTION
      'pending_operations row % is in terminal state % and cannot be modified (BFL 7 kap.)',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pending_operations_immutability ON public.pending_operations;
CREATE TRIGGER pending_operations_immutability
  BEFORE UPDATE ON public.pending_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_pending_operations_immutability();

CREATE OR REPLACE FUNCTION public.enforce_pending_operations_no_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('committed', 'rejected', 'failed_partial') THEN
    RAISE EXCEPTION
      'pending_operations row % is in terminal state % and cannot be deleted (BFL 7 kap.)',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pending_operations_no_delete ON public.pending_operations;
CREATE TRIGGER pending_operations_no_delete
  BEFORE DELETE ON public.pending_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_pending_operations_no_delete();

-- Note: pending_ops_auto_commit_status (20260430120000) constrained
-- auto_committed_at to status = 'committed', but it was dropped together with
-- the auto-commit feature in 20260505190027, so there is nothing to expand
-- for the new status.

-- =============================================================================
-- 3. PostgREST schema reload
-- =============================================================================
NOTIFY pgrst, 'reload schema';
