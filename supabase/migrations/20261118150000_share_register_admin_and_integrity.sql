-- =============================================================================
-- The aktiebok: the database holds what the doors promise
-- =============================================================================
--
-- An audit of the share register (ABL 5 kap.) found four places where a rule
-- lived in the application alone:
--
--   1. Who writes. Every route and operation asks for the company's owner or
--      an admin, since the board keeps the aktiebok (ABL 5:7). The policies
--      asked only for a writer, so a member could insert an entry, change a
--      share class or mark the company an avstämningsbolag through PostgREST.
--      The three tables now ask for user_is_company_admin, like the doors.
--
--   2. Which register an entry was checked against. The service reads the
--      history, checks the new entry against it and inserts. Two entries in
--      flight each passed their own check; the holdings are replayed again at
--      commit, but the notes (aktiebrev, pant, nyttjanderätt) are checked in
--      the application only, so two colliding notes could both be stored.
--      An entry now carries the number of the last entry its check saw
--      (based_on_event_number), and the numbering trigger, which already
--      holds the per-company lock, refuses it when the register has moved on.
--
--   3. The dates and the writer. An entry dated in the future was refused by
--      the service only, and created_by was whatever the client sent. The
--      numbering trigger now refuses a future date and records the caller.
--
--   4. What changes without a trace. Votes per share and the förbehåll of a
--      class are part of what the aktiebok says about every share of that
--      class (ABL 5:5 p. 5), and changing them rewrote every printout with no
--      dated entry (ABL 5:9). A change now adds an anteckning to the register
--      in the same transaction.
--
-- A rättelse reference on an entry that is not a rättelse voided nothing and
-- blocked every later rättelse of that entry (the once-only index covers all
-- kinds): refused by a CHECK.
--
-- The party origin list is restated so that the code can name the people of
-- the registers (section 4).
--
-- Nothing here changes an existing row.
-- =============================================================================

-- =============================================================================
-- 1. Owner or admin writes the registers
-- =============================================================================

DROP POLICY IF EXISTS "insert own-company share_register_events" ON public.share_register_events;
CREATE POLICY "insert own-company share_register_events"
  ON public.share_register_events FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.user_is_company_admin(company_id)
  );

DROP POLICY IF EXISTS "insert own-company share_classes" ON public.share_classes;
CREATE POLICY "insert own-company share_classes"
  ON public.share_classes FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.user_is_company_admin(company_id)
  );
DROP POLICY IF EXISTS "update own-company share_classes" ON public.share_classes;
CREATE POLICY "update own-company share_classes"
  ON public.share_classes FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.user_is_company_admin(company_id));
DROP POLICY IF EXISTS "delete own-company share_classes" ON public.share_classes;
CREATE POLICY "delete own-company share_classes"
  ON public.share_classes FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids()) AND public.user_is_company_admin(company_id)
  );

DROP POLICY IF EXISTS "insert own-company share_register_settings" ON public.share_register_settings;
CREATE POLICY "insert own-company share_register_settings"
  ON public.share_register_settings FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.user_is_company_admin(company_id)
  );
DROP POLICY IF EXISTS "update own-company share_register_settings" ON public.share_register_settings;
CREATE POLICY "update own-company share_register_settings"
  ON public.share_register_settings FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.user_is_company_admin(company_id));

-- =============================================================================
-- 2. An entry is tied to the register it was checked against
-- =============================================================================

ALTER TABLE public.share_register_events
  ADD COLUMN IF NOT EXISTS based_on_event_number integer;

ALTER TABLE public.share_register_events
  DROP CONSTRAINT IF EXISTS share_register_events_based_on_check;
ALTER TABLE public.share_register_events
  ADD CONSTRAINT share_register_events_based_on_check
  CHECK (based_on_event_number IS NULL OR based_on_event_number >= 0);

COMMENT ON COLUMN public.share_register_events.based_on_event_number IS
  'The number of the last entry the writer had read when it checked this one (0 for an empty register). share_register_events_number() refuses the row when the register holds a newer entry. NULL: written without that check (a migration, the note a share class change adds).';

-- A rättelse reference belongs on a rättelse.
ALTER TABLE public.share_register_events
  DROP CONSTRAINT IF EXISTS share_register_events_corrects_only_rattelse;
ALTER TABLE public.share_register_events
  ADD CONSTRAINT share_register_events_corrects_only_rattelse
  CHECK (corrects_event_id IS NULL OR kind = 'rattelse');

-- Numbering in sequence per company, under a per-company lock: the same
-- function as 20261029210000, with the future-date refusal, the stale-check
-- and the recorded caller added.
CREATE OR REPLACE FUNCTION public.share_register_events_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_avstamning boolean;
  v_target public.share_register_events%ROWTYPE;
  v_last integer;
BEGIN
  SELECT s.is_avstamningsbolag INTO v_avstamning
    FROM public.share_register_settings s WHERE s.company_id = NEW.company_id;
  IF coalesce(v_avstamning, false) THEN
    RAISE EXCEPTION 'SHARE_REGISTER_AVSTAMNINGSBOLAG: the central securities depository keeps the aktiebok of an avstämningsbolag'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.event_date > public.stockholm_today() THEN
    RAISE EXCEPTION 'BOLAGET_DATES_INVALID: an aktiebok entry cannot be dated in the future (%)', NEW.event_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'rattelse' THEN
    SELECT * INTO v_target FROM public.share_register_events e
     WHERE e.id = NEW.corrects_event_id AND e.company_id = NEW.company_id;
    IF NOT FOUND OR v_target.kind = 'rattelse' THEN
      RAISE EXCEPTION 'SHARE_REGISTER_CORRECTION_INVALID: a rattelse voids one earlier entry that is not itself a rattelse'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('share_register_events:' || NEW.company_id::text, 0));
  SELECT coalesce(max(e.event_number), 0) INTO v_last
    FROM public.share_register_events e WHERE e.company_id = NEW.company_id;
  -- Under the lock: no entry can get in between this read and the insert.
  IF NEW.based_on_event_number IS NOT NULL AND NEW.based_on_event_number <> v_last THEN
    RAISE EXCEPTION 'SHARE_REGISTER_STALE: the aktiebok has entry % and this entry was checked against entry %', v_last, NEW.based_on_event_number
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.event_number := v_last + 1;
  NEW.created_at := now();
  -- A signed-in caller is the writer, whatever the row says. The service role
  -- (auth.uid() NULL: an API key, an approved proposal) names the acting user.
  IF auth.uid() IS NOT NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.share_register_events_number() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 3. A change to a share class is a dated note in the aktiebok
-- =============================================================================

CREATE OR REPLACE FUNCTION public.share_classes_note_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_parts text[] := '{}'::text[];
  v_avstamning boolean;
  v_text text;
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    v_parts := v_parts || format('beteckningen ändrad från %s till %s', OLD.code, NEW.code);
  END IF;
  IF NEW.votes_per_share IS DISTINCT FROM OLD.votes_per_share THEN
    v_parts := v_parts || format('röstvärdet ändrat från %s till %s',
      replace(trim_scale(OLD.votes_per_share)::text, '.', ','), replace(trim_scale(NEW.votes_per_share)::text, '.', ','));
  END IF;
  IF NEW.forbehall_samtycke IS DISTINCT FROM OLD.forbehall_samtycke THEN
    v_parts := v_parts || ('samtyckesförbehåll (4 kap. 8 § ABL) ' || CASE WHEN NEW.forbehall_samtycke THEN 'infört' ELSE 'borttaget' END);
  END IF;
  IF NEW.forbehall_forkop IS DISTINCT FROM OLD.forbehall_forkop THEN
    v_parts := v_parts || ('förköpsförbehåll (4 kap. 18 § ABL) ' || CASE WHEN NEW.forbehall_forkop THEN 'infört' ELSE 'borttaget' END);
  END IF;
  IF NEW.forbehall_hembud IS DISTINCT FROM OLD.forbehall_hembud THEN
    v_parts := v_parts || ('hembudsförbehåll (4 kap. 27 § ABL) ' || CASE WHEN NEW.forbehall_hembud THEN 'infört' ELSE 'borttaget' END);
  END IF;
  IF NEW.forbehall_omvandling IS DISTINCT FROM OLD.forbehall_omvandling THEN
    v_parts := v_parts || ('omvandlingsförbehåll (4 kap. 6 § ABL) ' || CASE WHEN NEW.forbehall_omvandling THEN 'infört' ELSE 'borttaget' END);
  END IF;
  IF NEW.forbehall_inlosen IS DISTINCT FROM OLD.forbehall_inlosen THEN
    v_parts := v_parts || ('inlösenförbehåll (20 kap. 31 § ABL) ' || CASE WHEN NEW.forbehall_inlosen THEN 'infört' ELSE 'borttaget' END);
  END IF;
  IF NEW.forbehall_text IS DISTINCT FROM OLD.forbehall_text THEN
    v_parts := v_parts || 'förbehållets lydelse ändrad'::text;
  END IF;
  IF cardinality(v_parts) = 0 THEN
    RETURN NULL;
  END IF;
  -- A class set up before the first entry needs no note: there is no share
  -- of it yet. An avstämningsbolag's register is not kept here.
  IF NOT EXISTS (SELECT 1 FROM public.share_register_events e WHERE e.company_id = NEW.company_id) THEN
    RETURN NULL;
  END IF;
  SELECT s.is_avstamningsbolag INTO v_avstamning
    FROM public.share_register_settings s WHERE s.company_id = NEW.company_id;
  IF coalesce(v_avstamning, false) THEN
    RETURN NULL;
  END IF;
  v_text := format('Aktieslag %s: %s.', NEW.code, array_to_string(v_parts, '; '));
  INSERT INTO public.share_register_events (company_id, event_date, kind, note, created_by)
  VALUES (NEW.company_id, public.stockholm_today(), 'anteckning', left(v_text, 2000), auth.uid());
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.share_classes_note_change() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.share_classes_note_change() IS
  'ABL 5:5 p. 5 and 5:9: a change to the votes or the förbehåll of a share class is entered in the aktiebok as a dated anteckning, in the transaction that makes the change.';

DROP TRIGGER IF EXISTS share_classes_note_change ON public.share_classes;
CREATE TRIGGER share_classes_note_change
  AFTER UPDATE ON public.share_classes
  FOR EACH ROW EXECUTE FUNCTION public.share_classes_note_change();

COMMENT ON TABLE public.share_classes IS
  'Aktieslag (ABL 4:2): votes per share and the förbehåll of the bolagsordning. A change to them adds a dated anteckning to the aktiebok (share_classes_note_change); a class used by the aktiebok cannot be deleted.';

-- =============================================================================
-- 4. parties.origin: the list written out
-- =============================================================================
--
-- 20261029210000 added 'bolaget' by reading the live constraint and rebuilding
-- it with EXECUTE. The schema replay in tests/schema cannot follow that: to it
-- the list still ended at 'backfill', so a filter on origin = 'bolaget' (the
-- people of the registers, lib/bolaget/people.ts) read as a value the CHECK
-- refuses. These are the same seven values production holds today, written
-- out. NOT VALID here and validated in 20261118150100, as 20261029210000 and
-- 20261029210100 did: adding it takes the heavy lock for an instant only.

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.parties DROP CONSTRAINT IF EXISTS parties_origin_check;
ALTER TABLE public.parties
  ADD CONSTRAINT parties_origin_check
  CHECK (origin IN ('manual', 'import', 'document', 'bank', 'ledger', 'backfill', 'bolaget')) NOT VALID;

NOTIFY pgrst, 'reload schema';
