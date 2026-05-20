-- Allow the in-app chat agent (lib/agent/chat/run-turn.ts) to insert into
-- pending_operations. Until now only SELECT + UPDATE policies existed because
-- the MCP server always wrote via service role (createServiceClientNoCookies)
-- and RLS was bypassed. The chat loop runs under the user's cookie session
-- and gets RLS-denied on insert, surfacing as "behörighetsproblem på
-- serversidan" in the assistant's narration.
--
-- Scoped to actor_type='agent_chat' so this policy doesn't quietly open
-- write paths for the api_key / mcp_oauth / cron actors — those continue
-- to go through the service role.

CREATE POLICY "pending_operations_chat_insert" ON public.pending_operations
  FOR INSERT
  WITH CHECK (
    actor_type = 'agent_chat'
    AND auth.uid() = user_id
    AND company_id IN (SELECT public.user_company_ids())
  );

NOTIFY pgrst, 'reload schema';
