-- Migration: recurring_invoice_schedules.send_hour + one-time safety pause
--
-- Context: the daily cron that spawns recurring invoices was accidentally
-- removed from vercel.json on 2026-05-22 (commit #559), so no recurring
-- schedule has run since. We are re-enabling it, this time as an hourly cron
-- with a user-chosen send hour.
--
-- Two changes, both one-time:
--
-- 1. send_hour: the whole hour (0-23, Europe/Stockholm) at which the schedule
--    should send. Default 08 = 08:00. Cron runs hourly and only fires
--    schedules matching the current Stockholm hour.
--
-- 2. Safety pause: because the cron has been dark for weeks, users may have
--    forgotten schedules they set up. Silently resuming automatic emails to
--    their customers would send invoices "behind their back". So we pause
--    every schedule that exists at deploy time; a user must consciously
--    reactivate one (or click "Skapa faktura nu") to resume sending. Rows
--    created AFTER this migration default to 'active' and are unaffected.
--    This is deliberate and matches the product decision (see DECISIONS.md).

ALTER TABLE public.recurring_invoice_schedules
  ADD COLUMN send_hour SMALLINT NOT NULL DEFAULT 8
    CHECK (send_hour BETWEEN 0 AND 23);

-- One-time: pause all pre-existing active schedules so nothing auto-sends
-- until the user knowingly turns it back on. last_run_warning surfaces the
-- reason inline (the list view renders it as a warning tooltip); it is
-- cleared on the next successful run after the user reactivates.
UPDATE public.recurring_invoice_schedules
SET
  status = 'paused',
  last_run_warning = 'Automatiska utskick pausades av säkerhetsskäl. Aktivera schemat igen för att återuppta månatliga utskick till kunden.'
WHERE status = 'active';

NOTIFY pgrst, 'reload schema';
