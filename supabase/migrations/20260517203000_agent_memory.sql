-- Migration: agent_memory — durable facts, preferences, patterns, corrections
--
-- The agent accumulates business-specific knowledge over time. Each entry
-- records a single fact ("VD heter Anna", a counterparty habit, a user-
-- expressed preference about lön/utdelning split, …) with provenance and
-- a ranking score.
--
-- Lifecycle is append-only: corrections do not delete prior entries, they
-- create a new entry and set `superseded_by` on the old one. is_active=false
-- pulls an entry out of the ranking pool without losing the audit trail.
--
-- Why ranking matters: the per-user system prompt block includes only the
-- top-N entries (plan §11: cap 30). The 200 stored entries form the pool;
-- inclusion is determined per-turn by relevance_score and last_accessed_at.
-- Keeping prompt churn low protects the per-user cache breakpoint (§10).
--
-- See dev_docs/specialized-agent-plan.md §5 (data model) and §11 (memory).

CREATE TABLE public.agent_memory (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Kind shapes how the agent uses the entry:
  --   fact        — verifiable statement ("räkenskapsår jan–dec")
  --   preference  — user-stated choice ("föredrar e-faktura framför PDF")
  --   pattern     — observed regularity ("hyresfaktura kommer 25e varje månad")
  --   correction  — agent learned from a user fix
  kind               text NOT NULL CHECK (kind IN ('fact', 'preference', 'pattern', 'correction')),

  content            text NOT NULL,

  -- Provenance.
  --   composer     — Phase A/B auto-derived from TIC/SIE/banking
  --   user_taught  — Phase C intake or explicit "remember this"
  --   agent_learned — captured during a conversation (with user assent)
  --   derived      — computed from other memory or transaction history
  source             text NOT NULL CHECK (source IN ('composer', 'user_taught', 'agent_learned', 'derived')),
  source_ref         text,

  -- Ranking score for prompt inclusion. POC: cheap heuristic (recency +
  -- intent match). Post-POC: embedding similarity vs. current turn.
  relevance_score    real NOT NULL DEFAULT 0,

  is_active          boolean NOT NULL DEFAULT true,
  superseded_by      uuid REFERENCES public.agent_memory(id) ON DELETE SET NULL,

  -- Used by the ranking heuristic.
  last_accessed_at   timestamptz,

  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_memory_company_active
  ON public.agent_memory (company_id, is_active)
  WHERE is_active = true;

CREATE INDEX idx_agent_memory_company_kind
  ON public.agent_memory (company_id, kind)
  WHERE is_active = true;

-- Ranking lookup: top-N active by score desc per company.
CREATE INDEX idx_agent_memory_company_score
  ON public.agent_memory (company_id, relevance_score DESC, last_accessed_at DESC NULLS LAST)
  WHERE is_active = true;

CREATE TRIGGER agent_memory_updated_at
  BEFORE UPDATE ON public.agent_memory
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE public.agent_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_memory_select"
  ON public.agent_memory
  FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "agent_memory_insert"
  ON public.agent_memory
  FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "agent_memory_update"
  ON public.agent_memory
  FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()));

-- No DELETE policy: lifecycle is append-only with is_active=false.

NOTIFY pgrst, 'reload schema';
