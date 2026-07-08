-- RPC: get_ledger_usage_stats — windowed booking-pattern aggregates for the
-- agent ledger-context resource (Accounted://ledger/context).
--
-- Returns one jsonb document with five sections:
--   account_usage:            top 20 accounts by posted-line count in the
--                             window, with account_name and last_used date
--   counterparty_patterns:    top 25 booked counterparties by occurrence, with
--                             dominant category (+ agree count), dominant
--                             non-bank contra account, and last booked date
--   supplier_patterns:        top 15 suppliers by invoice count in the window,
--                             with dominant expense account (+ agree count)
--                             and dominant vat_treatment
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
-- Storno handling, deliberately asymmetric:
--   - Stornos are excluded everywhere (account_usage by their swapped lines
--     re-inflating the account a human corrected AWAY from; the counterparty
--     CTE defensively, for legacy rows linked before reverseEntry() started
--     unlinking transactions).
--   - Corrections are excluded NOWHERE: correctEntry() relinks
--     transactions.journal_entry_id to the correction entry, making it the
--     live booking. Excluding 'correction' would drop exactly the booking
--     the human fixed.
--
-- Counterparties are keyed on normalize_counterparty_key(), the SQL mirror of
-- normalizeCounterpartyName() (lib/bookkeeping/counterparty-templates.ts), so
-- "SWISH KLARNA AB", "Klarna AB 2026-06-01" and "KLARNA AB" aggregate as one
-- counterparty instead of splintering and diluting every count. The key is
-- also returned so the lib layer can join categorization_templates (whose
-- counterparty_name is stored in the same normalized form) exactly.
-- This string key is the deliberate interim identity: it re-keys to
-- counterparty_entity.id when the identity substrate lands
-- (dev_docs/bank_transaction_ai_normalization.md §14, Layer F).
--
-- Dominant contra account excludes 19xx (bank/cash): for bank-sourced
-- bookings the 19xx side is the constant, so the informative side is the
-- other one. Transaction-side vat_treatment is NOT derived here; the lib
-- layer merges it from categorization_templates, which carry it explicitly.
-- Supplier-side vat_treatment IS derived here (supplier_invoices carry it).
--
-- SECURITY INVOKER: journal_entries/journal_entry_lines/transactions RLS is
-- company-scoped via user_company_ids() (20260330130000), so the caller's own
-- membership bounds what is aggregated; a non-member calling with a foreign
-- company id gets empty sections, not an error.
--
-- pg-test: tests/pg/ledger-usage-stats-rpc.pg.test.ts

-- SQL mirror of normalizeCounterpartyName() -> normalizeMerchantName()
-- (lib/bookkeeping/counterparty-templates.ts / lib/documents/core-receipt-matcher.ts).
-- Keep the two in sync: categorization_templates.counterparty_name is written
-- through the TS pair, and the lib layer joins RPC rows to templates on this
-- key. Regex notes: \y is Postgres's word boundary (JS \b); JS \w is
-- [A-Za-z0-9_], spelled out explicitly because Postgres \w is locale-wider.
CREATE OR REPLACE FUNCTION public.normalize_counterparty_key(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  cleaned text;
  tokens text[];
  last_tok text;
  months constant text[] := ARRAY[
    'jan','feb','mar','apr','maj','may','jun','jul','aug','sep','sept',
    'okt','oct','nov','dec',
    'januari','februari','mars','april','juni','juli','augusti',
    'september','oktober','november','december'
  ];
BEGIN
  IF raw IS NULL THEN
    RETURN '';
  END IF;

  -- normalizeCounterpartyName(): payment-rail prefixes, dates, invoice refs,
  -- trailing digit runs.
  cleaned := regexp_replace(raw, '^(BANKGIRO|SWISH|KORTKÖP|KORT[[:space:]]*KÖP|PG|BG|AUTOGIRO|PLUSGIRO)[[:space:]]*', '', 'i');
  cleaned := regexp_replace(cleaned, '\y\d{2,4}[-/]?\d{2}[-/]?\d{2}\y', '', 'g');
  cleaned := regexp_replace(cleaned, '\y[F#]?\d{4,}\S*', '', 'gi');
  cleaned := regexp_replace(cleaned, '\yINV-?\d+', '', 'gi');
  cleaned := regexp_replace(cleaned, '[[:space:]]+\d{4,}[[:space:]]*$', '', 'g');
  cleaned := btrim(cleaned);

  -- stripTrailingNoiseTokens(): pop trailing month names and 1-2 letter
  -- all-caps initials (checked against ORIGINAL casing, before lowering);
  -- always keep at least one token.
  tokens := regexp_split_to_array(cleaned, '[[:space:]]+');
  WHILE coalesce(array_length(tokens, 1), 0) > 1 LOOP
    last_tok := tokens[array_length(tokens, 1)];
    IF lower(last_tok) = ANY(months) OR last_tok ~ '^[A-ZÅÄÖ]{1,2}$' THEN
      tokens := tokens[1:array_length(tokens, 1) - 1];
    ELSE
      EXIT;
    END IF;
  END LOOP;
  cleaned := array_to_string(tokens, ' ');

  -- normalizeMerchantName(): lowercase, strip special chars (keep Swedish
  -- letters), drop legal-form suffixes, collapse whitespace.
  cleaned := lower(cleaned);
  cleaned := regexp_replace(cleaned, '[^a-z0-9_[:space:]åäöé]', '', 'g');
  cleaned := regexp_replace(cleaned, '\y(ab|hb|kb|ek|för|stiftelse)\y', '', 'g');
  cleaned := regexp_replace(cleaned, '[[:space:]]+', ' ', 'g');
  RETURN btrim(cleaned);
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_counterparty_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_counterparty_key(text) TO authenticated, service_role;

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
