-- The report benchmark's database. THROWAWAY DATABASE ONLY: run it on an
-- empty database where tests/pg/bootstrap.sql, supabase/bootstrap.sql and every
-- migration have been applied; scripts/perf/bench/setup-db.sh does all of it.
--
--   psql -v ON_ERROR_STOP=1 -f scripts/perf/bench/seed.sql
--
-- What it builds (ids in scripts/perf/bench/fixture.ts):
--   * Prestanda AB, the measured company: three fiscal years of per_year
--     verifikat (default 50 000, so 150 000), shaped like the largest
--     companies in production (scripts/perf/README.md, "Report benchmark").
--   * Bygget AB, the company mixed mode rebuilds while the readers run:
--     three years of second_per_year verifikat (default 7 000, so 21 000,
--     the size the build cron takes on in the daytime).
--   * bg_tenants background companies (default 6): copies of the measured
--     company's ledger, registers and documents under their own ids, so a
--     query that loses its company filter reads other companies' rows as it
--     would in production, and the planner sees the measured company as one
--     tenant among several (about 14 % of the verifikat; the largest company
--     in production holds about 7 %).
-- Then the two companies the benchmark reads are built onto the ledger
-- summaries (build_ledger_account_days), every verifikat is checked to
-- balance, and ledger_account_days_drift must be empty for both.
--
-- Variables (psql -v): per_year, second_per_year, bg_tenants.

\set ON_ERROR_STOP 1
\if :{?per_year}
\else
  \set per_year 50000
\endif
\if :{?second_per_year}
\else
  \set second_per_year 7000
\endif
\if :{?bg_tenants}
\else
  \set bg_tenants 6
\endif

SET client_min_messages = warning;
SET maintenance_work_mem = '512MB';
\timing on

\echo 'seed: measured company (Prestanda AB)'
\set co c0000000-0000-4000-8000-000000000001
\set uid a0000000-0000-4000-8000-000000000001
\set email bench@bench.invalid
\set company_name 'Prestanda AB'
\set org_number 5590000001
\set company_per_year :per_year
\set rnd_seed 0.42
\ir seed-company.sql

\echo 'seed: build target for mixed mode (Bygget AB)'
\set co c0000000-0000-4000-8000-000000000002
\set uid a0000000-0000-4000-8000-000000000002
\set email bench-build@bench.invalid
\set company_name 'Bygget AB'
\set org_number 5590000002
\set company_per_year :second_per_year
\set rnd_seed 0.17
\ir seed-company.sql

\echo 'seed: background tenants'
\ir seed-background.sql

\echo 'seed: ledger summaries'
SELECT public.build_ledger_account_days('c0000000-0000-4000-8000-000000000001') AS measured_summary_rows,
       public.build_ledger_account_days('c0000000-0000-4000-8000-000000000002') AS build_target_summary_rows;

-- Every verifikat balances (debits equal credits, both above zero), and the
-- summaries equal the journal for the companies the benchmark reads.
DO $$
DECLARE
  v_unbalanced integer;
  v_drift integer;
BEGIN
  SELECT count(*) INTO v_unbalanced
  FROM (SELECT e.id
        FROM public.journal_entries e JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
        WHERE e.company_id IN ('c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002')
        GROUP BY e.id
        HAVING sum(l.debit_amount) <> sum(l.credit_amount) OR sum(l.debit_amount) <= 0) u;
  IF v_unbalanced <> 0 THEN
    RAISE EXCEPTION 'seed: % verifikat do not balance', v_unbalanced;
  END IF;

  SELECT count(*) INTO v_drift
  FROM (SELECT * FROM public.ledger_account_days_drift('c0000000-0000-4000-8000-000000000001')
        UNION ALL
        SELECT * FROM public.ledger_account_days_drift('c0000000-0000-4000-8000-000000000002')) d;
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'seed: ledger_account_days_drift has % rows that disagree with the journal', v_drift;
  END IF;
END $$;

\echo 'seed: vacuum and analyze'
-- postgres may not vacuum the shared catalogs; their warnings are noise here.
SET client_min_messages = error;
VACUUM (ANALYZE);
SET client_min_messages = warning;

SELECT name, verifikat, share_pct
FROM (SELECT c.id, c.name, count(*) AS verifikat, round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS share_pct
      FROM journal_entries e JOIN companies c ON c.id = e.company_id
      WHERE e.status IN ('posted', 'reversed')
      GROUP BY c.id, c.name) x
WHERE id IN ('c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002')
ORDER BY verifikat DESC;
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
-- The same on every run with the same variables: compare it to check determinism.
SELECT md5(string_agg(concat_ws(':', l.id, e.voucher_number, e.entry_date, l.account_number, l.debit_amount,
                                l.credit_amount, l.dimensions), ',' ORDER BY l.id)) AS measured_journal_checksum
FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id
WHERE e.company_id = 'c0000000-0000-4000-8000-000000000001';
