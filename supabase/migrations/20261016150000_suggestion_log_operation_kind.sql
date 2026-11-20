-- Decision receipts for staged operations: suggestion_log gains the kind
-- 'operation', a decision whose subject is the pending operation an approval
-- committed rather than a bank line or an underlag.
-- pg-test: covered-by tests/pg/suggestion-log.pg.test.ts
--
-- Why: a posting that is staged (MCP, REST ?stage=true, the Att göra list)
-- and then approved through commitPendingOperation answered no receipt: the
-- receipt reader (src/lib/suggestion-log/receipts.ts) reads suggestion_log,
-- and only the bank-line and underlag doors write it. A staged manual IB or a
-- free voucher has neither a bank line nor an underlag, so the subject CHECK
-- refused any row that could describe it. The commit now writes one row per
-- voucher the approval posted (src/lib/suggestion-log/operation.ts), named by
-- pending_operation_id, and only when no door already recorded that voucher's
-- decision for the same operation.
--
-- Two CHECKs are re-created from their current definitions (20261011140008)
-- with the new kind added, NOT VALID; 20261016150100 validates them in a
-- separate transaction, as 20261016120100/120200 did for the actor type:
--   suggestion_log_kind_check  bank_line, inbox_item, operation
--   suggestion_log_subject     an operation row names its pending_operation_id
-- Each DROP names the constraint without IF EXISTS, so a name that is not
-- what this file expects fails the migration instead of leaving the old rule
-- in force beside the new one.
--
-- Nothing else changes: an operation row is append-only like every other row
-- (suggestion_log_append_only), goes only with its company (it has no bank
-- line, inbox item or document to cascade with), and is inserted under the
-- existing policy (resolved_by = auth.uid() for a member; the service role
-- for API-key and MCP approvals). No row is rewritten.

-- Never queue every write behind a long transaction: fail the migration job
-- instead and retry.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.suggestion_log
  DROP CONSTRAINT suggestion_log_kind_check;
ALTER TABLE public.suggestion_log
  ADD CONSTRAINT suggestion_log_kind_check
  CHECK (kind IN ('bank_line', 'inbox_item', 'operation')) NOT VALID;

ALTER TABLE public.suggestion_log
  DROP CONSTRAINT suggestion_log_subject;
ALTER TABLE public.suggestion_log
  ADD CONSTRAINT suggestion_log_subject CHECK (
    CASE kind
      WHEN 'bank_line' THEN transaction_id IS NOT NULL
      WHEN 'operation' THEN pending_operation_id IS NOT NULL
      ELSE inbox_item_id IS NOT NULL OR document_id IS NOT NULL
    END
  ) NOT VALID;

COMMENT ON TABLE public.suggestion_log IS
  'One row per bookkeeping decision on a bank line, an inbox item or an approved staged operation: the suggestions on offer, the one acted on, what was booked, the outcome and who decided. Append-only; rows go only with their company, bank line, inbox item or document.';
COMMENT ON COLUMN public.suggestion_log.pending_operation_id IS
  'The staged operation whose approval carried the decision, when an agent proposed it; the subject of a kind = operation row. No foreign key (see migration 20261016003000).';

NOTIFY pgrst, 'reload schema';
