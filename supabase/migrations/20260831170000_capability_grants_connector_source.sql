-- capability_grants.source gains 'connector'.
--
-- A self-hosted instance cannot provide the connector capabilities
-- (bank_sync, skatteverket, org_lookup, migration: see CONNECTOR_CAPABILITIES
-- in lib/entitlements/keys.ts) on its own; they run on services Accounted
-- operates. The instance's hourly connector sync validates its connector key
-- against the hosted service and writes these grants with source =
-- 'connector' and a short expiry (min(now + 72h, period_end + 3d)), so the
-- grant rows double as the offline cache: the existing expiry check is the
-- grace period, no new cache code. 401/403 from the hosted service deletes
-- them (freeze-and-retain); a network error leaves them.
--
-- The CHECK was declared inline in 20260628140000 and auto-named, so it is
-- looked up by definition rather than by name. Hosted companies never
-- receive connector grants: the trial-seed trigger hardcodes the PAID keys
-- (20260818170000) and the Stripe writer uses source = 'stripe'.

DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT c.conname
    INTO v_constraint
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'capability_grants'
     AND c.contype = 'c'
     -- Postgres stores `source IN (...)` as `(source = ANY (ARRAY[...]))`,
     -- so match the column reference at the start of the CHECK body.
     AND pg_get_constraintdef(c.oid) ~ '\(source\s+(=|IN)\s';

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.capability_grants DROP CONSTRAINT %I', v_constraint);
  END IF;

  ALTER TABLE public.capability_grants
    ADD CONSTRAINT capability_grants_source_check
    CHECK (source IN ('trial', 'stripe', 'manual', 'comp', 'connector'));
END $$;

COMMENT ON COLUMN public.capability_grants.source IS
  'trial | stripe | manual | comp | connector. connector = written by a self-hosted instance''s connector sync from its hosted connector key; expiry doubles as the offline grace.';
