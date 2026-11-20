-- =============================================================================
-- Bolaget, wave 1: people, roles over time and the aktiebok (ABL 5-6 kap.)
--
--   1. parties.origin 'bolaget': a person or company created for a role or a
--      shareholding. Kontakter leaves such a party out until it is also a
--      customer or supplier (src/lib/parties/register.ts). NOT VALID; the
--      VALIDATE runs in 20261029210100.
--   2. party_person_private: personnummer (encrypted, keyed HMAC, masked)
--      and postal address of a party in the registers. Service role only and
--      no write_audit_log trigger: audit_log stores whole rows as JSON.
--   3. company_roles: board, VD, firmatecknare, revisor, verklig huvudman,
--      kontaktperson, with valid_from/valid_to. A role is end-dated, never
--      deleted, and only its end, registration date and details change.
--   4. company_signatory_rules: the firmateckning text over time, same rule.
--   5. share_register_settings: per company; avstämningsbolag disables the
--      register (Euroclear keeps it, ABL 5:11-12), and the one-time claim
--      for seeding the roles from companies.tic_snapshot.
--   6. share_classes: class code, votes per share, förbehåll (ABL 4:6, 4:8,
--      4:18, 4:27, 20:31).
--   7. share_register_events: the aktiebok itself, append-only (ABL 5:3).
--      Each event is numbered in sequence per company and dated (ABL 5:9).
--      A mistake is voided by a 'rattelse' event, never edited. A deferred
--      constraint trigger replays the whole history at commit: no two
--      holders of one share number, a transfer or cancellation only of
--      shares the from-holder holds on that date, a sammanläggning only on
--      aligned ranges. share_register_state(company, as_of) answers the
--      holdings on a date.
--   8. beneficial_owner_assessments: the LRVH 2:1 record of each
--      investigation (date, basis, conclusion, who), append-only.
--   9. pending_operations.operation_type: the Bolaget staged writes,
--      expanded from the constraint's current definition, NOT VALID; the
--      VALIDATE runs in 20261029210100.
--
-- Nothing here touches the ledger. Capital-event bookings come in a later
-- wave and link here through journal_entry_id / decision_id (no FK yet).
--
-- pg-test: tests/pg/bolaget-registers.pg.test.ts
-- =============================================================================

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. parties.origin: 'bolaget'
-- =============================================================================

DO $$
DECLARE
  v_conname text;
  v_values text[];
BEGIN
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
   WHERE c.conrelid = 'public.parties'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%origin%'
   LIMIT 1;
  IF v_conname IS NULL THEN
    RAISE EXCEPTION 'parties origin CHECK not found';
  END IF;
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_values
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.parties'::regclass AND c.conname = v_conname;
  IF v_values IS NULL OR cardinality(v_values) < 5 THEN
    RAISE EXCEPTION 'parties origin CHECK: expected the full list, read % values', coalesce(cardinality(v_values), 0);
  END IF;
  IF NOT ('bolaget' = ANY (v_values)) THEN
    v_values := v_values || 'bolaget'::text;
  END IF;
  EXECUTE format('ALTER TABLE public.parties DROP CONSTRAINT %I', v_conname);
  EXECUTE format(
    'ALTER TABLE public.parties ADD CONSTRAINT parties_origin_check CHECK (origin IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_values) AS t)
  );
END;
$$;

-- =============================================================================
-- 2. party_person_private
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.party_person_private (
  party_id                uuid PRIMARY KEY,
  company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- AES-256-GCM (BANKID_ENCRYPTION_KEY), iv|tag|ciphertext.
  personnummer_encrypted  bytea,
  -- HMAC-SHA256 keyed from the same secret: finds the same person twice
  -- within a company without decrypting, and cannot be brute-forced from a
  -- leaked row the way an unsalted hash of a personnummer can.
  personnummer_hmac       text CHECK (personnummer_hmac IS NULL OR personnummer_hmac ~ '^[0-9a-f]{64}$'),
  -- "XXXXXXXX-1234": what members and agents see.
  personnummer_masked     text CHECK (personnummer_masked IS NULL OR personnummer_masked ~ '^X{6,8}-[0-9]{4}$'),
  -- A holder without a Swedish personnummer: birth date or a foreign id (ABL 5:5 "annat identifieringsnummer").
  birth_date              date,
  foreign_id              text CHECK (foreign_id IS NULL OR length(foreign_id) <= 64),
  address_line1           text CHECK (address_line1 IS NULL OR length(address_line1) <= 200),
  address_line2           text CHECK (address_line2 IS NULL OR length(address_line2) <= 200),
  postal_code             text CHECK (postal_code IS NULL OR length(postal_code) <= 20),
  city                    text CHECK (city IS NULL OR length(city) <= 100),
  country                 text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  email                   text CHECK (email IS NULL OR length(email) <= 254),
  phone                   text CHECK (phone IS NULL OR length(phone) <= 40),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK ((personnummer_encrypted IS NULL) = (personnummer_hmac IS NULL)),
  CHECK ((personnummer_encrypted IS NULL) = (personnummer_masked IS NULL)),
  CONSTRAINT party_person_private_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.party_person_private IS
  'Identity and postal address of a party in the Bolaget registers (aktiebok ABL 5:5, roles): the personnummer encrypted, its keyed HMAC and a masked form. Service role only, no audit trigger (audit_log copies whole rows).';

CREATE UNIQUE INDEX IF NOT EXISTS party_person_private_company_hmac
  ON public.party_person_private (company_id, personnummer_hmac)
  WHERE personnummer_hmac IS NOT NULL;
CREATE INDEX IF NOT EXISTS party_person_private_company ON public.party_person_private (company_id);

ALTER TABLE public.party_person_private ENABLE ROW LEVEL SECURITY;
-- No policy: the service role only.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.party_person_private TO service_role;
-- no-grant: anon on public.party_person_private (personnummer and address; service role only)
-- no-grant: authenticated on public.party_person_private (personnummer and address; service role only)

DROP TRIGGER IF EXISTS set_updated_at_party_person_private ON public.party_person_private;
CREATE TRIGGER set_updated_at_party_person_private
  BEFORE UPDATE ON public.party_person_private
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 3. company_roles
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_roles (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  party_id       uuid NOT NULL,
  role           text NOT NULL CHECK (role IN (
                   'styrelseledamot', 'styrelseordforande', 'styrelsesuppleant',
                   'vd', 'vice_vd', 'sarskild_firmatecknare',
                   'revisor', 'huvudansvarig_revisor', 'revisorssuppleant',
                   'verklig_huvudman', 'kontaktperson')),
  -- NULL when the source does not say (a registry row without a start date).
  valid_from     date,
  valid_to       date,
  source         text NOT NULL CHECK (source IN ('registry_tic', 'person', 'decision', 'document')),
  -- The stämma or board decision (a later wave adds the meetings table).
  decision_id    uuid,
  document_id    uuid,
  -- When Bolagsverket registered the change (ABL 8:13: a board change takes effect on notice).
  registered_at  date,
  -- Verklig huvudman: { extent, votes_pct, capital_pct, control }. Free otherwise.
  details        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_by     uuid REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CONSTRAINT company_roles_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id)
);

COMMENT ON TABLE public.company_roles IS
  'Who held which role in the company and when (ABL 8 kap., LRVH). End-dated, never deleted; only valid_to (once), registered_at and details change.';

CREATE INDEX IF NOT EXISTS idx_company_roles_company ON public.company_roles (company_id, role);
CREATE INDEX IF NOT EXISTS idx_company_roles_party ON public.company_roles (party_id);

-- The fields that say who, what and since when never change; the end is set once.
CREATE OR REPLACE FUNCTION public.company_roles_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'COMPANY_ROLE_APPEND_ONLY: a role is end-dated, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.party_id IS DISTINCT FROM OLD.party_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'COMPANY_ROLE_APPEND_ONLY: only the end date, registration date and details of a role change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    RAISE EXCEPTION 'COMPANY_ROLE_ALREADY_ENDED: the role has already ended'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.company_roles_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.company_roles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_roles TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.company_roles TO authenticated;
-- no-grant: anon on public.company_roles (company data)

DROP POLICY IF EXISTS "view own-company company_roles" ON public.company_roles;
CREATE POLICY "view own-company company_roles"
  ON public.company_roles FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company company_roles" ON public.company_roles;
CREATE POLICY "insert own-company company_roles"
  ON public.company_roles FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company company_roles" ON public.company_roles;
CREATE POLICY "update own-company company_roles"
  ON public.company_roles FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.company_roles;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS company_roles_block_migration_reset_source_mutation ON public.company_roles;
CREATE TRIGGER company_roles_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_roles
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS company_roles_guard ON public.company_roles;
CREATE TRIGGER company_roles_guard
  BEFORE UPDATE OR DELETE ON public.company_roles
  FOR EACH ROW EXECUTE FUNCTION public.company_roles_guard();
DROP TRIGGER IF EXISTS set_updated_at_company_roles ON public.company_roles;
CREATE TRIGGER set_updated_at_company_roles
  BEFORE UPDATE ON public.company_roles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_company_roles ON public.company_roles;
CREATE TRIGGER audit_company_roles
  AFTER INSERT OR UPDATE OR DELETE ON public.company_roles
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 4. company_signatory_rules
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_signatory_rules (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rule_text      text NOT NULL CHECK (length(btrim(rule_text)) BETWEEN 1 AND 2000),
  valid_from     date,
  valid_to       date,
  source         text NOT NULL CHECK (source IN ('registry_tic', 'person', 'decision', 'document')),
  decision_id    uuid,
  registered_at  date,
  created_by     uuid REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

COMMENT ON TABLE public.company_signatory_rules IS
  'The firmateckning as registered (ABL 8:35-37, 8:43) over time. End-dated, never deleted.';

CREATE INDEX IF NOT EXISTS idx_company_signatory_rules_company ON public.company_signatory_rules (company_id);

CREATE OR REPLACE FUNCTION public.company_signatory_rules_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'COMPANY_ROLE_APPEND_ONLY: a signatory rule is end-dated, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.rule_text IS DISTINCT FROM OLD.rule_text
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.decision_id IS DISTINCT FROM OLD.decision_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'COMPANY_ROLE_APPEND_ONLY: only the end date and registration date of a signatory rule change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    RAISE EXCEPTION 'COMPANY_ROLE_ALREADY_ENDED: the signatory rule has already ended'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.company_signatory_rules_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.company_signatory_rules ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_signatory_rules TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.company_signatory_rules TO authenticated;
-- no-grant: anon on public.company_signatory_rules (company data)

DROP POLICY IF EXISTS "view own-company company_signatory_rules" ON public.company_signatory_rules;
CREATE POLICY "view own-company company_signatory_rules"
  ON public.company_signatory_rules FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company company_signatory_rules" ON public.company_signatory_rules;
CREATE POLICY "insert own-company company_signatory_rules"
  ON public.company_signatory_rules FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company company_signatory_rules" ON public.company_signatory_rules;
CREATE POLICY "update own-company company_signatory_rules"
  ON public.company_signatory_rules FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.company_signatory_rules;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_signatory_rules
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS company_signatory_rules_block_migration_reset_source_mutation ON public.company_signatory_rules;
CREATE TRIGGER company_signatory_rules_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_signatory_rules
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS company_signatory_rules_guard ON public.company_signatory_rules;
CREATE TRIGGER company_signatory_rules_guard
  BEFORE UPDATE OR DELETE ON public.company_signatory_rules
  FOR EACH ROW EXECUTE FUNCTION public.company_signatory_rules_guard();
DROP TRIGGER IF EXISTS set_updated_at_company_signatory_rules ON public.company_signatory_rules;
CREATE TRIGGER set_updated_at_company_signatory_rules
  BEFORE UPDATE ON public.company_signatory_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_company_signatory_rules ON public.company_signatory_rules;
CREATE TRIGGER audit_company_signatory_rules
  AFTER INSERT OR UPDATE OR DELETE ON public.company_signatory_rules
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 5. share_register_settings
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.share_register_settings (
  company_id           uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  -- write_audit_log keys its rows on an id column.
  id                   uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  -- ABL 1:10: the shares are in a central securities depository; the
  -- depository keeps the aktiebok (5:11-12) and no aktiebrev exist (6:10).
  is_avstamningsbolag  boolean NOT NULL DEFAULT false,
  -- Set once, by the first read that seeded company_roles from the cached
  -- registry snapshot (companies.tic_snapshot; no registry call): the claim
  -- that keeps two concurrent reads from seeding twice.
  roles_seeded_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.share_register_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.share_register_settings TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.share_register_settings TO authenticated;
-- no-grant: anon on public.share_register_settings (company data)

DROP POLICY IF EXISTS "view own-company share_register_settings" ON public.share_register_settings;
CREATE POLICY "view own-company share_register_settings"
  ON public.share_register_settings FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company share_register_settings" ON public.share_register_settings;
CREATE POLICY "insert own-company share_register_settings"
  ON public.share_register_settings FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company share_register_settings" ON public.share_register_settings;
CREATE POLICY "update own-company share_register_settings"
  ON public.share_register_settings FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.share_register_settings;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.share_register_settings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS set_updated_at_share_register_settings ON public.share_register_settings;
CREATE TRIGGER set_updated_at_share_register_settings
  BEFORE UPDATE ON public.share_register_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_share_register_settings ON public.share_register_settings;
CREATE TRIGGER audit_share_register_settings
  AFTER INSERT OR UPDATE OR DELETE ON public.share_register_settings
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 6. share_classes
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.share_classes (
  id                       uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code                     text NOT NULL CHECK (code ~ '^[A-Za-z0-9]{1,12}$'),
  name                     text CHECK (name IS NULL OR length(btrim(name)) BETWEEN 1 AND 100),
  -- ABL 4:5: one class may carry at most ten times the votes of another (checked in the app; a warning).
  votes_per_share          numeric(10, 4) NOT NULL DEFAULT 1 CHECK (votes_per_share > 0),
  -- Förbehåll in the bolagsordning, noted in the aktiebok (ABL 5:5) and on an aktiebrev (6:2).
  forbehall_samtycke       boolean NOT NULL DEFAULT false,  -- 4:8
  forbehall_forkop         boolean NOT NULL DEFAULT false,  -- 4:18
  forbehall_hembud         boolean NOT NULL DEFAULT false,  -- 4:27
  forbehall_omvandling     boolean NOT NULL DEFAULT false,  -- 4:6
  forbehall_inlosen        boolean NOT NULL DEFAULT false,  -- 20:31
  forbehall_text           text CHECK (forbehall_text IS NULL OR length(forbehall_text) <= 4000),
  bolagsordning_reference  text CHECK (bolagsordning_reference IS NULL OR length(bolagsordning_reference) <= 200),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT share_classes_company_code_unique UNIQUE (company_id, code),
  CONSTRAINT share_classes_id_company_unique UNIQUE (id, company_id)
);

COMMENT ON TABLE public.share_classes IS
  'Aktieslag (ABL 4:2): votes per share and the förbehåll of the bolagsordning. Changes are kept in audit_log; a class used by the aktiebok cannot be deleted.';

ALTER TABLE public.share_classes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.share_classes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.share_classes TO authenticated;
-- no-grant: anon on public.share_classes (company data)

DROP POLICY IF EXISTS "view own-company share_classes" ON public.share_classes;
CREATE POLICY "view own-company share_classes"
  ON public.share_classes FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company share_classes" ON public.share_classes;
CREATE POLICY "insert own-company share_classes"
  ON public.share_classes FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company share_classes" ON public.share_classes;
CREATE POLICY "update own-company share_classes"
  ON public.share_classes FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));
DROP POLICY IF EXISTS "delete own-company share_classes" ON public.share_classes;
CREATE POLICY "delete own-company share_classes"
  ON public.share_classes FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.share_classes;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.share_classes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS share_classes_block_migration_reset_source_mutation ON public.share_classes;
CREATE TRIGGER share_classes_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.share_classes
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS set_updated_at_share_classes ON public.share_classes;
CREATE TRIGGER set_updated_at_share_classes
  BEFORE UPDATE ON public.share_classes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_share_classes ON public.share_classes;
CREATE TRIGGER audit_share_classes
  AFTER INSERT OR UPDATE OR DELETE ON public.share_classes
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 7. share_register_events: the aktiebok
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.share_register_events (
  id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id             uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- In sequence per company, assigned by share_register_events_number().
  event_number           integer NOT NULL,
  -- The day the change took effect; created_at is when it was entered (ABL 5:9).
  event_date             date NOT NULL,
  kind                   text NOT NULL CHECK (kind IN (
                           'bildande', 'nyemission', 'fondemission', 'overlatelse', 'indragning',
                           'omvandling', 'split', 'sammanlaggning', 'aktiebrev', 'pant',
                           'nyttjanderatt', 'anteckning', 'rattelse')),
  share_class_id         uuid,
  to_share_class_id      uuid,
  from_party_id          uuid,
  to_party_id            uuid,
  range_start            bigint CHECK (range_start IS NULL OR range_start >= 1),
  range_end              bigint,
  transfer_reason        text CHECK (transfer_reason IS NULL OR transfer_reason IN (
                           'kop', 'gava', 'arv', 'testamente', 'bodelning', 'byte', 'apport', 'annat')),
  price_total            numeric(16, 2) CHECK (price_total IS NULL OR price_total >= 0),
  -- split: each share becomes `ratio`; sammanläggning: `ratio` shares become one.
  ratio                  integer CHECK (ratio IS NULL OR ratio BETWEEN 2 AND 1000000),
  aktiebrev_number       text CHECK (aktiebrev_number IS NULL OR length(btrim(aktiebrev_number)) BETWEEN 1 AND 40),
  aktiebrev_action       text CHECK (aktiebrev_action IS NULL OR aktiebrev_action IN ('issued', 'returned')),
  -- pant / nyttjanderätt: the pledgee or the holder of the right, and whether this event opens or closes it.
  counterparty_party_id  uuid,
  note_status            text CHECK (note_status IS NULL OR note_status IN ('open', 'closed')),
  corrects_event_id      uuid,
  -- Emissions: when Bolagsverket registered the decision (ABL 12:10, 13:29).
  registered_on          date,
  decision_id            uuid,
  document_id            uuid,
  journal_entry_id       uuid,
  note                   text CHECK (note IS NULL OR length(note) <= 2000),
  details                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_by             uuid REFERENCES auth.users(id),
  created_via            text NOT NULL DEFAULT 'app' CHECK (created_via IN ('app', 'api', 'mcp')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT share_register_events_number_unique UNIQUE (company_id, event_number),
  CONSTRAINT share_register_events_id_company_unique UNIQUE (id, company_id),
  CONSTRAINT share_register_events_class_fk
    FOREIGN KEY (share_class_id, company_id) REFERENCES public.share_classes(id, company_id),
  CONSTRAINT share_register_events_to_class_fk
    FOREIGN KEY (to_share_class_id, company_id) REFERENCES public.share_classes(id, company_id),
  CONSTRAINT share_register_events_from_party_fk
    FOREIGN KEY (from_party_id, company_id) REFERENCES public.parties(id, company_id),
  CONSTRAINT share_register_events_to_party_fk
    FOREIGN KEY (to_party_id, company_id) REFERENCES public.parties(id, company_id),
  CONSTRAINT share_register_events_counterparty_fk
    FOREIGN KEY (counterparty_party_id, company_id) REFERENCES public.parties(id, company_id),
  CONSTRAINT share_register_events_corrects_fk
    FOREIGN KEY (corrects_event_id, company_id) REFERENCES public.share_register_events(id, company_id),
  CHECK (range_end IS NULL OR (range_start IS NOT NULL AND range_end >= range_start)),
  -- The shape each kind needs.
  CONSTRAINT share_register_events_shape CHECK (
    CASE kind
      WHEN 'bildande' THEN to_party_id IS NOT NULL AND share_class_id IS NOT NULL AND range_end IS NOT NULL AND from_party_id IS NULL
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
  )
);

COMMENT ON TABLE public.share_register_events IS
  'The aktiebok (ABL 5 kap.): every dated entry in sequence. Append-only (ABL 5:3); a rattelse event voids an earlier one. Holdings on a date: share_register_state(company, as_of).';

CREATE INDEX IF NOT EXISTS idx_share_register_events_company_date
  ON public.share_register_events (company_id, event_date, event_number);
-- An event is voided at most once.
CREATE UNIQUE INDEX IF NOT EXISTS share_register_events_corrects_once
  ON public.share_register_events (corrects_event_id) WHERE corrects_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_share_register_events_to_party ON public.share_register_events (to_party_id) WHERE to_party_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_share_register_events_from_party ON public.share_register_events (from_party_id) WHERE from_party_id IS NOT NULL;

-- A holding: one range of share numbers of one class held by one party.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE n.nspname = 'public' AND t.typname = 'share_register_range') THEN
    CREATE TYPE public.share_register_range AS (
      share_class_id uuid,
      party_id uuid,
      range_start bigint,
      range_end bigint
    );
  END IF;
END;
$$;

-- Numbering in sequence per company, under a per-company lock.
CREATE OR REPLACE FUNCTION public.share_register_events_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_avstamning boolean;
  v_target public.share_register_events%ROWTYPE;
BEGIN
  SELECT s.is_avstamningsbolag INTO v_avstamning
    FROM public.share_register_settings s WHERE s.company_id = NEW.company_id;
  IF coalesce(v_avstamning, false) THEN
    RAISE EXCEPTION 'SHARE_REGISTER_AVSTAMNINGSBOLAG: the central securities depository keeps the aktiebok of an avstämningsbolag'
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
  SELECT coalesce(max(e.event_number), 0) + 1 INTO NEW.event_number
    FROM public.share_register_events e WHERE e.company_id = NEW.company_id;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.share_register_events_number() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.share_register_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- An entry leaves only with its company (the cascade runs at trigger
  -- depth > 1) or under the operator and sandbox-teardown override.
  IF TG_OP = 'DELETE'
     AND (pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SHARE_REGISTER_APPEND_ONLY: the aktiebok is append-only (% refused); correct with a rattelse entry', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.share_register_events_append_only() FROM PUBLIC, anon, authenticated;

-- The holdings after replaying every entry that is not voided, up to and
-- including p_as_of (NULL: all of them), in date and entry order. Raises on
-- the first entry the history cannot hold. SECURITY INVOKER: RLS limits a
-- member to their own companies.
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
       AND e.kind IN ('bildande', 'nyemission', 'fondemission', 'overlatelse', 'indragning', 'omvandling', 'split', 'sammanlaggning')
       AND (p_as_of IS NULL OR e.event_date <= p_as_of)
       AND NOT EXISTS (
         SELECT 1 FROM public.share_register_events c
          WHERE c.company_id = e.company_id AND c.kind = 'rattelse' AND c.corrects_event_id = e.id)
     ORDER BY e.event_date, e.event_number
  LOOP
    IF ev.kind IN ('bildande', 'nyemission', 'fondemission') THEN
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

-- The holdings on a date with adjacent ranges of the same holder and class
-- joined: the aktiebok as of p_as_of (ABL 5:10, 7:28).
CREATE OR REPLACE FUNCTION public.share_register_state(p_company_id uuid, p_as_of date DEFAULT NULL)
RETURNS TABLE (share_class_id uuid, party_id uuid, range_start bigint, range_end bigint, share_count bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH ranges AS (
    SELECT s.share_class_id, s.party_id, s.range_start, s.range_end,
           CASE WHEN lag(s.range_end) OVER w = s.range_start - 1
                 AND lag(s.party_id) OVER w = s.party_id
                 AND lag(s.share_class_id) OVER w = s.share_class_id
                THEN 0 ELSE 1 END AS starts_group
      FROM public.share_register_replay(p_company_id, p_as_of) s
    WINDOW w AS (ORDER BY s.range_start)
  ), grouped AS (
    SELECT r.*, sum(r.starts_group) OVER (ORDER BY r.range_start) AS grp FROM ranges r
  )
  SELECT g.share_class_id, g.party_id, min(g.range_start), max(g.range_end), max(g.range_end) - min(g.range_start) + 1
    FROM grouped g
   GROUP BY g.grp, g.share_class_id, g.party_id
   ORDER BY min(g.range_start);
$$;

REVOKE ALL ON FUNCTION public.share_register_state(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.share_register_state(uuid, date) TO authenticated, service_role;

-- Deferred to commit, so a rattelse and the corrected entry inserted
-- together are judged together: the whole history must still hold.
CREATE OR REPLACE FUNCTION public.share_register_events_validate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM count(*) FROM public.share_register_replay(NEW.company_id, NULL);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.share_register_events_validate() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.share_register_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.share_register_events TO service_role;
GRANT SELECT, INSERT ON TABLE public.share_register_events TO authenticated;
-- no-grant: anon on public.share_register_events (company data)

DROP POLICY IF EXISTS "view own-company share_register_events" ON public.share_register_events;
CREATE POLICY "view own-company share_register_events"
  ON public.share_register_events FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company share_register_events" ON public.share_register_events;
CREATE POLICY "insert own-company share_register_events"
  ON public.share_register_events FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.share_register_events;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.share_register_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS share_register_events_block_migration_reset_source_mutation ON public.share_register_events;
CREATE TRIGGER share_register_events_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.share_register_events
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS share_register_events_number ON public.share_register_events;
CREATE TRIGGER share_register_events_number
  BEFORE INSERT ON public.share_register_events
  FOR EACH ROW EXECUTE FUNCTION public.share_register_events_number();
DROP TRIGGER IF EXISTS share_register_events_append_only ON public.share_register_events;
CREATE TRIGGER share_register_events_append_only
  BEFORE UPDATE OR DELETE ON public.share_register_events
  FOR EACH ROW EXECUTE FUNCTION public.share_register_events_append_only();
DROP TRIGGER IF EXISTS share_register_events_validate ON public.share_register_events;
CREATE CONSTRAINT TRIGGER share_register_events_validate
  AFTER INSERT ON public.share_register_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.share_register_events_validate();
DROP TRIGGER IF EXISTS audit_share_register_events ON public.share_register_events;
CREATE TRIGGER audit_share_register_events
  AFTER INSERT OR UPDATE OR DELETE ON public.share_register_events
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 8. beneficial_owner_assessments (LRVH 2:1)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.beneficial_owner_assessments (
  id                       uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  assessed_on              date NOT NULL,
  -- What the investigation rested on, e.g. "aktiebok per 2026-10-29".
  basis                    text NOT NULL CHECK (length(btrim(basis)) BETWEEN 1 AND 2000),
  conclusion               text NOT NULL CHECK (conclusion IN ('owners_identified', 'no_beneficial_owner')),
  -- [{ party_id, name, extent, votes_pct, capital_pct, control }]: names only, never a personnummer.
  owners                   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(owners) = 'array'),
  -- LRVH 1:5: close family holdings counted together.
  family_aggregation_checked boolean NOT NULL DEFAULT false,
  family_note              text CHECK (family_note IS NULL OR length(family_note) <= 2000),
  -- LRVH 1:3-4: control by agreement, articles or board appointment rights.
  control_agreements       boolean NOT NULL DEFAULT false,
  control_note             text CHECK (control_note IS NULL OR length(control_note) <= 2000),
  -- Whether the confirmed set differs from the previous assessment (a filing is due, LRVH 2:3).
  changed                  boolean NOT NULL DEFAULT true,
  assessed_by              uuid REFERENCES auth.users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (conclusion = 'owners_identified' OR jsonb_array_length(owners) = 0)
);

COMMENT ON TABLE public.beneficial_owner_assessments IS
  'The documented investigation of who the verkliga huvudmän are (LRVH 2:1): date, basis, conclusion, who. Append-only; kept at least five years after a change.';

CREATE INDEX IF NOT EXISTS idx_beneficial_owner_assessments_company
  ON public.beneficial_owner_assessments (company_id, assessed_on DESC, created_at DESC);

CREATE OR REPLACE FUNCTION public.beneficial_owner_assessments_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND (pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'BENEFICIAL_OWNER_APPEND_ONLY: an assessment is kept as made (% refused)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.beneficial_owner_assessments_append_only() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.beneficial_owner_assessments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.beneficial_owner_assessments TO service_role;
GRANT SELECT, INSERT ON TABLE public.beneficial_owner_assessments TO authenticated;
-- no-grant: anon on public.beneficial_owner_assessments (company data)

DROP POLICY IF EXISTS "view own-company beneficial_owner_assessments" ON public.beneficial_owner_assessments;
CREATE POLICY "view own-company beneficial_owner_assessments"
  ON public.beneficial_owner_assessments FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company beneficial_owner_assessments" ON public.beneficial_owner_assessments;
CREATE POLICY "insert own-company beneficial_owner_assessments"
  ON public.beneficial_owner_assessments FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.beneficial_owner_assessments;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.beneficial_owner_assessments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS beneficial_owner_assessments_block_migration_reset_source_mutation ON public.beneficial_owner_assessments;
CREATE TRIGGER beneficial_owner_assessments_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.beneficial_owner_assessments
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS beneficial_owner_assessments_append_only ON public.beneficial_owner_assessments;
CREATE TRIGGER beneficial_owner_assessments_append_only
  BEFORE UPDATE OR DELETE ON public.beneficial_owner_assessments
  FOR EACH ROW EXECUTE FUNCTION public.beneficial_owner_assessments_append_only();
DROP TRIGGER IF EXISTS audit_beneficial_owner_assessments ON public.beneficial_owner_assessments;
CREATE TRIGGER audit_beneficial_owner_assessments
  AFTER INSERT OR UPDATE OR DELETE ON public.beneficial_owner_assessments
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 9. pending_operations.operation_type: the Bolaget staged writes
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
    'register_share_event', 'create_share_class', 'update_share_class',
    'add_company_role', 'end_company_role', 'set_signatory_rule', 'confirm_beneficial_owners'
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
