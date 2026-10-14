-- The switch campaign's send log (20261012170000) gains one kind: 'sunset',
-- the final mail the daily cron sends on the first run after the deadline
-- day, once per company, saying that from today the old Enable Banking
-- connection fetches nothing (lib/bank-feed/switch-notifications.ts). The
-- CHECK lists the kinds so a typo can never dedupe against nothing; it is
-- restated here with the new kind. Postgres named the inline CHECK
-- bank_switch_notifications_kind_check.
-- pg-test: covered-by tests/pg/bank-switch-campaign.pg.test.ts

ALTER TABLE public.bank_switch_notifications
  DROP CONSTRAINT IF EXISTS bank_switch_notifications_kind_check;

ALTER TABLE public.bank_switch_notifications
  ADD CONSTRAINT bank_switch_notifications_kind_check
  CHECK (kind IN ('announcement', 'reminder_14', 'reminder_7', 'reminder_3', 'reminder_1', 'sunset', 'byra_nudge'));

NOTIFY pgrst, 'reload schema';
