-- Automatic reminders (accounted#104, phase 4): a company whose last three
-- daily reminder batches were approved without changes may let the batch
-- send itself. Then each day's reminders whose bank check passed go out
-- without approval; anything uncertain (a bank not synced in 24 hours, or
-- none) still waits in Att göra for a person.
--
--   company_settings.reminders_automatic_at  when automatic sending was turned on (NULL: off)
--   company_settings.reminders_automatic_by  who turned it on (the actor on the automatic sends)
--
-- Only Accounted sets them (POST /api/reminders/automatic checks the three
-- clean batches, then writes with the service role): a member writing
-- through the API cannot. Turning reminders off turns automatic off too, so
-- turning them on again starts with approval.
--
-- pg-test: tests/pg/reminders-automatic-mode.pg.test.ts

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS reminders_automatic_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminders_automatic_by uuid;

COMMENT ON COLUMN public.company_settings.reminders_automatic_at IS
  'When automatic reminder sending was turned on (NULL: each day''s batch waits for approval). Set by Accounted only; cleared when reminders are turned off.';
COMMENT ON COLUMN public.company_settings.reminders_automatic_by IS
  'Who turned automatic reminder sending on: the actor recorded on the automatic sends.';

CREATE OR REPLACE FUNCTION public.guard_reminders_automatic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.send_invoice_reminders IS NOT TRUE THEN
    NEW.reminders_automatic_at := NULL;
    NEW.reminders_automatic_by := NULL;
  ELSIF current_user IN ('authenticated', 'anon') OR COALESCE(auth.role(), '') IN ('authenticated', 'anon') THEN
    -- A member's write never moves it: only Accounted, after the clean batches.
    IF TG_OP = 'UPDATE' THEN
      NEW.reminders_automatic_at := OLD.reminders_automatic_at;
      NEW.reminders_automatic_by := OLD.reminders_automatic_by;
    ELSE
      NEW.reminders_automatic_at := NULL;
      NEW.reminders_automatic_by := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_reminders_automatic() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS company_settings_guard_reminders_automatic ON public.company_settings;
CREATE TRIGGER company_settings_guard_reminders_automatic
  BEFORE INSERT OR UPDATE OF send_invoice_reminders, reminders_automatic_at, reminders_automatic_by ON public.company_settings
  FOR EACH ROW EXECUTE FUNCTION public.guard_reminders_automatic();

NOTIFY pgrst, 'reload schema';
