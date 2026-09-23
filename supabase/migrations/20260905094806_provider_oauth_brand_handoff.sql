-- Server-only OAuth handoff back to the domain that initiated the flow.
-- Existing states keep the canonical app origin through the NULL fallback.
ALTER TABLE public.provider_otc
  ADD COLUMN origin text,
  ADD COLUMN provider_code text,
  ADD COLUMN provider_error text;

COMMENT ON COLUMN public.provider_otc.origin IS
  'Validated initiating app/brand origin; NULL for legacy OAuth states.';
COMMENT ON COLUMN public.provider_otc.provider_code IS
  'Authorization code held for a two-minute handoff, deleted on consume.';
COMMENT ON COLUMN public.provider_otc.provider_error IS
  'Provider error held for a two-minute handoff, deleted on consume.';

NOTIFY pgrst, 'reload schema';
