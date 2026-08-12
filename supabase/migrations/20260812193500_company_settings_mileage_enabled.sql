-- Körjournal (mileage log) sidebar visibility toggle.
--
-- Adds the per-company UI toggle that surfaces the Körjournal nav row and the
-- /mileage page entry point. UI-visibility only, NEVER load-bearing for
-- correctness: trips written via API/MCP are validated and bookable regardless
-- of this flag, and the nav row also shows whenever the company already has
-- mileage_trips rows (same hybrid gate as webshop orders), so agent-created
-- trips can never become invisible underlag. Mirrors dimensions_enabled
-- (20260702100000).
--
-- pg-test: skip (plain column addition, no trigger/RPC/RLS)

ALTER TABLE public.company_settings
  ADD COLUMN mileage_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.mileage_enabled IS
  'UI-visibility toggle for the Körjournal (mileage log) nav row. Never load-bearing for correctness: trips created via API/MCP work regardless, and the nav row also shows when mileage_trips rows exist.';

NOTIFY pgrst, 'reload schema';
