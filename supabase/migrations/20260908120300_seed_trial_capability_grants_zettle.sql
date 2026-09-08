-- REPLACE seed_trial_capability_grants to add zettle_sync while keeping the
-- byrå suppression from 20260826130300 / 20260901081417.

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

  -- Full PAID set as of 20260908120300; keep this VALUES list in step with
  -- lib/entitlements/keys.ts PAID_CAPABILITIES whenever a key is added.
  INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at)
  SELECT NEW.id, k.key, 'trial', NEW.created_at + interval '30 days'
  FROM (VALUES
    ('ai'),
    ('bank_sync'),
    ('skatteverket'),
    ('email_send'),
    ('stripe_payments'),
    ('woocommerce_sync'),
    ('shopify_sync'),
    ('zettle_sync'),
    ('multi_user')
  ) AS k(key)
  ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;
  RETURN NEW;
END;
$$;
