-- Service-only invariant checks. The legacy source constraint is installed
-- after the separately approved repair; this check covers those rows too.
CREATE FUNCTION public.check_sie_import_invariants() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
  WITH duplicates AS (
    SELECT company_id,fiscal_period_id,source_voucher_series,source_voucher_number,count(*) n
    FROM public.journal_entries
    WHERE source_type = 'import' AND status = 'posted'
      AND source_voucher_series IS NOT NULL AND source_voucher_number IS NOT NULL
    GROUP BY company_id,fiscal_period_id,source_voucher_series,source_voucher_number HAVING count(*) > 1
  ), missing_holds AS (
    SELECT j.id FROM public.sie_imports j JOIN public.fiscal_periods p ON p.id=j.fiscal_period_id
    WHERE j.job_state NOT IN ('completed','undone','failed') AND p.import_hold IS DISTINCT FROM j.id
      AND NOT (j.job_state='queued' AND j.supersedes_import_id=p.import_hold)
  ), stale_holds AS (
    SELECT p.id FROM public.fiscal_periods p JOIN public.sie_imports j ON j.id=p.import_hold
    WHERE j.job_state IN ('completed','undone','failed')
  ) SELECT jsonb_build_object(
    'duplicate_groups',(SELECT count(*) FROM duplicates),
    'extra_vouchers',(SELECT coalesce(sum(n-1),0) FROM duplicates),
    'duplicate_samples',(SELECT coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb) FROM
      (SELECT * FROM duplicates ORDER BY company_id,fiscal_period_id,source_voucher_series,source_voucher_number LIMIT 20) d),
    'missing_holds',(SELECT count(*) FROM missing_holds),
    'stale_holds',(SELECT count(*) FROM stale_holds),
    'paused_jobs',(SELECT count(*) FROM public.sie_imports WHERE job_state='paused'),
    'expired_leases',(SELECT count(*) FROM public.sie_imports WHERE job_state NOT IN ('completed','undone','failed')
      AND lease_until < clock_timestamp()-interval '10 minutes'),
    'oldest_unresolved',(SELECT min(created_at) FROM public.sie_imports WHERE job_state NOT IN ('completed','undone','failed'))
  );
$$;
REVOKE ALL ON FUNCTION public.check_sie_import_invariants() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.check_sie_import_invariants() TO service_role;

