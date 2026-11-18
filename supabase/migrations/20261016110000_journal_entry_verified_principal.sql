-- The verified principal of a commit, beside the asserted actor (building
-- blocks plan, Phase 1; record-only).
--
-- committed_actor_type, committed_actor_label and commit_method say who the
-- application says committed a verifikat (20260619120000, and the attribution
-- migrations 20261015235000 and 20261016005000 to 20261016005200). They are
-- asserted by the calling code: the database cannot tell an honest 'cron'
-- from a mislabelled one. The behandlingshistorik (BFL 5 kap. 11 §, BFNAR
-- 2013:2 p. 9.16) should also be able to show what the system itself
-- verified.
--
--   1. journal_entries gains two nullable columns:
--        committed_auth_role  the database role the committing request ran
--                             as: 'authenticated' (a signed-in user's JWT),
--                             'service_role' (the server's service key),
--                             'anon', or on a connection with no SET ROLE
--                             (pg_cron, a migration, an operator script) the
--                             login role, e.g. 'postgres'.
--        committed_auth_uid   auth.uid() of that request: the subject of the
--                             JWT PostgREST verified; NULL for the service
--                             role and on direct connections.
--      Rows posted before this migration keep NULL: nothing can be verified
--      after the fact, and posted entries are never touched (no backfill).
--   2. stamp_journal_entry_verified_principal, a BEFORE INSERT OR UPDATE
--      trigger, stamps them on the commit (draft -> posted, or a trusted
--      writer inserting a row past draft), clears them on drafts, and keeps
--      them frozen once the row has left draft, the same shape as
--      stamp_journal_entry_committed_by (20260929220100). Whatever the
--      statement itself sets is overwritten: the value is the database's own
--      observation, never the caller's.
--
-- Why a trigger and not commit_journal_entry: the draft -> posted transition
-- is written by commit_journal_entry, write_sie_job_entries,
-- undo_sie_import_chunk and undo_sie_duplicate_repair_chunk. One trigger
-- covers all of them and any later path, and no function is restated.
--
-- Where the role comes from: current_setting('role') is the role PostgREST
-- switches to (SET LOCAL ROLE) after it has checked the JWT signature, and a
-- SECURITY DEFINER function does not change it (commit_journal_entry reads it
-- the same way). current_user would name the definer inside every posting
-- RPC, and request.jwt.claims is a plain setting that any SQL can set_config.
--
-- Record-only: this never refuses and never fails a commit. Both lookups sit
-- in one exception block, so a missing or malformed request.jwt.claims (or a
-- sub that is not a uuid) leaves the uid NULL and the role as read. No CHECK
-- constraint and no foreign key (a uid missing from auth.users must not fail
-- the write). Refusing impossible combinations is a later phase; until then
-- verified_actor_disagreements() (20261016110100) lists them.
--
-- The journal_entry.committed outbox row (20261016001100) serialises the
-- posted row, so the event carries the two fields from here on, as the bus
-- handler's select('*') of the same row does.
--
-- lock_timeout: the ALTER and the CREATE TRIGGER take short table locks on
-- journal_entries. If a long transaction holds it, the migration fails after
-- 5 s and is re-run, instead of queueing every commit behind it (precedent
-- 20261016001100).
--
-- pg-test: tests/pg/journal-entry-verified-principal.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS committed_auth_role text,
  ADD COLUMN IF NOT EXISTS committed_auth_uid uuid;

COMMENT ON COLUMN public.journal_entries.committed_auth_role IS
  'Database role the committing request ran as, observed by the database at commit (stamp_journal_entry_verified_principal): authenticated, service_role, anon, or the login role of a direct connection. Verified, unlike committed_actor_type (asserted). NULL on drafts and on entries posted before 20261016110000.';
COMMENT ON COLUMN public.journal_entries.committed_auth_uid IS
  'auth.uid() of the committing request, observed by the database at commit: the subject of the verified JWT. NULL for the service role, direct connections, unreadable claims, drafts and entries posted before 20261016110000. Not a foreign key.';

CREATE OR REPLACE FUNCTION public.stamp_journal_entry_verified_principal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_uid  uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Frozen once the row has left draft (posted, reversed, cancelled).
    IF OLD.status IS DISTINCT FROM 'draft' THEN
      NEW.committed_auth_role := OLD.committed_auth_role;
      NEW.committed_auth_uid := OLD.committed_auth_uid;
      RETURN NEW;
    END IF;
    -- A draft that stays a draft or is cancelled was committed by no one.
    IF NEW.status IS DISTINCT FROM 'posted' THEN
      NEW.committed_auth_role := NULL;
      NEW.committed_auth_uid := NULL;
      RETURN NEW;
    END IF;
  ELSIF NEW.status IS NOT DISTINCT FROM 'draft' THEN
    NEW.committed_auth_role := NULL;
    NEW.committed_auth_uid := NULL;
    RETURN NEW;
  END IF;

  -- The commit. Record-only: a lookup that fails leaves NULL and the commit
  -- goes on. PL/pgSQL keeps a variable assigned before the error, so a role
  -- already read survives a failing auth.uid().
  BEGIN
    v_role := nullif(current_setting('role', true), '');
    IF v_role IS NULL OR v_role = 'none' THEN
      v_role := session_user::text;
    END IF;
    v_uid := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  NEW.committed_auth_role := v_role;
  NEW.committed_auth_uid := v_uid;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stamp_journal_entry_verified_principal ON public.journal_entries;
CREATE TRIGGER stamp_journal_entry_verified_principal
  BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_journal_entry_verified_principal();

NOTIFY pgrst, 'reload schema';
