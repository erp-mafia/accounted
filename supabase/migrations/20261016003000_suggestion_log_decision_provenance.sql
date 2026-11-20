-- Decision receipts, step 2: record, at decision time, under which rules and
-- policy a bank line or underlag was decided and on which exact inputs.
--
-- Why: step 1 reads suggestion_log back as a decision receipt, but its
-- rule_version, policy_version, input_hash, checks and confidence_band are
-- always null because nothing records them. They cannot be derived later: the
-- rules, thresholds and inputs in force at read time are not the ones in force
-- when the decision was made. BFNAR 2013:2 p. 9.16 asks the behandlingshistorik
-- to cover automated processing and changes to processing rules.
--
-- Every column is written in the same INSERT as the rest of the row, so the
-- table stays append-only (suggestion_log_append_only refuses every UPDATE).
-- No backfill: rows written before this migration keep NULL, which the reader
-- answers as "not recorded".
--
-- pending_operation_id has no foreign key, like journal_entries.
-- source_proposal_id: a terminal pending_operations row is never deleted
-- except by its company's cascade or sandbox teardown, and every FK action is
-- wrong there. SET NULL needs an UPDATE the append-only guard refuses,
-- RESTRICT blocks the teardown, CASCADE would delete the decision with the
-- operation that carried it. The reader scopes the lookup by company_id.

ALTER TABLE public.suggestion_log
  ADD COLUMN rule_version         text,
  ADD COLUMN policy_version       text,
  ADD COLUMN input_hash           text,
  ADD COLUMN checks               jsonb,
  ADD COLUMN confidence_band      text,
  ADD COLUMN pending_operation_id uuid;

ALTER TABLE public.suggestion_log
  ADD CONSTRAINT suggestion_log_input_hash
    CHECK (input_hash IS NULL OR input_hash ~ '^[0-9a-f]{64}$'),
  -- CASE fixes the evaluation order, so a non-array never reaches the path.
  ADD CONSTRAINT suggestion_log_checks CHECK (
    CASE
      WHEN checks IS NULL THEN true
      WHEN jsonb_typeof(checks) <> 'array' THEN false
      ELSE NOT jsonb_path_exists(
        checks,
        '$[*] ? (!(@.type() == "object" && exists(@.id) && @.id.type() == "string" && exists(@.result) && (@.result == "pass" || @.result == "warn" || @.result == "fail")))'
      )
    END
  ),
  ADD CONSTRAINT suggestion_log_confidence_band CHECK (
    confidence_band IS NULL
    OR (confidence_band IN ('direct', 'review') AND acted_on IS NOT NULL AND policy_version IS NOT NULL)
  );

COMMENT ON COLUMN public.suggestion_log.rule_version IS
  'The rules that produced the suggestions on offer, as <pipeline>.<revision>[+<program version>]: bank-proposals for a bank line, inbox-extraction for an underlag. NULL on rows written before it was recorded.';
COMMENT ON COLUMN public.suggestion_log.policy_version IS
  'The approval policy confidence_band was evaluated under, with its thresholds (direct-booking.<revision>;...). NULL when no policy applies (an underlag, a dismissal) or on rows written before it was recorded.';
COMMENT ON COLUMN public.suggestion_log.input_hash IS
  'SHA-256 (hex) of the canonical JSON of the decision inputs, taken before booking: the bank line or underlag fields, the document hash and the suggestion list without matches_final. Field list: src/lib/suggestion-log/provenance.ts.';
COMMENT ON COLUMN public.suggestion_log.checks IS
  'The guards the booking door ran before deciding: [{id, result: pass|warn|fail, detail}]. [] when the door ran none; NULL when the door does not report them or the row predates it.';
COMMENT ON COLUMN public.suggestion_log.confidence_band IS
  'Under policy_version at decision time, whether the acted-on suggestion books without a review (direct) or opens one (review). Derived from deterministic backing, never the model''s own score. NULL without an acted-on suggestion.';
COMMENT ON COLUMN public.suggestion_log.pending_operation_id IS
  'The staged operation whose approval carried the decision, when an agent proposed it. No foreign key (see migration 20261016003000).';

-- The reader finds the operation by this column.
CREATE INDEX idx_suggestion_log_pending_operation
  ON public.suggestion_log (pending_operation_id) WHERE pending_operation_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
