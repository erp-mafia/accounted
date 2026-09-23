-- Client-created fiscal periods cannot assign execution-owned import holds.
-- pg-test: covered-by lib/import/__tests__/sie-job.pg.test.ts
CREATE OR REPLACE FUNCTION public.guard_sie_period_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.import_hold IS NOT NULL AND current_user IN ('anon','authenticated','service_role') THEN
      RAISE EXCEPTION 'SIE import hold requires an authorized RPC' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.import_hold IS DISTINCT FROM OLD.import_hold AND current_user IN ('anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'SIE import hold requires an authorized RPC' USING ERRCODE = '42501';
  END IF;
  IF OLD.import_hold IS NOT NULL AND (
      (NEW.is_closed AND NOT coalesce(OLD.is_closed, false)) OR
      (NEW.locked_at IS NOT NULL AND OLD.locked_at IS NULL) OR
      NEW.closing_entry_id IS DISTINCT FROM OLD.closing_entry_id) THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it before closing' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_sie_period_hold() FROM PUBLIC;

DROP TRIGGER guard_sie_period_hold ON public.fiscal_periods;
CREATE TRIGGER guard_sie_period_hold BEFORE INSERT OR UPDATE ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_sie_period_hold();

NOTIFY pgrst, 'reload schema';
