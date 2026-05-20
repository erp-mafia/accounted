-- Allow actor_type='agent_chat' so the in-app chat agent can stage operations
-- and write audit rows. The chat loop (lib/agent/chat/run-turn.ts) passes
-- actor.type='agent_chat' per AgentActorContext, but the CHECK constraints
-- from migration 20260430120000 predate the chat agent and silently rejected
-- every staged categorization with "Failed to stage operation: new row …
-- violates check constraint". The agent narrated this as "permission error",
-- so users saw the assistant claim a server-side block while the real cause
-- was an enum mismatch.

ALTER TABLE public.pending_operations
  DROP CONSTRAINT IF EXISTS pending_operations_actor_type_check;

ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_actor_type_check CHECK (actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron', 'agent_chat'
  ));

ALTER TABLE public.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_actor_type_check;

ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat'
  ));

NOTIFY pgrst, 'reload schema';
