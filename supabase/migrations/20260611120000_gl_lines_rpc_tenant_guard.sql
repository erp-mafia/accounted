-- Migration: tenant-isolation guard for the GL-line read RPCs.
--
-- get_unlinked_gl_lines and get_account_gl_lines_for_matching are SECURITY
-- DEFINER (they read journal_entry_lines / journal_entries / transactions as the
-- owner, bypassing RLS) and PostgREST grants EXECUTE to anon + authenticated.
-- Both take p_company_id as a plain argument, so any authenticated — or even
-- anonymous — caller could invoke them DIRECTLY over /rest/v1/rpc with another
-- company's id and read that company's general-ledger lines: a cross-tenant read
-- that bypasses the API routes' requireCompanyId() guard. Flagged in the PR #624
-- review and confirmed exploitable (anon and authenticated both hold EXECUTE,
-- and neither has rolbypassrls so RLS would normally protect the tables — but
-- SECURITY DEFINER sidesteps it).
--
-- Fix: enforce INSIDE the function that an anon/authenticated caller is a member
-- of p_company_id (the same boundary RLS enforces via user_company_ids()).
-- Trusted callers are NOT anon/authenticated and are deliberately left untouched:
--   * service_role — the enable-banking reconciliation cron calls
--     get_unlinked_gl_lines via the service client; its JWT role is
--     'service_role' (and it has rolbypassrls).
--   * direct / superuser DB access — migrations and the pg-real test harness
--     call these on a bare connection with no JWT role claim.
-- For both, auth.role() is not 'anon'/'authenticated', so the added predicate is
-- a no-op and behaviour is byte-for-byte unchanged. Only the PostgREST-exposed
-- anon/authenticated path is constrained, to the caller's own companies. A
-- foreign p_company_id simply yields zero rows — no error, no data leak.
--
-- Scope: this hardens the two READ RPCs that expose ledger data. The remaining
-- company-scoped SECURITY DEFINER RPCs (commit_journal_entry, next_voucher_number,
-- delete_last_voucher, …) are writes / sequence generators with their own
-- internal authorization; a broader audit of that set is tracked separately.

-- ------------------------------------------------------------
-- get_unlinked_gl_lines — unchanged except the trailing tenant guard.
-- Body mirrors 20260605130000_unlinked_gl_lines_exclude_storno_correction.sql.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_unlinked_gl_lines(
  p_company_id      UUID,
  p_account_number  TEXT DEFAULT '1930',
  p_date_from       DATE DEFAULT NULL,
  p_date_to         DATE DEFAULT NULL
)
RETURNS TABLE (
  line_id            UUID,
  journal_entry_id   UUID,
  debit_amount       NUMERIC,
  credit_amount      NUMERIC,
  line_description   TEXT,
  entry_date         DATE,
  voucher_number     INT,
  voucher_series     TEXT,
  entry_description  TEXT,
  source_type        TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    jel.id AS line_id,
    je.id AS journal_entry_id,
    jel.debit_amount,
    jel.credit_amount,
    jel.line_description,
    je.entry_date,
    je.voucher_number,
    je.voucher_series,
    je.description AS entry_description,
    je.source_type
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_number = p_account_number
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    AND je.source_type IS DISTINCT FROM 'storno'
    AND je.source_type IS DISTINCT FROM 'correction'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to   IS NULL OR je.entry_date <= p_date_to)
    AND NOT EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
    )
    -- Tenant guard (see migration header): anon/authenticated may only read
    -- their own companies; service_role / direct DB access bypass.
    AND (
      coalesce(auth.role(), '') NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

-- ------------------------------------------------------------
-- get_account_gl_lines_for_matching — unchanged except the trailing tenant guard.
-- Body mirrors 20260610120000_gl_lines_for_matching.sql.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_account_gl_lines_for_matching(
  p_company_id      UUID,
  p_account_number  TEXT DEFAULT '1930',
  p_date_from       DATE DEFAULT NULL,
  p_date_to         DATE DEFAULT NULL,
  p_include_matched BOOLEAN DEFAULT false
)
RETURNS TABLE (
  line_id                  UUID,
  journal_entry_id         UUID,
  debit_amount             NUMERIC,
  credit_amount            NUMERIC,
  line_description         TEXT,
  entry_date               DATE,
  voucher_number           INT,
  voucher_series           TEXT,
  entry_description        TEXT,
  source_type              TEXT,
  linked_transaction_count INT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    jel.id AS line_id,
    je.id AS journal_entry_id,
    jel.debit_amount,
    jel.credit_amount,
    jel.line_description,
    je.entry_date,
    je.voucher_number,
    je.voucher_series,
    je.description AS entry_description,
    je.source_type,
    (
      SELECT count(*)
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
    )::int AS linked_transaction_count
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_number = p_account_number
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    AND je.source_type IS DISTINCT FROM 'storno'
    AND je.source_type IS DISTINCT FROM 'correction'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to   IS NULL OR je.entry_date <= p_date_to)
    AND (
      p_include_matched
      OR NOT EXISTS (
        SELECT 1
        FROM public.transactions t
        WHERE t.journal_entry_id = je.id
          AND t.company_id = p_company_id
      )
    )
    -- Tenant guard (see migration header): anon/authenticated may only read
    -- their own companies; service_role / direct DB access bypass.
    AND (
      coalesce(auth.role(), '') NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

NOTIFY pgrst, 'reload schema';
