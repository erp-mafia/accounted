-- =============================================================================
-- Bolaget, wave 2: meetings, decisions and minutes (ABL 7 kap., 8:24-26)
--
--   1. corporate_meetings: årsstämma, extra stämma, styrelsemöte or a
--      decision per capsulam (by the stämma or by the board). Date, place or
--      digital, chair, protokollförare and justerare (party ids, names only),
--      kallelse date and method, the röstlängd as a snapshot of the aktiebok
--      on the meeting day (ABL 7:48: holders, shares, votes, names only,
--      never a personnummer), attendance, and the fiscal year an årsstämma is
--      for. Status draft -> held -> signed. Board minutes are numbered per
--      company when the meeting is held (ABL 8:26 "i nummerföljd"), so a
--      deleted draft never leaves a gap.
--   2. corporate_decisions: one paragraph of the minutes: item number,
--      kind, a payload validated per kind in code
--      (src/lib/bolaget/meetings/payloads.ts), text, outcome, votes and
--      reservations.
--   3. Signed minutes are immutable: a signed meeting and its decisions never
--      change and are never deleted; minutes out for BankID signing are
--      frozen while the request runs; only a draft meeting is deleted
--      (enforced below, not only in the app).
--   4. pending_operations.operation_type: create_corporate_meeting,
--      update_corporate_meeting, record_corporate_decision,
--      hold_corporate_meeting, expanded from the constraint's current
--      definition, NOT VALID; the VALIDATE runs in 20261030010100.
--
-- Nothing here touches the ledger. Capital decisions (utdelning, nyemission,
-- ...) are booked by a later wave, which links back by decision_id (no FK).
-- Party ids (chair, secretary, justerare) carry no foreign key: the service
-- checks them against the company's parties (src/lib/bolaget/people.ts).
--
-- pg-test: tests/pg/corporate-meetings.pg.test.ts
-- =============================================================================

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. corporate_meetings
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.corporate_meetings (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('arsstamma', 'extra_stamma', 'styrelsemote', 'per_capsulam')),
  -- Which body decides: the bolagsstämma or the styrelse. Fixed by the kind,
  -- except per capsulam, where it says whose decision it is.
  organ               text NOT NULL CHECK (organ IN ('bolagsstamma', 'styrelse')),
  -- Board minutes in numerical order (ABL 8:26), set when the meeting is held.
  sequence_number     integer CHECK (sequence_number IS NULL OR sequence_number > 0),
  meeting_date        date NOT NULL,
  meeting_time        text CHECK (meeting_time IS NULL OR meeting_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  place               text CHECK (place IS NULL OR char_length(place) <= 200),
  is_digital          boolean NOT NULL DEFAULT false,
  chair_party_id      uuid,
  secretary_party_id  uuid,
  -- Justerare (ABL 7:48 stämma, 8:24 styrelse).
  adjuster_party_ids  uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(adjuster_party_ids) <= 10),
  kallelse_date       date,
  kallelse_method     text CHECK (kallelse_method IS NULL OR char_length(kallelse_method) <= 200),
  -- The fiscal year an årsstämma adopts the årsredovisning for.
  fiscal_period_id    uuid REFERENCES public.fiscal_periods(id) ON DELETE SET NULL,
  -- The röstlängd: { as_of, total_shares, total_votes, holders: [{ party_id,
  -- name, kind, shares, votes, present, proxy_name }] }. Names only.
  voting_list         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(voting_list) = 'object'),
  -- Närvarande: [{ party_id, name, capacity, present }]. Names only.
  attendees           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attendees) = 'array'),
  notes               text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'held', 'signed')),
  held_at             timestamptz,
  signed_at           timestamptz,
  -- Who signed, as the signed copy says (a hand-signed copy, or the BankID names).
  signature_names     text CHECK (signature_names IS NULL OR char_length(signature_names) <= 1000),
  -- The minutes PDF archived for signing; the signed copy (BankID seal or the
  -- uploaded scan). SET NULL only lets a sanctioned destructive path (the
  -- sandbox teardown) remove a document; the guard below lets it through.
  minutes_document_id uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  signed_document_id  uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  -- The BankID signing request while it runs; the minutes are frozen meanwhile.
  signing_request_id  uuid REFERENCES public.signing_requests(id) ON DELETE SET NULL,
  created_by          uuid REFERENCES auth.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind IN ('arsstamma', 'extra_stamma') AND organ = 'bolagsstamma')
    OR (kind = 'styrelsemote' AND organ = 'styrelse')
    OR kind = 'per_capsulam'
  ),
  CHECK (sequence_number IS NULL OR organ = 'styrelse'),
  CHECK (status = 'draft' OR held_at IS NOT NULL),
  CHECK (status <> 'signed' OR signed_at IS NOT NULL)
);

COMMENT ON TABLE public.corporate_meetings IS
  'Bolagsstämmor, styrelsemöten and per capsulam decisions with their minutes (ABL 7:48, 8:24-26). Frozen once signed; board minutes numbered per company.';

CREATE UNIQUE INDEX IF NOT EXISTS corporate_meetings_board_number
  ON public.corporate_meetings (company_id, sequence_number) WHERE sequence_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_corporate_meetings_company_date
  ON public.corporate_meetings (company_id, meeting_date DESC);
CREATE INDEX IF NOT EXISTS idx_corporate_meetings_fiscal_period
  ON public.corporate_meetings (fiscal_period_id) WHERE fiscal_period_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_corporate_meetings_minutes_document
  ON public.corporate_meetings (minutes_document_id) WHERE minutes_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_corporate_meetings_signed_document
  ON public.corporate_meetings (signed_document_id) WHERE signed_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_corporate_meetings_signing_request
  ON public.corporate_meetings (signing_request_id) WHERE signing_request_id IS NOT NULL;

ALTER TABLE public.corporate_meetings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.corporate_meetings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.corporate_meetings TO authenticated;
-- no-grant: anon on public.corporate_meetings (company data)

DROP POLICY IF EXISTS "view own-company corporate_meetings" ON public.corporate_meetings;
CREATE POLICY "view own-company corporate_meetings"
  ON public.corporate_meetings FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company corporate_meetings" ON public.corporate_meetings;
CREATE POLICY "insert own-company corporate_meetings"
  ON public.corporate_meetings FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company corporate_meetings" ON public.corporate_meetings;
CREATE POLICY "update own-company corporate_meetings"
  ON public.corporate_meetings FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));
DROP POLICY IF EXISTS "delete own-company corporate_meetings" ON public.corporate_meetings;
CREATE POLICY "delete own-company corporate_meetings"
  ON public.corporate_meetings FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
    AND status = 'draft'
  );

-- =============================================================================
-- 2. corporate_decisions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.corporate_decisions (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  meeting_id       uuid NOT NULL REFERENCES public.corporate_meetings(id) ON DELETE CASCADE,
  -- The paragraph (§) of the minutes; kept 1..n by the service.
  item_number      integer NOT NULL CHECK (item_number BETWEEN 1 AND 999),
  kind             text NOT NULL CHECK (kind IN (
                     'faststallande_rr_br', 'resultatdisposition', 'utdelning', 'ansvarsfrihet',
                     'val_styrelse', 'val_revisor', 'arvoden', 'andrad_bolagsordning',
                     'nyemission', 'fondemission', 'minskning', 'optioner',
                     'aterbetalning_villkorat_tillskott', 'ovrigt')),
  title            text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  text             text CHECK (text IS NULL OR char_length(text) <= 8000),
  -- Per kind (amounts, dates, who was elected); validated in code. Names and
  -- party ids only, never a personnummer.
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  outcome          text NOT NULL DEFAULT 'bifallen' CHECK (outcome IN ('bifallen', 'avslagen', 'bordlagd')),
  -- Votes cast (röster, not persons) when the item went to a vote.
  votes_for        numeric(20, 2) CHECK (votes_for IS NULL OR votes_for >= 0),
  votes_against    numeric(20, 2) CHECK (votes_against IS NULL OR votes_against >= 0),
  votes_abstained  numeric(20, 2) CHECK (votes_abstained IS NULL OR votes_abstained >= 0),
  -- Reservationer and other dissent to be noted (ABL 8:24).
  reservations     text CHECK (reservations IS NULL OR char_length(reservations) <= 2000),
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.corporate_decisions IS
  'One paragraph of a meeting''s minutes (corporate_meetings): kind, payload, text, outcome and votes. Frozen once the minutes are signed.';

CREATE INDEX IF NOT EXISTS idx_corporate_decisions_meeting ON public.corporate_decisions (meeting_id, item_number);
CREATE INDEX IF NOT EXISTS idx_corporate_decisions_company_kind ON public.corporate_decisions (company_id, kind);

ALTER TABLE public.corporate_decisions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.corporate_decisions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.corporate_decisions TO authenticated;
-- no-grant: anon on public.corporate_decisions (company data)

DROP POLICY IF EXISTS "view own-company corporate_decisions" ON public.corporate_decisions;
CREATE POLICY "view own-company corporate_decisions"
  ON public.corporate_decisions FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company corporate_decisions" ON public.corporate_decisions;
CREATE POLICY "insert own-company corporate_decisions"
  ON public.corporate_decisions FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company corporate_decisions" ON public.corporate_decisions;
CREATE POLICY "update own-company corporate_decisions"
  ON public.corporate_decisions FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));
DROP POLICY IF EXISTS "delete own-company corporate_decisions" ON public.corporate_decisions;
CREATE POLICY "delete own-company corporate_decisions"
  ON public.corporate_decisions FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );

-- =============================================================================
-- 3. Signed minutes are immutable; board minutes are numbered
-- =============================================================================

-- corporate_meetings: a new meeting starts as an unnumbered draft. A draft
-- or held meeting changes freely (but never goes back from held to draft,
-- and only a held meeting is signed). Holding a board meeting gives it the
-- company's next number. Minutes out for BankID signing change only by
-- being signed or by the request ending. A signed meeting never changes,
-- except that a signed copy still being sealed may be filled in once. Only a
-- draft is deleted. The cascade from the company and the SET NULL from a
-- sanctioned document, signing-request or fiscal-year delete (all at
-- trigger depth > 1) and the operator override pass.
CREATE OR REPLACE FUNCTION public.corporate_meetings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.sequence_number IS NOT NULL OR NEW.signing_request_id IS NOT NULL
       OR NEW.signed_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'CORPORATE_MEETING_LOCKED: a meeting starts as an unnumbered draft' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'CORPORATE_MEETING_LOCKED: held or signed minutes are kept' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.company_id <> OLD.company_id OR NEW.organ <> OLD.organ
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'CORPORATE_MEETING_LOCKED: the company and body of a meeting never change' USING ERRCODE = '55000';
  END IF;

  -- Signed: the minutes are the record. Only a signed copy still being
  -- sealed is filled in, once.
  IF OLD.status = 'signed' THEN
    IF ROW(NEW.kind, NEW.sequence_number, NEW.meeting_date, NEW.meeting_time, NEW.place, NEW.is_digital,
           NEW.chair_party_id, NEW.secretary_party_id, NEW.adjuster_party_ids, NEW.kallelse_date,
           NEW.kallelse_method, NEW.fiscal_period_id, NEW.voting_list, NEW.attendees, NEW.notes, NEW.status,
           NEW.held_at, NEW.signed_at, NEW.signature_names, NEW.minutes_document_id, NEW.signing_request_id)
       IS DISTINCT FROM
       ROW(OLD.kind, OLD.sequence_number, OLD.meeting_date, OLD.meeting_time, OLD.place, OLD.is_digital,
           OLD.chair_party_id, OLD.secretary_party_id, OLD.adjuster_party_ids, OLD.kallelse_date,
           OLD.kallelse_method, OLD.fiscal_period_id, OLD.voting_list, OLD.attendees, OLD.notes, OLD.status,
           OLD.held_at, OLD.signed_at, OLD.signature_names, OLD.minutes_document_id, OLD.signing_request_id)
       OR (OLD.signed_document_id IS NOT NULL AND NEW.signed_document_id IS DISTINCT FROM OLD.signed_document_id) THEN
      RAISE EXCEPTION 'CORPORATE_MEETING_LOCKED: signed minutes never change' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.sequence_number IS DISTINCT FROM OLD.sequence_number THEN
    RAISE EXCEPTION 'CORPORATE_MEETING_LOCKED: the minutes number is given when the meeting is held' USING ERRCODE = '55000';
  END IF;

  -- Out for BankID signing: the content is what the signers see.
  IF OLD.signing_request_id IS NOT NULL THEN
    IF ROW(NEW.kind, NEW.meeting_date, NEW.meeting_time, NEW.place, NEW.is_digital, NEW.chair_party_id,
           NEW.secretary_party_id, NEW.adjuster_party_ids, NEW.kallelse_date, NEW.kallelse_method,
           NEW.fiscal_period_id, NEW.voting_list, NEW.attendees, NEW.notes, NEW.held_at, NEW.minutes_document_id)
       IS DISTINCT FROM
       ROW(OLD.kind, OLD.meeting_date, OLD.meeting_time, OLD.place, OLD.is_digital, OLD.chair_party_id,
           OLD.secretary_party_id, OLD.adjuster_party_ids, OLD.kallelse_date, OLD.kallelse_method,
           OLD.fiscal_period_id, OLD.voting_list, OLD.attendees, OLD.notes, OLD.held_at, OLD.minutes_document_id)
       OR NOT (
         (NEW.status = 'signed' AND NEW.signing_request_id IS NOT DISTINCT FROM OLD.signing_request_id)
         OR (NEW.status = OLD.status AND NEW.signing_request_id IS NULL)
       ) THEN
      RAISE EXCEPTION 'CORPORATE_MEETING_LOCKED: the minutes are out for signing' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'draft' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'CORPORATE_MEETING_LOCKED: a held meeting does not go back to draft' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'signed' AND OLD.status <> 'held' THEN
    RAISE EXCEPTION 'CORPORATE_MEETING_NOT_HELD: a meeting is held before its minutes are signed' USING ERRCODE = '55000';
  END IF;
  IF NEW.signing_request_id IS NOT NULL AND NEW.status <> 'held' THEN
    RAISE EXCEPTION 'CORPORATE_MEETING_NOT_HELD: only the minutes of a held meeting go out for signing' USING ERRCODE = '55000';
  END IF;

  -- Held: a board meeting takes the company's next minutes number.
  IF OLD.status = 'draft' AND NEW.status = 'held' AND NEW.organ = 'styrelse' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('corporate_meetings_number:' || NEW.company_id::text, 0));
    SELECT coalesce(max(m.sequence_number), 0) + 1
      INTO NEW.sequence_number
      FROM public.corporate_meetings m
     WHERE m.company_id = NEW.company_id
       AND m.organ = 'styrelse';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.corporate_meetings_guard() FROM PUBLIC, anon, authenticated;

-- corporate_decisions: a paragraph changes only while its meeting is a draft
-- or held and not out for signing, and stays on its meeting.
CREATE OR REPLACE FUNCTION public.corporate_decisions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_meeting_id uuid;
  v_company uuid;
  v_status text;
  v_signing uuid;
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_meeting_id := OLD.meeting_id;
  ELSE
    v_meeting_id := NEW.meeting_id;
  END IF;
  SELECT company_id, status, signing_request_id INTO v_company, v_status, v_signing
    FROM public.corporate_meetings WHERE id = v_meeting_id;
  IF TG_OP <> 'DELETE' THEN
    IF v_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'CORPORATE_MEETING_NOT_FOUND: the decision belongs to a meeting of another company' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_status = 'signed' OR v_signing IS NOT NULL THEN
    RAISE EXCEPTION 'CORPORATE_MEETING_LOCKED: the decisions of signed minutes never change' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.meeting_id <> OLD.meeting_id OR NEW.company_id <> OLD.company_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'CORPORATE_MEETING_LOCKED: a decision stays on its meeting' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.corporate_decisions_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.corporate_meetings;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.corporate_meetings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS corporate_meetings_block_migration_reset_source_mutation ON public.corporate_meetings;
CREATE TRIGGER corporate_meetings_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.corporate_meetings
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS corporate_meetings_guard ON public.corporate_meetings;
CREATE TRIGGER corporate_meetings_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.corporate_meetings
  FOR EACH ROW EXECUTE FUNCTION public.corporate_meetings_guard();
DROP TRIGGER IF EXISTS set_updated_at_corporate_meetings ON public.corporate_meetings;
CREATE TRIGGER set_updated_at_corporate_meetings
  BEFORE UPDATE ON public.corporate_meetings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_corporate_meetings ON public.corporate_meetings;
CREATE TRIGGER audit_corporate_meetings
  AFTER INSERT OR UPDATE OR DELETE ON public.corporate_meetings
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.corporate_decisions;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.corporate_decisions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS corporate_decisions_block_migration_reset_source_mutation ON public.corporate_decisions;
CREATE TRIGGER corporate_decisions_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.corporate_decisions
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS corporate_decisions_guard ON public.corporate_decisions;
CREATE TRIGGER corporate_decisions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.corporate_decisions
  FOR EACH ROW EXECUTE FUNCTION public.corporate_decisions_guard();
DROP TRIGGER IF EXISTS set_updated_at_corporate_decisions ON public.corporate_decisions;
CREATE TRIGGER set_updated_at_corporate_decisions
  BEFORE UPDATE ON public.corporate_decisions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_corporate_decisions ON public.corporate_decisions;
CREATE TRIGGER audit_corporate_decisions
  AFTER INSERT OR UPDATE OR DELETE ON public.corporate_decisions
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 4. pending_operations.operation_type: the meeting staged writes
-- =============================================================================

DO $$
DECLARE
  v_types text[];
  v_new text;
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_types
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.pending_operations'::regclass
     AND c.conname = 'pending_operations_operation_type_check';
  IF v_types IS NULL OR cardinality(v_types) < 150 THEN
    RAISE EXCEPTION 'pending_operations_operation_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[
    'create_corporate_meeting', 'update_corporate_meeting', 'record_corporate_decision', 'hold_corporate_meeting'
  ] LOOP
    IF NOT (v_new = ANY (v_types)) THEN
      v_types := v_types || v_new;
    END IF;
  END LOOP;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
