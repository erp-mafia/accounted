-- Migration: stop streaming skattekonto_transactions through Supabase realtime
--
-- 20260903120000 added the table to supabase_realtime for one listener: the
-- sidebar badge channel in DashboardNav. That channel is gone (the badges
-- now refresh on tab focus, navigation and a 60 s backstop while visible,
-- lib/hooks/use-worklist-badges.ts), and no other code subscribes to this
-- table. While the Realtime WAL poller runs (realtime.list_changes, the
-- single biggest database consumer), every change to a published table is
-- decoded to JSON and run through realtime.apply_rls whether or not anyone
-- listens, and skattekonto_transactions is the most-updated table in the
-- publication (about ten updates per live row in pg_stat_user_tables).
--
-- Data, RLS and every reader are unchanged; only the change stream stops.
-- Undo: ALTER PUBLICATION supabase_realtime ADD TABLE public.skattekonto_transactions;
--
-- Idempotent and safe where the publication or the table membership is
-- missing (self-hosted, preview branches, partial re-applies).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'skattekonto_transactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.skattekonto_transactions;
  END IF;
END $$;
