-- The stornos of an SIE undo record WHO asked for it (attribution step 2,
-- Phase 1 "the actor record on every write", founder-accepted 2026-10-15).
--
-- undo_sie_import_chunk and undo_sie_duplicate_repair_chunk post their
-- stornos with a plain draft-to-posted UPDATE, outside commit_journal_entry,
-- so committed_actor_type, committed_actor_label and commit_method stayed
-- NULL and every audit row of the chunk (COMMIT of each storno, REVERSE of
-- each original) fell back to 'user'. The import itself records its actor
-- since 20261015235000.
--
--   1. sie_imports gains undo_actor_type (the committed_actor_type list) and
--      undo_actor_label, nullable: who asked for the undo, beside the uuid
--      in execution_actor_id.
--   2. request_sie_import_undo gains two defaulted parameters, p_actor_type
--      and p_actor_label, and records them. The application passes the actor
--      of the request labelled 'SIE undo' (sie-jobs.ts sieUndoCommitActor).
--      The old signature is dropped; grants restated (authenticated,
--      service_role; not PUBLIC or anon).
--   3. replace_sie_import_job undoes the previous import on behalf of the
--      actor sealed in the replacement's manifest (commit_actor).
--   4. undo_sie_import_chunk stamps that actor on each storno with
--      commit_method 'migration', the value the import itself records, and
--      hands it to write_audit_log through the gnubok.actor_* GUCs.
--   5. undo_sie_duplicate_repair_chunk does the same with actor 'system',
--      label 'SIE duplicate repair': a reviewed repair is staged only by the
--      operator script, never by a user, key or connector.
--
-- A resume (resume_sie_import_job) moves execution_actor_id to whoever
-- resumes and leaves undo_actor_* as they are: the stornos keep naming who
-- asked for the undo. An undo requested before this migration recorded no
-- actor: its stornos get commit_method 'migration' and NULL actor, as before
-- for the actor. Posted entries are never touched.
--
-- Each function is the newest definition copied byte for byte with only the
-- change described here (request_sie_import_undo and replace_sie_import_job
-- from 20261005193558_sie_undo_lock_preflight, undo_sie_import_chunk from
-- 20260911145105_sie_duplicate_repair_jobs, undo_sie_duplicate_repair_chunk
-- from 20260911150200_sie_repair_action_boundaries); replace_sie_import_job
-- and both chunk functions keep their signatures, owners and grants (CREATE
-- OR REPLACE). None of them had a comment.
--
-- Rollout: an older deploy calls request_sie_import_undo without the new
-- parameters and still resolves (defaults). A newer deploy that reaches a
-- database without this migration gets PGRST202 and retries once without
-- them (src/lib/bookkeeping/actor-rpc.ts).
--
-- pg-test: tests/pg/sie-undo-actor.pg.test.ts

ALTER TABLE public.sie_imports
  ADD COLUMN IF NOT EXISTS undo_actor_type text
    CONSTRAINT sie_imports_undo_actor_type_check
    CHECK (undo_actor_type IS NULL OR undo_actor_type IN (
      'user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat'
    )),
  ADD COLUMN IF NOT EXISTS undo_actor_label text;

COMMENT ON COLUMN public.sie_imports.undo_actor_type IS
  'WHO asked for the undo of this import (user | api_key | mcp_oauth | cron | system | agent_chat); stamped on each storno the undo posts. NULL when the undo was requested before 20261016005200 or without an actor.';
COMMENT ON COLUMN public.sie_imports.undo_actor_label IS
  'Human-readable credential label of the undo requester at request time (e.g. ''SIE undo: <API key name>''). Snapshot, not a foreign key.';

DROP FUNCTION IF EXISTS public.request_sie_import_undo(uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.request_sie_import_undo(p_company_id uuid,p_import_id uuid,p_actor uuid,
  p_actor_type text DEFAULT NULL,p_actor_label text DEFAULT NULL)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods; v_refusal text;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  IF NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=p_company_id AND user_id=p_actor AND role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'SIE reversal requires company owner or administrator' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE id = p_import_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_state IS NULL THEN RAISE EXCEPTION 'SIE execution not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.job_kind<>'import' THEN RAISE EXCEPTION 'Reviewed repair requires its reviewed stop action' USING ERRCODE='55000'; END IF;
  IF v_job.job_state IN ('undone','failed') THEN RETURN v_job; END IF;
  IF EXISTS (SELECT 1 FROM public.sie_imports other
      WHERE other.company_id = p_company_id AND other.id <> p_import_id
        AND other.job_state NOT IN ('completed','undone','failed')
        AND NOT (v_job.job_phase = 'undo' AND other.supersedes_import_id = p_import_id)) THEN
    RAISE EXCEPTION 'Another SIE execution must finish before undo' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = v_job.fiscal_period_id AND company_id = p_company_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.journal_entries original JOIN public.journal_entries reversal
    ON reversal.reverses_id = original.id AND reversal.company_id = p_company_id
    WHERE original.company_id = p_company_id AND original.import_batch_id = p_import_id
      AND original.status = 'posted' AND reversal.status IN ('draft','posted')) THEN
    RAISE EXCEPTION 'SIE undo requires review: a voucher reversal is already in progress' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (WITH RECURSIVE descendants AS (
    SELECT id,status FROM public.journal_entries WHERE company_id = p_company_id AND import_batch_id = p_import_id
    UNION SELECT j.id,j.status FROM public.journal_entries j JOIN descendants d ON j.correction_of_id = d.id
      WHERE j.company_id = p_company_id
  ) SELECT 1 FROM descendants d JOIN public.journal_entries j ON j.id = d.id
    WHERE j.status IN ('draft','posted') AND j.import_batch_id IS DISTINCT FROM p_import_id) THEN
    RAISE EXCEPTION 'SIE undo requires review: an imported voucher has a live correction' USING ERRCODE = '55000';
  END IF;
  IF p_actor IS DISTINCT FROM coalesce(v_job.execution_actor_id,v_job.user_id) AND NOT EXISTS (
    SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_actor AND role IN ('owner','admin')
  ) THEN RAISE EXCEPTION 'SIE undo requires company administrator' USING ERRCODE = '42501'; END IF;
  -- The fiscal year row is locked above, and guard_sie_company_lock_date takes
  -- the same row locks before a lock date can move forward: this answer holds
  -- until the hold below is committed.
  v_refusal := public.sie_undo_lock_refusal(p_company_id,p_import_id);
  IF v_refusal IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SIE_IMPORT_PERIOD_LOCKED: ' || v_refusal;
  END IF;
  IF v_period.import_hold IS NOT NULL AND v_period.import_hold <> p_import_id THEN
    RAISE EXCEPTION 'SIE period is locked or has another execution' USING ERRCODE = '55000';
  END IF;
  UPDATE public.fiscal_periods SET import_hold = p_import_id WHERE id = v_period.id;
  -- WHO asked for the undo (the user, API key, OAuth client, ...), beside
  -- the uuid: undo_sie_import_chunk stamps it on every storno it posts.
  UPDATE public.sie_imports SET job_state = 'undoing',job_phase = 'undo',job_attempt = job_attempt+1,
    execution_actor_id = p_actor,worker_id = NULL,lease_until = NULL,next_attempt_at = NULL,error_message = NULL,
    undo_actor_type = p_actor_type,undo_actor_label = CASE WHEN p_actor_type IS NULL THEN NULL ELSE p_actor_label END
    WHERE id = p_import_id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.request_sie_import_undo(uuid, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_sie_import_undo(uuid, uuid, uuid, text, text) TO authenticated, service_role;

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
    IF v_actor_type NOT IN ('user','api_key','mcp_oauth','cron','system','agent_chat') THEN v_actor_type := NULL; END IF;
    PERFORM public.request_sie_import_undo(p_company_id,p_supersedes_import_id,p_actor,v_actor_type,
      CASE WHEN v_actor_type IS NULL THEN NULL ELSE left(p_manifest #>> '{commit_actor,label}', 200) END);
  END IF;
  RETURN public.start_sie_import_job(p_company_id,p_actor,p_period_id,p_filename,p_file_hash,p_manifest,p_supersedes_import_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.undo_sie_import_chunk(p_company_id uuid,p_import_id uuid,p_worker_id uuid,p_attempt integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
DECLARE v_job public.sie_imports; v_actor uuid; v_ids uuid[]; v_receipt jsonb;
  v_first integer; v_links uuid[]; v_renames public.sie_import_chunks;
BEGIN
  v_job := public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  IF v_job.job_phase <> 'undo' OR v_job.job_kind <> 'import' THEN RAISE EXCEPTION 'SIE job is not undoing'; END IF;
  v_actor := coalesce(v_job.execution_actor_id,v_job.user_id);
  -- WHO: the actor that asked for the undo (request_sie_import_undo), for
  -- the stornos below and, through the GUCs commit_journal_entry sets, for
  -- every audit row this chunk writes. An undo requested before
  -- 20261016005200 recorded none: NULL, as before.
  PERFORM set_config('gnubok.actor_type', coalesce(v_job.undo_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', CASE WHEN v_job.undo_actor_type IS NULL THEN ''
    ELSE coalesce(v_job.undo_actor_label, '') END, true);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:0',0)) AND
     NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:1',0)) THEN
    RAISE EXCEPTION 'SIE platform write capacity is busy' USING ERRCODE = '55P03';
  END IF;
  -- Bound both header and line work. A voucher is never split.
  WITH candidates AS (
    SELECT j.id,j.source_ordinal,(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id = j.id) n
    FROM public.journal_entries j WHERE j.import_batch_id = p_import_id AND j.company_id = p_company_id
      AND j.status = 'posted' ORDER BY j.source_ordinal LIMIT 500
  ), sized AS (SELECT *,sum(n) OVER (ORDER BY source_ordinal) total FROM candidates)
  SELECT array_agg(id ORDER BY source_ordinal),min(source_ordinal) INTO v_ids,v_first FROM sized WHERE total <= 2000;
  IF coalesce(cardinality(v_ids),0) = 0 THEN
    IF EXISTS (SELECT 1 FROM public.journal_entries WHERE import_batch_id = p_import_id AND status = 'posted') THEN
      RAISE EXCEPTION 'SIE undo voucher exceeds 2000 lines';
    END IF;
    -- Restore names only while they still equal this import's write; preserve
    -- subsequent user edits. Each batch of at most 100 names has a receipt.
    SELECT c.* INTO v_renames FROM public.sie_import_chunks c WHERE c.import_id = p_import_id
      AND c.phase = 'prepare' AND ((c.chunk_no >= 50000 AND c.chunk_no < 60000) OR (c.chunk_no >= 70000 AND c.chunk_no < 80000))
      AND NOT EXISTS (SELECT 1 FROM public.sie_import_chunks u WHERE u.import_id = p_import_id
        AND u.phase = 'undo' AND u.chunk_no = 100000+c.chunk_no)
      ORDER BY c.chunk_no LIMIT 1;
    IF FOUND THEN
      UPDATE public.chart_of_accounts a SET account_name = r->>'from'
        FROM jsonb_array_elements(coalesce(v_renames.result->'renamed','[]'::jsonb)) r
        WHERE a.company_id = p_company_id AND a.account_number = r->>'accountNumber' AND a.account_name = r->>'to';
      UPDATE public.chart_of_accounts a SET default_vat_treatment = r->>'fromTreatment',default_vat_rate = (r->>'fromRate')::numeric
        FROM jsonb_array_elements(coalesce(v_renames.result->'vatDefaults','[]'::jsonb)) r
        WHERE a.company_id = p_company_id AND a.account_number = r->>'accountNumber'
          AND a.default_vat_treatment IS NOT DISTINCT FROM r->>'toTreatment'
          AND a.default_vat_rate IS NOT DISTINCT FROM (r->>'toRate')::numeric;
      INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
        VALUES(p_import_id,p_company_id,v_actor,'undo',100000+v_renames.chunk_no,v_renames.payload_hash,
          'completed',jsonb_build_object('accountNamesRestored',true),clock_timestamp());
      RETURN jsonb_build_object('reversed',0,'done',false);
    END IF;
    UPDATE public.sie_imports SET job_state = 'undone',status = 'replaced',worker_id = NULL,lease_until = NULL,
      error_message = NULL WHERE id = p_import_id;
    UPDATE public.fiscal_periods SET import_hold = NULL WHERE id = v_job.fiscal_period_id AND import_hold = p_import_id;
    RETURN jsonb_build_object('reversed',0,'done',true);
  END IF;
  PERFORM 1 FROM public.journal_entries WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE id = ANY(v_ids) AND
      (source_type NOT IN ('import','opening_balance') OR status <> 'posted')) THEN
    RAISE EXCEPTION 'SIE batch contains a changed or unsupported entry';
  END IF;
  WITH counts AS (
    SELECT voucher_series,count(*)::integer n FROM public.journal_entries WHERE id = ANY(v_ids) GROUP BY voucher_series
  ), reserved AS (
    INSERT INTO public.voucher_sequences(company_id,user_id,fiscal_period_id,voucher_series,last_number)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,n FROM counts ORDER BY voucher_series
      ON CONFLICT (company_id,fiscal_period_id,voucher_series) DO UPDATE
        SET last_number = voucher_sequences.last_number+EXCLUDED.last_number,updated_at = now()
      RETURNING voucher_series,last_number
  ), originals AS (
    SELECT j.*,r.last_number-c.n+row_number() OVER (PARTITION BY j.voucher_series ORDER BY j.source_ordinal) number
      FROM public.journal_entries j JOIN counts c USING (voucher_series) JOIN reserved r USING (voucher_series)
      WHERE j.id = ANY(v_ids)
  ), headers AS (
    INSERT INTO public.journal_entries(company_id,user_id,fiscal_period_id,voucher_series,voucher_number,entry_date,
      description,source_type,source_id,reverses_id,status)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,number::integer,entry_date,
        'Makulering: ' || description,'storno',source_id,id,'draft' FROM originals
      RETURNING id,reverses_id,voucher_number,voucher_series
  ), lines AS (
    INSERT INTO public.journal_entry_lines(journal_entry_id,account_number,account_id,debit_amount,credit_amount,
      line_description,currency,amount_in_currency,exchange_rate,tax_code,dimensions,sort_order)
      SELECT h.id,l.account_number,l.account_id,greatest(l.credit_amount-l.debit_amount,0),
        greatest(l.debit_amount-l.credit_amount,0),'Reversal: ' || coalesce(l.line_description,''),l.currency,
        -l.amount_in_currency,l.exchange_rate,l.tax_code,l.dimensions,l.sort_order
      FROM headers h JOIN public.journal_entry_lines l ON l.journal_entry_id = h.reverses_id
      RETURNING journal_entry_id
  )
  SELECT jsonb_agg(jsonb_build_object('id',id,'reverses',reverses_id,'number',voucher_number,'series',voucher_series))
    INTO v_receipt FROM headers;
  -- HOW: 'migration', as write_sie_job_entries stamps the import itself
  -- (20261015235000): imported history taken back out in bulk, never
  -- accepted entry by entry.
  UPDATE public.journal_entries SET status = 'posted',
      commit_method = 'migration',
      committed_actor_type = v_job.undo_actor_type,
      committed_actor_label = CASE WHEN v_job.undo_actor_type IS NULL THEN NULL ELSE v_job.undo_actor_label END
    WHERE id IN (SELECT (r->>'id')::uuid FROM jsonb_array_elements(v_receipt) r);
  UPDATE public.journal_entries j SET status = 'reversed',reversed_by_id = (r->>'id')::uuid
    FROM jsonb_array_elements(v_receipt) r WHERE j.id = (r->>'reverses')::uuid AND j.status = 'posted';

  -- Preserve documents and audit records. Release bank anchors atomically.
  PERFORM 1 FROM public.transactions t WHERE t.company_id = p_company_id AND
    (t.journal_entry_id = ANY(v_ids) OR EXISTS (SELECT 1 FROM public.transaction_voucher_links l
      WHERE l.transaction_id = t.id AND l.company_id = p_company_id AND l.journal_entry_id = ANY(v_ids)))
    ORDER BY t.id FOR UPDATE;
  SELECT array_agg(DISTINCT transaction_id) INTO v_links FROM public.transaction_voucher_links
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT id FROM public.transactions WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids));
  UPDATE public.transactions SET journal_entry_id = NULL,is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  -- A partly reversed split no longer explains the transaction: release its
  -- remaining bank-line slices, as reverseEntry does for an individual storno.
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT t.id FROM public.transactions t JOIN public.transaction_voucher_links l ON l.transaction_id = t.id
      AND l.company_id = p_company_id WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
    GROUP BY t.id,t.amount HAVING bool_and(l.role = 'bank_line') AND abs(round(sum(l.allocated_amount)-t.amount,2)) > 0.005);
  UPDATE public.transactions t SET is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links l WHERE l.company_id = p_company_id AND l.transaction_id = t.id);
  UPDATE public.fiscal_periods SET opening_balances_set = false
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
    VALUES(p_import_id,p_company_id,v_actor,'undo',v_first,encode(extensions.digest(v_receipt::text,'sha256'),'hex'),
      'completed',jsonb_build_object('entries',v_receipt),clock_timestamp());
  RETURN jsonb_build_object('reversed',cardinality(v_ids),'done',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.undo_sie_duplicate_repair_chunk(p_company_id uuid,p_import_id uuid,p_worker_id uuid,p_attempt integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s' AS $$
DECLARE v_job public.sie_imports; v_actor uuid; v_ids uuid[]; v_keep_ids uuid[]; v_receipt jsonb;
  v_first integer; v_links uuid[]; v_bad uuid;
BEGIN
  v_job:=public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  IF v_job.job_kind<>'duplicate_repair' OR v_job.job_phase<>'undo' THEN RAISE EXCEPTION 'SIE job is not a reviewed repair'; END IF;
  v_actor:=coalesce(v_job.execution_actor_id,v_job.user_id);
  -- WHO: a reviewed repair is staged only by the operator script
  -- (scripts/sie-import/execute-reviewed-repair.ts, service_role), so the
  -- platform posts these stornos: actor 'system', for the stornos below and,
  -- through the GUCs, for every audit row this chunk writes.
  PERFORM set_config('gnubok.actor_type','system',true);
  PERFORM set_config('gnubok.actor_label','SIE duplicate repair',true);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:0',0)) AND
    NOT pg_try_advisory_xact_lock(hashtextextended('sie-writer-slot:1',0)) THEN
    RAISE EXCEPTION 'SIE platform write capacity is busy' USING ERRCODE='55P03';
  END IF;
  WITH candidates AS (
    SELECT i.*,(SELECT count(*) FROM public.journal_entry_lines l WHERE l.journal_entry_id=i.reverse_entry_id) n
      FROM public.sie_duplicate_repair_items i WHERE i.import_id=p_import_id AND i.reversal_id IS NULL AND i.cancelled_at IS NULL ORDER BY ordinal LIMIT 200
  ), sized AS (SELECT *,sum(n) OVER (ORDER BY ordinal) total FROM candidates)
  SELECT array_agg(reverse_entry_id ORDER BY ordinal),array_agg(keep_entry_id ORDER BY ordinal),min(ordinal)
    INTO v_ids,v_keep_ids,v_first FROM sized WHERE total<=2000;
  IF coalesce(cardinality(v_ids),0)=0 THEN
    IF EXISTS(SELECT 1 FROM public.sie_duplicate_repair_items WHERE import_id=p_import_id AND reversal_id IS NULL AND cancelled_at IS NULL) THEN
      RAISE EXCEPTION 'SIE repair voucher exceeds 2000 lines' USING ERRCODE='22023';
    END IF;
    UPDATE public.sie_imports SET job_state='undone',status='replaced',worker_id=NULL,lease_until=NULL,error_message=NULL
      WHERE id=p_import_id;
    UPDATE public.fiscal_periods SET import_hold=NULL WHERE id=v_job.fiscal_period_id AND import_hold=p_import_id;
    RETURN jsonb_build_object('reversed',0,'done',true);
  END IF;
  PERFORM 1 FROM public.journal_entries WHERE id=ANY(v_ids||v_keep_ids) ORDER BY id FOR UPDATE;
  SELECT i.reverse_entry_id INTO v_bad FROM public.sie_duplicate_repair_items i
    JOIN public.journal_entries d ON d.id=i.reverse_entry_id JOIN public.journal_entries k ON k.id=i.keep_entry_id
    WHERE i.import_id=p_import_id AND i.reverse_entry_id=ANY(v_ids) AND (
      d.status<>'posted' OR k.status<>'posted' OR d.company_id<>p_company_id OR k.company_id<>p_company_id
      OR d.fiscal_period_id<>v_job.fiscal_period_id OR k.fiscal_period_id<>v_job.fiscal_period_id
      OR public.sie_repair_content_hash(d.id) IS DISTINCT FROM i.content_hash
      OR public.sie_repair_content_hash(k.id) IS DISTINCT FROM i.content_hash
      OR public.sie_repair_entry_links(d.id) IS DISTINCT FROM i.reverse_links
      OR public.sie_repair_entry_links(k.id) IS DISTINCT FROM i.keep_links) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'SIE repair review changed for voucher %',v_bad USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM public.sie_duplicate_repair_items i,
    LATERAL jsonb_array_elements(i.reverse_links) l WHERE i.import_id=p_import_id AND i.reverse_entry_id=ANY(v_ids)
      AND l->>'relationship' NOT IN ('document_attachments.journal_entry_id','document_attachments.journal_entry_line_id',
        'transactions.journal_entry_id','transaction_voucher_links.journal_entry_id','journal_entry_no_doc_required.journal_entry_id')) THEN
    RAISE EXCEPTION 'SIE repair has a dependent record requiring separate review' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('app.sie_repair_job',p_import_id::text,true);
  -- The atomic storno writer below is shared in shape with ordinary batch undo.
  PERFORM 1 FROM public.journal_entries WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.journal_entries WHERE id = ANY(v_ids) AND
      (source_type NOT IN ('import','opening_balance') OR status <> 'posted')) THEN
    RAISE EXCEPTION 'SIE batch contains a changed or unsupported entry';
  END IF;
  WITH counts AS (
    SELECT voucher_series,count(*)::integer n FROM public.journal_entries WHERE id = ANY(v_ids) GROUP BY voucher_series
  ), reserved AS (
    INSERT INTO public.voucher_sequences(company_id,user_id,fiscal_period_id,voucher_series,last_number)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,n FROM counts ORDER BY voucher_series
      ON CONFLICT (company_id,fiscal_period_id,voucher_series) DO UPDATE
        SET last_number = voucher_sequences.last_number+EXCLUDED.last_number,updated_at = now()
      RETURNING voucher_series,last_number
  ), originals AS (
    SELECT j.*,r.last_number-c.n+row_number() OVER (PARTITION BY j.voucher_series ORDER BY j.voucher_number,j.id) number
      FROM public.journal_entries j JOIN counts c USING (voucher_series) JOIN reserved r USING (voucher_series)
      WHERE j.id = ANY(v_ids)
  ), headers AS (
    INSERT INTO public.journal_entries(company_id,user_id,fiscal_period_id,voucher_series,voucher_number,entry_date,
      description,source_type,source_id,reverses_id,status)
      SELECT p_company_id,v_actor,v_job.fiscal_period_id,voucher_series,number::integer,entry_date,
        'Makulering: ' || description,'storno',source_id,id,'draft' FROM originals
      RETURNING id,reverses_id,voucher_number,voucher_series
  ), lines AS (
    INSERT INTO public.journal_entry_lines(journal_entry_id,account_number,account_id,debit_amount,credit_amount,
      line_description,currency,amount_in_currency,exchange_rate,tax_code,dimensions,sort_order)
      SELECT h.id,l.account_number,l.account_id,greatest(l.credit_amount-l.debit_amount,0),
        greatest(l.debit_amount-l.credit_amount,0),'Reversal: ' || coalesce(l.line_description,''),l.currency,
        -l.amount_in_currency,l.exchange_rate,l.tax_code,l.dimensions,l.sort_order
      FROM headers h JOIN public.journal_entry_lines l ON l.journal_entry_id = h.reverses_id
      RETURNING journal_entry_id
  )
  SELECT jsonb_agg(jsonb_build_object('id',id,'reverses',reverses_id,'number',voucher_number,'series',voucher_series))
    INTO v_receipt FROM headers;
  -- HOW: 'migration', as for the import and its undo: imported history
  -- corrected in bulk, never accepted entry by entry.
  UPDATE public.journal_entries SET status = 'posted',
      commit_method = 'migration',
      committed_actor_type = 'system',
      committed_actor_label = 'SIE duplicate repair'
    WHERE id IN (SELECT (r->>'id')::uuid FROM jsonb_array_elements(v_receipt) r);
  UPDATE public.journal_entries j SET status = 'reversed',reversed_by_id = (r->>'id')::uuid
    FROM jsonb_array_elements(v_receipt) r WHERE j.id = (r->>'reverses')::uuid AND j.status = 'posted';

  -- Preserve documents and audit records. Release bank anchors atomically.
  PERFORM 1 FROM public.transactions t WHERE t.company_id = p_company_id AND
    (t.journal_entry_id = ANY(v_ids) OR EXISTS (SELECT 1 FROM public.transaction_voucher_links l
      WHERE l.transaction_id = t.id AND l.company_id = p_company_id AND l.journal_entry_id = ANY(v_ids)))
    ORDER BY t.id FOR UPDATE;
  SELECT array_agg(DISTINCT transaction_id) INTO v_links FROM public.transaction_voucher_links
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT id FROM public.transactions WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids));
  UPDATE public.transactions SET journal_entry_id = NULL,is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND journal_entry_id = ANY(v_ids);
  -- A partly reversed split no longer explains the transaction: release its
  -- remaining bank-line slices, as reverseEntry does for an individual storno.
  DELETE FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id IN (
    SELECT t.id FROM public.transactions t JOIN public.transaction_voucher_links l ON l.transaction_id = t.id
      AND l.company_id = p_company_id WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
    GROUP BY t.id,t.amount HAVING bool_and(l.role = 'bank_line') AND abs(round(sum(l.allocated_amount)-t.amount,2)) > 0.005);
  UPDATE public.transactions t SET is_business = NULL,category = NULL,reconciliation_method = NULL
    WHERE t.company_id = p_company_id AND t.id = ANY(v_links) AND t.journal_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links l WHERE l.company_id = p_company_id AND l.transaction_id = t.id);
  UPDATE public.fiscal_periods SET opening_balances_set = false
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  UPDATE public.fiscal_periods SET opening_balance_entry_id = NULL
    WHERE company_id = p_company_id AND opening_balance_entry_id = ANY(v_ids);
  UPDATE public.sie_duplicate_repair_items i SET reversal_id=(r->>'id')::uuid
    FROM jsonb_array_elements(v_receipt) r WHERE i.import_id=p_import_id AND i.reverse_entry_id=(r->>'reverses')::uuid;
  INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload_hash,state,result,completed_at)
    VALUES(p_import_id,p_company_id,v_actor,'undo',v_first,encode(extensions.digest(v_receipt::text,'sha256'),'hex'),
      'completed',jsonb_build_object('entries',v_receipt,'reviewHash',v_job.manifest->>'reviewHash'),clock_timestamp());
  UPDATE public.sie_imports SET chunks_done=chunks_done+cardinality(v_ids) WHERE id=p_import_id;
  RETURN jsonb_build_object('reversed',cardinality(v_ids),'done',false);
END;
$$;

NOTIFY pgrst, 'reload schema';
