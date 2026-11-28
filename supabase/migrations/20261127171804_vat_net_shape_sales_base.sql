-- A sale or a purchase with a 2650/1650 line next to it is no momsredovisning.
--
-- Shape 1 of vat_declaration_special_entries read "a line on a declaration
-- account AND a line on 2650/1650" from the accounts alone. A sale that also
-- carries a line on 2650 (VAT of another scheme booked straight to the
-- redovisningskonto next to an ordinary domestic sale, all in credit against
-- the bank, or a sale whose output VAT was booked on 2650 itself) has those
-- accounts, so the rutor left the whole verifikat out: ruta 05 and ruta 10
-- lost a real sale, and the Moms page counted the period as settled by it.
--
-- A momsredovisning moves balances between the declaration accounts and
-- 2650/1650, so in it a declaration-account line stands against a 2650/1650
-- line: one in debit, the other in credit. Shape 1 now leaves a verifikat to
-- the rutor when no declaration-account line stands against a 2650/1650 line
-- AND one of its declaration lines is a sales or purchase base: a line on a
-- declaration account outside 26xx (rutor 05-08, 20-24, 35-42, 50). Such a
-- verifikat is a sale or a purchase that happens to carry a 2650/1650 line;
-- each of its lines is balanced by other accounts.
--
-- A verifikat whose only declaration lines are 26xx keeps the shape even when
-- they stand on the same side as its 2650/1650 line: it moves VAT balances
-- (a write-off against a cost, a transfer to the owner or the skattekonto, a
-- year-end adjustment), which is bookkeeping about the declaration, not a
-- sale or a purchase. That keeps a purchase whose only declaration line is
-- 2641 next to a same-side 2650/1650 line out too, as before.
--
-- No amounts are compared, on purpose: every arithmetic narrowing of the
-- shape broke real momsredovisningar (imported ones with a small cost line,
-- settle-and-pay vouchers that debit last period's 2650, year-end vouchers).
-- Each of those has a declaration-account line against a 2650/1650 line and
-- stays a momsredovisning, as does its storno (every line changes side) and
-- the historical corrections the earlier shape tests pin. A verifikat that
-- mixes a sale with lines against 2650/1650 (a refund's VAT in debit next to
-- a 2650 credit) still has the shape and keeps the per-verifikat mark
-- (vat_momsredovisning_marks).
--
-- The side of a line is the sign of debit minus credit, so a line stored
-- before the single-side constraints (20260908164944, 20260914075216) is read
-- by its net, and a zero line stands on no side and is no base.
--
-- vat_declaration_special_entries is restated from 20261115090244, its
-- newest definition. The one change in behaviour is the side and base flags
-- and the net_shape expression in shape_flags. The signature is the same, so
-- get_vat_declaration_totals, get_vat_ruta_source_lines and the filed-period
-- changes follow with no deploy order, and CREATE OR REPLACE keeps the
-- function's owner and grants. Shape 2 (the skattekonto) is untouched.
--
-- The TypeScript restatement for a voucher not posted yet,
-- momsredovisningShapeOfLines in src/lib/vat/voucher-vat-impact.ts, changes
-- with it; tests/pg/voucher-vat-impact-shapes.pg.test.ts pins the two
-- together.
--
-- pg-test: tests/pg/vat-net-shape-sales-base.pg.test.ts,
--          tests/pg/voucher-vat-impact-shapes.pg.test.ts

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
  -- it, down the chain, each with the IB at its root. Not dated by
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
  -- The verifikat a person marked as no momsredovisning: the
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
  --   net_shape (shape 1): a declaration account AND a 2650/1650 line,
  --     unless no declaration-account line stands against a 2650/1650 line
  --     (one in debit, the other in credit) and one of the declaration lines
  --     is a sales or purchase base (a declaration account outside 26xx):
  --     then it is a sale or a purchase with a 2650/1650 line next to it,
  --     and the rutor read it. The side of a line is the sign of debit
  --     minus credit; a zero line has none.
  --   tax_shape (shape 2): a pure movement between VAT accounts and the
  --     skattekonto: a 26xx declaration line, a skattekonto line, no
  --     2650/1650 line, and NOTHING else but 26xx, the skattekonto and 3740
  --     (öres- och kronutjämning) on any line.
  shape_flags AS (
    SELECT f.id,
           f.ruta_line AND f.net_line
             AND ((f.ruta_debit AND f.net_credit) OR (f.ruta_credit AND f.net_debit) OR NOT f.base_line) AS net_shape,
           f.moms_ruta_line AND f.tax_line AND NOT f.any_net_line AND NOT f.other_line AS tax_shape
    FROM (
      SELECT l.journal_entry_id AS id,
             COALESCE(bool_or(l.account_number = ANY (p_net_shape_ruta_accounts)), false) AS ruta_line,
             COALESCE(bool_or(l.account_number = ANY (p_net_shape_net_accounts)), false) AS net_line,
             COALESCE(bool_or(l.account_number = ANY (p_net_shape_ruta_accounts)
                              AND COALESCE(l.debit_amount, 0) > COALESCE(l.credit_amount, 0)), false) AS ruta_debit,
             COALESCE(bool_or(l.account_number = ANY (p_net_shape_ruta_accounts)
                              AND COALESCE(l.debit_amount, 0) < COALESCE(l.credit_amount, 0)), false) AS ruta_credit,
             COALESCE(bool_or(l.account_number = ANY (p_net_shape_net_accounts)
                              AND COALESCE(l.debit_amount, 0) > COALESCE(l.credit_amount, 0)), false) AS net_debit,
             COALESCE(bool_or(l.account_number = ANY (p_net_shape_net_accounts)
                              AND COALESCE(l.debit_amount, 0) < COALESCE(l.credit_amount, 0)), false) AS net_credit,
             COALESCE(bool_or(l.account_number = ANY (p_net_shape_ruta_accounts)
                              AND l.account_number NOT LIKE '26%'
                              AND COALESCE(l.debit_amount, 0) <> COALESCE(l.credit_amount, 0)), false) AS base_line,
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

COMMENT ON FUNCTION public.vat_declaration_special_entries(uuid, date, date, text[], text[], text[], text[]) IS
  'The verifikat the momsdeklaration treats specially: opening balance chain members (counted or carried), kontantmetod cut-off reversals and the period''s momsredovisning-shaped verifikat (a declaration-account line and a 2650/1650 line, unless none stands against the other and a declaration line is a sales or purchase base outside 26xx, or a pure 26xx movement against the skattekonto). The one definition get_vat_declaration_totals and get_vat_ruta_source_lines read.';

NOTIFY pgrst, 'reload schema';
