-- Parties, phase 1b: observed parties from the books.
--
-- Migrants arrive with vouchers, not bank transactions, so the existing
-- get_ledger_deep_context (keyed on transactions.merchant_name) is empty for
-- them. This adds the description-keyed twin: a legibility key on top of the
-- frozen normalize_counterparty_key mirror, and an RPC that aggregates posted
-- vouchers by that key. Observed parties are never stored; the register unions
-- this with confirmed parties and dedupes by alias key.
--
-- ledger_key(text) is mirrored in TypeScript by lib/parties/ledger-key.ts and
-- the pair is pinned by tests/pg/observed-parties-rpc.pg.test.ts. Change both
-- or neither.

CREATE OR REPLACE FUNCTION public.ledger_key(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  k text;
  stripped text;
BEGIN
  k := public.normalize_counterparty_key(raw);
  IF k IS NULL OR k = '' THEN RETURN coalesce(k, ''); END IF;
  stripped := k;
  -- AP-register prefixes that Fortnox, Visma and BL put in front of the
  -- vendor. "inköp" is deliberately NOT here: stripping it turns the generic
  -- "inköp av varor" into a vendor-looking "varor" (measured 2026-07-27).
  stripped := regexp_replace(stripped, '^(levfakt|levfkt|leverantörsfaktura från|leverantörsfaktura|levbet|faktura|kvitto|utgift)\s+', '', '');
  -- Supplier number that follows the prefix ("leverantörsfaktura från 18 loopia").
  stripped := regexp_replace(stripped, '^\d{1,5}\s+', '', '');
  -- Trailing short digit runs: supplier numbers whose parentheses the
  -- normaliser already removed ("beijer byggmaterial 097", "varsego 178").
  stripped := regexp_replace(stripped, '(\s+\d{1,3})+$', '', '');
  stripped := btrim(regexp_replace(stripped, '\s+', ' ', 'g'));
  IF stripped = '' THEN RETURN k; END IF;
  RETURN stripped;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ledger_key(text) TO authenticated, service_role;

-- Observed parties: posted vouchers grouped by ledger_key(description).
-- Vouchers that carry a bank transaction with a merchant name are excluded,
-- because get_ledger_deep_context already counts those under the bank key;
-- the register unions the two.
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
  WITH entries AS (
    SELECT je.id, je.entry_date, je.description, public.ledger_key(je.description) AS k
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
  money AS (
    SELECT e.id, e.k, e.entry_date, e.description,
           coalesce(sum(l.debit_amount) FILTER (WHERE l.account_number ~ '^[4-7][0-9]{3}$'), 0) AS expense_sek,
           coalesce(sum(l.credit_amount) FILTER (WHERE l.account_number ~ '^3[0-9]{3}$'), 0) AS revenue_sek
    FROM entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    GROUP BY e.id, e.k, e.entry_date, e.description
    HAVING coalesce(sum(l.debit_amount) FILTER (WHERE l.account_number ~ '^[4-7][0-9]{3}$'), 0) > 0
        OR coalesce(sum(l.credit_amount) FILTER (WHERE l.account_number ~ '^3[0-9]{3}$'), 0) > 0
  ),
  keyed AS (SELECT * FROM money WHERE k <> ''),
  distinct_dates AS (SELECT DISTINCT k, entry_date FROM keyed),
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
    FROM keyed b
    JOIN public.journal_entry_lines l ON l.journal_entry_id = b.id
    WHERE l.account_number ~ '^[3-8][0-9]{3}$'
    GROUP BY b.k, l.account_number
  ),
  acct_totals AS (SELECT k, sum(cnt) AS total FROM acct_counts GROUP BY k),
  dominant AS (
    SELECT DISTINCT ON (ac.k) ac.k, ac.account_number, ac.cnt, at.total
    FROM acct_counts ac JOIN acct_totals at ON at.k = ac.k
    ORDER BY ac.k, ac.cnt DESC, ac.account_number
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
  FROM (
    SELECT * FROM agg
    ORDER BY (expense_sek + revenue_sek) DESC, occurrences DESC, display_name
    LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
  ) a
  LEFT JOIN recur r ON r.k = a.k
  LEFT JOIN dominant d ON d.k = a.k;
$$;

COMMENT ON FUNCTION public.get_observed_parties(uuid, date, integer) IS
  'Observed parties from posted vouchers keyed on ledger_key(description); the description-keyed twin of get_ledger_deep_context for companies without bank feeds. Never stored.';

REVOKE ALL ON FUNCTION public.get_observed_parties(uuid, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_observed_parties(uuid, date, integer) TO authenticated, service_role;
