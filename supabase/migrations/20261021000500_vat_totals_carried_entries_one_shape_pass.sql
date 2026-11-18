-- Two changes to the VAT figure and its drill-down:
--   A. An opening balance feeds the momsdeklaration only when it is dated
--      inside the declared period with nothing of the period before it in the
--      books; its storno or rättelse follows it (crm#1333).
--   B. The momsredovisning shapes are read in one pass over the period's
--      lines, so a company with tens of thousands of verifikat a year gets
--      its momsrapport inside the statement timeout (crm#1331).
--
-- A. -------------------------------------------------------------------------
--
-- Why this exists: both VAT functions exempted source_type 'opening_balance'
-- from the momsredovisning shapes, which kept every opening balance's 26xx
-- lines IN the period's rutor ("carried-in 26xx balances are unsettled VAT
-- that belongs in the next declaration", 20260713120000). Two defects:
--
--   1. For a company that keeps books, output VAT is reported for the period
--      in which the supply has been or should have been booked under god
--      redovisningssed (ML 2023:200 7 kap. 14 §), input VAT likewise (7 kap.
--      31 §), and the skattedeklaration covers one redovisningsperiod (SFL 26
--      kap. 5 § 2 st., 10-11 §§). An IB dated on the period's first day
--      carries only balances booked in EARLIER periods, which their own
--      declarations hold: counting it re-declared them (a year closed before
--      its momsredovisning, a migration whose IB carries last quarter's VAT).
--      An IB dated INSIDE the period is the right carrier only when the
--      period's days before it are not in the books (a migration mid-period):
--      then it holds VAT booked in this period that nothing else reports.
--      When those days ARE in the books (the year-end roll-forward dates the
--      IB on a räkenskapsår starting mid-period; an import brought the earlier
--      verifikat) counting it reports them twice.
--   2. A storno was treated apart from its original. The storno of an IB has
--      source_type 'storno', so the exemption missed it: with a 2650/1650 line
--      it matched the net-account shape and left the rutor as a
--      "momsredovisning" while the IB it cancels stayed counted. crm#1333: the
--      IB's 2641/2645/2614 stayed in rutor 30 and 48 and nothing took them out.
--
-- The rule: the IB chain is every opening balance that is a balance
-- (source_type 'opening_balance', the marker the IB tool, the SIE import and
-- the year-end roll-forward set, with no resultatkonto line: class 3-8 comes
-- only from marking a business verifikat as IB in bank reconciliation) and
-- every entry that reverses (reverses_id) or corrects (correction_of_id) a
-- member, followed down; each member follows the IB at its root. An IB COUNTS
-- iff it is dated after p_start (and by p_end) and the company has no other
-- posted or reversed verifikat dated from p_start up to the day before it,
-- outside the IB chains. Otherwise it is CARRIED: it and its chain leave the
-- declaration before any shape is looked at. A counted chain is kept out of
-- both shapes, as the IB alone was before, so an IB and its storno net to
-- zero either way. Carried entries still count in source_type_counts, which
-- describes the period's verifikat, not the rutor. The counted IBs are
-- returned as counted_opening_balances (an added key) so the momsredovisning
-- matcher reads the same decision.
--
-- What this means for books already kept:
--   * an opening balance with 26xx declaration lines dated on its period's
--     first day now stays out;
--   * one dated inside its period still counts when nothing earlier in the
--     period is in the books (a SIE import that starts mid-period);
--   * one dated inside its period stays out when the period's earlier
--     verifikat are in the books (a year-end roll-forward into a
--     räkenskapsår starting mid-quarter, or a SIE import that also brought
--     those verifikat);
--   * an entry tagged opening_balance that books a resultatkonto is read as
--     the ordinary verifikat it is;
--   * a storno that the 2650 shape dropped while its IB counted (the
--     crm#1333 class) now follows its IB.
--
-- The 2650/1650 shape and the skattekonto shape are NOT narrowed: they
-- still see every entry outside the IB chains.
--
-- B. -------------------------------------------------------------------------
--
-- Why: a SQL function is planned without its parameter values (PG 17), so
-- `= ANY (p_accounts)` is a linear scan of a 70-element array wherever it
-- appears, and shape 1's EXISTS against vat_lines ran as a nested loop over
-- vat_lines for every verifikat: the period's verifikat times its VAT lines
-- in row checks. Shape 2 called skattekonto_shape_accounts() once per line
-- it probed. For a company with tens of thousands of verifikat a year the
-- function ran far past the API's 8 s statement timeout, so its months and
-- quarters all failed.
--
-- Now: the account lists become a small lookup table (account_lists), joined
-- by hash; every line of the period's verifikat is read once into one row of
-- flags per verifikat (shape_flags), one flag per former EXISTS with the same
-- predicate; the shapes, the totals and the drill-down filter on those flags;
-- the constants are MATERIALIZED, so the function runs once.
--
-- Under the function's own planning (a prepared statement on a generic
-- plan) a whole year of such a company stays well inside the timeout.
--
-- Results are identical by construction, and the old body and this one
-- (with the old opening-balance rule held) were compared side by side:
-- identical JSON for the totals and identical rows for the drill-downs.
--
-- Bodies are 20261015030000 apart from: the ib_chain CTE and its filter in
-- non_settlement_entries, the opening-balance exemption widened from the IB
-- to its whole chain (in_ib_chain), the account_lists and
-- shape_flags CTEs that the shapes, the totals and the drill-down now read,
-- and MATERIALIZED constants. Signatures, SECURITY INVOKER, search_path and ACLs are
-- unchanged, so the app deployed before this keeps working during the deploy
-- window.
--
-- pg-test: tests/pg/vat-totals-carried-entries.pg.test.ts,
--          tests/pg/vat-totals-shape-pass.pg.test.ts,
--          tests/pg/vat-declaration-totals-rpc.pg.test.ts,
--          tests/pg/vat-ruta-drilldown-reconcile.pg.test.ts,
--          tests/pg/vat-skattekonto-counter-entries.pg.test.ts

-- =============================================================================
-- The figure.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_vat_declaration_totals(
  p_company_id uuid,
  p_start date,
  p_end date,
  p_accounts text[],
  p_ruta_accounts text[],
  p_net_accounts text[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
WITH closing_entries AS (
  SELECT fp.closing_entry_id AS id
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND fp.closing_entry_id IS NOT NULL
),
scoped_entries AS (
  SELECT e.id, e.status, e.entry_date, e.source_type, e.description,
         e.voucher_series, e.voucher_number
  FROM public.journal_entries e
  WHERE e.company_id = p_company_id
    AND e.status IN ('posted', 'reversed')
    AND e.entry_date >= p_start
    AND e.entry_date <= p_end
    AND NOT (
      e.status = 'posted'
      AND EXISTS (SELECT 1 FROM closing_entries c WHERE c.id = e.id)
    )
),
-- Every opening balance of the company with the stornos and rättelser of it,
-- down the chain, each with the IB at its root (crm#1333). Not dated by the
-- period on purpose: a storno can be dated apart from its IB. An opening
-- balance is always its own root. Only a balance is an IB: an entry tagged
-- opening_balance that books a resultatkonto (class 3-8, which no IB door
-- writes: a verifikat marked as IB in bank reconciliation) is an ordinary
-- verifikat here. Keep in step with the copy in
-- get_vat_ruta_source_lines below.
ib_chain AS (
  WITH RECURSIVE chain AS (
    SELECT o.id, o.id AS root_id
    FROM public.journal_entries o
    WHERE o.company_id = p_company_id
      AND o.source_type = 'opening_balance'
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entry_lines r
        WHERE r.journal_entry_id = o.id
          AND substr(r.account_number, 1, 1) IN ('3', '4', '5', '6', '7', '8')
      )
    UNION
    SELECT n.id, c.root_id
    FROM chain c
    CROSS JOIN LATERAL (
      SELECT x.id FROM public.journal_entries x
      WHERE x.reverses_id = c.id AND x.company_id = p_company_id
        AND x.source_type IS DISTINCT FROM 'opening_balance'
      UNION ALL
      SELECT y.id FROM public.journal_entries y
      WHERE y.correction_of_id = c.id AND y.company_id = p_company_id
        AND y.source_type IS DISTINCT FROM 'opening_balance'
    ) n
  )
  SELECT id, root_id FROM chain
),
-- Whether an opening balance feeds this declaration. It does only when it is
-- dated after the period's first day AND the books hold no other verifikat
-- of the period before it: then it is the only carrier of those days' VAT
-- (a migration mid-period). An IB on the first day carries only earlier
-- periods; one after the first day with the period's earlier days in the
-- books (the year-end roll-forward into a räkenskapsår starting mid-period,
-- an import that brought the earlier verifikat) would count them twice.
ib_roots AS (
  SELECT o.id,
         o.entry_date > p_start
         AND o.entry_date <= p_end
         AND NOT EXISTS (
           SELECT 1 FROM public.journal_entries v
           WHERE v.company_id = p_company_id
             AND v.status IN ('posted', 'reversed')
             AND v.entry_date >= p_start
             AND v.entry_date < o.entry_date
             AND NOT EXISTS (SELECT 1 FROM ib_chain b WHERE b.id = v.id)
         ) AS counts
  FROM public.journal_entries o
  WHERE o.id IN (SELECT root_id FROM ib_chain)
),
-- Each chain member follows the IB at its root (if two roots ever meet, it
-- counts only when both do).
ib_members AS (
  SELECT b.id, bool_and(r.counts) AS counts
  FROM ib_chain b
  JOIN ib_roots r ON r.id = b.root_id
  GROUP BY b.id
),
-- A carried chain member never feeds the declaration; a counted one counts,
-- kept out of the momsredovisning shapes so an IB and its storno net.
non_settlement_entries AS (
  SELECT e.*, (m.id IS NOT NULL) AS in_ib_chain
  FROM scoped_entries e
  LEFT JOIN ib_members m ON m.id = e.id
  WHERE e.source_type IS DISTINCT FROM 'vat_settlement'
    AND NOT EXISTS (
      SELECT 1 FROM public.kontantmetod_cutoff_entries k
      WHERE k.journal_entry_id = e.id
        AND k.kind IN ('receivable_reversal', 'payable_reversal')
    )
    AND (m.id IS NULL OR m.counts)
),
-- The account lists as a lookup table, built once (crm#1331). A SQL
-- function's plan does not know the parameter values, so `= ANY (p_accounts)`
-- is a linear scan of a 70-element array for every line it touches; a join on
-- this table is one hash probe.
account_lists AS MATERIALIZED (
  SELECT x.account_number,
         bool_or(x.list = 'measured') AS measured,
         bool_or(x.list = 'ruta') AS ruta,
         bool_or(x.list = 'net') AS net
  FROM (
    SELECT unnest(p_accounts) AS account_number, 'measured' AS list
    UNION ALL
    SELECT unnest(p_ruta_accounts), 'ruta'
    UNION ALL
    SELECT unnest(p_net_accounts), 'net'
  ) x
  GROUP BY x.account_number
),
vat_lines AS MATERIALIZED (
  SELECT l.journal_entry_id, l.account_number, l.debit_amount, l.credit_amount
  FROM non_settlement_entries e
  JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
  JOIN account_lists a ON a.account_number = l.account_number
  WHERE a.measured
),
-- Named constants for shape 2. The skattekonto accounts come from
-- skattekonto_shape_accounts() (1630, plus 2012 for an enskild firma); keep
-- the rest in step with the copy in get_vat_ruta_source_lines below.
-- MATERIALIZED so the function runs once, not once per line (crm#1331).
tax_shape_constants AS MATERIALIZED (
  SELECT public.skattekonto_shape_accounts(p_company_id) AS tax_accounts, -- skattekonto
         ARRAY['3740']::text[] AS rounding_accounts, -- öres- och kronutjämning
         '26%'::text AS vat_account_pattern          -- BAS 26xx, the moms accounts
),
-- Both momsredovisning shapes, decided per verifikat in ONE pass over the
-- period's lines (crm#1331) instead of up to six correlated subqueries per
-- verifikat. Each flag is one former EXISTS with the same predicate: shape 1
-- read vat_lines, so its two flags keep the p_accounts condition; shape 2
-- read every line of the verifikat, so its flags do too.
--   net_shape (shape 1, unchanged): a declaration account AND a 2650/1650 line.
--   tax_shape (shape 2): a pure movement between VAT accounts and the
--     skattekonto: a 26xx declaration line, a skattekonto line, no 2650/1650
--     line, and NOTHING else but 26xx, the skattekonto and 3740 on any line.
-- Disjoint by construction (shape 2 requires NO p_net_accounts line, shape 1
-- requires one).
shape_flags AS MATERIALIZED (
  SELECT f.id,
         f.ruta_vat_line AND f.net_vat_line AND NOT f.in_ib_chain AS net_shape,
         f.moms_ruta_line AND f.tax_line AND NOT f.net_line AND NOT f.other_line
           AND NOT f.in_ib_chain AS tax_shape
  FROM (
    SELECT l.journal_entry_id AS id,
           bool_and(e.in_ib_chain) AS in_ib_chain,
           COALESCE(bool_or(a.measured AND a.ruta), false) AS ruta_vat_line,
           COALESCE(bool_or(a.measured AND a.net), false) AS net_vat_line,
           COALESCE(bool_or(a.ruta AND l.account_number LIKE k.vat_account_pattern), false) AS moms_ruta_line,
           COALESCE(bool_or(l.account_number = ANY (k.tax_accounts)), false) AS tax_line,
           COALESCE(bool_or(a.net), false) AS net_line,
           COALESCE(bool_or(l.account_number NOT LIKE k.vat_account_pattern
                            AND l.account_number <> ALL (k.tax_accounts)
                            AND l.account_number <> ALL (k.rounding_accounts)), false) AS other_line
    FROM non_settlement_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    LEFT JOIN account_lists a ON a.account_number = l.account_number
    CROSS JOIN tax_shape_constants k
    GROUP BY l.journal_entry_id
  ) f
),
shaped_net AS (
  SELECT e.id, e.status, e.entry_date, e.source_type, e.voucher_series, e.voucher_number
  FROM non_settlement_entries e
  JOIN shape_flags f ON f.id = e.id
  WHERE f.net_shape
),
shaped_tax AS (
  SELECT e.id, e.status, e.entry_date, e.source_type, e.voucher_series, e.voucher_number
  FROM non_settlement_entries e
  JOIN shape_flags f ON f.id = e.id
  WHERE f.tax_shape
),
-- UNION rather than UNION ALL so a future edit to either predicate can never
-- list a verifikat twice.
shaped AS (
  SELECT id, status, entry_date, source_type, voucher_series, voucher_number FROM shaped_net
  UNION
  SELECT id, status, entry_date, source_type, voucher_series, voucher_number FROM shaped_tax
)
SELECT jsonb_build_object(
  'totals', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM vat_lines l
      -- Every vat_lines verifikat has its row of flags: same entries, same lines.
      JOIN shape_flags f ON f.id = l.journal_entry_id
      WHERE NOT f.net_shape AND NOT f.tax_shape
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'settlement_shaped_entries', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id,
      'status', s.status,
      'entry_date', s.entry_date,
      'source_type', s.source_type,
      'voucher_series', s.voucher_series,
      'voucher_number', s.voucher_number
    ) ORDER BY s.entry_date, s.id)
    FROM shaped s
  ), '[]'::jsonb),
  'source_type_counts', COALESCE((
    SELECT jsonb_object_agg(COALESCE(c.source_type, ''), c.n)
    FROM (
      SELECT source_type, count(*)::int AS n
      FROM scoped_entries
      GROUP BY source_type
    ) c
  ), '{}'::jsonb),
  -- The opening balances this declaration counts, so the momsredovisning
  -- matcher (carriedIntoPeriod) reads the same decision. Additive: a caller
  -- that does not know the key ignores it.
  'counted_opening_balances', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', e.id,
      'status', e.status,
      'entry_date', e.entry_date
    ) ORDER BY e.entry_date, e.id)
    FROM non_settlement_entries e
    WHERE e.in_ib_chain AND e.source_type = 'opening_balance'
  ), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) TO authenticated, service_role;

-- =============================================================================
-- The drill-down: the same exclusions, so it lists exactly what the figure sums.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_vat_ruta_source_lines(
  p_company_id uuid,
  p_start date,
  p_end date,
  p_accounts text[],
  p_ruta_accounts text[],
  p_net_accounts text[],
  p_cursor_date date DEFAULT NULL,
  p_cursor_voucher_number integer DEFAULT NULL,
  p_cursor_entry_id uuid DEFAULT NULL,
  p_cursor_line_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 501
)
RETURNS TABLE (
  line_id uuid,
  journal_entry_id uuid,
  voucher_number integer,
  voucher_series text,
  entry_date date,
  description text,
  debit_amount numeric,
  credit_amount numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH closing_entries AS (
    SELECT fp.closing_entry_id AS id
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND fp.closing_entry_id IS NOT NULL
  ),
  scoped_entries AS (
    SELECT e.id, e.status, e.entry_date, e.source_type, e.description,
           e.voucher_series, e.voucher_number
    FROM public.journal_entries e
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND e.entry_date >= p_start
      AND e.entry_date <= p_end
      AND NOT (
        e.status = 'posted'
        AND EXISTS (SELECT 1 FROM closing_entries c WHERE c.id = e.id)
      )
  ),
  -- Every opening balance of the company with the stornos and rättelser of it,
  -- down the chain, each with the IB at its root (crm#1333). Not dated by the
  -- period on purpose: a storno can be dated apart from its IB. An opening
  -- balance is always its own root. Only a balance is an IB: an entry tagged
  -- opening_balance that books a resultatkonto (class 3-8, which no IB door
  -- writes: a verifikat marked as IB in bank reconciliation) is an ordinary
  -- verifikat here. Keep in step with the copy in
  -- get_vat_declaration_totals above.
  ib_chain AS (
    WITH RECURSIVE chain AS (
      SELECT o.id, o.id AS root_id
      FROM public.journal_entries o
      WHERE o.company_id = p_company_id
        AND o.source_type = 'opening_balance'
        AND NOT EXISTS (
          SELECT 1 FROM public.journal_entry_lines r
          WHERE r.journal_entry_id = o.id
            AND substr(r.account_number, 1, 1) IN ('3', '4', '5', '6', '7', '8')
        )
      UNION
      SELECT n.id, c.root_id
      FROM chain c
      CROSS JOIN LATERAL (
        SELECT x.id FROM public.journal_entries x
        WHERE x.reverses_id = c.id AND x.company_id = p_company_id
          AND x.source_type IS DISTINCT FROM 'opening_balance'
        UNION ALL
        SELECT y.id FROM public.journal_entries y
        WHERE y.correction_of_id = c.id AND y.company_id = p_company_id
          AND y.source_type IS DISTINCT FROM 'opening_balance'
      ) n
    )
    SELECT id, root_id FROM chain
  ),
  -- Whether an opening balance feeds this declaration. It does only when it is
  -- dated after the period's first day AND the books hold no other verifikat
  -- of the period before it: then it is the only carrier of those days' VAT
  -- (a migration mid-period). An IB on the first day carries only earlier
  -- periods; one after the first day with the period's earlier days in the
  -- books (the year-end roll-forward into a räkenskapsår starting mid-period,
  -- an import that brought the earlier verifikat) would count them twice.
  ib_roots AS (
    SELECT o.id,
           o.entry_date > p_start
           AND o.entry_date <= p_end
           AND NOT EXISTS (
             SELECT 1 FROM public.journal_entries v
             WHERE v.company_id = p_company_id
               AND v.status IN ('posted', 'reversed')
               AND v.entry_date >= p_start
               AND v.entry_date < o.entry_date
               AND NOT EXISTS (SELECT 1 FROM ib_chain b WHERE b.id = v.id)
           ) AS counts
    FROM public.journal_entries o
    WHERE o.id IN (SELECT root_id FROM ib_chain)
  ),
  -- Each chain member follows the IB at its root (if two roots ever meet, it
  -- counts only when both do).
  ib_members AS (
    SELECT b.id, bool_and(r.counts) AS counts
    FROM ib_chain b
    JOIN ib_roots r ON r.id = b.root_id
    GROUP BY b.id
  ),
  -- A carried chain member never feeds the declaration; a counted one counts,
  -- kept out of the momsredovisning shapes so an IB and its storno net.
  non_settlement_entries AS (
    SELECT e.*, (m.id IS NOT NULL) AS in_ib_chain
    FROM scoped_entries e
    LEFT JOIN ib_members m ON m.id = e.id
    WHERE e.source_type IS DISTINCT FROM 'vat_settlement'
      AND NOT EXISTS (
        SELECT 1 FROM public.kontantmetod_cutoff_entries k
        WHERE k.journal_entry_id = e.id
          AND k.kind IN ('receivable_reversal', 'payable_reversal')
      )
      AND (m.id IS NULL OR m.counts)
  ),
  -- The shape's account lists as a lookup table (crm#1331): see
  -- get_vat_declaration_totals above. p_accounts is the expanded ruta's own
  -- short list and filters the output only.
  account_lists AS MATERIALIZED (
    SELECT x.account_number,
           bool_or(x.list = 'ruta') AS ruta,
           bool_or(x.list = 'net') AS net
    FROM (
      SELECT unnest(p_ruta_accounts) AS account_number, 'ruta' AS list
      UNION ALL
      SELECT unnest(p_net_accounts), 'net'
    ) x
    GROUP BY x.account_number
  ),
  -- Named constants for shape 2. Keep in step with the copy in
  -- get_vat_declaration_totals above. MATERIALIZED: evaluated once.
  tax_shape_constants AS MATERIALIZED (
    SELECT public.skattekonto_shape_accounts(p_company_id) AS tax_accounts, -- skattekonto
           ARRAY['3740']::text[] AS rounding_accounts, -- öres- och kronutjämning
           '26%'::text AS vat_account_pattern          -- BAS 26xx, the moms accounts
  ),
  -- Both shapes from one pass over the period's lines (crm#1331), each flag
  -- one former EXISTS. Here both shapes read journal_entry_lines, as before.
  shape_flags AS MATERIALIZED (
    SELECT f.id,
           f.ruta_line AND f.net_line AND NOT f.in_ib_chain AS net_shape,
           f.moms_ruta_line AND f.tax_line AND NOT f.net_line AND NOT f.other_line
             AND NOT f.in_ib_chain AS tax_shape
    FROM (
      SELECT l.journal_entry_id AS id,
             bool_and(e.in_ib_chain) AS in_ib_chain,
             COALESCE(bool_or(a.ruta), false) AS ruta_line,
             COALESCE(bool_or(a.ruta AND l.account_number LIKE k.vat_account_pattern), false) AS moms_ruta_line,
             COALESCE(bool_or(l.account_number = ANY (k.tax_accounts)), false) AS tax_line,
             COALESCE(bool_or(a.net), false) AS net_line,
             COALESCE(bool_or(l.account_number NOT LIKE k.vat_account_pattern
                              AND l.account_number <> ALL (k.tax_accounts)
                              AND l.account_number <> ALL (k.rounding_accounts)), false) AS other_line
      FROM non_settlement_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      LEFT JOIN account_lists a ON a.account_number = l.account_number
      CROSS JOIN tax_shape_constants k
      GROUP BY l.journal_entry_id
    ) f
  )
  SELECT
    l.id AS line_id,
    je.id AS journal_entry_id,
    je.voucher_number,
    COALESCE(je.voucher_series, 'A') AS voucher_series,
    je.entry_date,
    COALESCE(je.description, '') AS description,
    l.debit_amount,
    l.credit_amount
  FROM non_settlement_entries je
  JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
  JOIN shape_flags f ON f.id = je.id
  WHERE l.account_number = ANY (p_accounts)
    AND NOT f.net_shape
    AND NOT f.tax_shape
    AND (
      p_cursor_date IS NULL
      OR (
        je.entry_date,
        je.voucher_number,
        je.id,
        l.id
      ) > (
        p_cursor_date,
        p_cursor_voucher_number,
        COALESCE(p_cursor_entry_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid),
        COALESCE(p_cursor_line_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
      )
    )
  ORDER BY je.entry_date, je.voucher_number, je.id, l.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 501), 1), 501);
$$;

REVOKE ALL ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
