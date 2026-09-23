-- Keep observed-party reads within the authenticated statement timeout after imports.
-- Preserve eligibility, full-history aggregates, ordering, rounding and the 1000-key cap.
-- pg-test: covered-by tests/pg/observed-parties-rpc.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_observed_parties(
  p_company_id uuid,
  p_from_date date DEFAULT NULL,
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH entries AS MATERIALIZED (
    SELECT je.id, je.entry_date, je.description
    FROM public.journal_entries je
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.source_type NOT IN ('storno', 'opening_balance', 'year_end', 'vat_settlement')
      AND (p_from_date IS NULL OR je.entry_date >= p_from_date)
      AND je.description IS NOT NULL
      AND btrim(je.description) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.transactions t
        WHERE t.journal_entry_id = je.id
          AND t.merchant_name IS NOT NULL
          AND btrim(t.merchant_name) <> ''
      )
  ),
  -- Money per voucher, already SEK on journal_entry_lines: expense = debit
  -- on 4xxx-7xxx, revenue = credit on 3xxx. Vouchers with neither (pure
  -- balance-sheet movements) are not parties' business.
  -- Retain account multiplicity while reading each voucher's lines once.
  money AS MATERIALIZED (
    SELECT e.id, e.entry_date, e.description,
           array_agg(l.account_number) FILTER (WHERE l.account_number ~ '^[3-8][0-9]{3}$') AS result_accounts,
           coalesce(sum(l.debit_amount) FILTER (WHERE l.account_number ~ '^[4-7][0-9]{3}$'), 0) AS expense_sek,
           coalesce(sum(l.credit_amount) FILTER (WHERE l.account_number ~ '^3[0-9]{3}$'), 0) AS revenue_sek
    FROM entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    -- Every contributing account is in this range. The existing entry/account
    -- index can exclude balance-sheet lines before their per-line RLS check.
    -- Keep the exact regexes above: non-four-digit account strings still do not count.
    WHERE l.account_number >= '3000' AND l.account_number < '9000'
    GROUP BY e.id, e.entry_date, e.description
    HAVING coalesce(sum(l.debit_amount) FILTER (WHERE l.account_number ~ '^[4-7][0-9]{3}$'), 0) > 0
        OR coalesce(sum(l.credit_amount) FILTER (WHERE l.account_number ~ '^3[0-9]{3}$'), 0) > 0
  ),
  -- Normalize once per distinct eligible description, after money filtering.
  -- Materialization prevents inlining the normalizer back into the line join.
  descriptions AS MATERIALIZED (
    SELECT description, public.ledger_key(description) AS k
    FROM (SELECT DISTINCT description FROM money) d
  ),
  keyed AS MATERIALIZED (
    SELECT m.*, d.k FROM money m JOIN descriptions d USING (description) WHERE d.k <> ''
  ),
  agg AS (
    SELECT k,
           mode() WITHIN GROUP (ORDER BY description) AS display_name,
           count(*)::bigint AS occurrences,
           count(DISTINCT description)::int AS variant_count,
           (array_agg(DISTINCT description))[1:8] AS variants,
           sum(expense_sek) AS expense_sek,
           sum(revenue_sek) AS revenue_sek,
           min(entry_date) AS first_seen,
           max(entry_date) AS last_seen
    FROM keyed
    GROUP BY k
  ),
  -- Ranking uses the complete history. Enrich only the returned keys below.
  selected AS MATERIALIZED (
    SELECT * FROM agg ORDER BY (expense_sek + revenue_sek) DESC, occurrences DESC, display_name
    LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
  ),
  selected_entries AS MATERIALIZED (
    SELECT k.* FROM keyed k JOIN selected s ON s.k = k.k
  ),
  distinct_dates AS (SELECT DISTINCT k, entry_date FROM selected_entries),
  gaps AS (
    SELECT k, (entry_date - lag(entry_date) OVER (PARTITION BY k ORDER BY entry_date)) AS gap
    FROM distinct_dates
  ),
  recur AS (
    SELECT k, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::int AS cadence_days
    FROM gaps WHERE gap IS NOT NULL GROUP BY k
  ),
  -- Dominant result account (3xxx-8xxx) and its Laplace-smoothed share.
  acct_counts AS (
    SELECT b.k, l.account_number, count(*)::bigint AS cnt
    FROM selected_entries b
    CROSS JOIN LATERAL unnest(b.result_accounts) AS l(account_number)
    GROUP BY b.k, l.account_number
  ),
  acct_totals AS (SELECT k, sum(cnt) AS total FROM acct_counts GROUP BY k),
  dominant AS (
    SELECT DISTINCT ON (ac.k) ac.k, ac.account_number, ac.cnt, at.total
    FROM acct_counts ac JOIN acct_totals at ON at.k = ac.k
    ORDER BY ac.k, ac.cnt DESC, ac.account_number
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'key', a.k,
        'name', a.display_name,
        'variants', to_jsonb(a.variants),
        'variant_count', a.variant_count,
        'occurrences', a.occurrences,
        'expense_sek', round(a.expense_sek)::bigint,
        'revenue_sek', round(a.revenue_sek)::bigint,
        'first_seen', a.first_seen,
        'last_seen', a.last_seen,
        'cadence_days', r.cadence_days,
        'dominant_account_number', d.account_number,
        'dominant_account_share',
          CASE WHEN d.total > 0 THEN round((d.cnt + 1)::numeric / (d.total + 2), 2) ELSE NULL END,
        'dominant_account_count', d.cnt,
        'dominant_account_total', d.total
      )
      ORDER BY (a.expense_sek + a.revenue_sek) DESC, a.occurrences DESC, a.display_name
    ),
    '[]'::jsonb
  )
  FROM selected a
  LEFT JOIN recur r ON r.k = a.k
  LEFT JOIN dominant d ON d.k = a.k;
$$;

REVOKE ALL ON FUNCTION public.get_observed_parties(uuid, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_observed_parties(uuid, date, integer) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
