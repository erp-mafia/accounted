-- Booked mileage trips are korjournal underlag for a posted verifikat:
-- immutable at the database layer (BFL 5 kap 5 §, 7 kap), mirroring the
-- delete block from 20260807084705. Allowed transitions only:
--   * draft -> booked (the booking service's claim; may set salary_run_id)
--   * booked -> draft revert of an UNLINKED claim (journal_entry_id IS NULL),
--     clearing salary_run_id
--   * booked -> booked filling journal_entry_id / salary_run_id from NULL
--   * notes may always change (annotation, mirrors the verifikat-notes
--     carve-out); everything else on a booked row is frozen.

CREATE OR REPLACE FUNCTION public.enforce_booked_mileage_trip_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  core_changed boolean;
BEGIN
  IF OLD.status <> 'booked' THEN
    RETURN NEW;
  END IF;

  core_changed :=
       NEW.trip_date            IS DISTINCT FROM OLD.trip_date
    OR NEW.vehicle_type         IS DISTINCT FROM OLD.vehicle_type
    OR NEW.vehicle_registration IS DISTINCT FROM OLD.vehicle_registration
    OR NEW.odometer_start       IS DISTINCT FROM OLD.odometer_start
    OR NEW.odometer_end         IS DISTINCT FROM OLD.odometer_end
    OR NEW.distance_km          IS DISTINCT FROM OLD.distance_km
    OR NEW.from_location        IS DISTINCT FROM OLD.from_location
    OR NEW.to_location          IS DISTINCT FROM OLD.to_location
    OR NEW.purpose              IS DISTINCT FROM OLD.purpose
    OR NEW.visited              IS DISTINCT FROM OLD.visited
    OR NEW.is_round_trip        IS DISTINCT FROM OLD.is_round_trip
    OR NEW.employee_id          IS DISTINCT FROM OLD.employee_id
    OR NEW.company_id           IS DISTINCT FROM OLD.company_id
    OR NEW.user_id              IS DISTINCT FROM OLD.user_id
    OR NEW.created_via          IS DISTINCT FROM OLD.created_via;

  IF core_changed THEN
    RAISE EXCEPTION 'Cannot modify a booked mileage trip: it is retained as underlag (BFL). Reverse the verifikat first.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Revert of an unlinked claim back to draft.
  IF NEW.status = 'draft' THEN
    IF OLD.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot unbook a mileage trip linked to a verifikat. Reverse the verifikat first.'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- Booked stays booked: links may only be set from NULL, never rewritten.
  IF OLD.journal_entry_id IS NOT NULL
     AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'Cannot repoint a booked mileage trip to another verifikat.'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.salary_run_id IS NOT NULL
     AND NEW.salary_run_id IS DISTINCT FROM OLD.salary_run_id THEN
    RAISE EXCEPTION 'Cannot repoint a booked mileage trip to another salary run.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_booked_mileage_trip_immutability
  BEFORE UPDATE ON public.mileage_trips
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booked_mileage_trip_immutability();

NOTIFY pgrst, 'reload schema';
