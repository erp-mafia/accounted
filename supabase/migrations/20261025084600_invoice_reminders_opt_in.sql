-- Automatic invoice reminders become opt-in.
--
-- send_invoice_reminders defaulted to true, so every company held "reminders
-- on" without anyone choosing it. The sender was deleted on 2026-10-12 and the
-- setting has been hidden since 2026-10-18, so no company can see or change
-- the value it holds. A future sender must not inherit that unchosen true:
-- every company starts with reminders off and turns them on itself once a
-- sender exists. Customers have been told exactly this.
--
-- Rows already false stay false. Nothing sends on this value while
-- REMINDERS_SENDING_ENABLED is false (lib/invoices/reminders-enabled.ts), so
-- the reset changes no behavior today. Archived migration-reset source
-- companies are skipped: block_migration_reset_source_mutation refuses writes
-- to their rows, and a reset source never sends anything. Re-running is a
-- no-op.

ALTER TABLE public.company_settings
  ALTER COLUMN send_invoice_reminders SET DEFAULT false;

BEGIN;

SET LOCAL gnubok.actor_type = 'system';
SET LOCAL gnubok.actor_label = 'migration 20261025084600 invoice_reminders_opt_in';

UPDATE public.company_settings cs
SET send_invoice_reminders = false
WHERE cs.send_invoice_reminders IS DISTINCT FROM false
  AND NOT EXISTS (
    SELECT 1 FROM public.company_migration_resets m
    WHERE m.source_company_id = cs.company_id
  );

COMMIT;

COMMENT ON COLUMN public.company_settings.send_invoice_reminders IS
  'Opt-in switch for automatic invoice reminder emails: defaults to false, and NULL counts as off. Nothing sends while REMINDERS_SENDING_ENABLED is false.';

NOTIFY pgrst, 'reload schema';
