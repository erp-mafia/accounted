-- Arrivals: one row per delivery into a company, whatever the door.
--
-- pg-test: tests/pg/intake-arrivals.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts,
--          tests/pg/full-archive-coverage.pg.test.ts
--
-- An arrival records HOW something came in: the mail, the chat message, the
-- e-invoice, the upload, the provider payload. It keeps the original exactly
-- as it came (original_path points at the bytes in the documents bucket, or
-- at the document that already holds them, as for a Peppol XML) and who
-- fetched it (fetched_by, shaped to become the actor record later:
-- {type: 'user'|'api_key'|'mcp_oauth'|'cron'|'system'|'webhook', user_id?,
-- api_key_id?, label?}). arrival_outputs links an arrival to what it
-- produced: documents, inbox items, transactions, journal entries.
--
-- `source` is deliberately unconstrained here: the vocabulary lives in code
-- (src/lib/intake/sources.ts), so a new door needs no migration.
-- (company_id, source, source_ref) is the idempotency key: a redelivered
-- webhook or a re-run sync finds its row instead of writing a second one.
--
-- Append-only. The original is räkenskapsinformation under the same seven
-- year retention as the underlag it produced (BFL 7 kap 2 §), so no row is
-- ever changed and none is deleted while its company exists. Deleting the
-- company itself (the sandbox teardown, a company the user removes) takes
-- its arrivals with it, as it takes every other company row. GDPR erasure of
-- sender data inside arrivals is out of scope for this migration.
--
-- Writes: server code with the member's own client (uploads) and the
-- service role (webhooks, crons, MCP, v1). Members read their companies'
-- rows. Nobody but the service role updates or deletes, and the trigger
-- refuses even the service role.

-- =============================================================================
-- 1. arrivals
-- =============================================================================

CREATE TABLE public.arrivals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source          text NOT NULL,
  source_ref      text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 512),
  received_at     timestamptz NOT NULL,
  sender          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sender) = 'object'),
  subject         text,
  message_text    text,
  original_path   text,
  original_sha256 text CHECK (original_sha256 IS NULL OR original_sha256 ~ '^[0-9a-f]{64}$'),
  original_mime   text,
  original_size   bigint CHECK (original_size IS NULL OR original_size >= 0),
  fetched_by      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fetched_by) = 'object'),
  source_meta     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_meta) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arrivals_company_source_ref_key UNIQUE (company_id, source, source_ref),
  -- Target of arrival_outputs' composite foreign key: an output always
  -- belongs to its arrival's company.
  CONSTRAINT arrivals_id_company_key UNIQUE (id, company_id),
  -- No original metadata without the original itself.
  CONSTRAINT arrivals_original_consistent CHECK (
    original_path IS NOT NULL
    OR (original_sha256 IS NULL AND original_mime IS NULL AND original_size IS NULL)
  )
);

COMMENT ON TABLE public.arrivals IS
  'One row per delivery into a company (mail, chat message, e-invoice, upload, provider payload), with the original kept as it came. Append-only.';

CREATE INDEX idx_arrivals_company_received
  ON public.arrivals (company_id, received_at DESC);

ALTER TABLE public.arrivals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company arrivals"
  ON public.arrivals FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "insert own-company arrivals"
  ON public.arrivals FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

-- No UPDATE and no DELETE policy: append-only.
GRANT SELECT, INSERT ON TABLE public.arrivals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arrivals TO service_role;
-- no-grant: anon on public.arrivals (company data)

-- =============================================================================
-- 2. arrival_outputs
-- =============================================================================

CREATE TABLE public.arrival_outputs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  arrival_id   uuid NOT NULL,
  company_id   uuid NOT NULL,
  output_kind  text NOT NULL
    CHECK (output_kind IN ('document', 'inbox_item', 'transaction', 'journal_entry')),
  output_id    uuid NOT NULL,
  role         text NOT NULL
    CHECK (role IN ('attachment', 'body', 'xml', 'rendering', 'row', 'entry')),
  position     integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The company comes from the arrival, never from the caller: the composite
  -- key makes a cross-company output impossible. Deleting the company
  -- removes its arrivals, which removes their outputs.
  CONSTRAINT arrival_outputs_arrival_fkey
    FOREIGN KEY (arrival_id, company_id)
    REFERENCES public.arrivals (id, company_id) ON DELETE CASCADE,
  CONSTRAINT arrival_outputs_unique UNIQUE (arrival_id, output_kind, output_id)
);

COMMENT ON TABLE public.arrival_outputs IS
  'What an arrival produced: documents, inbox items, transactions, journal entries. output_id is polymorphic (no foreign key). Append-only.';

-- "Which arrivals produced this document?" (Kom även via, Visa originalet).
CREATE INDEX idx_arrival_outputs_company_output
  ON public.arrival_outputs (company_id, output_kind, output_id);

ALTER TABLE public.arrival_outputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company arrival_outputs"
  ON public.arrival_outputs FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "insert own-company arrival_outputs"
  ON public.arrival_outputs FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT, INSERT ON TABLE public.arrival_outputs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arrival_outputs TO service_role;
-- no-grant: anon on public.arrival_outputs (company data)

-- =============================================================================
-- 3. Append-only guards
-- =============================================================================
-- UPDATE never. DELETE only once the owner is gone: an arrival when its
-- company row no longer exists (the companies cascade, which runs after the
-- company row is deleted and therefore no longer sees it), an output when its
-- arrival no longer exists. SECURITY DEFINER so the existence check reads
-- the row whatever the caller's RLS shows.

CREATE OR REPLACE FUNCTION public.arrivals_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'arrivals is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER arrivals_append_only
  BEFORE UPDATE OR DELETE ON public.arrivals
  FOR EACH ROW EXECUTE FUNCTION public.arrivals_append_only();

CREATE OR REPLACE FUNCTION public.arrival_outputs_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM public.arrivals a WHERE a.id = OLD.arrival_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'arrival_outputs is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER arrival_outputs_append_only
  BEFORE UPDATE OR DELETE ON public.arrival_outputs
  FOR EACH ROW EXECUTE FUNCTION public.arrival_outputs_append_only();

REVOKE ALL ON FUNCTION public.arrivals_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.arrival_outputs_append_only() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
