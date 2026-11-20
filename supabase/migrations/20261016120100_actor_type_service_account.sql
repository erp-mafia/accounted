-- The actor type 'service_account': writes made through a service account's
-- key record WHO acted as the service account (label = its name), acting for
-- its sponsor (the row's user_id), in every place an actor type is recorded.
-- pg-test: tests/pg/service-accounts.pg.test.ts
--
-- The service accounts themselves arrive in 20261016120000. The application
-- names the actor { type: 'service_account', label: <account name> } for every
-- request authenticated by such a key (src/lib/api/v1/with-api-v1.ts), and
-- the posting and rättelse RPCs stamp it where they stamp any other actor
-- (commit_journal_entry since 20260619120000, the inline rättelse functions
-- since 20261016005000, the SIE import and undo since 20261015235000 and
-- 20261016005200). Every value list of actor types gains the new value:
--
--   1. CHECK constraints, each re-created from its current list plus
--      'service_account', NOT VALID; 20261016120200 validates them in a
--      separate transaction (no full-table scan under the ALTER's lock):
--        journal_entries.committed_actor_type        (20260619120000)
--        pending_operations.actor_type               (20260519090000)
--        audit_log.actor_type                        (20260519090000)
--        suggestion_log.actor_type                   (20261011140008)
--        journal_entry_rattelse_log.actor_type       (20261016005000)
--        sie_imports.undo_actor_type                 (20261016005200)
--      Each DROP names the constraint without IF EXISTS, so a name that is
--      not what this file expects fails the migration instead of leaving the
--      old list in force beside the new one.
--   2. Two SQL functions that drop an actor type outside the list instead of
--      failing (so a service account's SIE import would otherwise commit with
--      no actor): import_sie_chunk (newest definition 20261015235000) and
--      replace_sie_import_job (newest definition 20261016005200), each copied
--      byte for byte with only the list extended. Signatures, owners and
--      grants are unchanged (CREATE OR REPLACE keeps them).
--
-- No row is rewritten; posted entries are never touched (the immutability
-- triggers of migration 017 only see DML).

-- =============================================================================
-- 1. CHECK constraints
-- =============================================================================

-- Hot tables (journal_entries, api_keys, audit_log, ...): never queue every
-- write behind a long transaction. Fail the migration job instead and retry.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.journal_entries
  DROP CONSTRAINT journal_entries_committed_actor_type_check;
ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_committed_actor_type_check
  CHECK (committed_actor_type IS NULL OR committed_actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account'
  )) NOT VALID;

ALTER TABLE public.pending_operations
  DROP CONSTRAINT pending_operations_actor_type_check;
ALTER TABLE public.pending_operations
  ADD CONSTRAINT pending_operations_actor_type_check
  CHECK (actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron', 'agent_chat', 'service_account'
  )) NOT VALID;

ALTER TABLE public.audit_log
  DROP CONSTRAINT audit_log_actor_type_check;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_actor_type_check
  CHECK (actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account'
  )) NOT VALID;

ALTER TABLE public.suggestion_log
  DROP CONSTRAINT suggestion_log_actor_type_check;
ALTER TABLE public.suggestion_log
  ADD CONSTRAINT suggestion_log_actor_type_check
  CHECK (actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account'
  )) NOT VALID;

ALTER TABLE public.journal_entry_rattelse_log
  DROP CONSTRAINT journal_entry_rattelse_log_actor_type_check;
ALTER TABLE public.journal_entry_rattelse_log
  ADD CONSTRAINT journal_entry_rattelse_log_actor_type_check
  CHECK (actor_type IS NULL OR actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account'
  )) NOT VALID;

ALTER TABLE public.sie_imports
  DROP CONSTRAINT sie_imports_undo_actor_type_check;
ALTER TABLE public.sie_imports
  ADD CONSTRAINT sie_imports_undo_actor_type_check
  CHECK (undo_actor_type IS NULL OR undo_actor_type IN (
    'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account'
  )) NOT VALID;

COMMENT ON COLUMN public.journal_entries.committed_actor_type IS
  'WHO relayed the commit (user | api_key | mcp_oauth | cron | system | agent_chat | service_account). Complements commit_method (HOW). For service_account the label is the account''s name and user_id its sponsor. NULL on rows committed before this column existed or via paths that do not pass actor context.';
COMMENT ON COLUMN public.journal_entry_rattelse_log.actor_type IS
  'WHO relayed the rättelse (user | api_key | mcp_oauth | cron | system | agent_chat | service_account), as journal_entries.committed_actor_type records it for a commit. NULL on rows written before 20261016005000 or by a caller that passes no actor.';
COMMENT ON COLUMN public.sie_imports.undo_actor_type IS
  'WHO asked for the undo of this import (user | api_key | mcp_oauth | cron | system | agent_chat | service_account); stamped on each storno the undo posts. NULL when the undo was requested before 20261016005200 or without an actor.';

-- =============================================================================
-- 2. import_sie_chunk (from 20261015235000, list extended)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.import_sie_chunk(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_phase text, p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
DECLARE v_job public.sie_imports; v_chunk public.sie_import_chunks;
  v_result jsonb; v_bad_source text; v_new jsonb; v_existing jsonb; v_actor_type text;
BEGIN
  v_job := public.lock_sie_execution(p_company_id, p_import_id, p_worker_id, p_attempt);
  SELECT * INTO v_chunk FROM public.sie_import_chunks WHERE import_id = p_import_id
    AND phase = p_phase AND chunk_no = p_chunk_no FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SIE chunk not found' USING ERRCODE = 'P0002'; END IF;
  IF v_chunk.state = 'completed' THEN RETURN v_chunk.result; END IF;
  -- A lease can expire during a slow transaction. Actual writer slots remain
  -- held until commit/rollback, so expiry cannot increase platform concurrency.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:0', 0)) AND
     NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:1', 0)) THEN
    RAISE EXCEPTION 'SIE platform write capacity is busy' USING ERRCODE = '55P03';
  END IF;
  IF p_phase NOT IN ('vouchers','finalize') OR p_phase IS NULL OR v_job.job_phase <> p_phase OR
     (p_phase = 'vouchers' AND p_chunk_no <> v_job.chunks_done) OR
     EXISTS (SELECT 1 FROM public.sie_import_chunks WHERE import_id = p_import_id
       AND phase = p_phase AND chunk_no < p_chunk_no AND state <> 'completed') THEN
    RAISE EXCEPTION 'SIE chunk is out of order' USING ERRCODE = '55000';
  END IF;
  -- Private writer receives only frozen, bounded, company-owned payload.
  -- Validate account ownership here even if a service-role caller prepared it.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_chunk.payload) e,
    LATERAL jsonb_array_elements(e->'lines') l
    WHERE NOT EXISTS (SELECT 1 FROM public.chart_of_accounts a WHERE a.company_id = p_company_id
      AND a.account_number = l->>'account_number' AND a.id = (l->>'account_id')::uuid)) THEN
    RAISE EXCEPTION 'SIE account does not belong to company' USING ERRCODE = '42501';
  END IF;
  SELECT e->>'sourceId' INTO v_bad_source
  FROM jsonb_array_elements(v_chunk.payload) e JOIN public.journal_entries j
    ON j.company_id = p_company_id AND j.fiscal_period_id = v_job.fiscal_period_id
    AND ((j.import_batch_id = p_import_id AND j.source_ordinal = (e->>'sourceOrdinal')::integer)
      OR (j.source_type = 'import' AND j.status = 'posted' AND
        j.source_voucher_series = e->>'sourceSeries' AND j.source_voucher_number = (e->>'sourceNumber')::integer))
  WHERE j.import_batch_id IS DISTINCT FROM p_import_id OR j.source_ordinal IS DISTINCT FROM (e->>'sourceOrdinal')::integer OR
    j.source_content_hash IS DISTINCT FROM encode(extensions.digest((e - 'sieImportId' - 'sourceOrdinal')::text,'sha256'),'hex')
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'SIE conflicting voucher %', v_bad_source USING ERRCODE = '23505'; END IF;

  SELECT coalesce(jsonb_agg(e ORDER BY ord), '[]'::jsonb) INTO v_new
    FROM jsonb_array_elements(v_chunk.payload) WITH ORDINALITY p(e,ord)
    WHERE NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE import_batch_id = p_import_id
      AND source_ordinal = (e->>'sourceOrdinal')::integer);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', j.id,'sourceId',e->>'sourceId',
      'sourceOrdinal',j.source_ordinal,'series',j.voucher_series,'voucherNumber',j.voucher_number,'sourceType',j.source_type)), '[]'::jsonb)
    INTO v_existing FROM jsonb_array_elements(v_chunk.payload) e JOIN public.journal_entries j
      ON j.import_batch_id = p_import_id AND j.source_ordinal = (e->>'sourceOrdinal')::integer;
  -- WHO the chunk's verifikat record as committer: the actor sealed into the
  -- manifest when the import was submitted (the user, key or OAuth client),
  -- not the worker or cron running the chunk. write_sie_job_entries stamps
  -- it from these transaction-local settings, which the audit triggers read
  -- too. A type outside the committed_actor_type list is dropped, never a
  -- reason to fail the chunk; set on every chunk, so nothing carries over.
  v_actor_type := v_job.manifest #>> '{commit_actor,type}';
  IF v_actor_type NOT IN ('user','api_key','mcp_oauth','cron','system','agent_chat','service_account') THEN
    v_actor_type := NULL;
  END IF;
  PERFORM set_config('gnubok.actor_type', coalesce(v_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', CASE WHEN v_actor_type IS NULL THEN ''
    ELSE coalesce(left(v_job.manifest #>> '{commit_actor,label}', 200), '') END, true);
  v_result := public.write_sie_job_entries(p_company_id, coalesce(v_job.execution_actor_id, v_job.user_id), v_job.fiscal_period_id, v_new);
  v_result := jsonb_build_object('inserted_entries', v_existing || (v_result->'inserted_entries'));
  UPDATE public.sie_import_chunks SET state = 'completed', result = v_result, completed_at = clock_timestamp()
    WHERE id = v_chunk.id;
  UPDATE public.sie_imports SET transactions_count = transactions_count + jsonb_array_length(v_new),
    chunks_done = chunks_done + CASE WHEN p_phase = 'vouchers' THEN 1 ELSE 0 END,
    job_phase = CASE WHEN p_phase = 'vouchers' AND chunks_done + 1 = chunks_total THEN 'finalize' ELSE job_phase END,
    job_state = CASE WHEN p_phase = 'vouchers' AND chunks_done + 1 = chunks_total THEN 'finalizing' ELSE job_state END,
    consecutive_failures = 0, error_message = NULL
    WHERE id = p_import_id;
  RETURN v_result;
END;
$$;

-- =============================================================================
-- 3. replace_sie_import_job (from 20261016005200, list extended)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.replace_sie_import_job(p_company_id uuid,p_actor uuid,p_period_id uuid,
  p_filename text,p_file_hash text,p_manifest jsonb,p_supersedes_import_id uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_previous public.sie_imports; v_period public.fiscal_periods; v_refusal text;
  v_actor_type text;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_previous FROM public.sie_imports WHERE id = p_supersedes_import_id
    AND company_id = p_company_id AND fiscal_period_id = p_period_id FOR UPDATE;
  IF NOT FOUND OR v_previous.job_state IS NULL OR v_previous.job_kind<>'import' THEN
    RAISE EXCEPTION 'Legacy SIE import requires reviewed reconciliation before replacement' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_job FROM public.sie_imports WHERE supersedes_import_id = p_supersedes_import_id
    AND company_id = p_company_id AND job_state NOT IN ('undone','failed') ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_job.file_hash IS DISTINCT FROM p_file_hash OR v_job.manifest->'input' IS DISTINCT FROM p_manifest->'input' THEN
      RAISE EXCEPTION 'SIE replacement already reserved with different input' USING ERRCODE = '23505';
    END IF;
    RETURN v_job;
  END IF;
  IF v_previous.job_state NOT IN ('completed','undoing','undone') THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it first' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = p_period_id AND company_id = p_company_id FOR UPDATE;
  IF FOUND THEN
    v_refusal := public.sie_write_lock_refusal(p_company_id,p_period_id,v_period.period_start,v_period.period_end,'replace');
    IF v_refusal IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SIE_IMPORT_PERIOD_LOCKED: ' || v_refusal;
    END IF;
  END IF;
  IF v_previous.job_state = 'completed' THEN
    -- The previous import is undone on behalf of whoever submits its
    -- replacement: the actor sealed in the new manifest as commit_actor
    -- (sie-jobs.ts). A type outside the committed_actor_type list is
    -- dropped, as import_sie_chunk drops it.
    v_actor_type := p_manifest #>> '{commit_actor,type}';
    IF v_actor_type NOT IN ('user','api_key','mcp_oauth','cron','system','agent_chat','service_account') THEN v_actor_type := NULL; END IF;
    PERFORM public.request_sie_import_undo(p_company_id,p_supersedes_import_id,p_actor,v_actor_type,
      CASE WHEN v_actor_type IS NULL THEN NULL ELSE left(p_manifest #>> '{commit_actor,label}', 200) END);
  END IF;
  RETURN public.start_sie_import_job(p_company_id,p_actor,p_period_id,p_filename,p_file_hash,p_manifest,p_supersedes_import_id);
END;
$$;

NOTIFY pgrst, 'reload schema';
