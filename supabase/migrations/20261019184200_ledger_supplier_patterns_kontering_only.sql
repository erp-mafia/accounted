-- Supplier patterns: a supplier's dominant account is where its invoices
-- book the cost, never the moms row (crm#1310).
--
-- get_ledger_usage_stats.supplier_patterns (the ledger_context an agent is
-- told to prefer over guesses) and get_ledger_deep_context.supplier_entities
-- ("Vad din agent vet") picked a supplier's dominant account by counting the
-- invoices touching each account in supplier_invoice_items, every row
-- included. A row on 2641 is a legal row of its own (the provider migration
-- and register-booked store the source verifikat's ingående moms that way,
-- 20260928150100), and it recurs on every invoice whatever the invoice
-- bought. So it always had the highest count or tied with the cost row, and
-- the account_number tiebreak then picked '2641' over any 4xxx-7xxx account.
-- Measured on production before this migration (12-month window, archived
-- and sandbox companies excluded): 502 of the 1196 supplier patterns that
-- ledger_context showed, in 141 companies, named 26xx, 3740, 244x or 19xx
-- as the dominant account (437 of them 26xx).
--
-- The counterparty branch of the same function had this fixed in
-- 20260708110000 (19xx and 26xx left out of the contra); the supplier branch
-- never got it. The rows are right; the reader counted the wrong ones. Both
-- functions now count the invoice's kontering only and leave out:
--   26xx  moms (every 26xx account is VAT, excise or the VAT settlement
--         account, swedish-vat section 8); the momsbehandling is reported
--         separately as vat_treatment / dominant_vat
--   244x  leverantörsskulder: the skuld leg, never the kontering (a table
--         CHECK since 20260928150100; older rows stay until repaired)
--   19xx  bank and kassa: the settlement leg, as in the counterparty branch
--   3740  öres- och kronutjämning (account-roles 'rounding')
-- A supplier whose rows are all of those (an invoice that is only moms) gets
-- no dominant account instead of a wrong one. A share stays counted over all
-- of the supplier's invoices, so an invoice without a kontering row lowers it.
--
-- Everything else is byte-identical to the live definitions,
-- 20260708120000_ledger_stats_committed_at_lag.sql and
-- 20260726150000_ledger_deep_context_honest_sek_amounts.sql (production's
-- bodies were compared against them, comments and whitespace aside, before
-- this was written). Same signatures, so CREATE OR REPLACE keeps the grants;
-- they are restated.
--
-- pg-test: tests/pg/ledger-usage-stats-rpc.pg.test.ts
-- pg-test: tests/pg/ledger-deep-context-rpc.pg.test.ts

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
          -- The invoice's kontering only. Rows on 26xx (moms), 244x (the
          -- skuld), 19xx (bank) and 3740 (öresavrundning) are legal rows,
          -- booked as they stand (20260928150100), but they recur on every
          -- invoice whatever it bought: counted, a 2641 row ties with the
          -- cost row and wins the account_number tiebreak (crm#1310).
          WHERE i.account_number NOT LIKE '19%'
            AND i.account_number NOT LIKE '244%'
            AND i.account_number NOT LIKE '26%'
            AND i.account_number <> '3740'
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
      -- committed_at (when the voucher was POSTED), not entry_date (the
      -- accounting date the bank flow sets to the transaction date, making
      -- entry_date - date a ~0 tautology). This is real posting promptness.
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY (je.committed_at::date - t.date))
      FROM public.transactions t
      JOIN public.journal_entries je ON je.id = t.journal_entry_id
      WHERE t.company_id = p_company_id
        AND je.status = 'posted'
        -- A legacy transaction still linked to a storno (a reversal posted
        -- long after the transaction) would inject a spurious large lag into
        -- the very metric this migration exists to make honest. Exclude it,
        -- matching account_usage and counterparty_patterns.
        AND je.source_type <> 'storno'
        AND je.committed_at IS NOT NULL
        AND t.date >= p_from_date
    )
  );
$$;

REVOKE ALL ON FUNCTION public.get_ledger_usage_stats(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_usage_stats(uuid, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_ledger_deep_context(
  p_company_id uuid,
  p_from_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'counterparty_entities',
    (
      WITH booked AS (
        SELECT
          public.normalize_counterparty_key(t.merchant_name) AS k,
          t.merchant_name,
          t.journal_entry_id,
          t.date,
          -- SEK, or NULL when no SEK value can be established. NULL is the whole
          -- point: it drops out of sum() below instead of entering the total at
          -- its foreign face value.
          CASE
            -- SEK row: amount_sek is NULL here by design and `amount` already IS
            -- kronor, so this is the pre-existing coalesce untouched.
            WHEN upper(coalesce(nullif(btrim(t.currency), ''), 'SEK')) = 'SEK'
              THEN abs(coalesce(t.amount_sek, t.amount))
            -- Foreign row converted at ingest.
            WHEN t.amount_sek IS NOT NULL
              THEN abs(t.amount_sek)
            -- Foreign row carrying the rate it was recorded at.
            WHEN t.exchange_rate IS NOT NULL AND t.exchange_rate > 0
              THEN round(abs(t.amount) * t.exchange_rate, 2)
            -- Foreign row with neither: unknown in SEK, never assumed.
            ELSE NULL
          END AS amount
        FROM public.transactions t
        JOIN public.journal_entries je ON je.id = t.journal_entry_id
        WHERE t.company_id = p_company_id
          AND t.journal_entry_id IS NOT NULL
          AND je.status = 'posted'
          AND je.source_type <> 'storno'
          AND t.merchant_name IS NOT NULL
          AND trim(t.merchant_name) <> ''
          AND (p_from_date IS NULL OR t.date >= p_from_date)
      ),
      keyed AS (SELECT * FROM booked WHERE k <> ''),
      -- Median gap between distinct booking dates -> recurrence cadence.
      distinct_dates AS (SELECT DISTINCT k, date FROM keyed),
      gaps AS (
        SELECT k, (date - lag(date) OVER (PARTITION BY k ORDER BY date)) AS gap
        FROM distinct_dates
      ),
      recur AS (
        SELECT k, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::int AS cadence_days
        FROM gaps WHERE gap IS NOT NULL GROUP BY k
      ),
      -- Dominant contra account + its share, over the entity's verifikat lines.
      -- Rows with no SEK value stay in here on purpose: which account a booking
      -- went to is a fact that does not depend on the currency.
      acct_counts AS (
        SELECT b.k, l.account_number, count(*)::bigint AS cnt
        FROM keyed b
        JOIN public.journal_entry_lines l ON l.journal_entry_id = b.journal_entry_id
        WHERE l.account_number NOT LIKE '19%'
          AND l.account_number NOT LIKE '26%'
        GROUP BY b.k, l.account_number
      ),
      acct_totals AS (SELECT k, sum(cnt) AS total FROM acct_counts GROUP BY k),
      dominant_account AS (
        SELECT DISTINCT ON (ac.k) ac.k, ac.account_number, ac.cnt, at.total
        FROM acct_counts ac JOIN acct_totals at ON at.k = ac.k
        ORDER BY ac.k, ac.cnt DESC, ac.account_number
      ),
      agg AS (
        SELECT
          k,
          mode() WITHIN GROUP (ORDER BY merchant_name) AS display_name,
          count(*)::bigint AS occurrences,
          count(DISTINCT merchant_name)::int AS variant_count,
          (array_agg(DISTINCT merchant_name))[1:8] AS variants,
          -- sum() skips the NULLs from case 4. COALESCE keeps the field a number
          -- when every row was unconvertible.
          coalesce(sum(amount), 0) AS total_amount,
          (count(*) FILTER (WHERE amount IS NULL))::int AS unconverted_fx_count,
          min(date) AS first_seen,
          max(date) AS last_seen
        FROM keyed GROUP BY k
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', a.display_name,
            'key', a.k,
            'variants', to_jsonb(a.variants),
            'variant_count', a.variant_count,
            'occurrences', a.occurrences,
            'total_amount', round(a.total_amount)::bigint,
            -- Bookings whose SEK value could not be established, and which are
            -- therefore NOT in total_amount above.
            'unconverted_fx_count', a.unconverted_fx_count,
            'first_seen', a.first_seen,
            'last_seen', a.last_seen,
            'cadence_days', r.cadence_days,
            'dominant_account_number', da.account_number,
            -- Laplace-smoothed: n=1 no longer reads as 100%.
            'dominant_account_share',
              CASE WHEN da.total > 0 THEN round((da.cnt + 1)::numeric / (da.total + 2), 2) ELSE NULL END,
            'dominant_account_count', da.cnt,
            'dominant_account_total', da.total
          )
          ORDER BY a.occurrences DESC, a.total_amount DESC, a.display_name
        ),
        '[]'::jsonb
      )
      FROM (SELECT * FROM agg ORDER BY occurrences DESC, total_amount DESC, display_name LIMIT 40) a
      LEFT JOIN recur r ON r.k = a.k
      LEFT JOIN dominant_account da ON da.k = a.k
    ),
    'supplier_entities',
    (
      WITH sinv AS (
        SELECT si.id, si.supplier_id, s.name AS supplier_name,
               si.invoice_date, si.vat_treatment,
               -- Same four cases as the counterparty side. total_sek is NULL on
               -- every foreign invoice registered without an exchange_rate, so
               -- case 4 is the live cohort here, not an edge case.
               CASE
                 WHEN upper(coalesce(nullif(btrim(si.currency), ''), 'SEK')) = 'SEK'
                   THEN coalesce(si.total_sek, si.total, 0)
                 WHEN si.total_sek IS NOT NULL
                   THEN si.total_sek
                 WHEN si.exchange_rate IS NOT NULL AND si.exchange_rate > 0
                   THEN round(coalesce(si.total, 0) * si.exchange_rate, 2)
                 ELSE NULL
               END AS amount
        FROM public.supplier_invoices si
        JOIN public.suppliers s ON s.id = si.supplier_id
        WHERE si.company_id = p_company_id
          AND si.status NOT IN ('reversed', 'credited')
          AND si.is_credit_note = false
          AND (p_from_date IS NULL OR si.invoice_date >= p_from_date)
      ),
      distinct_dates AS (SELECT DISTINCT supplier_id, invoice_date FROM sinv),
      gaps AS (
        SELECT supplier_id,
               (invoice_date - lag(invoice_date) OVER (PARTITION BY supplier_id ORDER BY invoice_date)) AS gap
        FROM distinct_dates
      ),
      recur AS (
        SELECT supplier_id, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::int AS cadence_days
        FROM gaps WHERE gap IS NOT NULL GROUP BY supplier_id
      ),
      acct_counts AS (
        SELECT v.supplier_id, i.account_number, count(DISTINCT v.id)::bigint AS cnt
        FROM sinv v JOIN public.supplier_invoice_items i ON i.supplier_invoice_id = v.id
        -- The invoice's kontering only, as in get_ledger_usage_stats: moms,
        -- skuld, bank and öresavrundning rows are not where the cost goes,
        -- and counted they also inflate dominant_account_total (crm#1310).
        WHERE i.account_number NOT LIKE '19%'
          AND i.account_number NOT LIKE '244%'
          AND i.account_number NOT LIKE '26%'
          AND i.account_number <> '3740'
        GROUP BY v.supplier_id, i.account_number
      ),
      acct_totals AS (SELECT supplier_id, sum(cnt) AS total FROM acct_counts GROUP BY supplier_id),
      dominant_account AS (
        SELECT DISTINCT ON (ac.supplier_id) ac.supplier_id, ac.account_number, ac.cnt, at.total
        FROM acct_counts ac JOIN acct_totals at ON at.supplier_id = ac.supplier_id
        ORDER BY ac.supplier_id, ac.cnt DESC, ac.account_number
      ),
      agg AS (
        SELECT
          supplier_id,
          max(supplier_name) AS supplier_name,
          count(*)::bigint AS occurrences,
          coalesce(sum(amount), 0) AS total_amount,
          (count(*) FILTER (WHERE amount IS NULL))::int AS unconverted_fx_count,
          min(invoice_date) AS first_seen,
          max(invoice_date) AS last_seen,
          mode() WITHIN GROUP (ORDER BY vat_treatment) AS dominant_vat
        FROM sinv GROUP BY supplier_id
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', a.supplier_name,
            'key', a.supplier_id::text,
            'variants', to_jsonb(ARRAY[a.supplier_name]),
            'variant_count', 1,
            'occurrences', a.occurrences,
            'total_amount', round(a.total_amount)::bigint,
            -- Invoices whose SEK total could not be established, and which are
            -- therefore NOT in total_amount above.
            'unconverted_fx_count', a.unconverted_fx_count,
            'first_seen', a.first_seen,
            'last_seen', a.last_seen,
            'cadence_days', r.cadence_days,
            'dominant_account_number', da.account_number,
            -- Laplace-smoothed: n=1 no longer reads as 100%.
            'dominant_account_share',
              CASE WHEN da.total > 0 THEN round((da.cnt + 1)::numeric / (da.total + 2), 2) ELSE NULL END,
            'dominant_account_count', da.cnt,
            'dominant_account_total', da.total,
            'dominant_vat', a.dominant_vat
          )
          ORDER BY a.occurrences DESC, a.total_amount DESC, a.supplier_name
        ),
        '[]'::jsonb
      )
      FROM (SELECT * FROM agg ORDER BY occurrences DESC, total_amount DESC, supplier_name LIMIT 20) a
      LEFT JOIN recur r ON r.supplier_id = a.supplier_id
      LEFT JOIN dominant_account da ON da.supplier_id = a.supplier_id
    )
  );
$$;

COMMENT ON FUNCTION public.get_ledger_deep_context(uuid, date) IS
  'Deep entity-resolved ledger analysis behind "Vad din agent vet". total_amount is SEK only: a non-SEK row with neither a stored SEK value nor an exchange_rate is excluded from the sum and from the total_amount sort key, and counted in unconverted_fx_count instead of being added at its foreign face value. occurrences, cadence_days and the dominant-account pick are currency-free and still include those rows.';

REVOKE ALL ON FUNCTION public.get_ledger_deep_context(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_deep_context(uuid, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
