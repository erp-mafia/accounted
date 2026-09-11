-- Checkpoint receipts cover preparation and final metadata as well as money.
CREATE FUNCTION public.project_sie_operation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.job_state IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.operations(id,company_id,user_id,operation_type,status,params,progress,result,error,started_at,completed_at)
    VALUES(NEW.id,NEW.company_id,NEW.user_id,'import.sie',
      CASE NEW.job_state WHEN 'queued' THEN 'queued' WHEN 'completed' THEN 'succeeded' WHEN 'undone' THEN 'cancelled'
        WHEN 'failed' THEN 'failed' ELSE 'running' END,
      jsonb_build_object('import_id',NEW.id),
      jsonb_build_object('phase',NEW.job_state,'current',NEW.chunks_done,'total',NEW.chunks_total,'vouchers',NEW.transactions_count),
      NEW.job_result,CASE WHEN NEW.error_message IS NULL THEN NULL ELSE jsonb_build_object('message',NEW.error_message) END,
      CASE WHEN NEW.job_state = 'queued' THEN NULL ELSE now() END,
      CASE WHEN NEW.job_state IN ('completed','undone','failed') THEN now() ELSE NULL END)
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status,progress = EXCLUDED.progress,result = EXCLUDED.result,
      error = EXCLUDED.error,started_at = coalesce(operations.started_at,EXCLUDED.started_at),completed_at = EXCLUDED.completed_at
    WHERE operations.status NOT IN ('succeeded','failed','cancelled');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.project_sie_operation() FROM PUBLIC;
CREATE TRIGGER project_sie_operation AFTER INSERT OR UPDATE OF job_state,chunks_done,job_result,error_message ON public.sie_imports
  FOR EACH ROW EXECUTE FUNCTION public.project_sie_operation();

CREATE FUNCTION public.apply_sie_import_metadata(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_chunk_no integer, p_kind text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_checkpoint public.sie_import_chunks;
  v_hash text; v_result jsonb := '{}'::jsonb; v_count integer; v_actor uuid;
BEGIN
  v_job := public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  v_actor := coalesce(v_job.execution_actor_id,v_job.user_id);
  IF p_kind NOT IN ('accounts','dimensions','dimension_values','mappings','account_names','vat_defaults','no_documents') OR
     p_kind IS NULL OR p_chunk_no IS NULL OR p_chunk_no < 0 OR
     jsonb_typeof(p_payload) IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload) > 100 OR
     octet_length(p_payload::text) > 1000000 THEN
    RAISE EXCEPTION 'Invalid SIE metadata checkpoint' USING ERRCODE = '22023';
  END IF;
  IF (p_kind IN ('accounts','dimensions','dimension_values') AND v_job.job_phase <> 'prepare') OR
     (p_kind IN ('mappings','account_names','vat_defaults','no_documents') AND v_job.job_phase <> 'finalize') THEN
    RAISE EXCEPTION 'SIE metadata in wrong phase' USING ERRCODE = '55000';
  END IF;
  v_hash := encode(extensions.digest(jsonb_build_array(p_kind,p_payload)::text,'sha256'),'hex');
  SELECT * INTO v_checkpoint FROM public.sie_import_chunks
    WHERE import_id = p_import_id AND phase = 'prepare' AND chunk_no = p_chunk_no FOR UPDATE;
  IF FOUND THEN
    IF v_checkpoint.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'SIE metadata retry changed payload' USING ERRCODE = '23505';
    END IF;
    RETURN v_checkpoint.result;
  END IF;
  IF p_kind = 'accounts' THEN
    INSERT INTO public.chart_of_accounts(company_id,user_id,account_number,account_name,account_class,
      account_group,account_type,normal_balance,sru_code,k2_excluded,plan_type,is_active,is_system_account,
      description,sort_order,default_vat_treatment,default_vat_rate)
    SELECT p_company_id,v_actor,r.account_number,r.account_name,r.account_class,r.account_group,
      r.account_type,r.normal_balance,r.sru_code,coalesce(r.k2_excluded,false),'full_bas',true,false,
      r.description,r.sort_order,r.default_vat_treatment,r.default_vat_rate
    FROM jsonb_populate_recordset(NULL::public.chart_of_accounts,p_payload) r
    ON CONFLICT (company_id,account_number) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_result := jsonb_build_object('created',v_count);
  ELSIF p_kind = 'dimensions' THEN
    PERFORM public.ensure_company_dimensions(p_company_id);
    INSERT INTO public.dimensions(company_id,sie_dim_no,parent_sie_dim_no,name,resets_annually,created_by_import_id)
      SELECT p_company_id,r.sie_dim_no,r.parent_sie_dim_no,r.name,r.sie_dim_no <> 6,p_import_id
      FROM jsonb_populate_recordset(NULL::public.dimensions,p_payload) r
      ON CONFLICT (company_id,sie_dim_no) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE public.company_settings SET dimensions_enabled = true WHERE company_id = p_company_id AND NOT dimensions_enabled;
    v_result := jsonb_build_object('created',v_count);
  ELSIF p_kind = 'dimension_values' THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload) r WHERE NOT EXISTS (
      SELECT 1 FROM public.dimensions d WHERE d.company_id = p_company_id AND d.sie_dim_no = (r->>'sie_dim_no')::integer
    )) THEN RAISE EXCEPTION 'SIE dimension missing'; END IF;
    INSERT INTO public.dimension_values(company_id,dimension_id,code,name,created_by_import_id)
      SELECT p_company_id,d.id,r->>'code',r->>'name',p_import_id FROM jsonb_array_elements(p_payload) r
      JOIN public.dimensions d ON d.company_id = p_company_id AND d.sie_dim_no = (r->>'sie_dim_no')::integer
      ON CONFLICT (company_id,dimension_id,code) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_result := jsonb_build_object('created',v_count);
  ELSIF p_kind = 'mappings' THEN
    INSERT INTO public.sie_account_mappings(company_id,user_id,source_account,source_name,target_account,confidence,match_type)
      SELECT p_company_id,v_actor,r.source_account,r.source_name,r.target_account,r.confidence,r.match_type
      FROM jsonb_populate_recordset(NULL::public.sie_account_mappings,p_payload) r
      ON CONFLICT (company_id,source_account) DO UPDATE SET user_id = EXCLUDED.user_id,
        source_name = EXCLUDED.source_name,target_account = EXCLUDED.target_account,
        confidence = EXCLUDED.confidence,match_type = EXCLUDED.match_type;
  ELSIF p_kind = 'account_names' THEN
    -- Snapshot exactly the names this transaction changes, before updating.
    SELECT jsonb_build_object('renamed',coalesce(jsonb_agg(jsonb_build_object(
      'accountNumber',a.account_number,'from',a.account_name,'to',r->>'name')), '[]'::jsonb)) INTO v_result
      FROM jsonb_array_elements(p_payload) r JOIN public.chart_of_accounts a
        ON a.company_id = p_company_id AND a.account_number = r->>'account_number'
      WHERE a.account_name IS DISTINCT FROM r->>'name';
    UPDATE public.chart_of_accounts a SET account_name = r->>'name'
      FROM jsonb_array_elements(p_payload) r WHERE a.company_id = p_company_id
        AND a.account_number = r->>'account_number' AND a.account_name IS DISTINCT FROM r->>'name';
  ELSIF p_kind = 'vat_defaults' THEN
    SELECT jsonb_build_object('vatDefaults',coalesce(jsonb_agg(jsonb_build_object(
      'accountNumber',a.account_number,'fromTreatment',a.default_vat_treatment,'fromRate',a.default_vat_rate,
      'toTreatment',r->>'treatment','toRate',(r->>'rate')::numeric)), '[]'::jsonb)) INTO v_result
      FROM jsonb_array_elements(p_payload) r JOIN public.chart_of_accounts a
        ON a.company_id = p_company_id AND a.account_number = r->>'account_number'
      WHERE a.default_vat_treatment IS DISTINCT FROM r->>'treatment'
        OR a.default_vat_rate IS DISTINCT FROM (r->>'rate')::numeric;
    UPDATE public.chart_of_accounts a SET default_vat_treatment = r->>'treatment',default_vat_rate = (r->>'rate')::numeric
      FROM jsonb_array_elements(p_payload) r WHERE a.company_id = p_company_id AND a.account_number = r->>'account_number';
  ELSIF p_kind = 'no_documents' THEN
    -- Scope to this batch even for a compromised or stale payload.
    INSERT INTO public.journal_entry_no_doc_required(journal_entry_id,company_id,user_id,reason)
      SELECT id,p_company_id,v_actor,'Importerat från tidigare bokföringssystem'
      FROM public.journal_entries WHERE company_id = p_company_id AND import_batch_id = p_import_id
        AND source_type = 'import' AND status = 'posted'
        AND id IN (SELECT (r->>'id')::uuid FROM jsonb_array_elements(p_payload) r)
      ON CONFLICT (journal_entry_id) DO NOTHING;
  END IF;
  INSERT INTO public.sie_import_chunks(import_id,company_id,user_id,phase,chunk_no,payload,payload_hash,state,result,completed_at)
    VALUES(p_import_id,p_company_id,v_actor,'prepare',p_chunk_no,jsonb_build_array(p_kind,p_payload),
      v_hash,'completed',v_result,clock_timestamp());
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_sie_import_metadata(uuid,uuid,uuid,integer,integer,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_sie_import_metadata(uuid,uuid,uuid,integer,integer,text,jsonb) TO service_role;

CREATE FUNCTION public.checkpoint_sie_preparation(p_company_id uuid,p_import_id uuid,
  p_worker_id uuid,p_attempt integer,p_manifest jsonb,p_position integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  v_job := public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  IF v_job.job_phase <> 'prepare' OR p_position < v_job.prepared_through OR
    p_manifest->'input' IS DISTINCT FROM v_job.manifest->'input' OR
    p_manifest->'prior_activity' IS DISTINCT FROM v_job.manifest->'prior_activity' OR
    octet_length(p_manifest::text) > 1000000 THEN RAISE EXCEPTION 'Invalid SIE preparation progress'; END IF;
  UPDATE public.sie_imports SET manifest = p_manifest,prepared_through = p_position WHERE id = p_import_id;
END;
$$;
REVOKE ALL ON FUNCTION public.checkpoint_sie_preparation(uuid,uuid,uuid,integer,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_sie_preparation(uuid,uuid,uuid,integer,jsonb,integer) TO service_role;

CREATE FUNCTION public.resume_sie_import_job(p_company_id uuid,p_import_id uuid,p_actor uuid)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id,p_actor);
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text,0));
  SELECT * INTO v_job FROM public.sie_imports WHERE id = p_import_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR v_job.job_state IS NULL THEN RAISE EXCEPTION 'SIE execution not found' USING ERRCODE = 'P0002'; END IF;
  IF v_job.job_state IN ('completed','undone','failed') THEN RETURN v_job; END IF;
  IF p_actor IS DISTINCT FROM coalesce(v_job.execution_actor_id,v_job.user_id) AND NOT EXISTS (
    SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_actor AND role IN ('owner','admin')
  ) THEN RAISE EXCEPTION 'SIE recovery requires company administrator' USING ERRCODE = '42501'; END IF;
  UPDATE public.sie_imports SET execution_actor_id = p_actor,next_attempt_at = NULL WHERE id = p_import_id;
  RETURN public.reconcile_sie_import(p_company_id,p_import_id,p_actor);
END;
$$;
REVOKE ALL ON FUNCTION public.resume_sie_import_job(uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.resume_sie_import_job(uuid,uuid,uuid) TO authenticated,service_role;

CREATE FUNCTION public.fail_sie_preparation(p_company_id uuid,p_import_id uuid,p_worker_id uuid,p_attempt integer,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  v_job := public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  IF v_job.job_phase <> 'prepare' OR EXISTS (SELECT 1 FROM public.journal_entries WHERE import_batch_id = p_import_id) THEN
    RAISE EXCEPTION 'A SIE job with booked entries cannot be failed';
  END IF;
  UPDATE public.sie_imports SET job_state = 'failed',status = 'failed',error_message = left(p_reason,2000),
    worker_id = NULL,lease_until = NULL WHERE id = p_import_id;
  UPDATE public.fiscal_periods SET import_hold = NULL WHERE id = v_job.fiscal_period_id AND import_hold = p_import_id;
END;
$$;
REVOKE ALL ON FUNCTION public.fail_sie_preparation(uuid,uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fail_sie_preparation(uuid,uuid,uuid,integer,text) TO service_role;

CREATE FUNCTION public.yield_sie_import_job(p_company_id uuid,p_import_id uuid,p_worker_id uuid,p_attempt integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.lock_sie_execution(p_company_id,p_import_id,p_worker_id,p_attempt);
  UPDATE public.sie_imports SET worker_id = NULL,lease_until = NULL WHERE id = p_import_id;
END;
$$;
REVOKE ALL ON FUNCTION public.yield_sie_import_job(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.yield_sie_import_job(uuid,uuid,uuid,integer) TO service_role;

NOTIFY pgrst,'reload schema';

