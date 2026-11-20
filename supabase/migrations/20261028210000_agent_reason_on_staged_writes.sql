-- An agent's reason on a staged write: one or two sentences on why it
-- proposes it, shown to the person who approves it and kept with the
-- decision.
--
--   * pending_operations.agent_reason: what the staging door was given
--     (MCP staging tools and their bridges, REST v1 ?stage=true), trimmed and
--     cut at a word boundary to at most 500 characters before it is written
--     (src/lib/pending-operations/agent-reason.ts), so the CHECK is the
--     backstop, never the normal refusal. Set in the INSERT and never
--     changed: a committed or rejected row is immutable already
--     (pending_operations_immutability), so the reason of a decided proposal
--     stays as the approver saw it.
--   * suggestion_log.agent_reason: the decision receipt's own copy, written
--     in the same INSERT as the rest of the row by every door that records an
--     approved operation (the operation receipt, the bank-line and underlag
--     doors reached through an approval). A column, not a key inside
--     suggestions: a bank-line or underlag row lists the suggestions the
--     engine offered, and the staged proposal is not one of them. The table
--     stays append-only (suggestion_log_append_only is unchanged).
--   * behandlingshistorik_decisions() is re-created from its definition in
--     20261023094050 with agent_reason added to the decision rows it returns.
--     Nothing else in it changes.
--
-- No backfill: rows written before this migration keep NULL, which every
-- reader shows as no reason. The code is live a few minutes before this
-- runs: its writes retry without the column (PGRST204) and its reads without
-- naming it (42703).
-- pg-test: covered-by tests/pg/agent-reason.pg.test.ts

-- Never queue every write behind a long transaction: fail the migration job
-- instead and retry.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.pending_operations
  ADD COLUMN agent_reason text,
  ADD CONSTRAINT pending_operations_agent_reason_length
    CHECK (agent_reason IS NULL OR char_length(agent_reason) BETWEEN 1 AND 500);

COMMENT ON COLUMN public.pending_operations.agent_reason IS
  'Why the agent (or key) that staged the operation proposes it, in its own words, as given when staging: trimmed, at most 500 characters. Shown to the approver. NULL when none was given.';

ALTER TABLE public.suggestion_log
  ADD COLUMN agent_reason text,
  ADD CONSTRAINT suggestion_log_agent_reason_length
    CHECK (agent_reason IS NULL OR char_length(agent_reason) BETWEEN 1 AND 500);

COMMENT ON COLUMN public.suggestion_log.agent_reason IS
  'The staged operation''s agent_reason at the approval that carried this decision (pending_operation_id), copied in the same INSERT. NULL when none was given, outside an approval, or on rows written before it was recorded.';

-- ── behandlingshistorik_decisions: the decision rows carry agent_reason ─────
CREATE OR REPLACE FUNCTION public.behandlingshistorik_decisions(
  p_company_id uuid,
  p_period_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_fiscal_year boolean
)
RETURNS TABLE (
  rows json,
  entries json,
  operations json,
  legacy_by_entry json,
  legacy_by_registration json
)
LANGUAGE plpgsql
STABLE
SET search_path TO ''
SET plan_cache_mode TO 'force_custom_plan'
AS $$
BEGIN
  RETURN QUERY
  WITH decision_rows AS MATERIALIZED (
    SELECT s.id, s.kind, s.transaction_id, s.inbox_item_id, s.document_id, s.suggestions,
           s.acted_on, s.final, s.outcome, s.actor_type, s.resolved_by, s.created_at,
           s.rule_version, s.policy_version, s.input_hash, s.checks, s.confidence_band,
           s.pending_operation_id, s.agent_reason
      FROM public.suggestion_log s
     WHERE s.company_id = p_company_id
       AND ((s.created_at >= p_from AND s.created_at <= p_to)
            OR (p_fiscal_year AND s.final->>'journal_entry_id' IN (
                  SELECT e.id::text FROM public.journal_entries e
                   WHERE e.company_id = p_company_id
                     AND e.fiscal_period_id = p_period_id)))
  ),
  -- bookedEntryId(): final is an object whose journal_entry_id is a non-empty
  -- string. legacy: the row names no staged operation.
  booked AS MATERIALIZED (
    SELECT DISTINCT d.final->>'journal_entry_id' AS entry_id, d.pending_operation_id IS NULL AS legacy
      FROM decision_rows d
     WHERE jsonb_typeof(d.final) = 'object'
       AND jsonb_typeof(d.final->'journal_entry_id') = 'string'
       AND d.final->>'journal_entry_id' <> ''
  ),
  company_operations AS NOT MATERIALIZED (
    SELECT po.id, po.operation_type, po.actor_type, po.actor_id, po.actor_label, po.risk_level,
           po.agent_metadata, po.created_at, po.resolved_at, po.status,
           po.result_data->>'journal_entry_id' AS journal_entry_id,
           po.result_data->>'registration_journal_entry_id' AS registration_journal_entry_id
      FROM public.pending_operations po
     WHERE po.company_id = p_company_id
  )
  SELECT
    (SELECT coalesce(json_agg(d), '[]'::json) FROM decision_rows d),
    (
      SELECT coalesce(json_agg(t), '[]'::json)
        FROM (
          SELECT e.id, e.voucher_series, e.voucher_number, e.status, e.committed_actor_type,
                 e.committed_actor_label, e.commit_method
            FROM public.journal_entries e
           WHERE e.company_id = p_company_id
             -- The reader looks vouchers up by the string it holds, and the
             -- ids it gets back are canonical: no other string can match.
             AND e.id IN (
                   SELECT b.entry_id::uuid FROM booked b
                    WHERE b.entry_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        ) t),
    (
      SELECT coalesce(json_agg(t), '[]'::json)
        FROM (
          SELECT o.id, o.operation_type, o.actor_type, o.actor_id, o.actor_label, o.risk_level,
                 o.agent_metadata, o.created_at, o.resolved_at, o.journal_entry_id,
                 o.registration_journal_entry_id
            FROM company_operations o
           WHERE o.id IN (SELECT d.pending_operation_id FROM decision_rows d WHERE d.pending_operation_id IS NOT NULL)
        ) t),
    (
      SELECT coalesce(json_agg(t), '[]'::json)
        FROM (
          SELECT o.id, o.operation_type, o.actor_type, o.actor_id, o.actor_label, o.risk_level,
                 o.agent_metadata, o.created_at, o.resolved_at, o.journal_entry_id,
                 o.registration_journal_entry_id
            FROM company_operations o
           WHERE o.status = 'committed'
             AND o.journal_entry_id IN (SELECT b.entry_id FROM booked b WHERE b.legacy)
           ORDER BY o.id
        ) t),
    (
      SELECT coalesce(json_agg(t), '[]'::json)
        FROM (
          SELECT o.id, o.operation_type, o.actor_type, o.actor_id, o.actor_label, o.risk_level,
                 o.agent_metadata, o.created_at, o.resolved_at, o.journal_entry_id,
                 o.registration_journal_entry_id
            FROM company_operations o
           WHERE o.status = 'committed'
             AND o.registration_journal_entry_id IN (SELECT b.entry_id FROM booked b WHERE b.legacy)
           ORDER BY o.id
        ) t);
END;
$$;

REVOKE ALL ON FUNCTION public.behandlingshistorik_decisions(uuid, uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.behandlingshistorik_decisions(uuid, uuid, timestamptz, timestamptz, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
