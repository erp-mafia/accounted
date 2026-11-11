-- SIE import invariant monitor: a scan that still finishes as the ledger grows.
--
-- The weekly /api/import/sie/invariants/cron called
-- check_sie_import_invariants() (20260911140534) as one statement. Its
-- duplicates CTE groups every posted imported voucher of every company by
-- (company_id, fiscal_period_id, source_voucher_series,
-- source_voucher_number). No index fits that grouping and filter:
-- journal_import_source_owned_idx has the columns but covers only
-- import_batch_id IS NOT NULL, so the legacy rows the check exists for are not
-- in it, and idx_journal_entries_source_voucher has neither fiscal_period_id
-- nor the source_type/status filter. Every plan therefore visits the heap row
-- of every imported voucher of every company and aggregates them all in one
-- statement. On 2026-11-09 that hit the function's 30 s statement timeout
-- (57014): the cron threw before it reported anything, so the hold checks and
-- the invoice payment-row check in the same run reported nothing either.
--
-- 1. idx_journal_entries_posted_import_source_voucher: the grouping columns in
--    grouping order, partial on exactly the check's filter. A page of the
--    duplicates query is then a range scan of this index in group order
--    feeding a streaming GroupAggregate: no sort, no hash table, and an
--    index-only scan where the visibility map is set (imported vouchers are
--    rarely updated once posted).
-- 2. check_sie_import_duplicate_vouchers(p_after_company_id, p_company_limit):
--    the same duplicates CTE for one page of companies in id order, so each
--    call is bounded by its page and runs on its own statement budget. A group
--    never spans companies (company_id is part of the key), so the pages
--    partition the groups: the summed counts equal the single-statement
--    counts, and the samples of consecutive pages, in order, start with the
--    same 20 groups the single statement sampled. journal_entries.company_id
--    is NOT NULL and references companies, so the company pages cover every
--    voucher.
-- 3. check_sie_import_job_invariants(): the hold and job checks of
--    20260911140534, copied unchanged, as their own call.
-- 4. check_sie_import_invariants() is dropped: the cron was its only caller,
--    and keeping it would leave a second definition of the same checks.
--
-- What counts as a violation does not change: the WHERE, GROUP BY and HAVING
-- clauses are copied verbatim from 20260911140534; only the company page
-- bound is added.
--
-- Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY cannot run inside the
-- migration transaction (precedent 20260710101000, 20261027060517,
-- 20261031110200). The build holds a SHARE lock on journal_entries: reads go
-- on, writes to journal_entries wait for the build. It scans the heap once
-- (2.43 M rows on production on 2026-10-29) and sorts only the posted
-- imported vouchers. 20261031110200 built two full indexes on this table and
-- its migration took 32 s on production (2026-10-30); expect writes to pause
-- for roughly 10 to 20 s for this one. lock_timeout keeps the build from
-- queueing behind a long transaction, where every later write to
-- journal_entries would queue behind it; on a timeout the migration fails and
-- is re-run (precedent 20261012100500, 20261016001100).
--
-- pg-test: tests/pg/sie-import-invariants.pg.test.ts
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX IF NOT EXISTS idx_journal_entries_posted_import_source_voucher
  ON public.journal_entries (company_id, fiscal_period_id, source_voucher_series, source_voucher_number)
  WHERE source_type = 'import' AND status = 'posted'
    AND source_voucher_series IS NOT NULL AND source_voucher_number IS NOT NULL;

CREATE FUNCTION public.check_sie_import_duplicate_vouchers(
  p_after_company_id uuid DEFAULT NULL,
  p_company_limit integer DEFAULT 500
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
DECLARE
  v_page uuid[];
  v_first uuid;
  v_last uuid;
  v_companies integer;
  v_result jsonb;
BEGIN
  -- The page: the next companies in id order after p_after_company_id. Every
  -- company id between the page's first and last is in the page, so the
  -- range bound below selects exactly the page's vouchers. (Postgres 15 has
  -- no min/max for uuid, hence the ordered array.)
  SELECT array_agg(c.id ORDER BY c.id) INTO v_page
  FROM (
    SELECT id FROM public.companies
    WHERE p_after_company_id IS NULL OR id > p_after_company_id
    ORDER BY id
    LIMIT greatest(coalesce(p_company_limit, 500), 1)
  ) c;
  v_companies := coalesce(cardinality(v_page), 0);
  v_first := v_page[1];
  v_last := v_page[v_companies];

  IF v_companies = 0 THEN
    RETURN jsonb_build_object(
      'companies_checked', 0,
      'last_company_id', p_after_company_id,
      'done', true,
      'duplicate_groups', 0,
      'extra_vouchers', 0,
      'duplicate_samples', '[]'::jsonb
    );
  END IF;

  WITH duplicates AS (
    SELECT company_id,fiscal_period_id,source_voucher_series,source_voucher_number,count(*) n
    FROM public.journal_entries
    WHERE source_type = 'import' AND status = 'posted'
      AND source_voucher_series IS NOT NULL AND source_voucher_number IS NOT NULL
      AND company_id BETWEEN v_first AND v_last
    GROUP BY company_id,fiscal_period_id,source_voucher_series,source_voucher_number HAVING count(*) > 1
  ) SELECT jsonb_build_object(
    'companies_checked', v_companies,
    'last_company_id', v_last,
    'done', NOT EXISTS (SELECT 1 FROM public.companies WHERE id > v_last),
    'duplicate_groups',(SELECT count(*) FROM duplicates),
    'extra_vouchers',(SELECT coalesce(sum(n-1),0) FROM duplicates),
    'duplicate_samples',(SELECT coalesce(jsonb_agg(to_jsonb(d)),'[]'::jsonb) FROM
      (SELECT * FROM duplicates ORDER BY company_id,fiscal_period_id,source_voucher_series,source_voucher_number LIMIT 20) d)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.check_sie_import_duplicate_vouchers(uuid, integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.check_sie_import_duplicate_vouchers(uuid, integer) TO service_role;

CREATE FUNCTION public.check_sie_import_job_invariants() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
  WITH missing_holds AS (
    SELECT j.id FROM public.sie_imports j JOIN public.fiscal_periods p ON p.id=j.fiscal_period_id
    WHERE j.job_state NOT IN ('completed','undone','failed') AND p.import_hold IS DISTINCT FROM j.id
      AND NOT (j.job_state='queued' AND j.supersedes_import_id=p.import_hold)
  ), stale_holds AS (
    SELECT p.id FROM public.fiscal_periods p JOIN public.sie_imports j ON j.id=p.import_hold
    WHERE j.job_state IN ('completed','undone','failed')
  ) SELECT jsonb_build_object(
    'missing_holds',(SELECT count(*) FROM missing_holds),
    'stale_holds',(SELECT count(*) FROM stale_holds),
    'paused_jobs',(SELECT count(*) FROM public.sie_imports WHERE job_state='paused'),
    'expired_leases',(SELECT count(*) FROM public.sie_imports WHERE job_state NOT IN ('completed','undone','failed')
      AND lease_until < clock_timestamp()-interval '10 minutes'),
    'oldest_unresolved',(SELECT min(created_at) FROM public.sie_imports WHERE job_state NOT IN ('completed','undone','failed'))
  );
$$;
REVOKE ALL ON FUNCTION public.check_sie_import_job_invariants() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.check_sie_import_job_invariants() TO service_role;

DROP FUNCTION IF EXISTS public.check_sie_import_invariants();

NOTIFY pgrst, 'reload schema';
