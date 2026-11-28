-- Follow a verifikat to the request that wrote it, and a rule to the version
-- that proposed a booking.
--
-- 1. audit_log.trace_id
--
-- The request trace id (migration 20261109090000) is on the rows a staged
-- write leaves behind: pending_operations, business_events and
-- suggestion_log. It is not on the row-level history: audit_log, which every
-- audited table writes through its triggers, journal_entries included (an
-- INSERT when a verifikat is created, an UPDATE when it is committed). With
-- the trace id there, a verifikat leads to the request that created it and
-- the one that committed it, and through them to the proposal, the decision
-- receipt, the tool call and every other audited row those requests wrote.
-- No column is added to journal_entries: its own audit rows carry the trace.
--
-- The triggers cannot see the application's trace scope, so the trace travels
-- the way the actor does (20261031202000): every PostgREST request a server
-- client makes inside a trace scope carries it in one header,
-- x-accounted-trace (src/lib/supabase/trace-header.ts), and PostgREST hands
-- request headers to the transaction as request.headers.
-- public.request_trace_id() reads it, and it is the column's default, so
-- every audit writer (write_audit_log and the tables' own audit functions,
-- which all name their columns) fills it without being changed.
--
-- Trust: the trace id is a correlation hint, never an identity or an
-- authorization input (as in 20261109090000), so it is read on any role's
-- request, unlike the actor header. Only a value of the trace id's form is
-- taken (32 lowercase hex); anything else is NULL. The value is matched in
-- the header JSON's text, with no parse: no exception block, so no
-- subtransaction per audit row. A quote inside another header's value is
-- escaped in that JSON, so only the real key matches.
--
-- 2. categorization_templates.version
--
-- A rule (a counterparty template) changes in place: a correction rewrites
-- its accounts and moms. version counts the changes to what the rule books,
-- so a suggestion can record the version that offered it and a track record
-- can be read per version. A BEFORE UPDATE trigger owns it: it goes up by one
-- when a column outside the rule's state and learning counters changes, and
-- is otherwise kept, whatever the writer sent. The state and counters are
-- listed, not the content: a column added later counts as content, so a new
-- field can only bump a version too often, never leave two different rules
-- under one version. Alias growth, hit counts, the ladder (mode, paused_at,
-- is_active), always_review and the origin (source) are not a new version:
-- the ladder decides who must say yes, not what is booked. Each change's
-- before and after is in audit_log already (audit_categorization_templates_update).
--
-- Locks and deploy order:
--   * ADD COLUMN without a default, SET DEFAULT on an existing column and a
--     NOT VALID CHECK are catalogue changes: audit_log, the largest table,
--     is neither rewritten nor scanned. Every existing row is NULL.
--   * No index on audit_log.trace_id: a build would scan the heap under a
--     lock that blocks every audited write. One verifikat's rows are found by
--     (table_name, record_id); a request's other rows by created_at and trace.
--   * ADD COLUMN version with a constant default is a catalogue change too;
--     categorization_templates is small, so its CHECK is validated at once.
--   * lock_timeout fails the job fast instead of queueing every audited write
--     behind a long transaction; re-running the job retries.
--   * The code may go live first: until this runs, PostgREST ignores the
--     header and the matcher's select('*') has no version to read.
--
-- pg-test: tests/pg/audit-trace-and-rule-versions.pg.test.ts
-- PostgREST end to end: tests/tool-pg/audit-trace-header.tool.test.ts

SELECT set_config('lock_timeout', '3s', true);

-- =============================================================================
-- 1. public.request_trace_id(): the trace of the request a statement runs in
-- =============================================================================

CREATE OR REPLACE FUNCTION public.request_trace_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT substring(
    current_setting('request.headers', true)
    FROM '"x-accounted-trace"\s*:\s*"([0-9a-f]{32})"'
  )
$function$;

COMMENT ON FUNCTION public.request_trace_id() IS
  'The W3C trace-id (32 lowercase hex) of the PostgREST request a statement runs in, from its x-accounted-trace header (src/lib/supabase/trace-header.ts). NULL outside a request, without the header, or when the value is not a trace-id. A correlation hint, never an identity. The default of audit_log.trace_id.';

REVOKE ALL ON FUNCTION public.request_trace_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_trace_id() TO authenticated, service_role;

-- =============================================================================
-- 2. audit_log.trace_id
-- =============================================================================

ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS trace_id text;

DO $$
BEGIN
  ALTER TABLE public.audit_log
    ADD CONSTRAINT audit_log_trace_id_format
      CHECK (trace_id ~ '^[0-9a-f]{32}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$$;

ALTER TABLE public.audit_log
  ALTER COLUMN trace_id SET DEFAULT public.request_trace_id();

COMMENT ON COLUMN public.audit_log.trace_id IS
  'W3C trace-id (32 lowercase hex) of the request whose statement wrote the row, from public.request_trace_id(). NULL outside a request scope, for a client that does not send the header, and on rows written before it was recorded.';

-- =============================================================================
-- 3. categorization_templates.version
-- =============================================================================

ALTER TABLE public.categorization_templates
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  ALTER TABLE public.categorization_templates
    ADD CONSTRAINT categorization_templates_version_check CHECK (version >= 1);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END;
$$;

COMMENT ON COLUMN public.categorization_templates.version IS
  'How many times what the rule books has changed, from 1. Raised by categorization_templates_bump_version() when a column other than its state and learning counters changes; never written by a caller.';

CREATE OR REPLACE FUNCTION public.categorization_templates_bump_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  -- The rule's state and learning counters: changing them is not a new
  -- version. Everything else is what the rule books.
  v_state constant text[] := ARRAY[
    'version',
    'updated_at',
    'created_at',
    'user_id',
    'counterparty_aliases',
    'occurrence_count',
    'confidence',
    'last_seen_date',
    'corrections',
    'source',
    'is_active',
    'mode',
    'paused_at',
    'always_review'
  ];
BEGIN
  IF (to_jsonb(NEW) - v_state) IS DISTINCT FROM (to_jsonb(OLD) - v_state) THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.categorization_templates_bump_version() IS
  'BEFORE UPDATE on categorization_templates: version + 1 when what the rule books changes (any column outside its state and learning counters), otherwise the version it had.';

-- Named to fire after the other BEFORE UPDATE triggers (alphabetical), so it
-- compares the row as they leave it.
DROP TRIGGER IF EXISTS trg_categorization_templates_version ON public.categorization_templates;
CREATE TRIGGER trg_categorization_templates_version
  BEFORE UPDATE ON public.categorization_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.categorization_templates_bump_version();

NOTIFY pgrst, 'reload schema';
