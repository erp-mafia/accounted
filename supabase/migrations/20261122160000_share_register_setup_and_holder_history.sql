-- =============================================================================
-- The aktiebok: setting it up, the day an entry carries, and what a holder was
-- =============================================================================
--
-- Three things the share register (ABL 5 kap.) could not say:
--
--   1. That a company already had an aktiebok. The only way in was the
--      formation (bildande), so a company with a history typed today's
--      holdings as its formation. A new kind, 'ingaende', enters a holding as
--      it stands on a day, carried over from the register kept before.
--
--   2. Which day an entry belongs to. A shareholder has rights against the
--      company from the day they are entered (ABL 4:37, 7:2), and entries are
--      dated (5:9). An entry dated back changed who the register showed on a
--      past day. The register now has two phases:
--        - while it is set up, an entry carries the day of the event, so the
--          history can be entered as it happened;
--        - once every share is entered (share_register_settings.
--          setup_completed_at), an entry carries the day it is made. The day
--          of the event, when earlier, is kept beside it (occurred_on).
--      Completing the setup is itself a dated note in the register: it is the
--      day ABL 5:3 counts the ten years of the earlier register from.
--
--   3. What a holder's particulars were before a change. The name and the
--      organisationsnummer live on the party, the identity number and the
--      postal address in party_person_private; both were changed in place.
--      Removed register data is kept at least ten years (ABL 5:3) and a
--      change is dated (5:9). A change of name or organisationsnummer of a
--      party the register names now adds a dated note; the replaced identity
--      number and address are kept in party_person_private_history.
--
-- Nothing here changes an existing entry.
-- =============================================================================

-- The new column points at auth.users and section 3 adds a trigger to
-- parties: both take a lock on a busy table for an instant. Give up rather
-- than queue every write behind a wait.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. Setting the register up
-- =============================================================================

ALTER TABLE public.share_register_settings
  ADD COLUMN IF NOT EXISTS setup_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS setup_completed_by uuid REFERENCES auth.users(id);

COMMENT ON COLUMN public.share_register_settings.setup_completed_at IS
  'When every share of the company had been entered here (ABL 5:3). NULL: the register is being set up and an entry carries the day of the event. Set once; from then on an entry carries the day it is made and no ingaende entry is taken.';
COMMENT ON COLUMN public.share_register_settings.setup_completed_by IS
  'Who said the register was complete (the acting user when the service role writes).';

CREATE OR REPLACE FUNCTION public.share_register_settings_setup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.setup_completed_at IS NOT NULL THEN
    IF NEW.setup_completed_at IS DISTINCT FROM OLD.setup_completed_at
       OR NEW.setup_completed_by IS DISTINCT FROM OLD.setup_completed_by THEN
      RAISE EXCEPTION 'SHARE_REGISTER_SETUP_COMPLETE: the aktiebok is in use; its setup cannot be reopened or completed again'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.setup_completed_at IS NULL THEN
    NEW.setup_completed_by := NULL;
    RETURN NEW;
  END IF;
  IF NEW.is_avstamningsbolag THEN
    RAISE EXCEPTION 'SHARE_REGISTER_AVSTAMNINGSBOLAG: the central securities depository keeps the aktiebok of an avstämningsbolag'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.share_register_replay(NEW.company_id, NULL)) THEN
    RAISE EXCEPTION 'SHARE_REGISTER_EMPTY: the aktiebok holds no shares; enter them before the setup is completed'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The moment is the database's, whatever the row says; a signed-in caller is who did it.
  NEW.setup_completed_at := now();
  IF auth.uid() IS NOT NULL THEN
    NEW.setup_completed_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.share_register_settings_setup() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.share_register_settings_setup() IS
  'ABL 5:3: completing the setup of the aktiebok needs shares in it and happens once.';

DROP TRIGGER IF EXISTS share_register_settings_setup ON public.share_register_settings;
CREATE TRIGGER share_register_settings_setup
  BEFORE INSERT OR UPDATE ON public.share_register_settings
  FOR EACH ROW EXECUTE FUNCTION public.share_register_settings_setup();

-- The completion is entered in the register. An AFTER trigger: it runs once
-- for the row that was stored, also when the write was an upsert (whose
-- BEFORE INSERT trigger runs for a row that is then updated instead).
CREATE OR REPLACE FUNCTION public.share_register_settings_setup_note()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.setup_completed_at IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.setup_completed_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.share_register_events (company_id, event_date, kind, note, created_by)
  VALUES (
    NEW.company_id,
    public.stockholm_today(),
    'anteckning',
    'Aktieboken är upplagd: bolagets samtliga aktier är införda. Härefter dateras varje anteckning den dag den förs in. En aktiebok som fördes tidigare ska bevaras i minst tio år (5 kap. 3 § ABL).',
    NEW.setup_completed_by
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.share_register_settings_setup_note() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.share_register_settings_setup_note() IS
  'ABL 5:3, 5:9: the completion of the setup is entered in the aktiebok as a dated anteckning, in the transaction that completes it.';

DROP TRIGGER IF EXISTS share_register_settings_setup_note ON public.share_register_settings;
CREATE TRIGGER share_register_settings_setup_note
  AFTER INSERT OR UPDATE ON public.share_register_settings
  FOR EACH ROW EXECUTE FUNCTION public.share_register_settings_setup_note();

-- =============================================================================
-- 2. The entries: an opening holding, and the day of the event
-- =============================================================================

ALTER TABLE public.share_register_events
  ADD COLUMN IF NOT EXISTS occurred_on date;

ALTER TABLE public.share_register_events
  DROP CONSTRAINT IF EXISTS share_register_events_occurred_on_check;
ALTER TABLE public.share_register_events
  ADD CONSTRAINT share_register_events_occurred_on_check
  CHECK (occurred_on IS NULL OR occurred_on < event_date);

COMMENT ON COLUMN public.share_register_events.event_date IS
  'The day the entry belongs to in the register. While the register is set up: the day of the event. Once the setup is completed: the day the entry is made (ABL 4:37, 5:9, 7:2), which share_register_events_number() sets.';
COMMENT ON COLUMN public.share_register_events.occurred_on IS
  'The day of the event when it is earlier than event_date: an entry made after the setup was completed carries the day it is made, and the day the transfer or the decision took place is kept here.';

ALTER TABLE public.share_register_events
  DROP CONSTRAINT IF EXISTS share_register_events_kind_check;
ALTER TABLE public.share_register_events
  ADD CONSTRAINT share_register_events_kind_check
  CHECK (kind IN (
    'bildande', 'ingaende', 'nyemission', 'fondemission', 'overlatelse', 'indragning',
    'omvandling', 'split', 'sammanlaggning', 'aktiebrev', 'pant',
    'nyttjanderatt', 'anteckning', 'rattelse'));

-- The shape each kind needs: the list of 20261029210000 with 'ingaende', which is shaped like a bildande.
ALTER TABLE public.share_register_events
  DROP CONSTRAINT IF EXISTS share_register_events_shape;
ALTER TABLE public.share_register_events
  ADD CONSTRAINT share_register_events_shape CHECK (
    CASE kind
      WHEN 'bildande' THEN to_party_id IS NOT NULL AND share_class_id IS NOT NULL AND range_end IS NOT NULL AND from_party_id IS NULL
      WHEN 'ingaende' THEN to_party_id IS NOT NULL AND share_class_id IS NOT NULL AND range_end IS NOT NULL AND from_party_id IS NULL
      WHEN 'nyemission' THEN to_party_id IS NOT NULL AND share_class_id IS NOT NULL AND range_end IS NOT NULL AND from_party_id IS NULL
      WHEN 'fondemission' THEN to_party_id IS NOT NULL AND share_class_id IS NOT NULL AND range_end IS NOT NULL AND from_party_id IS NULL
      WHEN 'overlatelse' THEN from_party_id IS NOT NULL AND to_party_id IS NOT NULL AND from_party_id <> to_party_id
                              AND share_class_id IS NOT NULL AND range_end IS NOT NULL AND transfer_reason IS NOT NULL
      WHEN 'indragning' THEN from_party_id IS NOT NULL AND share_class_id IS NOT NULL AND range_end IS NOT NULL
      WHEN 'omvandling' THEN from_party_id IS NOT NULL AND share_class_id IS NOT NULL AND to_share_class_id IS NOT NULL
                             AND share_class_id <> to_share_class_id AND range_end IS NOT NULL
      WHEN 'split' THEN ratio IS NOT NULL AND range_start IS NULL
      WHEN 'sammanlaggning' THEN ratio IS NOT NULL AND range_start IS NULL
      WHEN 'aktiebrev' THEN range_end IS NOT NULL AND aktiebrev_number IS NOT NULL AND aktiebrev_action IS NOT NULL
      WHEN 'pant' THEN range_end IS NOT NULL AND counterparty_party_id IS NOT NULL AND note_status IS NOT NULL
      WHEN 'nyttjanderatt' THEN range_end IS NOT NULL AND counterparty_party_id IS NOT NULL AND note_status IS NOT NULL
      WHEN 'anteckning' THEN note IS NOT NULL
      WHEN 'rattelse' THEN corrects_event_id IS NOT NULL AND note IS NOT NULL
      ELSE false
    END
  );

COMMENT ON TABLE public.share_register_events IS
  'The aktiebok (ABL 5 kap.): every dated entry in sequence. Append-only (ABL 5:3); a rattelse event voids an earlier one. An ingaende entry is a holding carried over from the register kept before, taken only while the register is set up. Holdings on a date: share_register_state(company, as_of).';

-- Numbering in sequence per company, under a per-company lock: the function of
-- 20261118150000, with the two phases of the register added.
CREATE OR REPLACE FUNCTION public.share_register_events_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_avstamning boolean;
  v_setup_completed_at timestamptz;
  v_target public.share_register_events%ROWTYPE;
  v_last integer;
  v_today date := public.stockholm_today();
BEGIN
  SELECT s.is_avstamningsbolag, s.setup_completed_at INTO v_avstamning, v_setup_completed_at
    FROM public.share_register_settings s WHERE s.company_id = NEW.company_id;
  IF coalesce(v_avstamning, false) THEN
    RAISE EXCEPTION 'SHARE_REGISTER_AVSTAMNINGSBOLAG: the central securities depository keeps the aktiebok of an avstämningsbolag'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.event_date > v_today THEN
    RAISE EXCEPTION 'BOLAGET_DATES_INVALID: an aktiebok entry cannot be dated in the future (%)', NEW.event_date
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_setup_completed_at IS NOT NULL THEN
    -- The register is in use: no more holdings carried over from an earlier
    -- register, and an entry belongs to the day it is made.
    IF NEW.kind = 'ingaende' THEN
      RAISE EXCEPTION 'SHARE_REGISTER_SETUP_COMPLETE: the aktiebok is in use; an opening holding is entered only while it is set up'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.event_date < v_today THEN
      NEW.occurred_on := coalesce(NEW.occurred_on, NEW.event_date);
      NEW.event_date := v_today;
    END IF;
  END IF;
  -- The day of the event is kept only when it is earlier than the entry's day.
  IF NEW.occurred_on IS NOT NULL AND NEW.occurred_on >= NEW.event_date THEN
    NEW.occurred_on := NULL;
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

-- The holdings after replaying every entry that is not voided, up to and
-- including p_as_of (NULL: all of them), in date and entry order: the
-- function of 20261029210000, with an ingaende entry read as the holding it
-- enters. Raises on the first entry the history cannot hold. SECURITY
-- INVOKER: RLS limits a member to their own companies.
CREATE OR REPLACE FUNCTION public.share_register_replay(p_company_id uuid, p_as_of date DEFAULT NULL)
RETURNS SETOF public.share_register_range
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_state public.share_register_range[] := '{}'::public.share_register_range[];
  v_next public.share_register_range[];
  r public.share_register_range;
  v_last public.share_register_range;
  v_have boolean;
  ev record;
  v_cov bigint;
  v_lo bigint;
  v_hi bigint;
BEGIN
  FOR ev IN
    SELECT e.id, e.event_number, e.event_date, e.kind, e.share_class_id, e.to_share_class_id,
           e.from_party_id, e.to_party_id, e.range_start, e.range_end, e.ratio
      FROM public.share_register_events e
     WHERE e.company_id = p_company_id
       AND e.kind IN ('bildande', 'ingaende', 'nyemission', 'fondemission', 'overlatelse', 'indragning', 'omvandling', 'split', 'sammanlaggning')
       AND (p_as_of IS NULL OR e.event_date <= p_as_of)
       AND NOT EXISTS (
         SELECT 1 FROM public.share_register_events c
          WHERE c.company_id = e.company_id AND c.kind = 'rattelse' AND c.corrects_event_id = e.id)
     ORDER BY e.event_date, e.event_number
  LOOP
    IF ev.kind IN ('bildande', 'ingaende', 'nyemission', 'fondemission') THEN
      FOREACH r IN ARRAY v_state LOOP
        IF r.range_start <= ev.range_end AND ev.range_start <= r.range_end THEN
          RAISE EXCEPTION 'SHARE_REGISTER_RANGE_TAKEN: shares % to % are already held (entry %)',
            greatest(r.range_start, ev.range_start), least(r.range_end, ev.range_end), ev.event_number
            USING ERRCODE = 'check_violation';
        END IF;
      END LOOP;
      v_state := v_state || ROW(ev.share_class_id, ev.to_party_id, ev.range_start, ev.range_end)::public.share_register_range;
    ELSIF ev.kind IN ('overlatelse', 'indragning', 'omvandling') THEN
      v_next := '{}'::public.share_register_range[];
      v_cov := 0;
      FOREACH r IN ARRAY v_state LOOP
        IF r.range_end < ev.range_start OR r.range_start > ev.range_end THEN
          v_next := v_next || r;
        ELSE
          IF r.party_id IS DISTINCT FROM ev.from_party_id OR r.share_class_id IS DISTINCT FROM ev.share_class_id THEN
            RAISE EXCEPTION 'SHARE_REGISTER_NOT_HELD: shares % to % of that class are not held by the transferor on % (entry %)',
              ev.range_start, ev.range_end, ev.event_date, ev.event_number
              USING ERRCODE = 'check_violation';
          END IF;
          v_lo := greatest(r.range_start, ev.range_start);
          v_hi := least(r.range_end, ev.range_end);
          v_cov := v_cov + (v_hi - v_lo + 1);
          IF r.range_start < v_lo THEN
            v_next := v_next || ROW(r.share_class_id, r.party_id, r.range_start, v_lo - 1)::public.share_register_range;
          END IF;
          IF ev.kind = 'overlatelse' THEN
            v_next := v_next || ROW(r.share_class_id, ev.to_party_id, v_lo, v_hi)::public.share_register_range;
          ELSIF ev.kind = 'omvandling' THEN
            v_next := v_next || ROW(ev.to_share_class_id, r.party_id, v_lo, v_hi)::public.share_register_range;
          END IF;
          IF r.range_end > v_hi THEN
            v_next := v_next || ROW(r.share_class_id, r.party_id, v_hi + 1, r.range_end)::public.share_register_range;
          END IF;
        END IF;
      END LOOP;
      IF v_cov <> ev.range_end - ev.range_start + 1 THEN
        RAISE EXCEPTION 'SHARE_REGISTER_NOT_HELD: shares % to % are not all held by the transferor on % (entry %)',
          ev.range_start, ev.range_end, ev.event_date, ev.event_number
          USING ERRCODE = 'check_violation';
      END IF;
      v_state := v_next;
    ELSIF ev.kind = 'split' THEN
      v_next := '{}'::public.share_register_range[];
      FOREACH r IN ARRAY v_state LOOP
        v_next := v_next || ROW(r.share_class_id, r.party_id, (r.range_start - 1) * ev.ratio + 1, r.range_end * ev.ratio)::public.share_register_range;
      END LOOP;
      v_state := v_next;
    ELSIF ev.kind = 'sammanlaggning' THEN
      -- Join adjacent ranges of one holder and class first: alignment is a
      -- property of the holding, not of how it was put together.
      v_next := '{}'::public.share_register_range[];
      v_have := false;
      FOR r IN SELECT s.share_class_id, s.party_id, s.range_start, s.range_end
                 FROM unnest(v_state) AS s ORDER BY s.range_start LOOP
        IF v_have AND v_last.range_end + 1 = r.range_start
           AND v_last.party_id = r.party_id AND v_last.share_class_id = r.share_class_id THEN
          v_last.range_end := r.range_end;
        ELSE
          IF v_have THEN
            v_next := v_next || v_last;
          END IF;
          v_last := r;
          v_have := true;
        END IF;
      END LOOP;
      IF v_have THEN
        v_next := v_next || v_last;
      END IF;
      v_state := v_next;
      v_next := '{}'::public.share_register_range[];
      FOREACH r IN ARRAY v_state LOOP
        IF (r.range_start - 1) % ev.ratio <> 0 OR r.range_end % ev.ratio <> 0 THEN
          RAISE EXCEPTION 'SHARE_REGISTER_RATIO_MISALIGNED: shares % to % cannot be combined % to 1 (entry %)',
            r.range_start, r.range_end, ev.ratio, ev.event_number
            USING ERRCODE = 'check_violation';
        END IF;
        v_next := v_next || ROW(r.share_class_id, r.party_id, (r.range_start - 1) / ev.ratio + 1, r.range_end / ev.ratio)::public.share_register_range;
      END LOOP;
      v_state := v_next;
    END IF;
  END LOOP;
  RETURN QUERY SELECT s.share_class_id, s.party_id, s.range_start, s.range_end
                 FROM unnest(v_state) AS s
                ORDER BY s.range_start;
END;
$$;

REVOKE ALL ON FUNCTION public.share_register_replay(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.share_register_replay(uuid, date) TO authenticated, service_role;

-- =============================================================================
-- 3. A holder's name or organisationsnummer changes: a dated note
-- =============================================================================
--
-- The register names its holders, pledgees and holders of rights by party. A
-- party is one row shared with the customer and supplier registers, renamed by
-- whoever keeps those and by the registry lookup. The register must not be
-- silently rewritten by that (ABL 5:3, 5:9): the change is entered as an
-- anteckning that says what the name or number was. SECURITY DEFINER because
-- the one who renames a party need not be one who may write the aktiebok; the
-- note is the register's own record of a change that has already happened.

CREATE OR REPLACE FUNCTION public.parties_share_register_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_parts text[] := '{}'::text[];
  v_avstamning boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.share_register_events e
     WHERE e.company_id = NEW.company_id
       AND (e.to_party_id = NEW.id OR e.from_party_id = NEW.id OR e.counterparty_party_id = NEW.id)
  ) THEN
    RETURN NULL;
  END IF;
  -- A company archived by a migration reset takes no writes, and an
  -- avstämningsbolag's register is not kept here.
  IF EXISTS (SELECT 1 FROM public.company_migration_resets m WHERE m.source_company_id = NEW.company_id) THEN
    RETURN NULL;
  END IF;
  SELECT s.is_avstamningsbolag INTO v_avstamning
    FROM public.share_register_settings s WHERE s.company_id = NEW.company_id;
  IF coalesce(v_avstamning, false) THEN
    RETURN NULL;
  END IF;
  IF NEW.display_name IS DISTINCT FROM OLD.display_name THEN
    v_parts := v_parts || format('namnet ändrat från %s till %s', OLD.display_name, NEW.display_name);
  END IF;
  IF NEW.org_number IS DISTINCT FROM OLD.org_number THEN
    v_parts := v_parts || CASE
      WHEN OLD.org_number IS NULL THEN format('organisationsnummer %s infört', NEW.org_number)
      WHEN NEW.org_number IS NULL THEN format('organisationsnummer %s borttaget', OLD.org_number)
      ELSE format('organisationsnumret ändrat från %s till %s', OLD.org_number, NEW.org_number)
    END;
  END IF;
  IF cardinality(v_parts) = 0 THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.share_register_events (company_id, event_date, kind, note, created_by)
  VALUES (
    NEW.company_id,
    public.stockholm_today(),
    'anteckning',
    left(format('%s: %s.', NEW.display_name, array_to_string(v_parts, '; ')), 2000),
    auth.uid()
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.parties_share_register_note() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.parties_share_register_note() IS
  'ABL 5:3 and 5:9: a change to the name or the organisationsnummer of a party the aktiebok names is entered in the register as a dated anteckning that says what it was, in the transaction that makes the change.';

DROP TRIGGER IF EXISTS parties_share_register_note ON public.parties;
CREATE TRIGGER parties_share_register_note
  AFTER UPDATE ON public.parties
  FOR EACH ROW
  WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name OR OLD.org_number IS DISTINCT FROM NEW.org_number)
  EXECUTE FUNCTION public.parties_share_register_note();

-- =============================================================================
-- 4. A holder's identity number or postal address changes: the old one is kept
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.party_person_private_history (
  id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  party_id                uuid NOT NULL,
  -- When these particulars stopped being the ones the register shows.
  replaced_at             timestamptz NOT NULL DEFAULT now(),
  -- The particulars as they stood until then (party_person_private's own columns and forms).
  personnummer_encrypted  bytea,
  personnummer_masked     text,
  birth_date              date,
  foreign_id              text,
  address_line1           text,
  address_line2           text,
  postal_code             text,
  city                    text,
  country                 text,
  CONSTRAINT party_person_private_history_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.party_person_private_history IS
  'What the aktiebok said about a holder before a change (ABL 5:3: register data that is removed is kept at least ten years; 5:9: a change is dated): the identity number and the postal address party_person_private held until replaced_at. Written by party_person_private_keep_replaced() for parties the aktiebok names. Service role only, append-only.';

CREATE INDEX IF NOT EXISTS idx_party_person_private_history_party
  ON public.party_person_private_history (company_id, party_id, replaced_at);

ALTER TABLE public.party_person_private_history ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.party_person_private_history TO service_role;
-- no-grant: anon on public.party_person_private_history (personnummer and address; service role only)
-- no-grant: authenticated on public.party_person_private_history (personnummer and address; service role only)

CREATE OR REPLACE FUNCTION public.party_person_private_history_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- A row leaves only with its party or company (the cascade runs at trigger
  -- depth > 1) or under the operator and sandbox-teardown override.
  IF TG_OP = 'DELETE'
     AND (pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SHARE_REGISTER_APPEND_ONLY: earlier particulars of a holder are kept as they were (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.party_person_private_history_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS party_person_private_history_append_only ON public.party_person_private_history;
CREATE TRIGGER party_person_private_history_append_only
  BEFORE UPDATE OR DELETE ON public.party_person_private_history
  FOR EACH ROW EXECUTE FUNCTION public.party_person_private_history_append_only();

-- The particulars being replaced, kept when the aktiebok names the party and
-- there was something to replace. The personnummer is compared by its keyed
-- HMAC: the ciphertext differs on every write of the same number.
CREATE OR REPLACE FUNCTION public.party_person_private_keep_replaced()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.personnummer_hmac IS NOT DISTINCT FROM OLD.personnummer_hmac
     AND NEW.birth_date IS NOT DISTINCT FROM OLD.birth_date
     AND NEW.foreign_id IS NOT DISTINCT FROM OLD.foreign_id
     AND NEW.address_line1 IS NOT DISTINCT FROM OLD.address_line1
     AND NEW.address_line2 IS NOT DISTINCT FROM OLD.address_line2
     AND NEW.postal_code IS NOT DISTINCT FROM OLD.postal_code
     AND NEW.city IS NOT DISTINCT FROM OLD.city
     AND NEW.country IS NOT DISTINCT FROM OLD.country THEN
    RETURN NEW;
  END IF;
  -- Filling in what was missing replaces nothing.
  IF OLD.personnummer_hmac IS NULL AND OLD.birth_date IS NULL AND OLD.foreign_id IS NULL
     AND OLD.address_line1 IS NULL AND OLD.address_line2 IS NULL AND OLD.postal_code IS NULL
     AND OLD.city IS NULL AND OLD.country IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.share_register_events e
     WHERE e.company_id = OLD.company_id
       AND (e.to_party_id = OLD.party_id OR e.from_party_id = OLD.party_id OR e.counterparty_party_id = OLD.party_id)
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.party_person_private_history (
    company_id, party_id, personnummer_encrypted, personnummer_masked, birth_date, foreign_id,
    address_line1, address_line2, postal_code, city, country
  ) VALUES (
    OLD.company_id, OLD.party_id, OLD.personnummer_encrypted, OLD.personnummer_masked, OLD.birth_date, OLD.foreign_id,
    OLD.address_line1, OLD.address_line2, OLD.postal_code, OLD.city, OLD.country
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.party_person_private_keep_replaced() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.party_person_private_keep_replaced() IS
  'ABL 5:3: when the identity number or the postal address of a party the aktiebok names is replaced, the earlier particulars are kept in party_person_private_history with the time of the change.';

DROP TRIGGER IF EXISTS party_person_private_keep_replaced ON public.party_person_private;
CREATE TRIGGER party_person_private_keep_replaced
  BEFORE UPDATE ON public.party_person_private
  FOR EACH ROW EXECUTE FUNCTION public.party_person_private_keep_replaced();

NOTIFY pgrst, 'reload schema';
