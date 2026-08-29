-- Make the VAT ruta drill-down return exactly the lines the filed figure sums.
--
-- `get_vat_declaration_totals` (the FIGURE, migration 20260813124510) drops
-- four classes of entry before summing: posted closing entries, source_type
-- 'vat_settlement', the two kontantmetod year-end reversals, and any entry
-- shaped like a momsredovisning (a line on a ruta account AND a line on
-- 2650/1650). `get_vat_ruta_source_lines` (the DRILL-DOWN, migration
-- 20260721103000) filtered on company, status and date only, so expanding a
-- ruta listed verifikat that are not in the number it claims to explain, with
-- no total on the panel to reveal the mismatch.
--
-- Measured on production 2026-08-28: 322 posted/reversed entries carrying 26xx
-- lines across 214 companies sit in those excluded classes. A momsdeklaration
-- is räkenskapsinformation (BFL 5 kap.), and this drill-down is what a
-- consultant uses to substantiate a filed figure, so the two must agree
-- exactly.
--
-- The exclusion CTEs below are lifted VERBATIM from get_vat_declaration_totals
-- rather than re-derived. That is deliberate: any divergence between the two
-- reintroduces exactly this bug, and a copy that reads identically is easy to
-- diff when the figure changes. tests/pg/vat-ruta-drilldown-reconcile.pg.test.ts
-- asserts the equality directly, so a future edit to one and not the other
-- fails CI rather than silently misreporting.
--
-- Settlement-shape is detected against journal_entry_lines directly instead of
-- through the figure's `vat_lines` CTE. That is equivalent, not a shortcut:
-- the figure passes p_ruta_accounts = VAT_ACCOUNTS and p_net_accounts =
-- ['2650','1650'], both strict subsets of its p_accounts, so restricting to
-- vat_lines first cannot change which entries match. It lets the drill-down
-- keep p_accounts meaning "the accounts of the ruta being expanded" without a
-- fourth account parameter.
--
-- opening_balance entries are deliberately NOT excluded. They are excluded
-- from the figure's `shaped` set, which keeps their lines IN the totals, so
-- dropping them here would break the equality in the other direction.
--
-- pg-test: tests/pg/vat-ruta-drilldown-reconcile.pg.test.ts

-- The signature gains p_ruta_accounts / p_net_accounts. DROP first: adding
-- parameters with CREATE OR REPLACE registers a second overload, and PostgREST
-- then cannot choose between them (documented in 20260421140000).
DROP FUNCTION IF EXISTS public.get_vat_ruta_source_lines(
  uuid, date, date, text[], date, integer, uuid, uuid, integer
);

-- OR REPLACE on the NEW signature, so re-running this file is a no-op rather
-- than "function already exists with same argument types". The DROP above is
-- what removes the old arity; this cannot reintroduce an overload.
CREATE OR REPLACE FUNCTION public.get_vat_ruta_source_lines(
  p_company_id uuid,
  p_start date,
  p_end date,
  -- Accounts of the ruta being expanded: which lines to RETURN.
  p_accounts text[],
  -- Settlement-shape detectors, mirroring the figure's own parameters.
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
  non_settlement_entries AS (
    SELECT * FROM scoped_entries
    WHERE source_type IS DISTINCT FROM 'vat_settlement'
      AND NOT (
        source_type = 'year_end'
        AND description IN (
          'Vändning kundfordringar bokslut (kontantmetoden)',
          'Vändning leverantörsskulder bokslut (kontantmetoden)'
        )
      )
  ),
  shaped AS (
    SELECT e.id
    FROM non_settlement_entries e
    WHERE e.source_type IS DISTINCT FROM 'opening_balance'
      AND EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number = ANY (p_ruta_accounts)
      )
      AND EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number = ANY (p_net_accounts)
      )
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
  WHERE l.account_number = ANY (p_accounts)
    AND NOT EXISTS (SELECT 1 FROM shaped s WHERE s.id = je.id)
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

NOTIFY pgrst, 'reload schema';
