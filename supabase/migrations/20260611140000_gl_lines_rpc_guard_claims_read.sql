-- Migration: make the GL-line read-RPC tenant guard read the role from the JWT
-- claims object directly, instead of via auth.role().
--
-- 20260611120000 used `auth.role()` to detect the caller's role. auth.role()
-- reads the individual `request.jwt.claim.role` GUC first and only falls back to
-- the `request.jwt.claims` object on installs whose auth.role() carries that
-- fallback. PostgREST sets the claims OBJECT (the individual claim.* GUCs are
-- deprecated), and the pg-real test harness sets `request.jwt.claims` (+ an
-- individual `request.jwt.claim.sub` for auth.uid()) but NOT `request.jwt.claim.role`.
-- On an auth.role() without the object fallback that yields NULL, so the guard's
-- `NOT IN ('anon','authenticated')` branch was TRUE and the membership check was
-- skipped — i.e. the guard failed OPEN (caught by a pg-real test: an
-- authenticated non-member could still read another company's lines).
--
-- Reading `current_setting('request.jwt.claims', true)::jsonb ->> 'role'`
-- directly is what auth.role() itself falls back to, and depends only on the
-- claims object that both PostgREST and the harness reliably set — so the guard
-- enforces correctly in every environment. Behaviour is otherwise identical:
-- service_role and direct/superuser (no claims → NULL → '') still bypass; anon
-- and authenticated are constrained to their own companies.

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
    -- Tenant guard: anon/authenticated may only read their own companies;
    -- service_role and direct/superuser access (no JWT role) bypass.
    AND (
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

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
    -- Tenant guard: anon/authenticated may only read their own companies;
    -- service_role and direct/superuser access (no JWT role) bypass.
    AND (
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

NOTIFY pgrst, 'reload schema';
