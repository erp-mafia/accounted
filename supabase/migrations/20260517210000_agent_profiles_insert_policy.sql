-- Migration: agent_profiles_insert_policy — fix missing INSERT RLS
--
-- The initial agent_profiles migration (20260517202000_agent_profiles.sql)
-- declared SELECT and UPDATE policies only, on the assumption the composer
-- would write via the service role. The actual composer route
-- (app/api/agent/composer + app/api/agent/onboarding/stream) uses the user-
-- scoped client created from cookies, because it already validates company
-- membership at the request layer and otherwise has no reason to bypass RLS.
--
-- Without an INSERT policy, .upsert() against an empty row silently failed
-- the RLS check — the composer pipeline completed all LLM work but the
-- agent_profiles row never landed.
--
-- This policy mirrors the SELECT/UPDATE shape: the caller must be a member
-- of the target company. user_company_ids() resolves to the auth.uid()'s
-- direct + team-derived memberships, matching every other company-scoped
-- table on the project.

CREATE POLICY "agent_profiles_insert"
  ON public.agent_profiles
  FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

NOTIFY pgrst, 'reload schema';
