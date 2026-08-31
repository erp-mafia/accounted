-- "Nytt att bokföra" daily email digest (user request 2026-08-31).
--
-- Extends notification_log's notification_type CHECK with
-- 'bookkeeping_digest': a per-user, per-company, per-day email summarizing
-- new bank transactions and new inbox documents since the previous day.
--
-- Opt-in: notification_settings gains email_digest_enabled, default false,
-- so nobody receives mail without flipping the toggle in
-- /settings/extensions/push-notifications.

ALTER TABLE public.notification_log
  DROP CONSTRAINT IF EXISTS notification_log_notification_type_check;

ALTER TABLE public.notification_log
  ADD CONSTRAINT notification_log_notification_type_check
  CHECK (notification_type IN (
    'tax_deadline',
    'invoice_due',
    'invoice_overdue',
    'period_locked',
    'period_year_closed',
    'invoice_sent',
    'receipt_extracted',
    'receipt_matched',
    'missing_underlag',
    'skv_kvittens',
    'skv_connection_expired',
    'bookkeeping_digest'
  )) NOT VALID;

ALTER TABLE public.notification_log
  VALIDATE CONSTRAINT notification_log_notification_type_check;

-- Atomic claim-then-send dedup, same mechanism as the kvittens index
-- (20260712113000): the sender inserts the log row FIRST and only sends
-- when the insert won; an overlapping cron invocation gets a 23505 and
-- skips. reference_id is a deterministic uuid derived from
-- (company, digest date), so the scope is one mail per user per company
-- per day. Scoped per type: other notification types legitimately log
-- multiple rows per reference.
--
-- No defensive duplicate cleanup needed: the type is new in this migration,
-- so the CHECK above guarantees no existing rows can carry it.
--
-- Plain CREATE INDEX (not CONCURRENTLY): Supabase branching applies
-- migrations inside a transaction, where CONCURRENTLY is not allowed.
-- notification_log is small and append-only; the brief lock is fine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_bookkeeping_digest_dedup
  ON public.notification_log (user_id, reference_id)
  WHERE notification_type = 'bookkeeping_digest';

-- NOT NULL DEFAULT false, same rationale as missing_underlag_enabled
-- (20260726174500): a toggle has no meaningful null state, and on
-- Postgres 11+ a constant default adds without a table rewrite. Default
-- false because this is a new outbound email channel: opt-in only.
ALTER TABLE public.notification_settings
  ADD COLUMN IF NOT EXISTS email_digest_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.notification_settings.email_digest_enabled IS
  'Opt-in for the daily "nytt att bokföra" email digest (new bank transactions and inbox documents).';

NOTIFY pgrst, 'reload schema';
