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
-- reading changes, by one rule: every 29xx line of a verifikat that books a
-- deferral with moms is read as the sale, on its revenue account, with its
-- own sign.
--
--   1. vat_invoice_deferral_schedules(): every förutbetald intäkt a customer
--      invoice booked (a revenue schedule with an invoice, its origin
--      verifikat and a 29xx account), and whether its line carries Swedish
--      moms (the invoice row's moms-sats above 0).
--   2. vat_invoice_deferral_shares(): the verifikat that book such a
--      deferral, and the part of their 29xx lines each revenue account
--      reads: the invoice's verifikat and its kreditfaktura at the invoice's
--      parts, each release whole on its schedule's revenue account, and every
--      storno and rättelse down from any of them (reverses_id,
--      correction_of_id) at its root's parts.
--   3. get_vat_declaration_totals() adds the read sale to its revenue
--      account's totals, and get_vat_ruta_source_lines() lists the 29xx line
--      in that ruta, so the drill-down still lists what the figure sums.
--
-- The one rule covers every way the books move a deferral:
--   - the invoice counts its deferred sale in its own period;
--   - a release (Dr 29xx / Cr revenue) nets to nothing on its revenue
--     account, so no release month reports a sale; a storno or rättelse of
--     one nets to nothing the same way, and a rättelse of a release that also
--     books a new sale keeps that sale and its moms;
--   - a kreditfaktura, a storno or a rättelse of the invoice moves the sale
--     with its own lines, also when the rättelse books the deferral on
--     another 29xx account: every 29xx line of the verifikat is read, not
--     only the schedule's account;
--   - an invoice's part is taken of all the invoice deferred, as its
--     verifikat booked it on 29xx: a row the schedule door could not schedule
--     is not known to carry moms, so it is not read as a sale with moms, and
--     a negative row lowers the whole.
--
-- Not changed: a deferral whose line has no Swedish moms (a momsfri line on
-- 2970), an upplupen intäkt on 17xx, and a manual periodisering keep the
-- reading they had. get_vat_declaration_totals and get_vat_ruta_source_lines
-- are restated from 20261023094030 with only the changes above. Signatures,
-- return shapes, SECURITY INVOKER, search_path and ACLs are unchanged, so the
-- app deployed before this keeps working during the deploy window.

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
  'Every förutbetald intäkt (29xx) a customer invoice booked, with whether its line carries Swedish moms (crm#1919). The one definition vat_invoice_deferral_shares reads.';

CREATE OR REPLACE FUNCTION public.vat_invoice_deferral_shares(p_company_id uuid)
RETURNS TABLE (
  journal_entry_id uuid,
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
  -- What each invoice's verifikat booked on 29xx when it was posted, signed:
  -- its lines now, less what an inline rättelse added and plus what it
  -- struck (journal_entry_rattelse_log), so a rättelse moves the sale through
  -- its lines and never through the parts.
  booked AS (
    SELECT o.origin_entry_id,
           COALESCE((
             SELECT sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0))
             FROM public.journal_entry_lines l
             WHERE l.journal_entry_id = o.origin_entry_id
               AND l.account_number LIKE '29%'
           ), 0)
           - COALESCE((
             SELECT sum(COALESCE((x ->> 'credit_amount')::numeric, 0) - COALESCE((x ->> 'debit_amount')::numeric, 0))
             FROM public.journal_entry_rattelse_log r
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.added_lines, '[]'::jsonb)) x
             WHERE r.journal_entry_id = o.origin_entry_id
               AND r.company_id = p_company_id
               AND r.rattelse_type = 'lines'
               AND x ->> 'account_number' LIKE '29%'
           ), 0)
           + COALESCE((
             SELECT sum(COALESCE((x ->> 'credit_amount')::numeric, 0) - COALESCE((x ->> 'debit_amount')::numeric, 0))
             FROM public.journal_entry_rattelse_log r
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.struck_lines, '[]'::jsonb)) x
             WHERE r.journal_entry_id = o.origin_entry_id
               AND r.company_id = p_company_id
               AND r.rattelse_type = 'lines'
               AND x ->> 'account_number' LIKE '29%'
           ), 0) AS amount
    FROM (SELECT DISTINCT d.origin_entry_id FROM deferrals d) o
  ),
  -- Per invoice, each revenue account's part of every 29xx krona the invoice
  -- booked: its deferrals with moms on that account, over all the invoice
  -- deferred. All of it is what the verifikat booked, not the schedules:
  -- createSchedulesForCustomerInvoice goes on past a row it could not
  -- schedule, such a row is not known to carry moms, and a row may be
  -- negative. A part without moms is not read, as before.
  invoice_shares AS (
    SELECT d.origin_entry_id,
           d.invoice_id,
           d.target_account,
           sum(d.total_amount) FILTER (WHERE d.with_moms) / b.amount AS share
    FROM deferrals d
    JOIN booked b ON b.origin_entry_id = d.origin_entry_id
    WHERE b.amount <> 0
    GROUP BY d.origin_entry_id, d.invoice_id, d.target_account, b.amount
    HAVING bool_or(d.with_moms)
  ),
  -- The verifikat that book a deferral with moms, each with the parts its
  -- 29xx lines are read at: the invoice's verifikat, and the kreditfaktura of
  -- the invoice (its rows carry the original's periodisering), at the
  -- invoice's parts; a release (Dr 29xx / Cr its revenue account) whole, on
  -- its schedule's revenue account, once also when "Lös upp nu" links several
  -- months to one verifikat (commit_accrual_dissolution).
  root_shares AS (
    SELECT s.origin_entry_id AS root_id, s.target_account, s.share
    FROM invoice_shares s
    UNION ALL
    SELECT e.id, s.target_account, s.share
    FROM invoice_shares s
    JOIN public.invoices cn
      ON cn.credited_invoice_id = s.invoice_id
     AND cn.company_id = p_company_id
    JOIN public.journal_entries e
      ON e.source_type = 'credit_note'
     AND e.source_id = cn.id
     AND e.company_id = p_company_id
    UNION ALL
    SELECT DISTINCT i.journal_entry_id, d.target_account, 1::numeric
    FROM deferrals d
    JOIN public.accrual_schedule_installments i ON i.schedule_id = d.schedule_id
    WHERE d.with_moms
      AND i.journal_entry_id IS NOT NULL
  ),
  -- Every storno and rättelse down from them, each following its root.
  chain AS (
    SELECT DISTINCT r.root_id AS id, r.root_id FROM root_shares r
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
  SELECT c.id, r.target_account, sum(r.share)
  FROM chain c
  JOIN root_shares r ON r.root_id = c.root_id
  GROUP BY c.id, r.target_account
$$;

REVOKE ALL ON FUNCTION public.vat_invoice_deferral_shares(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vat_invoice_deferral_shares(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.vat_invoice_deferral_shares(uuid) IS
  'The verifikat whose 29xx lines the momsdeklaration reads as the sale a customer invoice deferred with moms, and on which revenue account at which part (crm#1919): the invoice''s verifikat and its kreditfaktura at the invoice''s parts, each release whole, and every storno and rättelse down from any of them. get_vat_declaration_totals, get_vat_ruta_source_lines and lib/vat/filed-period-changes.ts read it.';

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
    -- the sale it defers, on the date of the verifikat that books it: every
    -- 29xx line of the invoice's verifikat, its kreditfaktura and its
    -- releases, and of every storno and rättelse down from them, counts on
    -- the revenue account at its part (vat_invoice_deferral_shares), with its
    -- own sign. The invoice's line counts in the invoice's period; a release,
    -- Dr 29xx / Cr the revenue account, nets to nothing. Each line's part is
    -- rounded to öre before it is summed, as the drill-down lists it.
    -- not_read holds the posted bokslut.
    deferral_totals AS (
      SELECT d.target_account AS account_number,
             sum(round(COALESCE(l.debit_amount, 0) * d.share, 2)) AS debit,
             sum(round(COALESCE(l.credit_amount, 0) * d.share, 2)) AS credit
      FROM public.vat_invoice_deferral_shares(p_company_id) d
      JOIN account_lists a ON a.account_number = d.target_account AND a.measured
      JOIN public.journal_entries e ON e.id = d.journal_entry_id
      JOIN public.journal_entry_lines l
        ON l.journal_entry_id = e.id
       AND l.account_number LIKE '29%'
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
  -- parts the figure sums, every part rounded to öre as the figure rounds it.
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
    SELECT d.line_id, je.id, je.voucher_number, je.voucher_series, je.entry_date, je.description,
           je.status, je.source_type, d.debit, d.credit
    FROM (
      SELECT ds.journal_entry_id,
             dl.id AS line_id,
             sum(round(COALESCE(dl.debit_amount, 0) * ds.share, 2)) AS debit,
             sum(round(COALESCE(dl.credit_amount, 0) * ds.share, 2)) AS credit
      FROM public.vat_invoice_deferral_shares(p_company_id) ds
      JOIN public.journal_entry_lines dl
        ON dl.journal_entry_id = ds.journal_entry_id
       AND dl.account_number LIKE '29%'
      WHERE ds.target_account = ANY (p_accounts)
      GROUP BY ds.journal_entry_id, dl.id
    ) d
    JOIN public.journal_entries je ON je.id = d.journal_entry_id
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
    -- Left out (cut-off reversal, carried opening balance) or shaped; a
    -- counted chain member stays.
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
