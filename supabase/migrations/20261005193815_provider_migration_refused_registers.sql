-- A provider can refuse ONE register of a migration while the same connection
-- keeps answering for the others. Fortnox answers 2001101 ("Det finns ingen
-- aktiv licens för önskat scope": the company's plan lacks the module the
-- register needs, Kundfaktura or Order for customers and customer invoices)
-- or 2000663 / a 403 (the Fortnox user who connected lacks the right to it).
-- No retry changes either answer. The durable worker used to treat it like a
-- timeout: five attempts over about four minutes, then the whole job parked
-- in needs_attention at discover, so nothing was imported, not even the
-- registers the provider did hand out (PH 149, PH 145).
--
-- The job now records the refusal and moves on: the register is named in
-- refused_resources with why ('license' or 'permission'), the cursor advances
-- exactly as save_provider_migration_page advances it after a register's last
-- page, and the remaining registers import. The wizard reads
-- refused_resources to tell the user what to do.

ALTER TABLE public.migration_jobs
  ADD COLUMN refused_resources jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT migration_jobs_refused_resources_object CHECK (jsonb_typeof(refused_resources) = 'object');

CREATE FUNCTION public.skip_provider_migration_resource(p_job_id uuid,p_worker_id uuid,p_attempt integer,
  p_resource text,p_page integer,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('license','permission') THEN
    RAISE EXCEPTION 'MIGRATION_REFUSAL_REASON_INVALID';
  END IF;
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  -- The cursor fence of save_provider_migration_page: only the register and
  -- page this attempt was reading can be skipped, and only once.
  IF j.phase<>'discover' OR j.resources[j.resource_index] IS DISTINCT FROM p_resource
    OR j.next_page IS DISTINCT FROM p_page THEN
    RAISE EXCEPTION 'MIGRATION_CURSOR_CONFLICT';
  END IF;
  -- Pages of this register saved before the refusal stay and import.
  UPDATE migration_jobs SET refused_resources=refused_resources||jsonb_build_object(p_resource,p_reason),
    resource_index=resource_index+1,next_page=1,
    phase=CASE WHEN resource_index=cardinality(resources) THEN 'import' ELSE 'discover' END,
    failures=0,error_code=NULL WHERE id=j.id;
END $$;

REVOKE ALL ON FUNCTION public.skip_provider_migration_resource(uuid,uuid,integer,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.skip_provider_migration_resource(uuid,uuid,integer,text,integer,text) TO service_role;

NOTIFY pgrst,'reload schema';
