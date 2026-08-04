-- Migration: no 30-day trial for byrå-team companies
--
-- White-label billing slice (WL-10 resolution, dev_docs/white-label/):
-- companies created under a byrå team (teams.kind = 'byra') are already
-- entitled via the team-scoped partner grant, so the company-scoped 30-day
-- trial is pure noise there: trial-expiry emails would hit byrå clients with
-- the wrong message. Personal-team and teamless companies keep the trial
-- exactly as shipped in 20260629120000.
--
-- Replaces ONLY the trigger function body (seed_trial_capability_grants);
-- the trigger itself (trg_seed_trial_capability_grants, AFTER INSERT ON
-- companies) is untouched. team_id is populated in the same INSERT on every
-- creation path (create_company_with_owner p_team_id / direct insert), so
-- reading NEW.team_id here is race-free.

CREATE OR REPLACE FUNCTION public.seed_trial_capability_grants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Byrå-team companies are covered by the team's agreement (WL-10):
  -- no company-scoped trial, so no trial-expiry noise toward byrå clients.
  IF NEW.team_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.teams t
    WHERE t.id = NEW.team_id
      AND t.kind = 'byra'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at)
  SELECT NEW.id, k.key, 'trial', NEW.created_at + interval '30 days'
  FROM (VALUES ('ai'), ('bank_sync'), ('skatteverket'), ('email_send')) AS k(key)
  ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
