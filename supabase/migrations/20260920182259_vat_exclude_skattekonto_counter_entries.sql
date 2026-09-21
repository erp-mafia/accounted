-- A second momsredovisning shape: VAT booked straight against the skattekonto.
--
-- Why this exists (#2805): intent is not recorded on manual and imported
-- verifikat, so both VAT functions infer "this is bookkeeping ABOUT the
-- declaration, not VAT-bearing activity" from the entry's shape. Until now
-- there was one shape: a line on a declaration account (p_ruta_accounts) AND a
-- line on 2650/1650 (p_net_accounts). That misses the companies that never
-- route VAT through the redovisningskonto 2650 and book it directly against
-- 1630, the ledger mirror of the skattekonto at Skatteverket:
--
--   2611 D / 1630 K   output VAT settled straight onto the skattekonto
--   1630 D / 2641 K   input VAT refunded straight onto the skattekonto
--   1630 D / 2610 K   a Skatteverket omprövning credited to the skattekonto,
--                     counter-entry parked on the VAT account
--
-- Every one of those is a movement between a VAT account and the skattekonto.
-- No sale or purchase happened, so none of it belongs in a ruta, yet each was
-- summed into ruta 10 or ruta 48 as if it were sales or purchase VAT. The case
-- behind the issue: verifikat X (1630 D / 2610 K) was counted, and verifikat Y
-- the same day (2610 D / 1650 K, reclassifying the counter-entry) was dropped
-- by the existing shape, so ruta 10 was overstated by the full amount while the
-- ledger itself was correct.
--
-- The existing 2650/1650 shape is NOT narrowed. Every arithmetic narrowing
-- tried against production broke real settlements (imported settlements that
-- carry a small cost line, settle-and-pay vouchers that also debit last
-- period's 2650, year-end omnibus vouchers). This migration only ADDS a shape.
--
-- The added shape (all four must hold, on an entry that is not tagged
-- vat_settlement and is not an opening balance):
--   1. a line on a declaration account in the VAT class (p_ruta_accounts that
--      start with 26). The 3xxx/4xxx beskattningsunderlag accounts in that list
--      do NOT qualify: 1630 D / 3980 K, a bidrag received on the skattekonto,
--      is real ruta 42 activity and keeps counting;
--   2. a line on the skattekonto (1630);
--   3. no line on p_net_accounts (2650/1650): those entries already belong to
--      the first shape, which makes the two shapes disjoint;
--   4. PURE: every line is on a 26xx account, the skattekonto, or 3740
--      (öres- och kronutjämning). Any other account makes it a business
--      verifikat that keeps counting: 5410 D / 2641 D / 1630 K stays in.
--
-- Both functions get the SAME predicate text. The drill-down once filtered
-- differently from the figure and listed verifikat that were not in the number
-- it claimed to explain (20260828172003); the reconcile test pins the equality.
--
-- Signatures, SECURITY INVOKER, search_path and ACLs are unchanged, and no
-- parameter is added on purpose: the app deployed before this migration keeps
-- calling the same signature during the window between migration and deploy.
-- The three literals live in the tax_shape_constants CTE and are mirrored by
-- VAT_TAX_ACCOUNT_COUNTERPARTS, VAT_SHAPE_ROUNDING_ACCOUNTS and
-- VAT_ACCOUNT_CLASS_PREFIX in lib/reports/vat-declaration.ts, whose
-- momsredovisningShape() is the TS mirror of this predicate.
--
-- Bodies are 20260914150109 verbatim apart from: `shaped` renamed to
-- `shaped_net` (unchanged predicate), the two new CTEs, and `shaped` rebuilt as
-- their union. Everything else those bodies do is preserved: posted closing
-- entries, tagged vat_settlement, marked kontantmetod vändningar, the
-- opening-balance exemption, source_type_counts, keyset paging.
--
-- pg-test: tests/pg/vat-skattekonto-counter-entries.pg.test.ts,
--          tests/pg/vat-declaration-totals-rpc.pg.test.ts,
--          tests/pg/vat-ruta-drilldown-reconcile.pg.test.ts

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
non_settlement_entries AS (
  SELECT * FROM scoped_entries e
  WHERE e.source_type IS DISTINCT FROM 'vat_settlement'
    AND NOT EXISTS (
      SELECT 1 FROM public.kontantmetod_cutoff_entries k
      WHERE k.journal_entry_id = e.id
        AND k.kind IN ('receivable_reversal', 'payable_reversal')
    )
),
vat_lines AS (
  SELECT l.journal_entry_id, l.account_number, l.debit_amount, l.credit_amount
  FROM public.journal_entry_lines l
  JOIN non_settlement_entries e ON e.id = l.journal_entry_id
  WHERE l.account_number = ANY (p_accounts)
),
-- Shape 1, unchanged: a declaration account AND a 2650/1650 line.
shaped_net AS (
  SELECT e.id, e.status, e.entry_date, e.source_type, e.voucher_series, e.voucher_number
  FROM non_settlement_entries e
  WHERE e.source_type IS DISTINCT FROM 'opening_balance'
    AND EXISTS (
      SELECT 1 FROM vat_lines l
      WHERE l.journal_entry_id = e.id AND l.account_number = ANY (p_ruta_accounts)
    )
    AND EXISTS (
      SELECT 1 FROM vat_lines l
      WHERE l.journal_entry_id = e.id AND l.account_number = ANY (p_net_accounts)
    )
),
-- Named constants for shape 2. Keep in step with VAT_TAX_ACCOUNT_COUNTERPARTS,
-- VAT_SHAPE_ROUNDING_ACCOUNTS and VAT_ACCOUNT_CLASS_PREFIX in
-- lib/reports/vat-declaration.ts, and with the copy in
-- get_vat_ruta_source_lines below.
tax_shape_constants AS (
  SELECT ARRAY['1630']::text[] AS tax_accounts,      -- skattekonto
         ARRAY['3740']::text[] AS rounding_accounts, -- öres- och kronutjämning
         '26%'::text AS vat_account_pattern          -- BAS 26xx, the moms accounts
),
-- Shape 2: a pure movement between VAT accounts and the skattekonto. Reads
-- journal_entry_lines directly, not vat_lines: purity is a statement about
-- EVERY line of the verifikat, and vat_lines only holds p_accounts.
shaped_tax AS (
  SELECT e.id, e.status, e.entry_date, e.source_type, e.voucher_series, e.voucher_number
  FROM non_settlement_entries e
  CROSS JOIN tax_shape_constants k
  WHERE e.source_type IS DISTINCT FROM 'opening_balance'
    AND EXISTS (
      SELECT 1 FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = e.id
        AND l.account_number = ANY (p_ruta_accounts)
        AND l.account_number LIKE k.vat_account_pattern
    )
    AND EXISTS (
      SELECT 1 FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = e.id
        AND l.account_number = ANY (k.tax_accounts)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = e.id
        AND l.account_number = ANY (p_net_accounts)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = e.id
        AND l.account_number NOT LIKE k.vat_account_pattern
        AND l.account_number <> ALL (k.tax_accounts)
        AND l.account_number <> ALL (k.rounding_accounts)
    )
),
-- Disjoint by construction (shape 2 requires NO p_net_accounts line, shape 1
-- requires one). UNION rather than UNION ALL so a future edit to either
-- predicate can never list a verifikat twice.
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
      WHERE NOT EXISTS (SELECT 1 FROM shaped s WHERE s.id = l.journal_entry_id)
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
  ), '{}'::jsonb)
)
$$;

-- CREATE OR REPLACE keeps the ACL; restated anyway, as 20260914150109 does, so
-- the file is also correct on a database where the function was dropped.
REVOKE ALL ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) TO authenticated, service_role;

-- =============================================================================
-- The drill-down. Same two shape CTEs; shape 2 is the figure's text verbatim
-- apart from the narrower SELECT list.
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
  non_settlement_entries AS (
    SELECT * FROM scoped_entries e
    WHERE e.source_type IS DISTINCT FROM 'vat_settlement'
      AND NOT EXISTS (
        SELECT 1 FROM public.kontantmetod_cutoff_entries k
        WHERE k.journal_entry_id = e.id
          AND k.kind IN ('receivable_reversal', 'payable_reversal')
      )
  ),
  -- Shape 1, unchanged: a declaration account AND a 2650/1650 line.
  shaped_net AS (
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
  ),
  -- Named constants for shape 2. Keep in step with the copy in
  -- get_vat_declaration_totals above and with lib/reports/vat-declaration.ts.
  tax_shape_constants AS (
    SELECT ARRAY['1630']::text[] AS tax_accounts,      -- skattekonto
           ARRAY['3740']::text[] AS rounding_accounts, -- öres- och kronutjämning
           '26%'::text AS vat_account_pattern          -- BAS 26xx, the moms accounts
  ),
  -- Shape 2: a pure movement between VAT accounts and the skattekonto.
  shaped_tax AS (
    SELECT e.id
    FROM non_settlement_entries e
    CROSS JOIN tax_shape_constants k
    WHERE e.source_type IS DISTINCT FROM 'opening_balance'
      AND EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number = ANY (p_ruta_accounts)
          AND l.account_number LIKE k.vat_account_pattern
      )
      AND EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number = ANY (k.tax_accounts)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number = ANY (p_net_accounts)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = e.id
          AND l.account_number NOT LIKE k.vat_account_pattern
          AND l.account_number <> ALL (k.tax_accounts)
          AND l.account_number <> ALL (k.rounding_accounts)
      )
  ),
  shaped AS (
    SELECT id FROM shaped_net
    UNION
    SELECT id FROM shaped_tax
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

-- Same reasoning as above: no DROP, so the ACL from 20260829090500 (no EXECUTE
-- for anon) survives CREATE OR REPLACE. Restated so it cannot be lost.
REVOKE ALL ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
