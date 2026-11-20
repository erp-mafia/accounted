-- suggestion_log: one row per bookkeeping decision on a bank line or an inbox
-- item. It keeps the suggestions that were on offer at that moment (AI
-- reading, mapping rule, catalog template, counterparty template, recent
-- booking, document extraction), which one the person or agent acted on, what
-- was finally booked, the outcome and who decided.
--
-- Why: nothing pairs a suggestion with the decision made on it today.
-- transaction_assistant_reads keeps only the latest AI reading per
-- transaction, rule and template suggestions are never stored, and
-- categorize_calibration_samples is anonymous and written from one dialog. A
-- decision that is not recorded when it is made cannot be reconstructed
-- afterwards, so the pairs needed to measure (and later improve) the
-- automatic booking are lost every day.
--
-- This migration creates the store and its lifecycle only. The writers come
-- with the booking paths in a later change, one row per decision, written
-- after the booking succeeds.
--
-- Lifecycle:
--   * A row lives exactly as long as what it describes: it cascades with its
--     company, bank line, inbox item or document. A booked bank line, a
--     converted inbox item and a document on a posted voucher cannot be
--     deleted, so the cascade only reaches decisions that never became
--     bookkeeping, plus sandbox teardown.
--   * Append-only: UPDATE is always refused. DELETE passes only through a
--     foreign-key cascade (trigger depth > 1) or under gnubok.allow_delete.
--     payment_match_log refuses cascades on purpose; here a refused cascade
--     would make every dismissed bank line undeletable.
--   * No foreign key from journal_entries.source_proposal_id: the voucher will
--     point at its decision row, and a SET NULL cascade would have to update
--     a posted voucher (refused by its immutability trigger) while RESTRICT
--     would block the legitimate deletes above.
--   * Not räkenskapsinformation in itself: the behandlingshistorik BFNAR
--     2013:2 p. 9.16 requires (who booked what and when, automated or not)
--     lives in journal_entries, audit_log and processing_history. Living as
--     long as the books keeps BFL 7 kap. satisfied should an auditor count the
--     log as part of that history.
--   * No audit trigger: like the other append-only logs, the row is the
--     record, and audit_log would only duplicate every insert.

CREATE TABLE public.suggestion_log (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('bank_line', 'inbox_item')),
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE CASCADE,
  inbox_item_id  uuid REFERENCES public.invoice_inbox_items(id) ON DELETE CASCADE,
  document_id    uuid REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  suggestions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  acted_on       integer,
  final          jsonb,
  outcome        text NOT NULL CHECK (outcome IN ('accepted', 'changed', 'manual', 'dismissed')),
  actor_type     text NOT NULL
    CHECK (actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat')),
  resolved_by    uuid REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suggestion_log_subject CHECK (
    CASE kind
      WHEN 'bank_line' THEN transaction_id IS NOT NULL
      ELSE inbox_item_id IS NOT NULL OR document_id IS NOT NULL
    END
  ),
  -- CASE fixes the evaluation order, so a non-array never reaches
  -- jsonb_array_length.
  CONSTRAINT suggestion_log_acted_on CHECK (
    CASE
      WHEN jsonb_typeof(suggestions) <> 'array' THEN false
      WHEN (acted_on IS NOT NULL) <> (outcome IN ('accepted', 'changed')) THEN false
      WHEN acted_on IS NULL THEN true
      ELSE acted_on >= 0 AND acted_on < jsonb_array_length(suggestions)
    END
  ),
  CONSTRAINT suggestion_log_final CHECK ((final IS NULL) = (outcome = 'dismissed'))
);

COMMENT ON TABLE public.suggestion_log IS
  'One row per bookkeeping decision on a bank line or inbox item: the suggestions on offer, the one acted on, what was booked, the outcome and who decided. Append-only; rows go only with their company, bank line, inbox item or document.';
COMMENT ON COLUMN public.suggestion_log.suggestions IS
  'Ranked list of what was on offer: [{source, source_id, rank, proposal, confidence, model, prompt_sha256, matches_final}]. Sources: assistant, rule, catalog, counterparty_template, recent, extraction.';
COMMENT ON COLUMN public.suggestion_log.acted_on IS
  'Index into suggestions of the one the person or agent acted on; set exactly when outcome is accepted or changed.';
COMMENT ON COLUMN public.suggestion_log.final IS
  'What was booked: accounts and VAT treatment, voucher lines, or the final document fields. NULL only when the bank line or inbox item was dismissed.';
COMMENT ON COLUMN public.suggestion_log.outcome IS
  'accepted: booked as suggested. changed: started from a suggestion, booked something else. manual: booked without acting on a suggestion. dismissed: the bank line was ignored or the inbox item deleted.';
COMMENT ON COLUMN public.suggestion_log.actor_type IS
  'Who relayed the decision, same vocabulary as journal_entries.committed_actor_type.';

CREATE INDEX idx_suggestion_log_company_created
  ON public.suggestion_log (company_id, created_at DESC);
-- The cascades look rows up by these columns.
CREATE INDEX idx_suggestion_log_transaction
  ON public.suggestion_log (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX idx_suggestion_log_inbox_item
  ON public.suggestion_log (inbox_item_id) WHERE inbox_item_id IS NOT NULL;
CREATE INDEX idx_suggestion_log_document
  ON public.suggestion_log (document_id) WHERE document_id IS NOT NULL;

ALTER TABLE public.suggestion_log ENABLE ROW LEVEL SECURITY;

-- Rows are inserted, never changed: nobody gets UPDATE. service_role keeps
-- DELETE for the gnubok.allow_delete path; members only read and insert.
GRANT SELECT, INSERT, DELETE ON TABLE public.suggestion_log TO service_role;
GRANT SELECT, INSERT ON TABLE public.suggestion_log TO authenticated;

CREATE POLICY "view own-company suggestion_log"
  ON public.suggestion_log FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));

CREATE POLICY "insert own suggestion_log"
  ON public.suggestion_log FOR INSERT
  WITH CHECK (
    company_id IN (SELECT user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND resolved_by = auth.uid()
  );

CREATE OR REPLACE FUNCTION public.suggestion_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- A row leaves only with what it describes: the foreign-key cascade from its
  -- company, bank line, inbox item or document runs at trigger depth > 1.
  -- gnubok.allow_delete is the operator and sandbox-teardown override used
  -- across the schema. UPDATE has no exception: a decision is recorded once.
  IF TG_OP = 'DELETE'
     AND (pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true') THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'suggestion_log is append-only: % is not allowed', TG_OP;
END;
$$;

REVOKE ALL ON FUNCTION public.suggestion_log_append_only() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.suggestion_log
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- Archived migration-reset source companies are static (20260818084050).
CREATE TRIGGER suggestion_log_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.suggestion_log
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE TRIGGER suggestion_log_append_only
  BEFORE UPDATE OR DELETE ON public.suggestion_log
  FOR EACH ROW EXECUTE FUNCTION public.suggestion_log_append_only();

NOTIFY pgrst, 'reload schema';
