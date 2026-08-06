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
-- included) and post it, and committed_at is what the löpande-bokföring
-- timeliness checks (BFL 5 kap) and behandlingshistorik (BFNAR 2013:2 kap 8)
-- read as the genuine transition time. So the preset value survives only for
-- backend writers: service_role, or no JWT claims at all (direct SQL,
-- maintenance, pg tests). End-user callers always get the tamper-proof now()
-- stamp.
--
-- The actor test reads the JWT claims role, the same primitive as the
-- commit_journal_entry tenant guard. current_user would be the WRONG
-- primitive here: commit_journal_entry is SECURITY DEFINER and granted to
-- authenticated, so inside it current_user resolves to the function owner
-- while the claims still identify the end-user caller; a current_user-based
-- guard would let a member preset committed_at on a direct-inserted draft
-- and launder it through the RPC. The engine path is unchanged either way:
-- its drafts never carry committed_at, so posting always stamps.
--
-- File 20260806150000 carries this same final body (see its header for why
-- both versions exist); applying either or both yields the same function.
CREATE OR REPLACE FUNCTION public.set_committed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_jwt_role text;
BEGIN
  IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
    v_jwt_role := coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      nullif(current_setting('request.jwt.claim.role', true), ''),
      ''
    );
    IF NEW.committed_at IS NULL
       OR NOT (v_jwt_role = '' OR v_jwt_role = 'service_role') THEN
      NEW.committed_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
