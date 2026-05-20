-- Migration: agent_conversations + agent_messages — persistent agent chat
--
-- Every "Fråga min revisor" click opens (or resumes) a conversation. The
-- pair of tables here is the durable record:
--
--   agent_conversations — one row per chat thread (intent that opened it,
--                         what page/entity it was bound to, pinned/archived
--                         state for the /chat surface).
--   agent_messages      — full Anthropic content array (text, tool_use,
--                         tool_result). Cascade-deleted when the parent
--                         conversation goes away.
--
-- Conversations belong to a company and a user. Cross-tenant access is
-- prevented by both: the company_id RLS predicate keeps team members from
-- seeing each other's drafts (a bureau-tier memory model lifts this in
-- post-POC; see plan §18.2).
--
-- Messages store content as jsonb (the raw Anthropic content array) to
-- preserve tool_use / tool_result blocks verbatim — BFL audit needs the
-- exact reasoning chain that led to a staged operation.
--
-- See dev_docs/specialized-agent-plan.md §5 (data model) and §9 (chat loop).

CREATE TABLE public.agent_conversations (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Which intent opened this conversation. Free-form text because intents
  -- live in lib/agent/intents/<id>.ts, not in the DB.
  intent_id         text NOT NULL,

  -- Optional reference to a captured context object, shaped as
  -- "<kind>:<id>" (e.g. "transaction:abc-123", "invoice:def-456"). null for
  -- general.help / settings.help / /chat sessions with no bound entity.
  context_ref       text,

  title             text,
  pinned            boolean NOT NULL DEFAULT false,
  archived          boolean NOT NULL DEFAULT false,
  last_message_at   timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Sidebar / /chat list query: active conversations per company, newest first.
CREATE INDEX idx_agent_conversations_company_active
  ON public.agent_conversations (company_id, archived, last_message_at DESC NULLS LAST);

-- "My conversations" filter on /chat.
CREATE INDEX idx_agent_conversations_user
  ON public.agent_conversations (user_id, last_message_at DESC NULLS LAST);

-- Quick lookup when an intent invocation re-opens an existing conversation
-- bound to the same entity.
CREATE INDEX idx_agent_conversations_context
  ON public.agent_conversations (company_id, context_ref)
  WHERE context_ref IS NOT NULL;

CREATE TRIGGER agent_conversations_updated_at
  BEFORE UPDATE ON public.agent_conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- agent_messages
-- =============================================================================

CREATE TABLE public.agent_messages (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id   uuid NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,

  -- Anthropic content roles. 'tool' is our shorthand for a turn that carries
  -- only tool_result blocks (the API itself reuses role='user' for that, but
  -- we record it separately so the timeline stays legible).
  role              text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),

  -- Raw Anthropic content array: [{ type: 'text'|'tool_use'|'tool_result', ... }, ...]
  content           jsonb NOT NULL,

  -- Convenience denormalization for tool turns.
  tool_use_id       text,

  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Replay order: conversation → messages ascending.
CREATE INDEX idx_agent_messages_conversation
  ON public.agent_messages (conversation_id, created_at);

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_conversations_select"
  ON public.agent_conversations
  FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "agent_conversations_insert"
  ON public.agent_conversations
  FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "agent_conversations_update"
  ON public.agent_conversations
  FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "agent_conversations_delete"
  ON public.agent_conversations
  FOR DELETE
  USING (company_id IN (SELECT public.user_company_ids()));

ALTER TABLE public.agent_messages ENABLE ROW LEVEL SECURITY;

-- Messages inherit visibility from their parent conversation.
CREATE POLICY "agent_messages_select"
  ON public.agent_messages
  FOR SELECT
  USING (
    conversation_id IN (
      SELECT id FROM public.agent_conversations
      WHERE company_id IN (SELECT public.user_company_ids())
    )
  );

CREATE POLICY "agent_messages_insert"
  ON public.agent_messages
  FOR INSERT
  WITH CHECK (
    conversation_id IN (
      SELECT id FROM public.agent_conversations
      WHERE company_id IN (SELECT public.user_company_ids())
    )
  );

-- No UPDATE / DELETE policies: messages are append-only. The audit trail of
-- what was said matters for BFL reconstruction (see pending_operations.
-- agent_metadata, which references conversation_id).

NOTIFY pgrst, 'reload schema';
