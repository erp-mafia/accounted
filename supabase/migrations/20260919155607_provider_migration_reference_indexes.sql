-- Keep foreign-key lookups bounded as retained import history grows.
CREATE INDEX migration_job_chunks_job_company
  ON public.migration_job_chunks(job_id,company_id);
CREATE INDEX migration_jobs_consent
  ON public.migration_jobs(consent_id);
CREATE INDEX migration_jobs_user
  ON public.migration_jobs(user_id);
CREATE INDEX migration_source_records_user
  ON public.migration_source_records(user_id);
NOTIFY pgrst,'reload schema';
