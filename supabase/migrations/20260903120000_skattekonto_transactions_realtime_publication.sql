-- Migration: stream skattekonto_transactions changes via Supabase realtime
--
-- The sidebar "Att göra" badge now counts unbooked skattekonto rows next to
-- unbooked bank transactions (#2180), and DashboardNav listens to
-- postgres_changes on public.skattekonto_transactions so a booked or
-- ignored tax-account row drops the badge without a manual refresh, the
-- same way public.transactions already does (20260629180000).
--
-- RLS already scopes skattekonto_transactions to the user's companies, so
-- realtime only delivers rows the current user is allowed to read.
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
      AND tablename = 'skattekonto_transactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.skattekonto_transactions;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
