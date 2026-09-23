-- Do not silently attach a new provider party to a same-named entity.
-- Existing source receipts remain authoritative; no business data is rewritten.
CREATE OR REPLACE FUNCTION public.resolve_provider_migration_party(p_job_id uuid,p_resource text,p_source_id text,p_row jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; target uuid; candidates uuid[]; tbl text; row_data jsonb;
BEGIN
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id;
  IF p_resource NOT IN ('customers','suppliers') OR NULLIF(p_source_id,'') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_PARTY_ID_MISSING'; END IF;
  tbl:=p_resource;
  SELECT target_id INTO target FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
    AND account_key=j.account_key AND resource=p_resource AND source_id=p_source_id;
  IF target IS NOT NULL THEN
    EXECUTE format('SELECT array_agg(id) FROM public.%I WHERE id=$1 AND company_id=$2',tbl)
      INTO candidates USING target,j.company_id;
    IF candidates IS NULL THEN RAISE EXCEPTION 'MIGRATION_PARTY_CHANGED'; END IF;
    RETURN target;
  END IF;
  -- Adopt a legacy/native party only with a verified organization identity.
  -- A display name alone is not identity, even when it matches only one row.
  -- Exact provider IDs remain authoritative on every subsequent retry.
  EXECUTE format('SELECT array_agg(id) FROM (SELECT id FROM public.%I p WHERE company_id=$1
    AND CASE WHEN NULLIF(regexp_replace($2->>''org_number'',''[^[:alnum:]]'','''',''g''),'''') IS NOT NULL
      THEN regexp_replace(COALESCE(org_number,''''),''[^[:alnum:]]'','''',''g'')=regexp_replace($2->>''org_number'',''[^[:alnum:]]'','''',''g'')
      ELSE false END
    AND ($6 OR NOT EXISTS(SELECT 1 FROM migration_source_records m WHERE m.company_id=$1 AND m.resource=$3
      AND m.provider=$4 AND m.account_key=$5 AND m.target_id=p.id AND m.source_id NOT LIKE ''invoice-party:%%''))
    LIMIT 2) candidates',tbl)
    INTO candidates USING j.company_id,p_row,p_resource,j.provider,j.account_key,p_source_id LIKE 'invoice-party:%';
  IF cardinality(candidates)>1 THEN RAISE EXCEPTION 'MIGRATION_PARTY_AMBIGUOUS'; END IF;
  target:=candidates[1];
  IF target IS NULL THEN
    row_data:=p_row||jsonb_build_object('company_id',j.company_id,'user_id',j.user_id);
    target:=insert_provider_migration_row(tbl,row_data);
  END IF;
  INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
    VALUES(j.company_id,j.user_id,j.provider,j.account_key,p_resource,p_source_id,target);
  RETURN target;
END $$;
REVOKE ALL ON FUNCTION public.resolve_provider_migration_party(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_provider_migration_party(uuid,text,text,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
