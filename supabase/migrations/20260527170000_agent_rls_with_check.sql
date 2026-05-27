-- Migration: defense-in-depth WITH CHECK on agent_* UPDATE policies
--
-- The UPDATE policies on agent_profiles, agent_memory, and agent_conversations
-- currently declare only USING. PostgreSQL evaluates USING against the row
-- BEFORE the update; without a matching WITH CHECK, a user who belongs to
-- companies A and B can flip a row's company_id from A→B at update time.
-- In practice both companies are already theirs, so this is not a tenancy
-- breach — but it breaks the invariant comments in the original migrations
-- claim ("keeps team members from seeing each other's drafts"). Tighten by
-- enforcing the membership predicate on the post-update row as well.

DROP POLICY IF EXISTS "agent_profiles_update" ON public.agent_profiles;
CREATE POLICY "agent_profiles_update"
  ON public.agent_profiles
  FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "agent_memory_update" ON public.agent_memory;
CREATE POLICY "agent_memory_update"
  ON public.agent_memory
  FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "agent_conversations_update" ON public.agent_conversations;
CREATE POLICY "agent_conversations_update"
  ON public.agent_conversations
  FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

NOTIFY pgrst, 'reload schema';
