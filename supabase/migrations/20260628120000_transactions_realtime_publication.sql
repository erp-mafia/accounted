-- Migration: stream transactions changes via Supabase realtime
--
-- The dashboard sidebar transaction badge now listens to postgres_changes
-- on public.transactions. Adding the table to supabase_realtime lets the
-- browser receive INSERT/UPDATE/DELETE events and keep the uncategorized
-- count in sync without a manual refresh.
--
-- RLS already scopes transactions to the active company, so realtime only
-- delivers rows the current user is allowed to read.
--
-- Idempotent so preview branches or partial re-applies do not fail if the
-- publication already includes the table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'transactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
