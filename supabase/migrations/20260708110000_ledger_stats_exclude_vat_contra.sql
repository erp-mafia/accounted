-- Fix: exclude VAT/settlement accounts (26xx) from the counterparty dominant
-- contra account in get_ledger_usage_stats.
--
-- 20260707120000 excluded only 19xx (bank/cash) from the dominant-contra pick.
-- On a reverse-charge EU purchase (the common case for foreign SaaS: Google,
-- ngrok, Supabase, ...) the booked lines are:
--   Dr 5420 expense · Dr 2645 calc input VAT · Cr 2614 calc output VAT · Cr 1930 bank
-- After excluding 19xx, the three remaining accounts tie at equal line counts,
-- and `ORDER BY cnt DESC, account_number` then picks the LOWEST number, 2614, a
-- reverse-charge VAT account, over the informative expense 5420. Verified on
-- prod: for the "google"/"ngrok"/"supabase" counterparty keys the dominant
-- account came out 2614 instead of 5420. 26xx is exclusively moms in BAS and
-- never characterizes a counterparty, so exclude it the same way 19xx is
-- excluded. (Loan/tax counterparties book to 23xx/24xx/25xx/27xx, which stay
-- eligible, so ALMI-style loan accounts still surface correctly.)
--
-- The supplier_patterns side is unaffected: it aggregates
-- supplier_invoice_items.account_number, which is the expense account only
-- (4xxx-6xxx); VAT there lives on the invoice header, not as a 26xx line.
--
-- CREATE OR REPLACE, no signature change. normalize_counterparty_key is
-- unchanged and not redefined here.
--
-- pg-test: tests/pg/ledger-usage-stats-rpc.pg.test.ts (reverse-charge case)

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
          -- Stornos annul: counting their swapped lines re-inflates the
          -- account the correction moved away from. Corrections stay.
          AND je.source_type <> 'storno'
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
          public.normalize_counterparty_key(t.merchant_name) AS counterparty_key,
          t.merchant_name,
          t.category,
          t.journal_entry_id,
          t.date
        FROM public.transactions t
        JOIN public.journal_entries je ON je.id = t.journal_entry_id
        WHERE t.company_id = p_company_id
          AND t.journal_entry_id IS NOT NULL
          AND je.status = 'posted'
          -- Defensive: no code path should link a transaction to a storno
          -- (correctEntry relinks to the correction, reverseEntry unlinks),
          -- but legacy rows may predate the unlink behavior. Corrections are
          -- deliberately NOT excluded: they are the live booking.
          AND je.source_type <> 'storno'
          AND t.merchant_name IS NOT NULL
          AND trim(t.merchant_name) <> ''
          AND t.date >= p_from_date
      ),
      keyed AS (
        -- All-digit/reference-only merchant labels normalize to '': no
        -- identity, no pattern.
        SELECT * FROM booked WHERE counterparty_key <> ''
      ),
      totals AS (
        SELECT
          counterparty_key,
          mode() WITHIN GROUP (ORDER BY merchant_name) AS display_name,
          count(*)::bigint AS occurrences,
          max(date) AS last_booked
        FROM keyed
        GROUP BY counterparty_key
      ),
      dominant_category AS (
        SELECT DISTINCT ON (counterparty_key)
          counterparty_key,
          category,
          cnt
        FROM (
          SELECT counterparty_key, category, count(*)::bigint AS cnt
          FROM keyed
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
          FROM keyed b
          JOIN public.journal_entry_lines l ON l.journal_entry_id = b.journal_entry_id
          WHERE l.account_number NOT LIKE '19%'
            -- Exclude VAT accounts (26xx): on a reverse-charge purchase the
            -- expense, 2645 and 2614 lines tie, and the account_number
            -- tiebreak would otherwise pick the low VAT number over the
            -- expense. 26xx is always moms, never the informative contra.
            AND l.account_number NOT LIKE '26%'
          GROUP BY b.counterparty_key, l.account_number
        ) a
        ORDER BY counterparty_key, cnt DESC, account_number
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'counterparty', t.display_name,
            'counterparty_key', t.counterparty_key,
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
    'supplier_patterns',
    (
      -- AP-side booking patterns: bank-transaction patterns only see rows
      -- with a merchant_name, so an invoice-heavy company would be half
      -- blind without this. Supplier identity here is exact (FK), no
      -- normalization needed.
      WITH sinv AS (
        SELECT si.id, si.supplier_id, s.name AS supplier_name,
               si.invoice_date, si.vat_treatment
        FROM public.supplier_invoices si
        JOIN public.suppliers s ON s.id = si.supplier_id
        WHERE si.company_id = p_company_id
          AND si.invoice_date >= p_from_date
          -- Reversed bookings and credited invoices are undone business;
          -- credit notes repeat their original's accounts with flipped sign.
          AND si.status NOT IN ('reversed', 'credited')
          AND si.is_credit_note = false
      ),
      totals AS (
        SELECT
          supplier_id,
          max(supplier_name) AS supplier_name,
          count(*)::bigint AS invoices,
          max(invoice_date) AS last_invoice,
          mode() WITHIN GROUP (ORDER BY vat_treatment) AS dominant_vat
        FROM sinv
        GROUP BY supplier_id
      ),
      dominant_account AS (
        -- Invoices (not lines) touching each account, so a many-line invoice
        -- does not outvote ten single-line ones.
        SELECT DISTINCT ON (supplier_id)
          supplier_id,
          account_number,
          cnt
        FROM (
          SELECT v.supplier_id, i.account_number, count(DISTINCT v.id)::bigint AS cnt
          FROM sinv v
          JOIN public.supplier_invoice_items i ON i.supplier_invoice_id = v.id
          GROUP BY v.supplier_id, i.account_number
        ) a
        ORDER BY supplier_id, cnt DESC, account_number
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'supplier', t.supplier_name,
            'invoices', t.invoices,
            'last_invoice', t.last_invoice,
            'vat_treatment', t.dominant_vat,
            'dominant_account_number', da.account_number,
            'dominant_account_count', coalesce(da.cnt, 0)
          )
          ORDER BY t.invoices DESC, t.supplier_name
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT * FROM totals ORDER BY invoices DESC, supplier_name LIMIT 15
      ) t
      LEFT JOIN dominant_account da ON da.supplier_id = t.supplier_id
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
