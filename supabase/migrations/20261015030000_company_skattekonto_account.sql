-- The skattekonto's ledger account per company: 1630, or 2012 for an enskild
-- firma that runs it in eget kapital (PH 175).
--
-- Why this exists: the product hard-coded 1630 as "the skattekonto" (one TS
-- constant plus the literals in the VAT functions and the onboarding summary).
-- Both practices exist for an enskild firma: our BAS 2026 chart runs the
-- skattekonto on 1630 Avräkning för skatter och avgifter and books only the
-- owner's own tax to 2013, while Fortnox, Björn Lundén and the BAS K1 chart
-- (förenklat årsbokslut) use 2012 Avräkning för skatter och avgifter
-- (skattekonto) under eget kapital, because the firm shares its skattekonto
-- with the owner. Enskilda firmor that book 2012 and never 1630 exist, some
-- of them with the skattekonto connected; the connection could not follow
-- them.
--
-- 1. company_settings.skattekonto_account: NULL (= 1630), '1630' or '2012'.
--    The value is only honoured for an enskild firma: an aktiebolag (and every
--    other form) always runs 1630, whatever is stored, so correcting the legal
--    form never needs this column first. No CHECK on entity_type for the same
--    reason (correct_company_entity_type rewrites entity_type alone).
-- 2. derive_skattekonto_account(company): what the books say. '1630' when a
--    posted (or reversed) line sits on 1630, else '2012' when one sits on 2012,
--    else NULL (no evidence). Used once by the backfill below and by the app
--    when a company's skattekonto rows first arrive with the column unset.
-- 3. Backfill, once: an enskild firma with lines on 2012 and none on 1630 gets
--    '2012'. Everything else stays NULL (1630). Companies that are migration
--    reset sources are immutable (block_migration_reset_source_mutation) and
--    archived ones are left alone.
-- 4. company_skattekonto_account(company): THE resolver. The app reads it over
--    RPC (src/lib/skatteverket/skattekonto-account.ts), the onboarding summary
--    reads it here.
-- 5. skattekonto_shape_accounts(company): the accounts the VAT functions treat
--    as the skattekonto in shape 2 (20260920182259): 1630 always, plus 2012 for
--    an enskild firma. Deliberately by legal form, not by the setting: in an
--    enskild firma 2012 has no other meaning (K1 chart), so a pure 26xx/2012
--    verifikat is a settlement against the skattekonto whichever account the
--    firm runs today, and a firm that switches keeps its declared history
--    unchanged. No verifikat of an enskild firma had that shape when this
--    was written, so no figure moves.
-- 6. get_vat_declaration_totals / get_vat_ruta_source_lines: 20260920182259
--    verbatim apart from tax_accounts in tax_shape_constants.
-- 7. get_onboarding_books_summary: 20260920215406 verbatim plus two keys,
--    skattekonto_account and ledger_skattekonto (that account across all time,
--    debit minus credit). ledger_1630 stays for the app deployed before this.
--
-- Signatures, SECURITY INVOKER, search_path and ACLs of the replaced functions
-- are unchanged.
--
-- pg-test: tests/pg/company-skattekonto-account.pg.test.ts,
--          tests/pg/vat-skattekonto-counter-entries.pg.test.ts,
--          tests/pg/onboarding-books-summary-rpc.pg.test.ts

-- =============================================================================
-- 1. The setting.
-- =============================================================================

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS skattekonto_account text
    CONSTRAINT company_settings_skattekonto_account_check
    CHECK (skattekonto_account IS NULL OR skattekonto_account IN ('1630', '2012'));

COMMENT ON COLUMN public.company_settings.skattekonto_account IS
  'Ledger account of the skattekonto: NULL or 1630 = 1630 Avräkning för skatter och avgifter; 2012 = 2012 Avräkning för skatter och avgifter (skattekonto) under eget kapital, honoured for an enskild firma only. Read through company_skattekonto_account().';

-- =============================================================================
-- 2. What the books say.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.derive_skattekonto_account(p_company_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND l.account_number = '1630'
    ) THEN '1630'
    WHEN EXISTS (
      SELECT 1
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND l.account_number = '2012'
    ) THEN '2012'
    ELSE NULL
  END
$$;

REVOKE ALL ON FUNCTION public.derive_skattekonto_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.derive_skattekonto_account(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.derive_skattekonto_account(uuid) IS
  'Which skattekonto account the books use: 1630 when any posted or reversed line is on 1630, else 2012 when one is on 2012, else NULL. Evidence only; company_skattekonto_account() is the resolver.';

-- =============================================================================
-- 3. Backfill, once.
-- =============================================================================

UPDATE public.company_settings cs
SET skattekonto_account = '2012'
FROM public.companies c
WHERE c.id = cs.company_id
  AND c.archived_at IS NULL
  AND cs.skattekonto_account IS NULL
  AND COALESCE(cs.entity_type, c.entity_type) = 'enskild_firma'
  AND NOT EXISTS (
    SELECT 1 FROM public.company_migration_resets r
    WHERE r.source_company_id = cs.company_id
  )
  AND public.derive_skattekonto_account(cs.company_id) = '2012';

-- =============================================================================
-- 4. The resolver.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.company_skattekonto_account(p_company_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((
    SELECT CASE
      WHEN COALESCE(cs.entity_type, c.entity_type) = 'enskild_firma'
        AND cs.skattekonto_account = '2012'
      THEN '2012'
      ELSE '1630'
    END
    FROM public.companies c
    LEFT JOIN public.company_settings cs ON cs.company_id = c.id
    WHERE c.id = p_company_id
    LIMIT 1
  ), '1630')
$$;

REVOKE ALL ON FUNCTION public.company_skattekonto_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_skattekonto_account(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.company_skattekonto_account(uuid) IS
  'The ledger account of the company''s skattekonto: 2012 for an enskild firma whose company_settings.skattekonto_account is 2012, else 1630. The one resolver behind every skattekonto reader.';

-- =============================================================================
-- 5. The VAT shape's skattekonto accounts.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.skattekonto_shape_accounts(p_company_id uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.companies c
      LEFT JOIN public.company_settings cs ON cs.company_id = c.id
      WHERE c.id = p_company_id
        AND COALESCE(cs.entity_type, c.entity_type) = 'enskild_firma'
    ) THEN ARRAY['1630', '2012']::text[]
    ELSE ARRAY['1630']::text[]
  END
$$;

REVOKE ALL ON FUNCTION public.skattekonto_shape_accounts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skattekonto_shape_accounts(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.skattekonto_shape_accounts(uuid) IS
  'Accounts the VAT functions treat as the skattekonto when they recognise a pure 26xx movement against it: 1630, plus 2012 for an enskild firma.';

-- =============================================================================
-- 6. The VAT figure and its drill-down (20260920182259 apart from tax_accounts).
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
-- Named constants for shape 2. The skattekonto accounts come from
-- skattekonto_shape_accounts() (1630, plus 2012 for an enskild firma); keep
-- the rest in step with the copy in get_vat_ruta_source_lines below.
tax_shape_constants AS (
  SELECT public.skattekonto_shape_accounts(p_company_id) AS tax_accounts, -- skattekonto
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

REVOKE ALL ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) TO authenticated, service_role;

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
  -- get_vat_declaration_totals above.
  tax_shape_constants AS (
    SELECT public.skattekonto_shape_accounts(p_company_id) AS tax_accounts, -- skattekonto
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

REVOKE ALL ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_ruta_source_lines(
  uuid, date, date, text[], text[], text[], date, integer, uuid, uuid, integer
) TO authenticated, service_role;

-- =============================================================================
-- 7. The onboarding summary (20260920215406 plus the skattekonto keys).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_onboarding_books_summary(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_period_name text;
  v_period_start date;
  v_period_end date;
  v_has_period boolean;
  v_revenue numeric;
  v_result numeric;
  v_vat_balance numeric;
  v_ledger_1630 numeric;
  v_skattekonto_account text;
  v_ledger_skattekonto numeric;
BEGIN
  v_skattekonto_account := public.company_skattekonto_account(p_company_id);

  SELECT fp.name, fp.period_start, fp.period_end
    INTO v_period_name, v_period_start, v_period_end
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND EXISTS (
      SELECT 1
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND e.entry_date >= fp.period_start
        AND e.entry_date <= fp.period_end
    )
  ORDER BY fp.period_start DESC
  LIMIT 1;
  v_has_period := FOUND;

  SELECT
    COALESCE(sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)) FILTER (
      WHERE v_has_period
        AND e.entry_date >= v_period_start
        AND e.entry_date <= v_period_end
        AND substr(l.account_number, 1, 1) = '3'
    ), 0),
    COALESCE(sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)) FILTER (
      WHERE v_has_period
        AND e.entry_date >= v_period_start
        AND e.entry_date <= v_period_end
        AND substr(l.account_number, 1, 1) IN ('3', '4', '5', '6', '7', '8')
    ), 0),
    COALESCE(sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)) FILTER (
      WHERE l.account_number >= '2600' AND l.account_number <= '2699'
    ), 0),
    COALESCE(sum(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)) FILTER (
      WHERE l.account_number = '1630'
    ), 0),
    COALESCE(sum(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)) FILTER (
      WHERE l.account_number = v_skattekonto_account
    ), 0)
    INTO v_revenue, v_result, v_vat_balance, v_ledger_1630, v_ledger_skattekonto
  FROM public.journal_entries e
  JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
  WHERE e.company_id = p_company_id
    AND e.status IN ('posted', 'reversed');

  RETURN jsonb_build_object(
    'period_name', CASE WHEN v_has_period THEN v_period_name END,
    'revenue', CASE WHEN v_has_period THEN v_revenue END,
    'result', CASE WHEN v_has_period THEN v_result END,
    'vat_balance', v_vat_balance,
    'ledger_1630', v_ledger_1630,
    'skattekonto_account', v_skattekonto_account,
    'ledger_skattekonto', v_ledger_skattekonto
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_onboarding_books_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_onboarding_books_summary(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_onboarding_books_summary(uuid) IS
  'Latest-period revenue/result plus all-time 26xx, 1630 and skattekonto-account balances for one company, summed company-first; the SQL side of loadBooksFindings.';

NOTIFY pgrst, 'reload schema';
