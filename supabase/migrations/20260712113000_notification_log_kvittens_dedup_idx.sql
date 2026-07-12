-- Atomic dedup for Skatteverket kvittens confirmation emails.
--
-- sendKvittensNotification (extensions/general/skatteverket/lib/
-- kvittens-notification.ts) deduped with a check-then-insert on
-- notification_log: two overlapping kvittens cron invocations could both
-- pass the SELECT and send duplicate confirmation emails. The code now
-- inserts the log row FIRST as a claim and only sends when the insert won;
-- this partial unique index is what makes that claim atomic (the loser gets
-- a 23505 unique violation and skips the send).
--
-- Scoped to notification_type = 'skv_kvittens' on purpose: other
-- notification types legitimately log multiple rows per reference
-- (one per days_before reminder step) and must not be constrained.
--
-- Defensive cleanup first: the 'skv_kvittens' type is new on this branch
-- (20260712090000), so no duplicates should exist anywhere, but if a cron
-- raced before this index lands, keep one row per (user_id, reference_id)
-- so the index build cannot fail.
DELETE FROM public.notification_log a
  USING public.notification_log b
  WHERE a.notification_type = 'skv_kvittens'
    AND b.notification_type = 'skv_kvittens'
    AND a.user_id = b.user_id
    AND a.reference_id = b.reference_id
    AND a.ctid > b.ctid;

-- Plain CREATE INDEX (not CONCURRENTLY): Supabase branching applies
-- migrations inside a transaction, where CONCURRENTLY is not allowed.
-- notification_log is small and append-only; the brief lock is fine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_skv_kvittens_dedup
  ON public.notification_log (user_id, reference_id)
  WHERE notification_type = 'skv_kvittens';
