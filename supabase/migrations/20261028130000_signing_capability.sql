-- BankID document signing joins the paid plan and the trial as the
-- capability 'signing' (lib/entitlements/keys.ts PAID_CAPABILITIES, so the
-- Stripe subscription sync writes it on the next subscription event and
-- TRIAL_CAPABILITIES, which this VALUES list must match, gains it). No price
-- per document for now (docs/decisions/2026-10/2026-10-26-signing-in-paid-plan.md).
--
-- 1. seed_trial_capability_grants() from its latest body (20261022120000)
--    with signing added to the VALUES list; the byrå suppression and
--    everything else unchanged.
-- 2. Backfill: every active grant of email_send (a key every paid source has
--    always written: the trial, the Stripe sync, operator grants and byrå
--    team agreements) gets a signing grant with the SAME source, scope
--    (company or team) and expiry, so it ends with the rest of the plan or
--    trial. Connector rows are skipped (hosted holds none; a self-host never
--    reaches signing, whose BankID provider is hosted-only). An expired grant
--    gets nothing.
-- 3. An index for the public check of a signed file (/verifiera,
--    lib/signing/verify.ts): a completed request found by the SHA-256 of
--    its original. The signed copy is found through document_attachments'
--    sha256_hash index and signing_requests_signed_document.
--
-- A grant switches nothing on by itself: starting a signing also needs the
-- SIGNING_ENABLED rollout and a wired BankID provider
-- (lib/signing/requests.ts signingAvailability), and nothing that finishes
-- or reads a request already sent ever reads the grant.
--
-- pg-test: covered-by tests/pg/capability-signing-seed.pg.test.ts
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
  -- Full PAID set as of 20261028130000; keep this VALUES list in step with
  -- lib/entitlements/keys.ts TRIAL_CAPABILITIES whenever a key is added.
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
    ('multi_user'),
    ('collections'),
    ('signing')
  ) AS k(key)
  ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;
  RETURN NEW;
END;
$$;

INSERT INTO public.capability_grants
  (company_id, team_id, capability_key, source, granted_at, expires_at, metadata)
SELECT
  g.company_id,
  g.team_id,
  'signing',
  g.source,
  now(),
  g.expires_at,
  jsonb_build_object(
    'backfilled_from', 'email_send',
    'backfill_migration', '20261028130000'
  )
FROM public.capability_grants g
WHERE g.capability_key = 'email_send'
  AND g.source IN ('trial', 'stripe', 'manual', 'comp')
  AND (g.expires_at IS NULL OR g.expires_at > now())
ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;

CREATE INDEX IF NOT EXISTS signing_requests_completed_document_sha256
  ON public.signing_requests (document_sha256)
  WHERE status = 'completed';
