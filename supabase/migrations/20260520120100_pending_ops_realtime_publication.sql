-- Migration: stream pending_operations changes via Supabase realtime
--
-- The /pending page only refetched on tab/filter changes — when an agent
-- staged an operation in the background, the user had to manually refresh
-- to see it. Adding the table to supabase_realtime lets the browser
-- subscribe via supabase.channel('postgres_changes') and refresh the list
-- as new rows land.
--
-- RLS already restricts pending_operations to company members
-- (migration 20260325130000_pending_operations.sql), and realtime respects
-- the same row-level access — a member of company A can only receive
-- change events for rows where their RLS predicate evaluates true.

ALTER PUBLICATION supabase_realtime ADD TABLE public.pending_operations;
