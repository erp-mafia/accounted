-- get_vat_declaration_totals: exclude the fiscal period's resultatavslut.
--
-- The closing verifikat posts the mirror image of every P&L account into 2099
-- inside the same fiscal period. Revenue accounts drive rutor 05, 39 and 40, so
-- any VAT period containing the fiscal-year end reported NEGATED turnover once
-- the year was closed. On a real production ledger this produced
-- ruta 39 = -794 734 kr for the December period of a closed year.
--
-- Verified reproducible read-only against production before this change.
--
-- Only a POSTED closing entry is dropped. A reversed one is retained together
-- with its storno so the pair continues to net to zero: the same predicate
-- lib/reports/trial-balance.ts uses for closingEntry: 'exclude-final'.
--
-- vat_settlement and opening_balance were already excluded; year_end was not.
-- The exclusion is keyed on fiscal_periods.closing_entry_id rather than on
-- source_type = 'year_end' because avskrivningar, periodiseringsfond and skatt
-- share that source_type and must keep whatever VAT effect they carry.

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
SET search_path TO 'public'
AS $function$
WITH closing_entries AS (
  SELECT fp.closing_entry_id AS id
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND fp.closing_entry_id IS NOT NULL
),
scoped_entries AS (
  SELECT e.id, e.status, e.entry_date, e.source_type, e.voucher_series, e.voucher_number
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
),
vat_lines AS (
  SELECT l.journal_entry_id, l.account_number, l.debit_amount, l.credit_amount
  FROM public.journal_entry_lines l
  JOIN non_settlement_entries e ON e.id = l.journal_entry_id
  WHERE l.account_number = ANY (p_accounts)
),
shaped AS (
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
$function$;
