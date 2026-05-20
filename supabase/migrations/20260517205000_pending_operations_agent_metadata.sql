-- Migration: pending_operations.agent_metadata — BFL audit hook for agent-staged ops
--
-- When the specialized accountant agent stages a write (categorize a
-- transaction, draft an invoice, propose a verifikation, …), we need to
-- record exactly what the model "knew" at that moment so the operation
-- is reconstructable years later under BFL 5 kap retention.
--
-- We extend the existing pending_operations table (do not invent a parallel
-- table — auditors look at one place). The new column is jsonb so the shape
-- can evolve without further migrations; the producer shape is:
--
--   {
--     "conversation_id":     "<uuid>",
--     "intent_id":           "transaction.categorization",
--     "model":               "claude-sonnet-4-6",
--     "model_version":       "<id from API response>",
--     "prompt_hash":         "sha256:<hex of system prompt>",
--     "atoms_loaded":        ["horizontal/swedish-vat", "vertical/konsult-it", ...],
--     "approved_by_user_id": "<uuid set on approval>"
--   }
--
-- Existing pending_operations rows have agent_metadata = NULL — only ops
-- staged by the agent loop populate it.
--
-- See dev_docs/specialized-agent-plan.md §5 (BFL audit) and §9 (chat loop).

ALTER TABLE public.pending_operations
  ADD COLUMN agent_metadata jsonb;

-- Helpful for "show me everything Sonnet 4.6 staged" / per-conversation audits.
CREATE INDEX idx_pending_ops_agent_conversation
  ON public.pending_operations ((agent_metadata->>'conversation_id'))
  WHERE agent_metadata IS NOT NULL;

NOTIFY pgrst, 'reload schema';
