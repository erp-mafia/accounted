-- Tighten reminder_fee_amount upper bound to the statutory cap.
--
-- Lag 1981:739 about late-payment fee caps the lagstadgad
-- påminnelseavgift at 60 kr. The original migration only enforced
-- `>= 0`, so a user could set 500 kr in settings and the cron would
-- happily book it. Add a hard upper bound at the DB level — the
-- application layer also clamps in lib/invoices/reminder-processor.ts.

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_reminder_fee_check;

-- Clamp any rows over 60 down before re-applying the constraint.
UPDATE public.company_settings
   SET reminder_fee_amount = 60
 WHERE reminder_fee_amount > 60;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_reminder_fee_check
  CHECK (reminder_fee_amount >= 0 AND reminder_fee_amount <= 60);

NOTIFY pgrst, 'reload schema';
