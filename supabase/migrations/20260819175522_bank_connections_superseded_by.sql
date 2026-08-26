-- Bank reconnect supersede metadata.
--
-- A successful (re)connect now supersedes any older bank_connections row for
-- the same bank in the same company (extensions/general/enable-banking/lib/
-- supersede.ts). The superseded row reuses status 'revoked' (no CHECK change:
-- every existing filter, claim release, and cron skip already treats
-- 'revoked' correctly); superseded_by records WHICH row replaced it so a
-- supersede is distinguishable from a user disconnect and the account picker
-- can follow the chain for its gap-fill probe.
--
-- Additive and idempotent; no RLS or trigger changes (bank_connections
-- already carries both).

ALTER TABLE public.bank_connections
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES public.bank_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

-- Only superseded rows carry a value, so a partial index keeps the
-- "which rows did this connection supersede" lookup cheap without taxing
-- every other row.
CREATE INDEX IF NOT EXISTS idx_bank_connections_superseded_by
  ON public.bank_connections (superseded_by)
  WHERE superseded_by IS NOT NULL;

NOTIFY pgrst, 'reload schema';
