-- crm#1919, the mirror case: the momsdeklaration reads an upplupen intäkt on
-- a customer invoice as the sale it accrues, in the invoice's own period.
--
-- An invoice line whose service period ends before the invoice month credits
-- a 17xx interim account (1790 by default) instead of its revenue account,
-- and the whole moms of the line is credited to 2611/2621/2631 on the same
-- verifikat, on the invoice date. Its months are booked on their own last
-- days, Dr 17xx / Cr 3xxx, with no moms. Read as an account projection, the
-- declaration counted the sale, with no moms, in each month before the
-- invoice and left it out of the period that reports its moms. In
-- production: an invoice of early November for October work gave October
-- the sale in ruta 05 with no moms, and November its moms in ruta 10 with no
-- underlag.
--
-- The law. Ruta 05 is the underlag of the moms in rutorna 10 to 12, so the
-- two belong to one period (Skatteverket, Fylla i momsdeklarationen: "Beloppen
-- i fält 05-08 ska gälla samma redovisningsperiod som momsen i fält 10-12").
-- Under faktureringsmetoden, ML 2023:200 7 kap. 14 § puts the moms in the
-- period in which the sale was, or should have been, booked under god
-- redovisningssed; a receivable may wait for the invoice (BFNAR 2013:2
-- p. 3.4), and Skatteverket (När ska jag deklarera moms?) gives the main rule:
-- "Huvudprincipen är att du ska bokföra och redovisa utgående moms i samband
-- med att du ställer ut en faktura till köparen, vanligtvis på fakturadagen."
-- The months before it are the income statement's periodisering (ÅRL 2 kap.
-- 4 §), an interimspost that carries no moms. 7 kap. 14 § has no year-end
-- rule; the one in 7 kap. 16 § is the bokslutsmetod's, and Accounted refuses
-- a periodisering on an invoice line under kontantmetoden, so it never meets
-- this case.
--
-- The rule is crm#1919's, one rule for both directions of a periodisering
-- (one-definition: vat-invoice-deferral-reading): every interim line, 17xx
-- or 29xx, of a verifikat that books an invoice's periodisering with moms is
-- read as the sale, on the schedule's revenue account, with its own sign. So:
--   - the invoice counts the accrued sale, its 17xx credit, in its own period;
--   - each month (Dr 17xx / Cr revenue) nets to nothing on its revenue
--     account, so no month before the invoice reports a sale;
--   - a kreditfaktura takes the sale back with its own 17xx debit, and the
--     stornos of the months net to nothing;
--   - a storno or rättelse of any of them follows its root, also when a
--     rättelse moves the accrual to another 17xx account.
-- The parts are kept per interim class: a 29xx part is read off 29xx lines
-- and a 17xx part off 17xx lines, each taken of what the invoice booked on
-- that class. The 29xx reading stays exactly 20261122140000's, and a
-- rättelse that changes one row of an invoice that both defers and accrues
-- moves only that row's sale.
--
-- Not changed: an upplupen intäkt whose row has no Swedish moms, and any
-- manual periodisering not spread out of what a rättelse added to an
-- invoice's lines of the plan's own interim class, keep the reading they had.
-- A month reads every interim line of it at its part, so a rättelse that
-- moves a month's line to the other class still nets to nothing. A rättelse
-- that moves the invoice's own interim line to the other class (Cr 1790 to
-- Cr 2970, say) is not read: the invoice has no part of that class. Such a
-- rättelse leaves both interim accounts open, and no reading of those books
-- puts the sale right.
--
-- vat_invoice_deferral_schedules, get_vat_declaration_totals and
-- get_vat_ruta_source_lines are restated from 20261122140000 (equal to
-- production's: same md5(prosrc)), and vat_invoice_deferral_shares is
-- created again from it, with only these changes: the interim account test
-- reads 17xx as well as 29xx (^(17|29)[0-9]{2}$, the range
-- accrual_schedules_balance_account_range allows; it also takes a 29xx
-- account of four digits only, which every account number is), the parts
-- are taken and read per interim class (share for 29xx lines as before, the
-- new accrued_share for 17xx lines), and the comments. The two readers keep
-- their signatures and return shapes; SECURITY INVOKER, search_path and
-- grants are unchanged.
--
-- The deploy window. The figure and the drill-down are SQL and change with
-- this migration. The changes to a filed period fold verifikat in TS
-- (readDeferredSaleLines): an app from before this reads share off 29xx
-- lines, exactly what it read before; an app from after it reads a missing
-- accrued_share (a database before this) as no 17xx part, which is what
-- 20261122140000 answers.

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
  -- Both directions of an invoice's periodisering: a förutbetald intäkt on
  -- 29xx (months from the invoice on) and an upplupen intäkt on 17xx (months
  -- before the invoice month). A row whose invoice item is gone
  -- (invoice_item_id SET NULL) has no known moms-sats and keeps the old
  -- reading.
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
    AND s.balance_account ~ '^(17|29)[0-9]{2}$'
$$;

REVOKE ALL ON FUNCTION public.vat_invoice_deferral_schedules(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vat_invoice_deferral_schedules(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.vat_invoice_deferral_schedules(uuid) IS
  'Every periodisering a customer invoice booked, a förutbetald intäkt (29xx) or an upplupen intäkt (17xx), with whether its line carries Swedish moms (crm#1919). The one definition vat_invoice_deferral_shares reads.';

-- The return shape gains accrued_share, so the function is dropped and
-- created again; its readers are PL/pgSQL, which records no dependency on it,
-- and read the new column below in this same migration. share keeps its
-- meaning, the part read off 29xx lines, so an app from before this reads
-- exactly what it read; accrued_share is the part read off 17xx lines.
DROP FUNCTION IF EXISTS public.vat_invoice_deferral_shares(uuid);

CREATE FUNCTION public.vat_invoice_deferral_shares(p_company_id uuid)
RETURNS TABLE (
  journal_entry_id uuid,
  target_account text,
  share numeric,
  accrued_share numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  -- Every part is of one interim class, 29xx (a förutbetald intäkt) or 17xx
  -- (an upplupen intäkt), taken of what the invoice booked on that class and
  -- read off that class's lines only: the 29xx reading stays exactly what it
  -- was, and a rättelse that changes one row of an invoice that both defers
  -- and accrues moves only that row's sale.
  WITH RECURSIVE deferrals AS MATERIALIZED (
    SELECT d.*, left(d.balance_account, 2) AS interim_class
    FROM public.vat_invoice_deferral_schedules(p_company_id) d
  ),
  -- What each invoice's verifikat booked on each interim class when it was
  -- posted, signed: its lines now, less what an inline rättelse added and
  -- plus what it struck (journal_entry_rattelse_log), so a rättelse moves the
  -- sale through its lines and never through the parts.
  booked AS (
    SELECT o.origin_entry_id,
           o.interim_class,
           COALESCE((
             SELECT sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0))
             FROM public.journal_entry_lines l
             WHERE l.journal_entry_id = o.origin_entry_id
               AND l.account_number ~ '^(17|29)[0-9]{2}$'
               AND left(l.account_number, 2) = o.interim_class
           ), 0)
           - COALESCE((
             SELECT sum(COALESCE((x ->> 'credit_amount')::numeric, 0) - COALESCE((x ->> 'debit_amount')::numeric, 0))
             FROM public.journal_entry_rattelse_log r
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.added_lines, '[]'::jsonb)) x
             WHERE r.journal_entry_id = o.origin_entry_id
               AND r.company_id = p_company_id
               AND r.rattelse_type = 'lines'
               AND x ->> 'account_number' ~ '^(17|29)[0-9]{2}$'
               AND left(x ->> 'account_number', 2) = o.interim_class
           ), 0)
           + COALESCE((
             SELECT sum(COALESCE((x ->> 'credit_amount')::numeric, 0) - COALESCE((x ->> 'debit_amount')::numeric, 0))
             FROM public.journal_entry_rattelse_log r
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.struck_lines, '[]'::jsonb)) x
             WHERE r.journal_entry_id = o.origin_entry_id
               AND r.company_id = p_company_id
               AND r.rattelse_type = 'lines'
               AND x ->> 'account_number' ~ '^(17|29)[0-9]{2}$'
               AND left(x ->> 'account_number', 2) = o.interim_class
           ), 0) AS amount
    FROM (SELECT DISTINCT d.origin_entry_id, d.interim_class FROM deferrals d) o
  ),
  -- Per invoice and interim class, each revenue account's part of every
  -- krona the invoice booked on that class: its periodiseringar with moms on
  -- that account, over all the invoice put on the class. All of it is what
  -- the verifikat booked, not the schedules: createSchedulesForCustomerInvoice
  -- goes on past a row it could not schedule, and such a row is not known to
  -- carry moms. A part without moms is not read, as before.
  invoice_shares AS (
    SELECT d.origin_entry_id,
           d.invoice_id,
           d.interim_class,
           d.target_account,
           sum(d.total_amount) FILTER (WHERE d.with_moms) / b.amount AS share
    FROM deferrals d
    JOIN booked b
      ON b.origin_entry_id = d.origin_entry_id
     AND b.interim_class = d.interim_class
    WHERE b.amount <> 0
    GROUP BY d.origin_entry_id, d.invoice_id, d.interim_class, d.target_account, b.amount
    HAVING bool_or(d.with_moms)
  ),
  -- The verifikat that book a periodisering with moms, each with the parts
  -- its interim lines are read at: the invoice's verifikat, and the
  -- kreditfaktura of the invoice (its rows carry the original's
  -- periodisering), at the invoice's parts; a month (Dr 29xx or 17xx / Cr its
  -- revenue account) whole, on its schedule's revenue account and class,
  -- once also when "Lös upp nu" links several months to one verifikat
  -- (commit_accrual_dissolution).
  -- A month holds nothing but its schedule's periodisering, so its part
  -- reads every interim line of it (whole): one a rättelse moved to the
  -- other class nets to nothing too.
  root_shares AS (
    SELECT s.origin_entry_id AS root_id, s.target_account, s.interim_class, s.share, false AS whole
    FROM invoice_shares s
    UNION ALL
    SELECT e.id, s.target_account, s.interim_class, s.share, false
    FROM invoice_shares s
    JOIN public.invoices cn
      ON cn.credited_invoice_id = s.invoice_id
     AND cn.company_id = p_company_id
    JOIN public.journal_entries e
      ON e.source_type = 'credit_note'
     AND e.source_id = cn.id
     AND e.company_id = p_company_id
    UNION ALL
    SELECT DISTINCT i.journal_entry_id, d.target_account, d.interim_class, 1::numeric, true
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
  ),
  -- What a verifikat of an invoice's own chain (the invoice's verifikat, a
  -- storno or rättelse of it) reads as the sale beyond what the invoice's
  -- schedules release, per interim class: what a rättelse added to its lines
  -- of the class over what the invoice booked on it, at the invoice's parts
  -- with moms.
  claimed AS (
    SELECT c.id,
           s.interim_class,
           sum(s.share) * (
             COALESCE((
               SELECT sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0))
               FROM public.journal_entry_lines l
               WHERE l.journal_entry_id = c.id
                 AND l.account_number ~ '^(17|29)[0-9]{2}$'
                 AND left(l.account_number, 2) = s.interim_class
             ), 0) - b.amount
           ) AS amount
    FROM chain c
    JOIN invoice_shares s ON s.origin_entry_id = c.root_id
    JOIN booked b
      ON b.origin_entry_id = c.root_id
     AND b.interim_class = s.interim_class
    GROUP BY c.id, s.interim_class, b.amount
  ),
  -- A manual periodisering spread out of such a verifikat, on the same
  -- interim class, releases what that verifikat already reads as the sale,
  -- up to that part: so much of each of its months nets to nothing, like a
  -- release, and the sale is counted once. The rest keeps the reading a
  -- manual periodisering has. The months of an undone plan are all stornoed,
  -- so each nets to nothing whole.
  manual_plans AS (
    SELECT m.id, m.origin_journal_entry_id, m.target_account, m.total_amount, m.status,
           left(m.balance_account, 2) AS interim_class
    FROM public.accrual_schedules m
    WHERE m.company_id = p_company_id
      AND m.source_kind = 'manual'
      AND m.direction = 'revenue'
      AND m.balance_account ~ '^(17|29)[0-9]{2}$'
      AND EXISTS (
        SELECT 1 FROM claimed x
        WHERE x.id = m.origin_journal_entry_id
          AND x.interim_class = left(m.balance_account, 2)
          AND x.amount > 0
      )
  ),
  manual_roots AS (
    SELECT DISTINCT i.journal_entry_id AS root_id,
           p.target_account,
           p.interim_class,
           CASE WHEN p.status = 'cancelled' THEN 1::numeric
                ELSE LEAST(1::numeric, x.amount / t.total) END AS share,
           true AS whole
    FROM manual_plans p
    JOIN claimed x
      ON x.id = p.origin_journal_entry_id
     AND x.interim_class = p.interim_class
    LEFT JOIN (
      SELECT q.origin_journal_entry_id, q.interim_class, sum(q.total_amount) AS total
      FROM manual_plans q
      WHERE q.status <> 'cancelled'
      GROUP BY q.origin_journal_entry_id, q.interim_class
    ) t
      ON t.origin_journal_entry_id = p.origin_journal_entry_id
     AND t.interim_class = p.interim_class
    JOIN public.accrual_schedule_installments i ON i.schedule_id = p.id
    WHERE i.journal_entry_id IS NOT NULL
      AND (p.status = 'cancelled' OR t.total > 0)
  ),
  manual_chain AS (
    SELECT DISTINCT r.root_id AS id, r.root_id FROM manual_roots r
    UNION
    SELECT n.id, c.root_id
    FROM manual_chain c
    CROSS JOIN LATERAL (
      SELECT x.id FROM public.journal_entries x
      WHERE x.reverses_id = c.id AND x.company_id = p_company_id
      UNION ALL
      SELECT y.id FROM public.journal_entries y
      WHERE y.correction_of_id = c.id AND y.company_id = p_company_id
    ) n
  )
  -- One row per verifikat and revenue account: share is the part of its
  -- 29xx lines, accrued_share the part of its 17xx lines (a month's part is
  -- both). Each part to 12 decimals, which a double carries exactly, so a
  -- fold in TS (multiplyOre) rounds every line as round(amount * share, 2)
  -- does here.
  SELECT r.id,
         r.target_account,
         round(COALESCE(sum(r.share) FILTER (WHERE r.interim_class = '29' OR r.whole), 0), 12),
         round(COALESCE(sum(r.share) FILTER (WHERE r.interim_class = '17' OR r.whole), 0), 12)
  FROM (
    SELECT c.id, s.target_account, s.interim_class, s.share, s.whole
    FROM chain c
    JOIN root_shares s ON s.root_id = c.root_id
    UNION ALL
    SELECT c.id, s.target_account, s.interim_class, s.share, s.whole
    FROM manual_chain c
    JOIN manual_roots s ON s.root_id = c.root_id
  ) r
  GROUP BY r.id, r.target_account
$$;

REVOKE ALL ON FUNCTION public.vat_invoice_deferral_shares(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vat_invoice_deferral_shares(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.vat_invoice_deferral_shares(uuid) IS
  'The verifikat whose interim lines the momsdeklaration reads as the sale a customer invoice deferred (29xx) or accrued (17xx) with moms, and on which revenue account at which part (crm#1919): share is read off the verifikat''s 29xx lines and accrued_share off its 17xx lines. The invoice''s verifikat and its kreditfaktura at the invoice''s parts, each month of its schedules whole, the months of a manual periodisering spread out of what a rättelse added to the invoice''s lines of that class, and every storno and rättelse down from any of them. get_vat_declaration_totals, get_vat_ruta_source_lines and lib/vat/filed-period-changes.ts read it.';

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
    -- A periodisering an invoice booked with moms (crm#1919), a förutbetald
    -- intäkt on 29xx or an upplupen intäkt on 17xx, is read as the sale it
    -- defers or accrues, on the date of the verifikat that books it: every
    -- interim line of the invoice's verifikat, its kreditfaktura and its
    -- months, and of every storno and rättelse down from them, counts on the
    -- revenue account at the part of the line's interim class
    -- (vat_invoice_deferral_shares: share for 29xx, accrued_share for 17xx),
    -- with its own sign. The invoice's line
    -- counts in the invoice's period; a month, Dr 29xx or 17xx / Cr the
    -- revenue account, nets to nothing. Each line's part is rounded to öre
    -- before it is summed, as the drill-down lists it.
    -- not_read holds the posted bokslut.
    deferral_totals AS (
      SELECT d.target_account AS account_number,
             sum(round(COALESCE(l.debit_amount, 0) * p.part, 2)) AS debit,
             sum(round(COALESCE(l.credit_amount, 0) * p.part, 2)) AS credit
      FROM public.vat_invoice_deferral_shares(p_company_id) d
      JOIN account_lists a ON a.account_number = d.target_account AND a.measured
      JOIN public.journal_entries e ON e.id = d.journal_entry_id
      JOIN public.journal_entry_lines l
        ON l.journal_entry_id = e.id
       AND l.account_number ~ '^(17|29)[0-9]{2}$'
      -- A 17xx line takes the 17xx part, a 29xx line the 29xx part.
      CROSS JOIN LATERAL (
        SELECT CASE WHEN left(l.account_number, 2) = '17' THEN d.accrued_share ELSE d.share END AS part
      ) p
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
  -- The ruta's lines: those on its accounts, and the interim lines (17xx and
  -- 29xx) read as a sale on one of them (vat_invoice_deferral_shares,
  -- crm#1919), each at the parts of its interim class the figure sums, every
  -- part rounded to öre as the figure rounds it.
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
             sum(round(COALESCE(dl.debit_amount, 0) * dp.part, 2)) AS debit,
             sum(round(COALESCE(dl.credit_amount, 0) * dp.part, 2)) AS credit
      FROM public.vat_invoice_deferral_shares(p_company_id) ds
      -- The period first, so only its verifikat's lines are read and grouped.
      JOIN public.journal_entries dj
        ON dj.id = ds.journal_entry_id
       AND dj.company_id = p_company_id
       AND dj.entry_date >= p_start
       AND dj.entry_date <= p_end
      JOIN public.journal_entry_lines dl
        ON dl.journal_entry_id = ds.journal_entry_id
       AND dl.account_number ~ '^(17|29)[0-9]{2}$'
      -- A 17xx line takes the 17xx part, a 29xx line the 29xx part; a line
      -- with no part on the ruta's accounts is not listed.
      CROSS JOIN LATERAL (
        SELECT CASE WHEN left(dl.account_number, 2) = '17' THEN ds.accrued_share ELSE ds.share END AS part
      ) dp
      WHERE ds.target_account = ANY (p_accounts)
        AND dp.part <> 0
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
