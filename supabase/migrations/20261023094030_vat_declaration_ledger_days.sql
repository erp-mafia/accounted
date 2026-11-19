-- The momsdeklaration figure and its drill-down find the momsredovisning
-- shapes among the few verifikat that can have them, through one shared
-- definition, and take the account sums from ledger_account_days once the
-- company is built.
--
-- Why: get_vat_declaration_totals read every line of the period twice under
-- the lines' RLS policy, which re-checks the parent entry once per line: once
-- to sum the declaration accounts and once to decide each verifikat's
-- momsredovisning shape. Its generic plan also joined the lines to the
-- account lists as a nested loop (126 x 15 000 comparisons for one month).
-- For a company with 50 000 verifikat a year it took 185 ms for a month,
-- 600 ms for a quarter and 1.9 s for the year (local, prod settings, under
-- RLS); the drill-down, which repeats the same shape pass, 140 ms per page of
-- a month and 1.1 s for the year.
--
-- Now:
--   1. vat_declaration_special_entries() is the one definition both functions
--      read (the copies "kept in step" before): the opening balance chains
--      and whether each member counts (crm#1333), the kontantmetod cut-off
--      reversals, and the period's verifikat of either momsredovisning shape
--      (crm#1331, #2805). A shape needs a line on a net account (shape 1:
--      2650/1650) or on the skattekonto (shape 2: 1630, plus 2012 for an
--      enskild firma), so only verifikat with such a line have their lines
--      read; once the company is built (ledger_account_days_ready), only the
--      days on which those accounts moved are looked at. The shape flags are
--      the predicates of 20261021000500, line for line.
--   2. The figure reads the period's verifikat once, for the source_type
--      counts and the ones the rutor leave out by their tag. Once the company
--      is built, the totals are the period's ledger_account_days sums on the
--      declaration accounts less the lines of the verifikat the rutor do not
--      read (the posted bokslut, the left-out and the shaped ones): a handful
--      of verifikat instead of every line. Until the build cron reaches the
--      company, it sums the lines of the verifikat the rutor read, as before.
--   3. The drill-down reads the lines of the ruta's accounts, on the days
--      those accounts moved once the company is built, and leaves out the
--      same verifikat.
--   4. plpgsql, so a connection plans each statement once instead of on every
--      call (a SQL function is planned per call on PG 17). The figure's one
--      pass over the period's verifikat is the exception: EXECUTE plans it for
--      the period's own size each call, since the cached generic plan sorted a
--      year's verifikat to count them.
--
-- Measured the same way after: 9 ms a month, 14 ms a quarter, 35 ms the year;
-- the drill-down 17 ms per page of a month, 23 ms for the year's first page.
--
-- Results are identical: the same verifikat are left out for the same
-- reasons, and the sums are exact numeric sums either way (compared before
-- and after for every month, quarter and year of the 50 000-verifikat
-- company, and pinned in tests/pg/vat-declaration-ledger-days.pg.test.ts).
-- One reading differs by construction and nobody can see it: a stored day
-- sums coalesce(debit_amount, 0), so an account whose every counted line has
-- a NULL amount on one side reports 0 there instead of null; the app reads
-- both as 0 (fetchVatAccountTotals: Number(x) || 0).
--
-- Signatures, return shapes, SECURITY INVOKER, search_path and ACLs of the two
-- restated functions are unchanged (their language is now plpgsql), so the
-- app deployed before this keeps working during the deploy window.
--
-- pg-test: tests/pg/vat-declaration-ledger-days.pg.test.ts,
--          tests/pg/vat-totals-carried-entries.pg.test.ts,
--          tests/pg/vat-totals-shape-pass.pg.test.ts,
--          tests/pg/vat-declaration-totals-rpc.pg.test.ts,
--          tests/pg/vat-ruta-drilldown-reconcile.pg.test.ts,
--          tests/pg/vat-skattekonto-counter-entries.pg.test.ts

-- =============================================================================
-- The verifikat the declaration treats specially.
-- =============================================================================

-- One row per (verifikat, reason):
--   counted_opening_balance  an opening balance chain member that feeds this
--                            declaration (kept out of the shapes),
--   carried_opening_balance  one that does not (left out),
--   kontantmetod_cutoff      a kontantmetod cut-off reversal (left out),
--   momsredovisning_shape    a verifikat of the period shaped like a
--                            momsredovisning (left out).
-- The chain members are listed company-wide and the cut-off reversals as the
-- caller sees them, as the old anti-joins read them; a reader keeps the ones
-- of its own period.
-- A tagged momsredovisning (source_type 'vat_settlement') is left out by its
-- tag, which every reader sees on the verifikat itself; it is never a shape.
-- Shape 1 reads p_net_shape_ruta_accounts / p_net_shape_net_accounts (the
-- figure passes only the ones it measures), shape 2 p_ruta_accounts /
-- p_net_accounts.
CREATE OR REPLACE FUNCTION public.vat_declaration_special_entries(
  p_company_id uuid,
  p_start date,
  p_end date,
  p_net_shape_ruta_accounts text[],
  p_net_shape_net_accounts text[],
  p_ruta_accounts text[],
  p_net_accounts text[]
)
RETURNS TABLE (journal_entry_id uuid, reason text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
ROWS 20
AS $$
#variable_conflict use_column
DECLARE
  -- 1630, plus 2012 for an enskild firma.
  v_tax_accounts text[] := public.skattekonto_shape_accounts(p_company_id);
  v_shape_line_accounts text[];
  v_shape_days date[];
BEGIN
  -- Shape 1 needs a line on one of its net accounts, shape 2 one on the
  -- skattekonto: no other verifikat can be a momsredovisning.
  v_shape_line_accounts := ARRAY(
    SELECT a FROM unnest(p_net_shape_net_accounts) a
    UNION
    SELECT a FROM unnest(v_tax_accounts) a
  );

  -- The days such a line can be on: once the company is built, the days on
  -- which those accounts moved; until then every day of the period.
  IF public.ledger_account_days_ready(p_company_id) THEN
    v_shape_days := ARRAY(
      SELECT DISTINCT d.entry_date
      FROM public.ledger_account_days d
      WHERE d.company_id = p_company_id
        AND d.entry_date >= p_start
        AND d.entry_date <= p_end
        AND d.account_number = ANY (v_shape_line_accounts)
        AND d.line_count > 0
    );
  ELSE
    v_shape_days := ARRAY(
      SELECT g::date
      FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
    );
  END IF;

  RETURN QUERY
  WITH closing_entries AS (
    SELECT fp.closing_entry_id AS id
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND fp.closing_entry_id IS NOT NULL
  ),
  -- Every opening balance of the company with the stornos and rättelser of
  -- it, down the chain, each with the IB at its root (crm#1333). Not dated by
  -- the period on purpose: a storno can be dated apart from its IB. An
  -- opening balance is always its own root. Only a balance is an IB: an entry
  -- tagged opening_balance that books a resultatkonto (class 3-8, which no IB
  -- door writes: a verifikat marked as IB in bank reconciliation) is an
  -- ordinary verifikat here.
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
    SELECT chain.id, chain.root_id FROM chain
  ),
  -- Whether an opening balance feeds this declaration. It does only when it
  -- is dated after the period's first day AND the books hold no other
  -- verifikat of the period before it: then it is the only carrier of those
  -- days' VAT (a migration mid-period). An IB on the first day carries only
  -- earlier periods; one after the first day with the period's earlier days
  -- in the books (the year-end roll-forward into a räkenskapsår starting
  -- mid-period, an import that brought the earlier verifikat) would count
  -- them twice.
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
    WHERE o.id IN (SELECT ib_chain.root_id FROM ib_chain)
  ),
  -- Each chain member follows the IB at its root (if two roots ever meet, it
  -- counts only when both do).
  ib_members AS (
    SELECT b.id, bool_and(r.counts) AS counts
    FROM ib_chain b
    JOIN ib_roots r ON r.id = b.root_id
    GROUP BY b.id
  ),
  cutoff_reversals AS (
    SELECT DISTINCT k.journal_entry_id AS id
    FROM public.kontantmetod_cutoff_entries k
    WHERE k.kind IN ('receivable_reversal', 'payable_reversal')
      AND k.journal_entry_id IS NOT NULL
  ),
  -- The verifikat of the period the rutor read (not tagged, not a cut-off
  -- reversal, no chain member: neither shape applies to a chain member) with
  -- a line on a shape's own account.
  shape_candidates AS MATERIALIZED (
    SELECT e.id
    FROM public.journal_entries e
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND e.entry_date = ANY (v_shape_days)
      AND e.entry_date >= p_start
      AND e.entry_date <= p_end
      AND NOT (
        e.status = 'posted'
        AND EXISTS (SELECT 1 FROM closing_entries c WHERE c.id = e.id)
      )
      AND e.source_type IS DISTINCT FROM 'vat_settlement'
      AND NOT EXISTS (SELECT 1 FROM cutoff_reversals k WHERE k.id = e.id)
      AND NOT EXISTS (SELECT 1 FROM ib_members m WHERE m.id = e.id)
      AND EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number = ANY (v_shape_line_accounts)
      )
  ),
  -- Both momsredovisning shapes, from every line of each candidate:
  --   net_shape (shape 1): a declaration account AND a 2650/1650 line.
  --   tax_shape (shape 2): a pure movement between VAT accounts and the
  --     skattekonto: a 26xx declaration line, a skattekonto line, no
  --     2650/1650 line, and NOTHING else but 26xx, the skattekonto and 3740
  --     (öres- och kronutjämning) on any line.
  shape_flags AS (
    SELECT f.id,
           f.ruta_line AND f.net_line AS net_shape,
           f.moms_ruta_line AND f.tax_line AND NOT f.any_net_line AND NOT f.other_line AS tax_shape
    FROM (
      SELECT l.journal_entry_id AS id,
             COALESCE(bool_or(l.account_number = ANY (p_net_shape_ruta_accounts)), false) AS ruta_line,
             COALESCE(bool_or(l.account_number = ANY (p_net_shape_net_accounts)), false) AS net_line,
             COALESCE(bool_or(l.account_number = ANY (p_ruta_accounts)
                              AND l.account_number LIKE '26%'), false) AS moms_ruta_line,
             COALESCE(bool_or(l.account_number = ANY (v_tax_accounts)), false) AS tax_line,
             COALESCE(bool_or(l.account_number = ANY (p_net_accounts)), false) AS any_net_line,
             COALESCE(bool_or(l.account_number NOT LIKE '26%'
                              AND l.account_number <> ALL (v_tax_accounts)
                              AND l.account_number <> '3740'), false) AS other_line
      FROM shape_candidates c
      JOIN public.journal_entry_lines l ON l.journal_entry_id = c.id
      GROUP BY l.journal_entry_id
    ) f
  )
  SELECT m.id,
         CASE WHEN m.counts THEN 'counted_opening_balance' ELSE 'carried_opening_balance' END
  FROM ib_members m
  UNION ALL
  SELECT k.id, 'kontantmetod_cutoff'
  FROM cutoff_reversals k
  UNION ALL
  SELECT f.id, 'momsredovisning_shape'
  FROM shape_flags f
  WHERE f.net_shape OR f.tax_shape;
END;
$$;

REVOKE ALL ON FUNCTION public.vat_declaration_special_entries(uuid, date, date, text[], text[], text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vat_declaration_special_entries(uuid, date, date, text[], text[], text[], text[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.vat_declaration_special_entries(uuid, date, date, text[], text[], text[], text[]) IS
  'The verifikat the momsdeklaration treats specially: opening balance chain members (counted or carried), kontantmetod cut-off reversals and the period''s momsredovisning-shaped verifikat. The one definition get_vat_declaration_totals and get_vat_ruta_source_lines read.';

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
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_ready boolean := public.ledger_account_days_ready(p_company_id);
  -- Shape 1 of the figure reads only the accounts it measures.
  v_net_shape_ruta text[] := ARRAY(SELECT unnest(p_ruta_accounts) INTERSECT SELECT unnest(p_accounts));
  v_net_shape_net text[] := ARRAY(SELECT unnest(p_net_accounts) INTERSECT SELECT unnest(p_accounts));
  v_left_out uuid[];  -- cut-off reversals and carried chain members, of any period
  v_shaped uuid[];    -- the period's momsredovisning-shaped verifikat
  v_counted uuid[];   -- chain members that count, of any period
  v_counts jsonb;     -- the period's verifikat per source_type
  v_not_read uuid[];  -- the period's verifikat left out before any shape
BEGIN
  SELECT COALESCE(array_agg(s.journal_entry_id) FILTER (
           WHERE s.reason IN ('kontantmetod_cutoff', 'carried_opening_balance')), '{}'),
         COALESCE(array_agg(s.journal_entry_id) FILTER (WHERE s.reason = 'momsredovisning_shape'), '{}'),
         COALESCE(array_agg(s.journal_entry_id) FILTER (WHERE s.reason = 'counted_opening_balance'), '{}')
    INTO v_left_out, v_shaped, v_counted
    FROM public.vat_declaration_special_entries(
      p_company_id, p_start, p_end,
      v_net_shape_ruta, v_net_shape_net,
      p_ruta_accounts, p_net_accounts
    ) s;

  -- The period's verifikat, read once: the counts per source_type and the
  -- ones the rutor leave out before any shape (tagged, cut-off reversal,
  -- carried opening balance). The posted bokslut is no verifikat here.
  -- EXECUTE plans it for the period's own size on every call: a cached
  -- generic plan sorts a year's 50 000 verifikat to count them.
  EXECUTE $sql$
    WITH g AS (
      SELECT e.source_type,
             count(*)::int AS n,
             array_agg(e.id) FILTER (
               WHERE e.source_type = 'vat_settlement'
                  OR e.id IN (SELECT x FROM unnest($4::uuid[]) x)
             ) AS left_out
      FROM public.journal_entries e
      WHERE e.company_id = $1
        AND e.status IN ('posted', 'reversed')
        AND e.entry_date >= $2
        AND e.entry_date <= $3
        AND NOT (
          e.status = 'posted'
          AND e.id IN (
            SELECT fp.closing_entry_id
            FROM public.fiscal_periods fp
            WHERE fp.company_id = $1
              AND fp.closing_entry_id IS NOT NULL
          )
        )
      GROUP BY e.source_type
    )
    SELECT (SELECT jsonb_object_agg(COALESCE(g.source_type, ''), g.n) FROM g),
           ARRAY(SELECT x FROM g CROSS JOIN LATERAL unnest(g.left_out) x)
  $sql$
  INTO v_counts, v_not_read
  USING p_company_id, p_start, p_end, v_left_out;

  RETURN (
    -- The account lists as a lookup table, built once (crm#1331).
    WITH account_lists AS MATERIALIZED (
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
    closing_entries AS (
      SELECT fp.closing_entry_id AS id
      FROM public.fiscal_periods fp
      WHERE fp.company_id = p_company_id
        AND fp.closing_entry_id IS NOT NULL
    ),
    -- Every verifikat of the period the rutor do not read: left out, shaped,
    -- or the posted bokslut (fiscal_periods.closing_entry_id).
    not_read AS MATERIALIZED (
      SELECT unnest(v_not_read) AS id
      UNION
      SELECT unnest(v_shaped)
      UNION
      SELECT e.id
      FROM public.journal_entries e
      WHERE e.id IN (SELECT c.id FROM closing_entries c)
        AND e.company_id = p_company_id
        AND e.status = 'posted'
        AND e.entry_date >= p_start
        AND e.entry_date <= p_end
    ),
    -- Built: the stored days less what the rutor do not read. An account
    -- appears exactly when at least one line the rutor read is on it.
    day_sums AS (
      SELECT d.account_number,
             sum(d.debit) AS debit,
             sum(d.credit) AS credit,
             sum(d.line_count) AS line_count
      FROM public.ledger_account_days d
      JOIN account_lists a ON a.account_number = d.account_number
      WHERE v_ready
        AND a.measured
        AND d.company_id = p_company_id
        AND d.entry_date >= p_start
        AND d.entry_date <= p_end
      GROUP BY d.account_number
    ),
    not_read_sums AS (
      SELECT l.account_number,
             sum(coalesce(l.debit_amount, 0)) AS debit,
             sum(coalesce(l.credit_amount, 0)) AS credit,
             count(*) AS line_count
      FROM not_read x
      JOIN public.journal_entry_lines l ON l.journal_entry_id = x.id
      JOIN account_lists a ON a.account_number = l.account_number
      WHERE v_ready
        AND a.measured
      GROUP BY l.account_number
    ),
    totals AS (
      SELECT d.account_number,
             (d.debit - COALESCE(x.debit, 0))::float8 AS debit,
             (d.credit - COALESCE(x.credit, 0))::float8 AS credit
      FROM day_sums d
      LEFT JOIN not_read_sums x ON x.account_number = d.account_number
      WHERE d.line_count - COALESCE(x.line_count, 0) > 0
      UNION ALL
      -- Not built yet: the lines the rutor read.
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      JOIN account_lists a ON a.account_number = l.account_number
      WHERE NOT v_ready
        AND a.measured
        AND e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND e.entry_date >= p_start
        AND e.entry_date <= p_end
        AND NOT EXISTS (SELECT 1 FROM not_read x WHERE x.id = e.id)
        AND NOT (
          e.status = 'posted'
          AND EXISTS (SELECT 1 FROM closing_entries c WHERE c.id = e.id)
        )
      GROUP BY l.account_number
    )
    SELECT jsonb_build_object(
      'totals', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'account_number', t.account_number,
          'debit', t.debit,
          'credit', t.credit
        ) ORDER BY t.account_number)
        FROM totals t
      ), '[]'::jsonb),
      'settlement_shaped_entries', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', e.id,
          'status', e.status,
          'entry_date', e.entry_date,
          'source_type', e.source_type,
          'voucher_series', e.voucher_series,
          'voucher_number', e.voucher_number
        ) ORDER BY e.entry_date, e.id)
        FROM public.journal_entries e
        WHERE e.id = ANY (v_shaped)
      ), '[]'::jsonb),
      'source_type_counts', COALESCE(v_counts, '{}'::jsonb),
      -- The opening balances this declaration counts, so the momsredovisning
      -- matcher (carriedIntoPeriod) reads the same decision: dated in the
      -- period, counted, and not a cut-off reversal.
      'counted_opening_balances', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', e.id,
          'status', e.status,
          'entry_date', e.entry_date
        ) ORDER BY e.entry_date, e.id)
        FROM public.journal_entries e
        WHERE e.id = ANY (v_counted)
          AND e.id <> ALL (v_left_out)
          AND e.source_type = 'opening_balance'
          AND e.company_id = p_company_id
          AND e.status IN ('posted', 'reversed')
          AND e.entry_date >= p_start
          AND e.entry_date <= p_end
          AND NOT (
            e.status = 'posted'
            AND EXISTS (SELECT 1 FROM closing_entries c WHERE c.id = e.id)
          )
      ), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) TO authenticated, service_role;

-- =============================================================================
-- The drill-down: the same special verifikat, so it lists exactly what the
-- figure sums.
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
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
  v_days date[];
BEGIN
  -- The days a line on the ruta's accounts can be on: once the company is
  -- built, the days on which they moved; until then every day of the period.
  IF public.ledger_account_days_ready(p_company_id) THEN
    v_days := ARRAY(
      SELECT DISTINCT d.entry_date
      FROM public.ledger_account_days d
      WHERE d.company_id = p_company_id
        AND d.entry_date >= p_start
        AND d.entry_date <= p_end
        AND d.account_number = ANY (p_accounts)
        AND d.line_count > 0
    );
  ELSE
    v_days := ARRAY(
      SELECT g::date
      FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
    );
  END IF;

  RETURN QUERY
  WITH special AS MATERIALIZED (
    -- Both shapes on the drill-down's own lists, as before.
    SELECT s.journal_entry_id AS id, s.reason
    FROM public.vat_declaration_special_entries(
      p_company_id, p_start, p_end,
      p_ruta_accounts, p_net_accounts,
      p_ruta_accounts, p_net_accounts
    ) s
  ),
  closing_entries AS (
    SELECT fp.closing_entry_id AS id
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND fp.closing_entry_id IS NOT NULL
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
  FROM public.journal_entries je
  JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
  WHERE je.company_id = p_company_id
    AND je.status IN ('posted', 'reversed')
    AND je.entry_date = ANY (v_days)
    AND je.entry_date >= p_start
    AND je.entry_date <= p_end
    AND NOT (
      je.status = 'posted'
      AND EXISTS (SELECT 1 FROM closing_entries c WHERE c.id = je.id)
    )
    AND je.source_type IS DISTINCT FROM 'vat_settlement'
    -- Left out (cut-off reversal, carried opening balance) or shaped; a
    -- counted chain member stays.
    AND NOT EXISTS (
      SELECT 1 FROM special x
      WHERE x.id = je.id
        AND x.reason <> 'counted_opening_balance'
    )
    AND l.account_number = ANY (p_accounts)
    -- A row past the cursor is dated on or after it.
    AND (p_cursor_date IS NULL OR je.entry_date >= p_cursor_date)
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
END;
$$;

REVOKE ALL ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
