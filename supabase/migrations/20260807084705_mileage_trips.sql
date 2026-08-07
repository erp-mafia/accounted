-- Körjournal: mileage trip log per Skatteverket documentation requirements.
-- Trips are drafts until booked; a booked trip is underlag for a verifikat
-- (or a salary run line) and falls under BFL 7-year retention, so booked
-- rows can never be deleted.

CREATE TABLE public.mileage_trips (
  id                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  employee_id          uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  trip_date            date NOT NULL,
  vehicle_type         text NOT NULL DEFAULT 'own_car'
                         CHECK (vehicle_type IN ('own_car', 'company_car_fossil', 'company_car_electric')),
  vehicle_registration text,
  odometer_start       integer CHECK (odometer_start >= 0),
  odometer_end         integer CHECK (odometer_end >= 0),
  distance_km          numeric(10,1) NOT NULL CHECK (distance_km > 0),
  from_location        text NOT NULL,
  to_location          text NOT NULL,
  purpose              text NOT NULL,
  visited              text,
  is_round_trip        boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'booked')),
  journal_entry_id     uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  salary_run_id        uuid REFERENCES public.salary_runs(id) ON DELETE SET NULL,
  notes                text,
  created_via          text NOT NULL DEFAULT 'manual' CHECK (created_via IN ('manual', 'mcp', 'import')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mileage_trips_odometer_order
    CHECK (odometer_start IS NULL OR odometer_end IS NULL OR odometer_end > odometer_start)
);

ALTER TABLE public.mileage_trips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company mileage_trips"
  ON public.mileage_trips FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company mileage_trips"
  ON public.mileage_trips FOR INSERT WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company mileage_trips"
  ON public.mileage_trips FOR UPDATE USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company mileage_trips"
  ON public.mileage_trips FOR DELETE USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_mileage_trips_company_date ON public.mileage_trips (company_id, trip_date DESC);
CREATE INDEX idx_mileage_trips_company_status ON public.mileage_trips (company_id, status);
CREATE INDEX idx_mileage_trips_journal_entry
  ON public.mileage_trips (journal_entry_id) WHERE journal_entry_id IS NOT NULL;

CREATE TRIGGER set_updated_at_mileage_trips
  BEFORE UPDATE ON public.mileage_trips
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_mileage_trips
  AFTER INSERT OR UPDATE OR DELETE ON public.mileage_trips
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- A booked trip is bookkeeping underlag (BFL 7 kap): block deletion.
CREATE OR REPLACE FUNCTION public.block_booked_mileage_trip_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'booked' THEN
    RAISE EXCEPTION 'Cannot delete a booked mileage trip: it is retained as underlag (BFL). Reverse the verifikat first.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER block_booked_mileage_trip_deletion
  BEFORE DELETE ON public.mileage_trips
  FOR EACH ROW EXECUTE FUNCTION public.block_booked_mileage_trip_deletion();

NOTIFY pgrst, 'reload schema';
