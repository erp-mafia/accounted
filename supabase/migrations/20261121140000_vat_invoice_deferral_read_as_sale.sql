-- crm#1919: the momsdeklaration reads a förutbetald intäkt on a customer
-- invoice as the sale it defers, in the invoice's own period.
--
-- A periodiserad invoice line credits a 29xx interim account (2970 by
-- default) instead of its revenue account, and the whole moms of the line is
-- credited to 2611/2621/2631 on the same verifikat. The schedule then moves
-- the amount to the revenue account month by month, Dr 29xx / Cr 3xxx, with
-- no moms. Read as an account projection, the declaration left the deferred
-- sale out of ruta 05 in the period that reports its moms (ruta 10), and
-- counted it in each release month with no moms. In production: a 25 %
-- invoice with 2 995 kr on 3040 and 995 kr periodiserad on 2970 gave ruta 05
-- 2 995 kr against 997,50 kr in ruta 10.
--
-- The beskattningsunderlag is the ersättning (ML 2023:200 8 kap. 2 §), and
-- ruta 05 is the underlag of the moms in rutorna 10 to 12: the sale belongs
-- to the declaration that carries its moms. The books stay as they are (the
-- deferral is right for the income statement, ÅRL 2 kap. 4 §); only the
-- reading changes:
--
--   1. vat_invoice_deferral_schedules(): every förutbetald intäkt a customer
--      invoice booked (a revenue schedule with an invoice, its origin
--      verifikat and a 29xx account), and whether its line carries Swedish
--      moms (the invoice row's moms-sats above 0). One definition, read by
--      the two below.
--   2. vat_invoice_deferral_shares(): the verifikat whose 29xx lines read as
--      the deferred sale, and on which revenue account: the invoice's own
--      verifikat, the kreditfaktura of the invoice, and every storno and
--      rättelse down from either (reverses_id, correction_of_id), each with
--      its own lines and sign. When several deferrals of one verifikat share
--      a 29xx account, each with moms takes its part of the account by its
--      schedule's amount; a part without moms stays unread, as before.
--   3. vat_declaration_special_entries(): a new reason,
--      invoice_deferral_release, for the releases of a deferral with moms and
--      their stornos. The rutor leave them out like a kontantmetod cut-off
--      reversal.
--   4. get_vat_declaration_totals() adds the deferred sale to its revenue
--      account's totals, and get_vat_ruta_source_lines() lists the 29xx line
--      in that ruta, so the drill-down still lists what the figure sums.
--
-- Not changed: a deferral whose line has no Swedish moms (a momsfri line on
-- 2970), an upplupen intäkt on 17xx, and a manual periodisering keep the
-- reading they had. get_vat_declaration_totals and get_vat_ruta_source_lines
-- are restated from 20261023094030, vat_declaration_special_entries from
-- 20261115090244, each with only the changes above. Signatures, return
-- shapes, SECURITY INVOKER, search_path and ACLs are unchanged, so the app
-- deployed before this keeps working during the deploy window.

CREATE OR REPLACE FUNCTION public.vat_invoice_deferral_schedules(p_company_id uuid)
RETURNS TABLE (
  schedule_id uuid,
  invoice_id uuid,
  origin_entry_id uuid,
  balance_account text,
  target_account text,
  total_amount numeric,
  with_moms boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  -- A row whose invoice item is gone (invoice_item_id SET NULL) has no known
  -- moms-sats and keeps the old reading.
  SELECT s.id,
         s.invoice_id,
         s.origin_journal_entry_id,
         s.balance_account,
         s.target_account,
         s.total_amount,
         COALESCE(i.vat_rate, 0) > 0
  FROM public.accrual_schedules s
  LEFT JOIN public.invoice_items i ON i.id = s.invoice_item_id
  WHERE s.company_id = p_company_id
    AND s.direction = 'revenue'
    AND s.invoice_id IS NOT NULL
    AND s.origin_journal_entry_id IS NOT NULL
    AND s.balance_account LIKE '29%'
$$;

REVOKE ALL ON FUNCTION public.vat_invoice_deferral_schedules(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vat_invoice_deferral_schedules(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.vat_invoice_deferral_schedules(uuid) IS
  'Every förutbetald intäkt (29xx) a customer invoice booked, with whether its line carries Swedish moms (crm#1919). The one definition vat_invoice_deferral_shares and vat_declaration_special_entries read.';

CREATE OR REPLACE FUNCTION public.vat_invoice_deferral_shares(p_company_id uuid)
RETURNS TABLE (
  journal_entry_id uuid,
  balance_account text,
  target_account text,
  share numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH RECURSIVE deferrals AS MATERIALIZED (
    SELECT * FROM public.vat_invoice_deferral_schedules(p_company_id)
  ),
  -- Per origin verifikat and 29xx account, each revenue account's part of
  -- what the deferrals with moms put there.
  shares AS (
    SELECT d.origin_entry_id,
           d.invoice_id,
           d.balance_account,
           d.target_account,
           sum(d.total_amount) FILTER (WHERE d.with_moms) / t.total AS share
    FROM deferrals d
    JOIN (
      SELECT x.origin_entry_id, x.balance_account, sum(x.total_amount) AS total
      FROM deferrals x
      GROUP BY x.origin_entry_id, x.balance_account
    ) t ON t.origin_entry_id = d.origin_entry_id AND t.balance_account = d.balance_account
    GROUP BY d.origin_entry_id, d.invoice_id, d.balance_account, d.target_account, t.total
    HAVING bool_or(d.with_moms)
  ),
  -- The invoice's verifikat, and the kreditfaktura of the invoice (its rows
  -- carry the original's periodisering, so it books the same 29xx account).
  roots AS (
    SELECT DISTINCT s.origin_entry_id AS id, s.origin_entry_id AS root_id
    FROM shares s
    UNION
    SELECT e.id, s.origin_entry_id
    FROM shares s
    JOIN public.invoices cn
      ON cn.credited_invoice_id = s.invoice_id
     AND cn.company_id = p_company_id
    JOIN public.journal_entries e
      ON e.source_type = 'credit_note'
     AND e.source_id = cn.id
     AND e.company_id = p_company_id
  ),
  -- Every storno and rättelse down from them, each following its root.
  chain AS (
    SELECT r.id, r.root_id FROM roots r
    UNION
    SELECT n.id, c.root_id
    FROM chain c
    CROSS JOIN LATERAL (
      SELECT x.id FROM public.journal_entries x
      WHERE x.reverses_id = c.id AND x.company_id = p_company_id
      UNION ALL
      SELECT y.id FROM public.journal_entries y
      WHERE y.correction_of_id = c.id AND y.company_id = p_company_id
    ) n
  )
  SELECT c.id, s.balance_account, s.target_account, s.share
  FROM chain c
  JOIN shares s ON s.origin_entry_id = c.root_id
$$;

REVOKE ALL ON FUNCTION public.vat_invoice_deferral_shares(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vat_invoice_deferral_shares(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.vat_invoice_deferral_shares(uuid) IS
  'The verifikat whose 29xx lines the momsdeklaration reads as the sale a customer invoice deferred, and on which revenue account at which part (crm#1919): the invoice''s verifikat, its kreditfaktura, and every storno and rättelse down from either. get_vat_declaration_totals, get_vat_ruta_source_lines and lib/vat/filed-period-changes.ts read it.';

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
  -- The releases of a förutbetald intäkt a customer invoice booked with moms
  -- (crm#1919), and the stornos of them: the invoice's own period reads the
  -- deferred sale (vat_invoice_deferral_shares), so a release, Dr 29xx /
  -- Cr the revenue account with no moms, is no sale of its own month.
  deferral_releases AS (
    SELECT i.journal_entry_id AS id
    FROM public.vat_invoice_deferral_schedules(p_company_id) s
    JOIN public.accrual_schedule_installments i ON i.schedule_id = s.schedule_id
    WHERE s.with_moms
      AND i.journal_entry_id IS NOT NULL
  ),
  deferral_release_members AS (
    SELECT r.id FROM deferral_releases r
    UNION
    SELECT x.id
    FROM public.journal_entries x
    JOIN deferral_releases r ON r.id = x.reverses_id
    WHERE x.company_id = p_company_id
  ),
  -- The verifikat a person marked as no momsredovisning (crm#1849): the
  -- latest mark on a verifikat decides, a withdrawn one restores the shapes.
  marked_roots AS (
    SELECT latest.id
    FROM (
      SELECT DISTINCT ON (k.journal_entry_id) k.journal_entry_id AS id, k.action
      FROM public.vat_momsredovisning_marks k
      WHERE k.company_id = p_company_id
      ORDER BY k.journal_entry_id, k.created_at DESC, k.id DESC
    ) latest
    WHERE latest.action = 'not_momsredovisning'
  ),
  -- A storno annuls its original line for line, so it follows the original's
  -- mark: otherwise the storno alone would pass for a momsredovisning while
  -- the annulled original still counts.
  marked AS (
    SELECT r.id FROM marked_roots r
    UNION
    SELECT s.id
    FROM public.journal_entries s
    JOIN marked_roots r ON r.id = s.reverses_id
    WHERE s.company_id = p_company_id
  ),
  -- The verifikat of the period the rutor read (not tagged, not a cut-off
  -- reversal, no chain member: neither shape applies to a chain member, not
  -- marked as no momsredovisning) with a line on a shape's own account.
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
      AND NOT EXISTS (SELECT 1 FROM marked k WHERE k.id = e.id)
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
  SELECT d.id, 'invoice_deferral_release'
  FROM deferral_release_members d
  UNION ALL
  SELECT f.id, 'momsredovisning_shape'
  FROM shape_flags f
  WHERE f.net_shape OR f.tax_shape;
END;
$$;

REVOKE ALL ON FUNCTION public.vat_declaration_special_entries(uuid, date, date, text[], text[], text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vat_declaration_special_entries(uuid, date, date, text[], text[], text[], text[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.vat_declaration_special_entries(uuid, date, date, text[], text[], text[], text[]) IS
  'The verifikat the momsdeklaration treats specially: opening balance chain members (counted or carried), kontantmetod cut-off reversals, the releases of a förutbetald intäkt an invoice booked with moms (crm#1919) and the period''s momsredovisning-shaped verifikat. The one definition get_vat_declaration_totals and get_vat_ruta_source_lines read.';

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
  v_left_out uuid[];  -- cut-off reversals, carried chain members and deferral releases, of any period
  v_shaped uuid[];    -- the period's momsredovisning-shaped verifikat
  v_counted uuid[];   -- chain members that count, of any period
  v_counts jsonb;     -- the period's verifikat per source_type
  v_not_read uuid[];  -- the period's verifikat left out before any shape
BEGIN
  SELECT COALESCE(array_agg(s.journal_entry_id) FILTER (
           WHERE s.reason IN ('kontantmetod_cutoff', 'carried_opening_balance', 'invoice_deferral_release')), '{}'),
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
    ledger_totals AS (
      SELECT d.account_number,
             d.debit - COALESCE(x.debit, 0) AS debit,
             d.credit - COALESCE(x.credit, 0) AS credit
      FROM day_sums d
      LEFT JOIN not_read_sums x ON x.account_number = d.account_number
      WHERE d.line_count - COALESCE(x.line_count, 0) > 0
      UNION ALL
      -- Not built yet: the lines the rutor read.
      SELECT l.account_number,
             sum(l.debit_amount) AS debit,
             sum(l.credit_amount) AS credit
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
    ),
    -- A förutbetald intäkt an invoice booked with moms (crm#1919) is read as
    -- the sale it defers, on the date of the verifikat that books it: the
    -- invoice's 29xx line counts on the revenue account it is released to,
    -- in the invoice's period, and so do the 29xx lines of its kreditfaktura,
    -- storno or rättelse, each with its own sign. Its releases are left out
    -- above (invoice_deferral_release). not_read holds the posted bokslut.
    deferral_totals AS (
      SELECT d.target_account AS account_number,
             round(sum(COALESCE(l.debit_amount, 0) * d.share), 2) AS debit,
             round(sum(COALESCE(l.credit_amount, 0) * d.share), 2) AS credit
      FROM public.vat_invoice_deferral_shares(p_company_id) d
      JOIN account_lists a ON a.account_number = d.target_account AND a.measured
      JOIN public.journal_entries e ON e.id = d.journal_entry_id
      JOIN public.journal_entry_lines l
        ON l.journal_entry_id = e.id
       AND l.account_number = d.balance_account
      WHERE e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND e.entry_date >= p_start
        AND e.entry_date <= p_end
        AND NOT EXISTS (SELECT 1 FROM not_read x WHERE x.id = e.id)
      GROUP BY d.target_account
    ),
    totals AS (
      SELECT t.account_number,
             sum(t.debit)::float8 AS debit,
             sum(t.credit)::float8 AS credit
      FROM (
        SELECT * FROM ledger_totals
        UNION ALL
        SELECT * FROM deferral_totals
      ) t
      GROUP BY t.account_number
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
  ),
  -- The ruta's lines: those on its accounts, and the 29xx lines read as a
  -- sale on one of them (vat_invoice_deferral_shares, crm#1919), each at the
  -- part the figure sums.
  read_lines AS (
    SELECT l.id AS line_id, je.id AS entry_id, je.voucher_number AS voucher,
           je.voucher_series AS series, je.entry_date AS day, je.description AS text,
           je.status AS entry_status, je.source_type AS entry_source,
           l.debit_amount AS debit, l.credit_amount AS credit
    FROM public.journal_entries je
    JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
    WHERE je.company_id = p_company_id
      AND je.entry_date = ANY (v_days)
      AND l.account_number = ANY (p_accounts)
    UNION ALL
    SELECT l.id, je.id, je.voucher_number, je.voucher_series, je.entry_date, je.description,
           je.status, je.source_type,
           round(l.debit_amount * d.share, 2), round(l.credit_amount * d.share, 2)
    FROM (
      SELECT ds.journal_entry_id, ds.balance_account, sum(ds.share) AS share
      FROM public.vat_invoice_deferral_shares(p_company_id) ds
      WHERE ds.target_account = ANY (p_accounts)
      GROUP BY ds.journal_entry_id, ds.balance_account
    ) d
    JOIN public.journal_entries je ON je.id = d.journal_entry_id
    JOIN public.journal_entry_lines l
      ON l.journal_entry_id = je.id
     AND l.account_number = d.balance_account
    WHERE je.company_id = p_company_id
  )
  SELECT
    r.line_id,
    r.entry_id AS journal_entry_id,
    r.voucher AS voucher_number,
    COALESCE(r.series, 'A') AS voucher_series,
    r.day AS entry_date,
    COALESCE(r.text, '') AS description,
    r.debit AS debit_amount,
    r.credit AS credit_amount
  FROM read_lines r
  WHERE r.entry_status IN ('posted', 'reversed')
    AND r.day >= p_start
    AND r.day <= p_end
    AND NOT (
      r.entry_status = 'posted'
      AND EXISTS (SELECT 1 FROM closing_entries c WHERE c.id = r.entry_id)
    )
    AND r.entry_source IS DISTINCT FROM 'vat_settlement'
    -- Left out (cut-off reversal, carried opening balance, deferral release)
    -- or shaped; a counted chain member stays.
    AND NOT EXISTS (
      SELECT 1 FROM special x
      WHERE x.id = r.entry_id
        AND x.reason <> 'counted_opening_balance'
    )
    -- A row past the cursor is dated on or after it.
    AND (p_cursor_date IS NULL OR r.day >= p_cursor_date)
    AND (
      p_cursor_date IS NULL
      OR (
        r.day,
        r.voucher,
        r.entry_id,
        r.line_id
      ) > (
        p_cursor_date,
        p_cursor_voucher_number,
        COALESCE(p_cursor_entry_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid),
        COALESCE(p_cursor_line_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
      )
    )
  ORDER BY r.day, r.voucher, r.entry_id, r.line_id
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
