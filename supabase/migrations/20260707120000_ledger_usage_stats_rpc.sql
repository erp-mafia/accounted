-- RPC: get_ledger_usage_stats — windowed booking-pattern aggregates for the
-- agent ledger-context resource (Accounted://ledger/context).
--
-- Returns one jsonb document with four sections:
--   account_usage:            top 20 accounts by posted-line count in the
--                             window, with account_name and last_used date
--   counterparty_patterns:    top 25 booked counterparties by occurrence, with
--                             dominant category (+ share), dominant non-bank
--                             contra account, and last booked date
--   vat_treatments_used:      distinct vat_treatment values on invoices and
--                             supplier invoices in the window
--   median_booking_lag_days:  median(entry_date - transaction date) across
--                             booked transactions in the window (honesty
--                             signal: how promptly this company books)
--
-- PostgREST cannot GROUP BY through supabase-js, and paging a year of
-- journal_entry_lines through fetchAllRows to aggregate in JS does not scale.
-- One SQL round trip keeps the resource read cheap enough to compute per
-- request (design: dev_docs/ledger_context_resource.md, phase 1 = no cache).
--
-- Only status = 'posted' entries count: the resource describes how this
-- company actually books things, and drafts are not yet bookings. (Contrast
-- get_account_usage_counts, which includes drafts because it answers a
-- deletion-safety question.)
--
-- Dominant contra account excludes 19xx (bank/cash): for bank-sourced
-- bookings the 19xx side is the constant, so the informative side is the
-- other one. vat_treatment is NOT derived here; the lib layer merges it from
-- categorization_templates, which carry it explicitly.
--
-- SECURITY INVOKER: journal_entries/journal_entry_lines/transactions RLS is
-- company-scoped via user_company_ids() (20260330130000), so the caller's own
-- membership bounds what is aggregated; a non-member calling with a foreign
-- company id gets empty sections, not an error.
--
-- pg-test: tests/pg/ledger-usage-stats-rpc.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_ledger_usage_stats(
  p_company_id uuid,
  p_from_date date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'account_usage',
    (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'account_number', au.account_number,
            'account_name', au.account_name,
            'postings', au.postings,
            'last_used', au.last_used
          )
          ORDER BY au.postings DESC, au.account_number
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT
          l.account_number,
          max(coa.account_name) AS account_name,
          count(*)::bigint AS postings,
          max(je.entry_date) AS last_used
        FROM public.journal_entry_lines l
        JOIN public.journal_entries je ON je.id = l.journal_entry_id
        LEFT JOIN public.chart_of_accounts coa
          ON coa.company_id = p_company_id
         AND coa.account_number = l.account_number
        WHERE je.company_id = p_company_id
          AND je.status = 'posted'
          AND je.entry_date >= p_from_date
        GROUP BY l.account_number
        ORDER BY count(*) DESC, l.account_number
        LIMIT 20
      ) au
    ),
    'counterparty_patterns',
    (
      WITH booked AS (
        SELECT
          lower(trim(t.merchant_name)) AS counterparty_key,
          t.merchant_name,
          t.category,
          t.journal_entry_id,
          t.date
        FROM public.transactions t
        JOIN public.journal_entries je ON je.id = t.journal_entry_id
        WHERE t.company_id = p_company_id
          AND t.journal_entry_id IS NOT NULL
          AND je.status = 'posted'
          AND t.merchant_name IS NOT NULL
          AND trim(t.merchant_name) <> ''
          AND t.date >= p_from_date
      ),
      totals AS (
        SELECT
          counterparty_key,
          mode() WITHIN GROUP (ORDER BY merchant_name) AS display_name,
          count(*)::bigint AS occurrences,
          max(date) AS last_booked
        FROM booked
        GROUP BY counterparty_key
      ),
      dominant_category AS (
        SELECT DISTINCT ON (counterparty_key)
          counterparty_key,
          category,
          cnt
        FROM (
          SELECT counterparty_key, category, count(*)::bigint AS cnt
          FROM booked
          WHERE category IS NOT NULL AND category <> 'uncategorized'
          GROUP BY counterparty_key, category
        ) c
        ORDER BY counterparty_key, cnt DESC, category
      ),
      dominant_account AS (
        SELECT DISTINCT ON (counterparty_key)
          counterparty_key,
          account_number
        FROM (
          SELECT b.counterparty_key, l.account_number, count(*)::bigint AS cnt
          FROM booked b
          JOIN public.journal_entry_lines l ON l.journal_entry_id = b.journal_entry_id
          WHERE l.account_number NOT LIKE '19%'
          GROUP BY b.counterparty_key, l.account_number
        ) a
        ORDER BY counterparty_key, cnt DESC, account_number
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'counterparty', t.display_name,
            'occurrences', t.occurrences,
            'last_booked', t.last_booked,
            'dominant_category', dc.category,
            'dominant_category_count', coalesce(dc.cnt, 0),
            'dominant_account_number', da.account_number
          )
          ORDER BY t.occurrences DESC, t.display_name
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT * FROM totals ORDER BY occurrences DESC, display_name LIMIT 25
      ) t
      LEFT JOIN dominant_category dc ON dc.counterparty_key = t.counterparty_key
      LEFT JOIN dominant_account da ON da.counterparty_key = t.counterparty_key
    ),
    'vat_treatments_used',
    (
      SELECT coalesce(jsonb_agg(DISTINCT vt), '[]'::jsonb)
      FROM (
        SELECT i.vat_treatment AS vt
        FROM public.invoices i
        WHERE i.company_id = p_company_id
          AND i.invoice_date >= p_from_date
          AND i.vat_treatment IS NOT NULL
        UNION
        SELECT si.vat_treatment AS vt
        FROM public.supplier_invoices si
        WHERE si.company_id = p_company_id
          AND si.invoice_date >= p_from_date
          AND si.vat_treatment IS NOT NULL
      ) treatments
    ),
    'median_booking_lag_days',
    (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (je.entry_date - t.date))
      FROM public.transactions t
      JOIN public.journal_entries je ON je.id = t.journal_entry_id
      WHERE t.company_id = p_company_id
        AND je.status = 'posted'
        AND t.date >= p_from_date
    )
  );
$$;

REVOKE ALL ON FUNCTION public.get_ledger_usage_stats(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_usage_stats(uuid, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
