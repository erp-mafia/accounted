-- RPC: get_vat_declaration_totals — one-round-trip aggregation for the
-- momsdeklaration (SKV 4700) and the settlement proposal.
--
-- Replaces the fetchEntryLines pattern in lib/reports/vat-declaration.ts,
-- which paged EVERY journal entry + VAT line for the period through
-- PostgREST (dozens of round trips for a busy quarter) and aggregated in
-- JS, plus a second full entry scan for source_type metadata counts. One
-- SQL pass now returns all three sections:
--
--   totals                     per-account debit/credit sums over the
--                              VAT-relevant accounts (p_accounts), excluding
--                              settlement entries (tagged AND shaped, below)
--   settlement_shaped_entries  untagged momsredovisning entries detected by
--                              shape: a line on a declaration account
--                              (p_ruta_accounts) AND a line on 2650/1650
--                              (p_net_accounts) in the same entry. Manual
--                              vouchers, SIE-imported settlements, stornos of
--                              a settlement (#984). Excluded from totals;
--                              surfaced so the settlement proposal can warn
--                              and gate. Opening-balance entries are exempt:
--                              carried-in 26xx balances are unsettled VAT
--                              that belongs in the next declaration.
--   source_type_counts         posted/reversed entry counts per source_type
--                              for the period (includes tagged settlements,
--                              matching the old metadata scan).
--
-- The account lists stay parameters so ACCOUNT_RUTA in TypeScript remains
-- the single source of truth for the BAS-to-ruta mapping; extending the
-- mapping must never require a migration.
--
-- SECURITY INVOKER: journal_entries/journal_entry_lines RLS is
-- company-scoped via user_company_ids(), so the caller's own membership
-- bounds what is aggregated; a non-member calling with a foreign company id
-- gets empty sections, not an error. Service-role callers (MCP) rely on the
-- explicit p_company_id filter.
--
-- pg-test: tests/pg/vat-declaration-totals-rpc.pg.test.ts

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
WITH scoped_entries AS (
  SELECT id, status, entry_date, source_type, voucher_series, voucher_number
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND status IN ('posted', 'reversed')
    AND entry_date >= p_start
    AND entry_date <= p_end
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
$$;

REVOKE ALL ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_vat_declaration_totals(uuid, date, date, text[], text[], text[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
