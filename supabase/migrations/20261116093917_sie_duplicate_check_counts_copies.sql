-- SIE duplicate voucher check: count copies, and alert only on copies the
-- import engine of today can still make.
--
-- check_sie_import_duplicate_vouchers (20261110094517) counted every group of
-- posted imported vouchers sharing company, fiscal period, source series and
-- source number, and the weekly cron answered 503 on any group. Its first
-- finished run (2026-11-16) found 4,961 groups, and none of them was a new
-- problem:
--
-- 1. 107 groups were no copies at all: different vouchers that reuse a source
--    number inside one fiscal year (a first fiscal year longer than twelve
--    months, where the old system restarts its numbering each calendar year,
--    or two source years in one file). Their dates differ.
-- 2. 4,861 groups were real copies, two whole SIE files imported twice on
--    2026-09-07 and 2026-09-11, before imports had a durable batch identity
--    (#2532, 2026-09-14). Those vouchers carry no import_batch_id, and no such
--    voucher can be posted any more: guard_sie_entry_provenance
--    (20260911140515) refuses an imported voucher without a batch, and
--    journal_import_source_owned_idx refuses a second batch-owned posted
--    voucher with the same source identity in a fiscal year. The set of
--    legacy copies can only shrink (storno or undo), so a weekly alert on it
--    repeats the same news until someone repairs books the founders decided
--    to leave alone.
--
-- What counts now:
-- - A copy group: two or more posted imported vouchers of one company and
--   fiscal period with the same source series, number and voucher date. The
--   date tells a reused number apart from the same source voucher posted
--   twice; full content (sie_repair_content_hash) would also miss a second
--   import under a different account mapping, which double counts just the
--   same. On 2026-11-16 the two keys gave the same 4,861 groups.
-- - duplicate_groups / extra_vouchers / duplicate_samples: the copy groups
--   that hold a batch-owned voucher, the only ones the import engine can
--   still create. These make the cron answer 503.
-- - legacy_duplicate_groups / legacy_extra_vouchers: copy groups made only of
--   pre-batch vouchers, reported in the run log, never alerted.
--
-- The page bound, the signature, the grants and the first grouping (it still
-- streams off idx_journal_entries_posted_import_source_voucher) are
-- unchanged; the copy step only reads the candidate groups back by the same
-- index.
--
-- pg-test: tests/pg/sie-import-invariants.pg.test.ts
CREATE OR REPLACE FUNCTION public.check_sie_import_duplicate_vouchers(
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
      'duplicate_samples', '[]'::jsonb,
      'legacy_duplicate_groups', 0,
      'legacy_extra_vouchers', 0
    );
  END IF;

  WITH shared_numbers AS (
    SELECT company_id,fiscal_period_id,source_voucher_series,source_voucher_number
    FROM public.journal_entries
    WHERE source_type = 'import' AND status = 'posted'
      AND source_voucher_series IS NOT NULL AND source_voucher_number IS NOT NULL
      AND company_id BETWEEN v_first AND v_last
    GROUP BY company_id,fiscal_period_id,source_voucher_series,source_voucher_number HAVING count(*) > 1
  ), copies AS (
    SELECT j.company_id,j.fiscal_period_id,j.source_voucher_series,j.source_voucher_number,j.entry_date,
      count(*) AS n,bool_or(j.import_batch_id IS NOT NULL) AS batch_owned
    FROM shared_numbers s
    JOIN public.journal_entries j ON j.company_id = s.company_id AND j.fiscal_period_id = s.fiscal_period_id
      AND j.source_voucher_series = s.source_voucher_series AND j.source_voucher_number = s.source_voucher_number
    WHERE j.source_type = 'import' AND j.status = 'posted'
      AND j.source_voucher_series IS NOT NULL AND j.source_voucher_number IS NOT NULL
    GROUP BY j.company_id,j.fiscal_period_id,j.source_voucher_series,j.source_voucher_number,j.entry_date
    HAVING count(*) > 1
  ) SELECT jsonb_build_object(
    'companies_checked', v_companies,
    'last_company_id', v_last,
    'done', NOT EXISTS (SELECT 1 FROM public.companies WHERE id > v_last),
    'duplicate_groups',(SELECT count(*) FROM copies WHERE batch_owned),
    'extra_vouchers',(SELECT coalesce(sum(n-1),0) FROM copies WHERE batch_owned),
    'duplicate_samples',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.company_id,d.fiscal_period_id,
        d.source_voucher_series,d.source_voucher_number,d.entry_date),'[]'::jsonb) FROM
      (SELECT company_id,fiscal_period_id,source_voucher_series,source_voucher_number,entry_date,n FROM copies
       WHERE batch_owned
       ORDER BY company_id,fiscal_period_id,source_voucher_series,source_voucher_number,entry_date LIMIT 20) d),
    'legacy_duplicate_groups',(SELECT count(*) FROM copies WHERE NOT batch_owned),
    'legacy_extra_vouchers',(SELECT coalesce(sum(n-1),0) FROM copies WHERE NOT batch_owned)
  ) INTO v_result;

  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.check_sie_import_duplicate_vouchers(uuid, integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.check_sie_import_duplicate_vouchers(uuid, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
