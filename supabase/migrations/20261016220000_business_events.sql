-- Business events: what happened in business terms, next to the verifikat it
-- produced (posting port, step 1 of Phase 2 of the building-blocks plan).
-- pg-test: tests/pg/business-events.pg.test.ts
--
-- WHY
-- ---
-- A verifikat says which BAS accounts moved. It does not say, in terms an
-- agent, a partner or another country's pack can read without the chart of
-- accounts, what the business did: "a bank line was categorized as software",
-- "a supplier invoice was registered". It also does not say which version of
-- the automatic booking rule produced its lines, which BFNAR 2013:2 p. 9.16
-- asks the behandlingshistorik to date. The posting port (src/lib/posting)
-- records one business event per business act and links it to the
-- verifikat(s) it produced.
--
-- WHAT
-- ----
-- 1. public.business_events: one row per business act, written by the port
--    BEFORE the engine drafts the verifikat. The id is made by the port (no
--    default), so a retried write of the same event is the same row.
--      kind             a closed list in code (src/lib/posting/kinds.ts),
--                       derived from journal_entries.source_type; the
--                       database checks the shape only, so a new kind needs
--                       no migration.
--      category         a closed, add-only list of neutral keys in code
--                       (src/lib/posting/categories.ts); Sweden-only keys
--                       carry the se. prefix. Shape-checked here.
--      subject          the producer's own record as type + id (a typed
--                       handle's parts: 'transaction', uuid).
--      party            type + id only, never a name or a personnummer, so
--                       GDPR erasure stays with the party tables.
--      amounts          currency, amount and amount_sek as magnitudes (never
--                       negative), tax_amounts (jsonb).
--      evidence         what the producer saw (document, link basis, the
--                       rule it used), a closed shape in code, at most 2000
--                       bytes like link_evidence.
--      receipt_id       the decision receipt (suggestion_log row) when the
--                       producer has one at posting time. No foreign key: a
--                       SET NULL cascade would update this append-only row
--                       and RESTRICT would block the deletes suggestion_log
--                       allows.
--      pending_operation_id  the staged operation whose approval posted it.
--                       No foreign key, for the same reason.
--      actor            type and credential label, the vocabulary of
--                       journal_entries.committed_actor_*; a person has no
--                       label, so no name is stored.
--      mapping_version  the rule source and version that produced the lines.
--      jurisdiction     ISO 3166-1 alpha-2, 'SE' today.
--      idempotency_key  unique per company when set (one event per import
--                       job, later); NULLs never collide.
-- 2. public.business_event_entries: the many-to-many link to journal_entries
--    with a role. A salary run is one event with several verifikat; a bulk
--    booking is many bank lines in one verifikat. The engine writes the link
--    right after the draft header and BEFORE commit_journal_entry draws a
--    voucher number, so a failure costs no number. A trigger accepts a link
--    only to a DRAFT verifikat of the same company as the event: an event is
--    never attached to a posted verifikat afterwards, which is what "history
--    is never touched, no backfill" means in the database.
--
-- Nothing here touches journal_entries, journal_entry_lines, voucher
-- numbering (commit_journal_entry) or the migration 017 triggers. No column
-- is added to journal_entries.
--
-- LIFECYCLE
-- ---------
-- * Append-only: UPDATE is always refused. DELETE passes only through a
--   foreign-key cascade (trigger depth > 1) or under gnubok.allow_delete (the
--   operator and sandbox-teardown override), as suggestion_log and
--   agi_kvittenser. An event goes only with its company; a link goes with its
--   event, its verifikat (a draft deleted, a sandbox torn down) or its
--   company. A company holding bookkeeping cannot be deleted inside the BFL
--   retention period (enforce_retention_journal_entries), so neither can its
--   events: they are kept at least as long as the verifikat they explain
--   (BFL 7 kap.).
-- * No audit trigger: like the other append-only logs, the row is the record.
-- * Read-side projection for history: entries posted before the port (and by
--   producers not moved yet) have no event; src/lib/posting/project.ts
--   answers "what kind of event was this?" from their source_type instead.
--
-- DEPLOY ORDER
-- ------------
-- Safe either way. The port is off by default (POSTING_EVENTS unset), and in
-- shadow or strict mode a missing table (42P01 / PGRST205) is skipped, so
-- code may reach production before this migration.

-- business_event_entries references journal_entries: the foreign key takes a
-- SHARE ROW EXCLUSIVE lock on that hot table. Fail the migration job instead
-- of queueing every posting behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. business_events
-- =============================================================================

CREATE TABLE public.business_events (
  id                   uuid PRIMARY KEY,
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind                 text NOT NULL
    CONSTRAINT business_events_kind_check
    CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(kind) <= 64),
  category             text
    CONSTRAINT business_events_category_check
    CHECK (category IS NULL OR (category ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND length(category) <= 64)),
  occurred_on          date NOT NULL,
  subject_type         text
    CONSTRAINT business_events_subject_type_check
    CHECK (subject_type IS NULL OR (subject_type ~ '^[a-z][a-z_]*$' AND length(subject_type) <= 40)),
  subject_id           uuid,
  party_type           text
    CONSTRAINT business_events_party_type_check
    CHECK (party_type IS NULL OR party_type IN ('customer', 'supplier', 'employee', 'party')),
  party_id             uuid,
  currency             text
    CONSTRAINT business_events_currency_check
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  amount               numeric(18, 2),
  amount_sek           numeric(18, 2),
  tax_amounts          jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,
  receipt_id           uuid,
  pending_operation_id uuid,
  actor_type           text
    CONSTRAINT business_events_actor_type_check
    CHECK (actor_type IS NULL OR actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account')),
  actor_label          text
    CONSTRAINT business_events_actor_label_check
    CHECK (actor_label IS NULL OR length(actor_label) <= 200),
  mapping_version      text
    CONSTRAINT business_events_mapping_version_check
    CHECK (mapping_version IS NULL OR length(mapping_version) BETWEEN 1 AND 200),
  jurisdiction         text NOT NULL DEFAULT 'SE'
    CONSTRAINT business_events_jurisdiction_check
    CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  idempotency_key      text
    CONSTRAINT business_events_idempotency_key_check
    CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_events_subject_pair CHECK ((subject_type IS NULL) = (subject_id IS NULL)),
  CONSTRAINT business_events_party_pair CHECK ((party_type IS NULL) = (party_id IS NULL)),
  CONSTRAINT business_events_amount_currency CHECK (amount IS NULL OR currency IS NOT NULL),
  -- Magnitudes: which way the money went is the kind's (and the evidence's)
  -- to say, so a sign never has to be interpreted per kind.
  CONSTRAINT business_events_amounts_non_negative CHECK (
    (amount IS NULL OR amount >= 0) AND (amount_sek IS NULL OR amount_sek >= 0)
  ),
  -- CASE fixes the evaluation order, so octet_length never reads a non-array.
  CONSTRAINT business_events_tax_amounts_check CHECK (
    CASE WHEN jsonb_typeof(tax_amounts) <> 'array' THEN false ELSE octet_length(tax_amounts::text) <= 2000 END
  ),
  CONSTRAINT business_events_evidence_check CHECK (
    CASE WHEN jsonb_typeof(evidence) <> 'object' THEN false ELSE octet_length(evidence::text) <= 2000 END
  ),
  -- NULLs are distinct: only a set key is unique within its company.
  CONSTRAINT business_events_company_idempotency_key UNIQUE (company_id, idempotency_key)
);

COMMENT ON TABLE public.business_events IS
  'One row per business act a posting came from (posting port, src/lib/posting): kind, category, subject, party (type and id only), amounts, evidence and the rule version that produced the lines. Linked to its verifikat through business_event_entries. Append-only; written before the verifikat is drafted; no backfill of history.';
COMMENT ON COLUMN public.business_events.id IS
  'Made by the posting port before the write, so a retried write of the same event is the same row.';
COMMENT ON COLUMN public.business_events.kind IS
  'What happened, from the closed list in src/lib/posting/kinds.ts (e.g. bank.categorized). The database checks the shape only.';
COMMENT ON COLUMN public.business_events.category IS
  'A neutral category key from the closed, add-only list in src/lib/posting/categories.ts (e.g. expense.software); se. prefixes a Sweden-only key.';
COMMENT ON COLUMN public.business_events.party_type IS
  'The counterparty''s record type; with party_id the only party data kept here, never a name or a personnummer.';
COMMENT ON COLUMN public.business_events.evidence IS
  'What the producer saw, a closed shape in src/lib/posting/evidence.ts (document, link basis, rule, proposal); at most 2000 bytes.';
COMMENT ON COLUMN public.business_events.mapping_version IS
  'The rule source and version that produced the verifikat lines, e.g. se.category-mapping@bank-proposals.1+<build>; dates automatic booking rules for the behandlingshistorik (BFNAR 2013:2 p. 9.16).';
COMMENT ON COLUMN public.business_events.receipt_id IS
  'The decision receipt (suggestion_log row) behind the posting, when it exists at posting time. No foreign key: the row is append-only.';
COMMENT ON COLUMN public.business_events.pending_operation_id IS
  'The staged operation whose approval posted it. No foreign key: the row is append-only.';

CREATE INDEX idx_business_events_company_occurred
  ON public.business_events (company_id, occurred_on DESC);
CREATE INDEX idx_business_events_company_kind
  ON public.business_events (company_id, kind);
CREATE INDEX idx_business_events_subject
  ON public.business_events (subject_id) WHERE subject_id IS NOT NULL;

ALTER TABLE public.business_events ENABLE ROW LEVEL SECURITY;

-- Rows are inserted, never changed: nobody gets UPDATE. service_role keeps
-- DELETE for the gnubok.allow_delete path; members read and record.
GRANT SELECT, INSERT, DELETE ON TABLE public.business_events TO service_role;
GRANT SELECT, INSERT ON TABLE public.business_events TO authenticated;
-- no-grant: anon on public.business_events (company bookkeeping: members and the service role only)

CREATE POLICY "view own-company business_events"
  ON public.business_events FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "record own-company business_events"
  ON public.business_events FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
  );

-- =============================================================================
-- 2. business_event_entries
-- =============================================================================

CREATE TABLE public.business_event_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_event_id uuid NOT NULL REFERENCES public.business_events(id) ON DELETE CASCADE,
  journal_entry_id  uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  role              text NOT NULL DEFAULT 'produced'
    CONSTRAINT business_event_entries_role_check
    CHECK (role IN ('produced', 'reversal', 'correction')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_event_entries_event_entry UNIQUE (business_event_id, journal_entry_id)
);

COMMENT ON TABLE public.business_event_entries IS
  'Which verifikat a business event produced (role produced), reversed (reversal) or corrected (correction). Many to many. Written by the engine right after the draft header, before a voucher number is drawn; a link to a posted verifikat is refused. Append-only.';

-- The cascades from journal_entries and the verifikat-side reads look rows up
-- by journal_entry_id; the company index serves RLS and the archive dump.
CREATE INDEX idx_business_event_entries_journal_entry
  ON public.business_event_entries (journal_entry_id);
CREATE INDEX idx_business_event_entries_company
  ON public.business_event_entries (company_id);

ALTER TABLE public.business_event_entries ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON TABLE public.business_event_entries TO service_role;
GRANT SELECT, INSERT ON TABLE public.business_event_entries TO authenticated;
-- no-grant: anon on public.business_event_entries (company bookkeeping: members and the service role only)

CREATE POLICY "view own-company business_event_entries"
  ON public.business_event_entries FOR SELECT
  TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "record own-company business_event_entries"
  ON public.business_event_entries FOR INSERT
  TO authenticated
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
  );

-- A link joins an event and a DRAFT verifikat of one company. Read with the
-- caller's own rights: a member reads their company's rows, the service role
-- reads every row, so a row the caller cannot see is a refusal.
CREATE FUNCTION public.business_event_entries_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_event_company uuid;
  v_entry_company uuid;
  v_entry_status  text;
BEGIN
  SELECT company_id INTO v_event_company
    FROM public.business_events
   WHERE id = NEW.business_event_id;
  IF v_event_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_LINK_COMPANY_MISMATCH: business event % does not belong to company %',
      NEW.business_event_id, NEW.company_id
      USING ERRCODE = '23514';
  END IF;

  SELECT company_id, status INTO v_entry_company, v_entry_status
    FROM public.journal_entries
   WHERE id = NEW.journal_entry_id;
  IF v_entry_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_LINK_COMPANY_MISMATCH: journal entry % does not belong to company %',
      NEW.journal_entry_id, NEW.company_id
      USING ERRCODE = '23514';
  END IF;

  -- Linked while it is drafted, never afterwards: history keeps no event it
  -- did not have when it was posted.
  IF v_entry_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'BUSINESS_EVENT_LINK_NOT_DRAFT: journal entry % is %, an event links only to a draft verifikat',
      NEW.journal_entry_id, v_entry_status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.business_event_entries_guard() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 3. Append-only, writer role, archived migration-reset sources
-- =============================================================================

CREATE FUNCTION public.business_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- A row leaves only with what it describes: the foreign-key cascade from its
  -- company (and, for a link, its event or verifikat) runs at trigger depth
  -- > 1. gnubok.allow_delete is the operator and sandbox-teardown override
  -- used across the schema. UPDATE has no exception: an event is recorded once.
  IF TG_OP = 'DELETE'
     AND (pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true') THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.business_events_append_only() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.business_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- Archived migration-reset source companies are static (20260818084050).
CREATE TRIGGER business_events_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.business_events
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE TRIGGER business_events_append_only
  BEFORE UPDATE OR DELETE ON public.business_events
  FOR EACH ROW EXECUTE FUNCTION public.business_events_append_only();

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.business_event_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE TRIGGER business_event_entries_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.business_event_entries
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE TRIGGER business_event_entries_guard
  BEFORE INSERT ON public.business_event_entries
  FOR EACH ROW EXECUTE FUNCTION public.business_event_entries_guard();

CREATE TRIGGER business_event_entries_append_only
  BEFORE UPDATE OR DELETE ON public.business_event_entries
  FOR EACH ROW EXECUTE FUNCTION public.business_events_append_only();

NOTIFY pgrst, 'reload schema';
