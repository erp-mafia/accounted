-- An SIE import turns dimensions on when the file brings dimension values.
--
-- apply_sie_import_metadata (20260911140525) turned
-- company_settings.dimensions_enabled on in its 'dimensions' step, which runs
-- for every file that declares a dimension (#DIM). A file can declare
-- dimensions without holding a single cost centre or project, and a company
-- importing such a file got the dimension pickers on every booking form, the
-- register in the menu and the report filters, with nothing to pick in any of
-- them.
--
-- The switch now goes on in the 'dimension_values' step, when the step carries
-- at least one value: a declared object (#OBJEKT), or a code a voucher line
-- or an object balance (#OIB, #OUB) refers to (the import registers those
-- too, lib/import/sie-dimensions.ts). A file that only declares dimensions
-- leaves the switch as it was. The dimensions themselves are still registered
-- either way, so a later file with values, or the switch under Inställningar,
-- finds them.
--
-- The function is otherwise the 20260911140525 text, unchanged. Its grants
-- are restated as they stand. The column comment (20260928200200) said the
-- import turns the switch on "with a notice" whenever it finds dimension
-- data; its last sentence now states the rule above.
--
-- Companies an earlier import switched on with nothing to pick are handled in
-- 20261124200100.
--
-- pg-test: src/lib/import/__tests__/sie-job.pg.test.ts

CREATE OR REPLACE FUNCTION public.apply_sie_import_metadata(p_company_id uuid, p_import_id uuid,
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
    -- The file brought values: the company has something to pick, so the
    -- pickers and the register show.
    IF jsonb_array_length(p_payload) > 0 THEN
      UPDATE public.company_settings SET dimensions_enabled = true WHERE company_id = p_company_id AND NOT dimensions_enabled;
    END IF;
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

COMMENT ON COLUMN public.company_settings.dimensions_enabled IS
  'Per-company dimensions switch (kostnadsställen, projekt). UI: shows the registry, the line pickers and the report filters. Also load-bearing for writes: while true, validateEntryDimensions (src/lib/bookkeeping/dimension-resolver.ts; engine createDraftEntry, updateDraftEntry, replaceOpeningBalanceEntry) and the MCP dimension resolver reject a tag whose dimension is not in the registry or whose code is not an active value of it; while false, tags pass through as free text with no registry check. Not consulted by retag_line_dimensions (always requires active registry values), bulk_book_transactions, reversal/storno/correction or accrual copies, or account_dimension_rules. The bag format (SIE dimension-number keys, 1-40 character codes) is enforced regardless, by the API schema and the jel_dimensions_well_formed CHECK. An SIE import turns it on when the file brings dimension values (a declared object, or a code on a voucher line or an object balance); a file that only declares dimensions leaves it as it was.';
