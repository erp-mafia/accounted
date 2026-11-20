-- complete_sie_import_job records the migration adjustment at the ordinal the
-- job sealed, not at a fixed 50001.
--
-- A job writes its IB and its migration adjustment after the file's vouchers,
-- which take source ordinals 0 to vouchers - 1. They sat at 50000 and 50001,
-- just past the old limit of 50 000 vouchers per file. A larger file now puts
-- them at 1000000 and 1000001 (sieFinalOrdinals in
-- src/lib/import/sie-job-contract.ts) and seals the pair in its manifest as
-- finalOrdinals. Read at 50001, a large import would record one of its own
-- vouchers as the adjustment. A job sealed without finalOrdinals used 50001.
--
-- The body is otherwise the 20260911140523 definition verbatim (the only one;
-- prod's pg_get_functiondef matched it on 2026-11-14). The ordinal is read
-- only when it is a plain integer, so a malformed manifest costs the record,
-- never the completion.

CREATE OR REPLACE FUNCTION public.complete_sie_import_job(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_result jsonb, p_documentation jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_opening uuid; v_opening_count integer; v_manifest jsonb;
  v_adjustment_ordinal integer;
BEGIN
  v_job := public.lock_sie_execution(p_company_id, p_import_id, p_worker_id, p_attempt);
  IF v_job.job_phase <> 'finalize' OR v_job.chunks_done <> v_job.chunks_total OR EXISTS (
    SELECT 1 FROM public.sie_import_chunks WHERE import_id = p_import_id AND phase IN ('vouchers','finalize') AND state <> 'completed'
  ) THEN RAISE EXCEPTION 'SIE import has unfinished work' USING ERRCODE = '55000'; END IF;
  IF p_result->>'success' IS DISTINCT FROM 'true' OR p_documentation IS NULL OR v_job.file_storage_path IS NULL THEN
    RAISE EXCEPTION 'SIE import archive or result missing' USING ERRCODE = '55000';
  END IF;
  SELECT count(*), (array_agg(id))[1] INTO v_opening_count,v_opening FROM public.journal_entries
    WHERE import_batch_id = p_import_id AND source_type = 'opening_balance' AND status = 'posted';
  IF v_opening_count > 1 THEN RAISE EXCEPTION 'SIE has multiple opening balance entries'; END IF;
  IF v_opening IS NOT NULL THEN
    UPDATE public.fiscal_periods SET opening_balance_entry_id = v_opening,opening_balances_set = true
      WHERE id = v_job.fiscal_period_id AND (opening_balance_entry_id IS NULL OR opening_balance_entry_id = v_opening);
    IF NOT FOUND THEN RAISE EXCEPTION 'SIE opening balance was changed concurrently'; END IF;
  END IF;
  v_adjustment_ordinal := CASE WHEN v_job.manifest #>> '{finalOrdinals,adjustment}' ~ '^[0-9]{1,9}$'
    THEN (v_job.manifest #>> '{finalOrdinals,adjustment}')::integer ELSE 50001 END;
  SELECT v_job.manifest || jsonb_build_object('chunks',coalesce(jsonb_agg(jsonb_build_object(
      'phase',phase,'number',chunk_no,'hash',payload_hash) ORDER BY phase,chunk_no),'[]'::jsonb),
      'openingBalanceEntryId',v_opening,'adjustmentEntryId',(SELECT id FROM public.journal_entries
        WHERE import_batch_id = p_import_id AND source_ordinal = v_adjustment_ordinal)) INTO v_manifest
    FROM public.sie_import_chunks WHERE import_id = p_import_id AND phase IN ('vouchers','finalize');
  UPDATE public.sie_imports SET job_state = 'completed', status = 'completed',
    manifest = v_manifest,opening_balance_entry_id = v_opening,
    job_result = p_result, migration_documentation = p_documentation, imported_at = clock_timestamp(),
    worker_id = NULL, lease_until = NULL, error_message = NULL
    WHERE id = p_import_id;
  UPDATE public.fiscal_periods SET import_hold = NULL WHERE id = v_job.fiscal_period_id AND import_hold = p_import_id;
  UPDATE public.sie_import_chunks SET payload = NULL WHERE import_id = p_import_id AND
    (phase IN ('vouchers','finalize') OR (phase = 'prepare' AND chunk_no > 100000 AND chunk_no < 200000));
END;
$$;
-- Same grants as 20260911140523 (CREATE OR REPLACE keeps them; restated).
REVOKE ALL ON FUNCTION public.complete_sie_import_job(uuid,uuid,uuid,integer,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_sie_import_job(uuid,uuid,uuid,integer,jsonb,jsonb) TO service_role;
