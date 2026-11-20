-- get_ledger_usage_stats: counterparty patterns for every bank feed.
--
-- counterparty_patterns (ledger_context in the agent briefing and the
-- Accounted://ledger/context resource) grouped booked bank rows by
-- normalize_counterparty_key(merchant_name) and skipped every row without a
-- merchant name. Most bank feeds store the counterparty in the description
-- only: of the companies with 20+ bank rows in 2026, more than half had no
-- merchant name on any row, so their patterns were always empty.
--
-- The key is now taken from the same text the counterparty templates learn
-- from and match on (src/lib/bookkeeping/counterparty-templates.ts): the
-- merchant name, else original_description, else description, kept only
-- when it names someone (grant_names_counterparty, the pinned SQL mirror of
-- namesCounterparty) and its key has two or more characters. The key itself
-- is still normalize_counterparty_key, so it equals
-- categorization_templates.counterparty_name and the template join in
-- src/lib/agent-context/ledger-context.ts stays exact. For a row that has a
-- merchant name, the key is unchanged; only payment-method texts ("Autogiro",
-- "Insättning", "Överföring 5") and one-character keys drop out, as they do
-- from the templates. The display name is cut at 60 characters.
--
-- Output shape, list caps (25) and every other section are unchanged. The
-- body is the production definition (md5 of prosrc compared with
-- 20261028090000_cash_accounts_card_kind before this was written) with only
-- the counterparty_patterns key and one stale comment changed. Same
-- signature, so CREATE OR REPLACE keeps the grants; restated as the last
-- definition did. Function only, no data change.
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
      -- The counterparty is read off the same text the counterparty
      -- templates learn from and match on (counterparty-templates.ts):
      -- the merchant name, else the bank's original description, else the
      -- description. Most bank feeds carry no merchant name, so keying on it
      -- alone left those companies without a single pattern.
      WITH booked AS (
        SELECT
          coalesce(nullif(t.merchant_name, ''), nullif(t.original_description, ''), t.description) AS raw_name,
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
          AND t.date >= p_from_date
      ),
      keyed AS (
        -- As the templates: a text that only says how it was paid ("INTERNET
        -- BET 4", "Insättning") names no one (grant_names_counterparty, the
        -- mirror of namesCounterparty), and a key shorter than two characters
        -- (an all-digit or reference-only label) is no identity. The key is
        -- normalize_counterparty_key, the categorization_templates key.
        SELECT n.counterparty_key, b.raw_name, b.category, b.journal_entry_id, b.date
        FROM booked b
        CROSS JOIN LATERAL (SELECT public.normalize_counterparty_key(b.raw_name) AS counterparty_key) n
        WHERE public.grant_names_counterparty(b.raw_name)
          AND char_length(n.counterparty_key) >= 2
      ),
      totals AS (
        SELECT
          counterparty_key,
          -- A bank's own text can run to 255 characters; 60 keeps the
          -- briefing payload in budget (no merchant name is that long).
          left(mode() WITHIN GROUP (ORDER BY raw_name), 60) AS display_name,
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
            AND NOT EXISTS (SELECT 1 FROM public.cash_accounts ca
              WHERE ca.company_id = p_company_id AND ca.kind = 'card' AND ca.ledger_account = l.account_number)
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
      -- AP-side booking patterns: bank-transaction patterns only see bank
      -- rows, so an invoice-heavy company would be half blind without this.
      -- Supplier identity here is exact (FK), no
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
            AND NOT EXISTS (SELECT 1 FROM public.cash_accounts ca
              WHERE ca.company_id = p_company_id AND ca.kind = 'card' AND ca.ledger_account = i.account_number)
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
