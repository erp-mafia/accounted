-- Arkiv phase 3 (dev_docs/arkiv_plan.md): typed extraction with provenance,
-- and a job queue so no model call runs on an upload's request path.
--
-- Provenance follows the W3C PROV shape: an agent (a person, or a software
-- version) runs an activity (one extract or review run, with its models and
-- prompt hash) that produces an extraction. Extractions are versioned and
-- never overwritten: a rerun or a person's correction inserts a new current
-- row that supersedes the previous one, in one transaction.
--
-- The queue is a table claimed with FOR UPDATE SKIP LOCKED, the pattern of
-- claim_due_webhook_deliveries (pgmq is not used anywhere in the schema).

-- ---------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------
CREATE TABLE public.agents (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind text NOT NULL CHECK (kind IN ('human', 'software')),
  name text NOT NULL,
  version text,
  user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name, version),
  CHECK (kind = 'human' OR version IS NOT NULL)
);
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
-- Software agents are public knowledge; a person's agent row is visible to that person only.
CREATE POLICY "view software agents and your own"
  ON public.agents FOR SELECT TO authenticated
  USING (kind = 'software' OR user_id = (SELECT auth.uid()));

CREATE TABLE public.activities (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id uuid REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id),
  kind text NOT NULL CHECK (kind IN ('extract', 'review')),
  schema_type text,
  schema_version integer,
  model_ids text[] NOT NULL DEFAULT '{}',
  prompt_sha256 text,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  -- settled: nothing left for a person; review: fields wait for a person
  outcome text NOT NULL CHECK (outcome IN ('settled', 'review')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_activities_document ON public.activities (document_id, started_at DESC);
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company activities"
  ON public.activities FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- ---------------------------------------------------------------------------
-- Schema registry and extractions
-- ---------------------------------------------------------------------------
-- Registered by the extractor on first use of a version; the TypeScript
-- definitions in lib/documents/extract/schemas.ts are the source.
CREATE TABLE public.extraction_schemas (
  schema_type text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  json_schema jsonb NOT NULL,
  field_kinds jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schema_type, version)
);
ALTER TABLE public.extraction_schemas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view extraction schemas"
  ON public.extraction_schemas FOR SELECT TO authenticated
  USING (true);

CREATE TABLE public.document_extractions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES public.activities(id) ON DELETE CASCADE,
  schema_type text NOT NULL,
  schema_version integer NOT NULL,
  -- consensus: two model readings merged; human: a person settled fields on top of the previous row
  pass text NOT NULL CHECK (pass IN ('consensus', 'human')),
  -- field name -> { value, normalized, page, quote, bbox, confidence, method, readings }
  payload jsonb NOT NULL,
  -- failed checks as [{ check, field }]; empty when every check passed
  validation jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- fields a person must settle; empty when the record is settled
  review_fields text[] NOT NULL DEFAULT '{}',
  supersedes_id uuid REFERENCES public.document_extractions(id) ON DELETE SET NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (schema_type, schema_version) REFERENCES public.extraction_schemas (schema_type, version)
);
CREATE INDEX idx_document_extractions_document ON public.document_extractions (document_id, created_at DESC);
CREATE UNIQUE INDEX idx_document_extractions_current ON public.document_extractions (document_id) WHERE is_current;
CREATE INDEX idx_document_extractions_review
  ON public.document_extractions (company_id)
  WHERE is_current AND review_fields <> '{}'::text[];
ALTER TABLE public.document_extractions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company document extractions"
  ON public.document_extractions FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- Writes: service role only, through save_document_extraction.

ALTER TABLE public.document_attachments ADD COLUMN fields_extracted_at timestamptz;
CREATE INDEX idx_document_attachments_unextracted
  ON public.document_attachments (created_at DESC)
  WHERE fields_extracted_at IS NULL AND doc_type IS NOT NULL;

CREATE OR REPLACE FUNCTION public.save_document_extraction(
  p_document_id uuid,
  p_supersedes_id uuid,
  p_activity_id uuid,
  p_schema_type text,
  p_schema_version integer,
  p_pass text,
  p_payload jsonb,
  p_validation jsonb,
  p_review_fields text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_current_id uuid;
  v_id uuid;
BEGIN
  -- The document row lock serialises saves for one document.
  SELECT company_id INTO v_company_id
    FROM public.document_attachments
   WHERE id = p_document_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document % not found', p_document_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Refuse to supersede a row the caller never saw: a model run that ends
  -- after a person's correction must not bury it.
  SELECT id INTO v_current_id
    FROM public.document_extractions
   WHERE document_id = p_document_id AND is_current;
  IF v_current_id IS DISTINCT FROM p_supersedes_id THEN
    RAISE EXCEPTION 'extraction of document % changed since it was read', p_document_id
      USING ERRCODE = 'serialization_failure';
  END IF;

  UPDATE public.document_extractions SET is_current = false WHERE id = v_current_id;
  INSERT INTO public.document_extractions
    (company_id, document_id, activity_id, schema_type, schema_version, pass, payload, validation, review_fields, supersedes_id)
  VALUES
    (v_company_id, p_document_id, p_activity_id, p_schema_type, p_schema_version, p_pass, p_payload, p_validation, p_review_fields, v_current_id)
  RETURNING id INTO v_id;
  UPDATE public.document_attachments SET fields_extracted_at = now() WHERE id = p_document_id;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.save_document_extraction(uuid, uuid, uuid, text, integer, text, jsonb, jsonb, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_document_extraction(uuid, uuid, uuid, text, integer, text, jsonb, jsonb, text[]) TO service_role;
COMMENT ON FUNCTION public.save_document_extraction(uuid, uuid, uuid, text, integer, text, jsonb, jsonb, text[]) IS
  'Arkiv: makes a new extraction the current record of its document, superseding the row the caller read (serialization_failure when that changed). Service role only.';

-- ---------------------------------------------------------------------------
-- Job queue: read, classify, extract
-- ---------------------------------------------------------------------------
CREATE TABLE public.document_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.document_attachments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('read', 'classify', 'extract')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  -- short outcome note of the last successful run
  result text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- one job per step per document; queueing a finished step again reuses the row
  UNIQUE (document_id, kind)
);
CREATE INDEX idx_document_jobs_due ON public.document_jobs (run_after) WHERE status <> 'done';
CREATE TRIGGER document_jobs_updated_at BEFORE UPDATE ON public.document_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.document_jobs ENABLE ROW LEVEL SECURITY;
-- No policies: service role only.

CREATE OR REPLACE FUNCTION public.claim_document_jobs(
  p_batch_size int,
  p_worker     text,
  p_now        timestamptz DEFAULT now()
)
RETURNS TABLE (
  id          uuid,
  company_id  uuid,
  document_id uuid,
  kind        text,
  attempts    int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_batch_size IS NULL OR p_batch_size <= 0 OR p_batch_size > 500 THEN
    RAISE EXCEPTION 'p_batch_size must be in (0, 500]; got %', p_batch_size
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT j.id
    FROM public.document_jobs j
    WHERE j.attempts < j.max_attempts
      AND j.run_after <= p_now
      AND (
        j.status IN ('queued', 'failed')
        -- a worker that died mid-job: take it over after ten minutes
        OR (j.status = 'running' AND j.locked_at < p_now - interval '10 minutes')
      )
    ORDER BY j.run_after ASC, j.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.document_jobs j
     SET status = 'running', locked_at = p_now, locked_by = p_worker, attempts = j.attempts + 1
    FROM due
   WHERE j.id = due.id
  RETURNING j.id, j.company_id, j.document_id, j.kind, j.attempts;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.claim_document_jobs(integer, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_jobs(integer, text, timestamptz) TO service_role;
COMMENT ON FUNCTION public.claim_document_jobs(integer, text, timestamptz) IS
  'Arkiv: claims due document jobs across all tenants for the worker cron (FOR UPDATE SKIP LOCKED). Service role only.';

CREATE OR REPLACE FUNCTION public.enqueue_document_job(p_company_id uuid, p_document_id uuid, p_kind text)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH queued AS (
    INSERT INTO public.document_jobs (company_id, document_id, kind)
    VALUES (p_company_id, p_document_id, p_kind)
    ON CONFLICT (document_id, kind) DO UPDATE
      SET status = 'queued', attempts = 0, run_after = now(),
          locked_at = NULL, locked_by = NULL, result = NULL, last_error = NULL
      WHERE public.document_jobs.status IN ('done', 'failed')
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM queued);
$$;
REVOKE EXECUTE ON FUNCTION public.enqueue_document_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_document_job(uuid, uuid, text) TO service_role;
COMMENT ON FUNCTION public.enqueue_document_job(uuid, uuid, text) IS
  'Arkiv: queues one pipeline step for a document; false when a queued or running job already covers it. Service role only.';

-- p_company_ids NULL means every company (ARKIV_COMPANY_IDS=*).
CREATE OR REPLACE FUNCTION public.enqueue_missing_document_extractions(p_company_ids uuid[], p_limit int)
RETURNS int
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH missing AS (
    SELECT d.id, d.company_id
    FROM public.document_attachments d
    WHERE d.fields_extracted_at IS NULL
      AND d.doc_type IS NOT NULL
      AND d.admission_state = 'admitted'
      AND d.page_count > 0
      AND d.company_id IS NOT NULL
      AND (p_company_ids IS NULL OR d.company_id = ANY (p_company_ids))
      AND NOT EXISTS (SELECT 1 FROM public.document_jobs j WHERE j.document_id = d.id AND j.kind = 'extract')
    ORDER BY d.created_at DESC
    LIMIT p_limit
  ), queued AS (
    INSERT INTO public.document_jobs (company_id, document_id, kind)
    SELECT company_id, id, 'extract' FROM missing
    ON CONFLICT (document_id, kind) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int FROM queued;
$$;
REVOKE EXECUTE ON FUNCTION public.enqueue_missing_document_extractions(uuid[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_missing_document_extractions(uuid[], integer) TO service_role;
COMMENT ON FUNCTION public.enqueue_missing_document_extractions(uuid[], integer) IS
  'Arkiv: queues an extract job for admitted, typed, read documents that never had one. Never re-queues a finished or failed job. Service role only.';

NOTIFY pgrst, 'reload schema';
