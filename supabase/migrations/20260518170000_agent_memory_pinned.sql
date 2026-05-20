-- Migration: agent_memory.is_pinned — user-elected priority for prompt inclusion
--
-- Mirrors agent_conversations.pinned. A pinned entry always lands in the
-- top-N prompt block (§10/§11) regardless of relevance_score, so the user
-- can guarantee inclusion of facts the ranking heuristic might otherwise
-- demote. Dismiss remains a separate concept (is_active=false).

ALTER TABLE public.agent_memory
  ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;

-- Replace the ranking index so pinned rows sort first within each company.
DROP INDEX IF EXISTS public.idx_agent_memory_company_score;
CREATE INDEX idx_agent_memory_company_score
  ON public.agent_memory (company_id, is_pinned DESC, relevance_score DESC, last_accessed_at DESC NULLS LAST)
  WHERE is_active = true;

NOTIFY pgrst, 'reload schema';
