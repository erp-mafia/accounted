-- get_ledger_usage_stats: counterparty patterns from imported verifikat.
--
-- ledger_context (the agent briefing and the Accounted://ledger/context
-- resource) learned counterparty patterns only from bank rows booked in
-- Accounted. A company that migrated its books (SIE or a provider import,
-- journal_entries.source_type 'import') brought its whole year of
-- verifikat, which counted toward account usage but taught no counterparty.
-- A newly migrated company has few bank rows booked in Accounted, so it
-- had few counterparty patterns or none at all, however much history it
-- had imported: who it buys from and sells to, on which accounts and with
-- which VAT, was in the books and went unread. The agent of such a company
-- booked as if the company had no past.
--
-- New section imported_counterparty_patterns, a second basis next to
-- counterparty_patterns (which is unchanged):
--
-- * Which verifikat: posted imports in the window that settle through
--   exactly one of money (19xx or a card ledger) or reskontra (244x, 151x).
--   A verifikat with both is a payment (Levbet, Kundbet, a supplier paid
--   with an exchange difference): it says how a debt was settled, not what
--   was bought or sold, so it never teaches "counterparty -> 2440/1930".
--   One with neither (accruals, depreciation, the VAT transfer, payroll
--   provisions) names no counterparty.
-- * Which text: imported_voucher_counterparty() takes the name out of the
--   wrappers the previous systems write ("Levfakt <name> (<nr>)",
--   "Kundfaktura <name> (<nr>)", "Leverantörsfaktura från <nr> <name>,
--   <ref>", "Faktura <nr> <name>", "Leverantörsfaktura: <name> - <ref> -
--   <text>"); any other text is a bank-direct verifikat whose description is
--   the bank's own text, kept as it stands. The key is then the
--   normalize_counterparty_key / grant_names_counterparty pair of the bank
--   rows and the templates, so an imported key equals the key a bank row of
--   the same counterparty gets.
-- * Which account: every line that is not money, reskontra, moms (26xx) or
--   öresavrundning (3740), counted once per verifikat (as supplier_patterns
--   counts invoices). settled_via says whether the history ran through
--   leverantörsreskontra (payable), kundreskontra (receivable) or straight
--   from the bank.
-- * Which VAT, per verifikat: 2647 domestic reverse charge, 2645 reverse
--   charge on a purchase from abroad, one utgående rate family (261x 25 %,
--   262x 12 %, 263x 6 %) its rate, only ingående 2640/2641 its amount over
--   the booking lines snapped to 25/12/6 % within 1.5 points (the tolerance
--   the SIE template learner uses); import legs (2615/2625/2635), other 26xx
--   accounts, a mix or no moms line read as unknown (null). BAS roles per
--   the swedish-vat reference (BAS 26xx series).
--
-- The RPC returns counts, not verdicts. ledger-context.ts decides what a
-- count is worth:
--   * it applies the share floor and the two-verifikat minimum;
--   * it fills only the slots the bank-row patterns leave, so Accounted's
--     own bookings keep precedence over the imported history;
--   * explicit mapping rules still outrank both the bank-row patterns and
--     the imported ones.
--
-- The rest of the body is the 20261101003600 definition, unchanged: the
-- imported_counterparty_patterns section is the only addition.
-- Same signature, so CREATE OR REPLACE keeps the grants; restated as the
-- last definition did. Functions only, no data change.
--
-- pg-test: tests/pg/ledger-usage-stats-rpc.pg.test.ts

-- The counterparty an imported verifikat names: the name inside the wrapper
-- the previous system wrote, NULL when the text is only a wrapper ("Levfakt
-- (12)", "Betalning Leverantörsfaktura V12", "Faktura #1001 (OCR ...)"),
-- else the text as it stands.
CREATE OR REPLACE FUNCTION public.imported_voucher_counterparty(p_description text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public'
AS $$
  SELECT coalesce(
    (regexp_match(p_description, '^\s*(?:levfakt|levbet|levkreditfakt|kundfaktura|kundbet|kreditfaktura|avtalsfaktura)\s+(.*\S)\s*\(\d+\)\s*$', 'i'))[1],
    (regexp_match(p_description, '^\s*(?:leverantörsfaktura från|betalning till|kundfaktura till|inbetalning från)\s+\d[0-9-]*\s+([^,]*[^,\s])\s*,[^,]*$', 'i'))[1],
    (regexp_match(p_description, '^\s*(?:faktura|kreditfaktura)\s+\d+\s+(.*\S)\s*$', 'i'))[1],
    nullif(split_part((regexp_match(p_description, '^\s*leverantörsfaktura:\s*(.*\S)\s*$', 'i'))[1], ' - ', 1), ''),
    CASE
      WHEN p_description ~* '^\s*(?:levfakt|levbet|levkreditfakt|kundfaktura|kundbet|kreditfaktura|avtalsfaktura|leverantörsfaktura|faktura|betalning|inbetalning)\M' THEN NULL
      ELSE nullif(btrim(p_description), '')
    END
  )
$$;

REVOKE ALL ON FUNCTION public.imported_voucher_counterparty(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.imported_voucher_counterparty(text) TO authenticated, service_role;

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
    'imported_counterparty_patterns',
    (
      -- Imported verifikat as a second basis (header of 20261109090100).
      -- Counts only: ledger-context.ts applies the floors.
      WITH cards AS (
        SELECT coalesce(array_agg(ca.ledger_account), '{}'::text[]) AS accounts
        FROM public.cash_accounts ca
        WHERE ca.company_id = p_company_id
          AND ca.kind = 'card'
      ),
      vouchers AS MATERIALIZED (
        -- One pass over the lines: how the verifikat settles, its booking
        -- accounts (not money, reskontra, moms or öresavrundning) and its
        -- moms legs.
        SELECT
          je.id,
          je.entry_date,
          je.description,
          CASE
            WHEN bool_or(l.account_number LIKE '244%') THEN 'payable'
            WHEN bool_or(l.account_number LIKE '151%') THEN 'receivable'
            ELSE 'bank'
          END AS settled_via,
          array_agg(DISTINCT l.account_number) FILTER (
            WHERE l.account_number NOT LIKE '19%'
              AND l.account_number <> ALL (c.accounts)
              AND l.account_number NOT LIKE '244%'
              AND l.account_number NOT LIKE '151%'
              AND l.account_number NOT LIKE '26%'
              AND l.account_number <> '3740'
          ) AS booking_accounts,
          abs(sum(l.debit_amount - l.credit_amount) FILTER (
            WHERE l.account_number NOT LIKE '19%'
              AND l.account_number <> ALL (c.accounts)
              AND l.account_number NOT LIKE '244%'
              AND l.account_number NOT LIKE '151%'
              AND l.account_number NOT LIKE '26%'
              AND l.account_number <> '3740'
          )) AS booking_net,
          abs(sum(l.debit_amount - l.credit_amount) FILTER (
            WHERE l.account_number IN ('2640', '2641')
          )) AS input_vat,
          array_agg(DISTINCT CASE
            WHEN l.account_number IN ('2610', '2611', '2612', '2613', '2616') THEN 'standard_25'
            WHEN l.account_number IN ('2620', '2621', '2622', '2623', '2626') THEN 'reduced_12'
            ELSE 'reduced_6'
          END) FILTER (
            WHERE l.account_number IN ('2610', '2611', '2612', '2613', '2616',
                                       '2620', '2621', '2622', '2623', '2626',
                                       '2630', '2631', '2632', '2633', '2636')
          ) AS output_rates,
          bool_or(l.account_number = '2647') AS reverse_charge_domestic,
          bool_or(l.account_number = '2645') AS reverse_charge_abroad,
          -- Import legs, the clearing account and anything else in 26xx:
          -- the rate cannot be read off them.
          bool_or(l.account_number LIKE '26%' AND l.account_number NOT IN (
            '2610', '2611', '2612', '2613', '2616',
            '2620', '2621', '2622', '2623', '2626',
            '2630', '2631', '2632', '2633', '2636',
            '2614', '2624', '2634', '2640', '2641', '2645', '2647'
          )) AS other_vat
        FROM public.journal_entries je
        CROSS JOIN cards c
        JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
        WHERE je.company_id = p_company_id
          AND je.status = 'posted'
          AND je.source_type = 'import'
          AND je.entry_date >= p_from_date
        GROUP BY je.id, je.entry_date, je.description
        -- Settled through money or through reskontra, not both (a payment)
        -- and not neither (an accrual, depreciation, the VAT transfer).
        HAVING bool_or(l.account_number LIKE '19%' OR l.account_number = ANY (c.accounts))
           <> bool_or(l.account_number LIKE '244%' OR l.account_number LIKE '151%')
      ),
      named AS MATERIALIZED (
        SELECT
          v.id,
          v.entry_date,
          v.settled_via,
          v.booking_accounts,
          public.imported_voucher_counterparty(v.description) AS raw_name,
          CASE
            WHEN v.reverse_charge_domestic THEN 'reverse_charge_domestic'
            WHEN v.reverse_charge_abroad THEN 'reverse_charge'
            WHEN v.other_vat THEN NULL
            WHEN cardinality(v.output_rates) = 1 AND v.input_vat IS NULL THEN v.output_rates[1]
            WHEN v.output_rates IS NULL AND v.input_vat > 0 AND v.booking_net > 0 THEN
              CASE
                WHEN abs(v.input_vat / v.booking_net - 0.25) <= 0.015 THEN 'standard_25'
                WHEN abs(v.input_vat / v.booking_net - 0.12) <= 0.015 THEN 'reduced_12'
                WHEN abs(v.input_vat / v.booking_net - 0.06) <= 0.015 THEN 'reduced_6'
              END
          END AS vat_treatment
        FROM vouchers v
        WHERE v.booking_accounts IS NOT NULL
      ),
      names AS MATERIALIZED (
        -- Keyed once per distinct name: a counterparty's name repeats on all
        -- its verifikat once the wrapper and number are gone, and the key
        -- function is the expensive step.
        SELECT d.raw_name, public.normalize_counterparty_key(d.raw_name) AS counterparty_key
        FROM (SELECT DISTINCT raw_name FROM named WHERE raw_name IS NOT NULL) d
        WHERE public.grant_names_counterparty(d.raw_name)
      ),
      keyed AS (
        SELECT n.*, k.counterparty_key
        FROM named n
        JOIN names k ON k.raw_name = n.raw_name
        WHERE char_length(k.counterparty_key) >= 2
      ),
      booking AS (
        SELECT k.counterparty_key, a.account_number, k.vat_treatment
        FROM keyed k
        CROSS JOIN LATERAL unnest(k.booking_accounts) AS a(account_number)
      ),
      totals AS (
        SELECT
          counterparty_key,
          left(mode() WITHIN GROUP (ORDER BY raw_name), 60) AS display_name,
          count(*)::bigint AS vouchers,
          max(entry_date) AS last_booked,
          mode() WITHIN GROUP (ORDER BY settled_via) AS settled_via
        FROM keyed
        GROUP BY counterparty_key
      ),
      dominant_account AS (
        SELECT DISTINCT ON (counterparty_key)
          counterparty_key,
          account_number,
          cnt
        FROM (
          SELECT counterparty_key, account_number, count(*)::bigint AS cnt
          FROM booking
          GROUP BY counterparty_key, account_number
        ) a
        ORDER BY counterparty_key, cnt DESC, account_number
      ),
      dominant_vat AS (
        -- Read on the verifikat that carry the dominant account only.
        SELECT DISTINCT ON (b.counterparty_key)
          b.counterparty_key,
          b.vat_treatment,
          count(*)::bigint AS cnt
        FROM booking b
        JOIN dominant_account d
          ON d.counterparty_key = b.counterparty_key
         AND d.account_number = b.account_number
        WHERE b.vat_treatment IS NOT NULL
        GROUP BY b.counterparty_key, b.vat_treatment
        ORDER BY b.counterparty_key, count(*) DESC, b.vat_treatment
      )
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'counterparty', t.display_name,
            'counterparty_key', t.counterparty_key,
            'vouchers', t.vouchers,
            'last_booked', t.last_booked,
            'settled_via', t.settled_via,
            'dominant_account_number', da.account_number,
            'dominant_account_count', coalesce(da.cnt, 0),
            'vat_treatment', dv.vat_treatment,
            'vat_treatment_count', coalesce(dv.cnt, 0)
          )
          ORDER BY t.vouchers DESC, t.display_name
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT * FROM totals ORDER BY vouchers DESC, display_name LIMIT 25
      ) t
      LEFT JOIN dominant_account da ON da.counterparty_key = t.counterparty_key
      LEFT JOIN dominant_vat dv ON dv.counterparty_key = t.counterparty_key
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
