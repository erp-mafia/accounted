-- set_committed_at() (migration 017) stamped committed_at := now() on every
-- draft-to-posted transition, discarding any committed_at the row already
-- carried. Seeding flows that backdate history (seed-demo-account,
-- seed-export-data) post drafts whose committed_at is the historical booking
-- time, and stamping now() over it makes every seeded verifikat look booked
-- today, skewing the booking-lag stats and audit views the demo exists to
-- show.
--
-- Preserving a preset value for EVERY writer would be a hole, not a fix:
-- RLS lets a company member insert a draft (any column, committed_at
-- included) and flip it to posted through PostgREST, and committed_at is
-- what the löpande-bokföring timeliness checks (BFL 5 kap) and
-- behandlingshistorik (BFNAR 2013:2 kap 8) read as the genuine transition
-- time. So the preset value survives only for trusted writers: service_role
-- (operational scripts) and postgres/supabase_admin (maintenance, pg tests).
-- End-user roles (authenticated, anon) always get the tamper-proof now()
-- stamp, exactly as before. The engine path is unchanged in both worlds:
-- its drafts never carry committed_at, so posting always stamps.
CREATE OR REPLACE FUNCTION public.set_committed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    IF NEW.committed_at IS NULL
       OR current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
      NEW.committed_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
