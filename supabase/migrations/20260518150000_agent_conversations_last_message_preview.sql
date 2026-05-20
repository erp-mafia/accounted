-- Migration: agent_conversations.last_message_preview
--
-- Lets the /chat sidebar render a one-line preview of each conversation
-- (like Mail/iMessage). Avoids an N+1 join on agent_messages by caching the
-- truncated assistant text on the conversation row itself. The chat loop
-- updates this column each time it persists an assistant turn.
--
-- Nullable so legacy conversations (and any future write paths that don't
-- run through the agent loop) don't break.

ALTER TABLE public.agent_conversations
  ADD COLUMN last_message_preview text;

NOTIFY pgrst, 'reload schema';
