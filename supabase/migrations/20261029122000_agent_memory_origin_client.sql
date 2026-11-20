-- Where a remembered company fact came from, so facts taught by the
-- customer's own AI can be told apart and counted.
--
--   origin  how the fact reached gnubok_remember_fact:
--             conversation       the user said it in a chat (the default)
--             session_sync       the AI offered what it already knew when it
--                                opened the company (briefing memory_sync)
--             onboarding_import  the onboarding import skill, after the user
--                                confirmed the list
--           NULL on rows written before this column and by the in-app agent.
--   client  the MCP client label of the connection that wrote it (claude,
--           chatgpt, grok, cursor, local, ...), from the request's actor.
--           NULL outside MCP.
--
-- Both nullable, no default: an old row has no honest value. No RLS, trigger
-- or RPC change; the existing agent_memory policies cover the new columns.

ALTER TABLE public.agent_memory
  ADD COLUMN origin text
    CONSTRAINT agent_memory_origin_check
    CHECK (origin IN ('conversation', 'session_sync', 'onboarding_import')),
  ADD COLUMN client text;

COMMENT ON COLUMN public.agent_memory.origin IS
  'How the fact reached remember_fact: conversation, session_sync (offered from the AI''s own memory at session start) or onboarding_import. NULL before 2026-10-29 and for the in-app agent.';
COMMENT ON COLUMN public.agent_memory.client IS
  'MCP client label of the connection that wrote the fact (claude, chatgpt, ...). NULL outside MCP.';

NOTIFY pgrst, 'reload schema';
