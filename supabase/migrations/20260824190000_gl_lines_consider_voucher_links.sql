-- The bank reconciliation's ledger side treats a verifikat as "matched" only
-- when a transactions row points at it (transactions.journal_entry_id). A
-- verifikat settled through transaction_voucher_links (a samlingsverifikation
-- from bulk-book, or a residual booking on the Avstämning page) carries no
-- such pointer: its rows have journal_entry_id NULL and the link lives in the
-- junction. Both GL RPCs therefore listed those verifikat as "utan
-- banktransaktion" while the TS side listed their transactions as unmatched:
-- the bridge still netted to zero, but the open buckets were polluted and a
-- residual booking could never disappear from the worksheet.
--
-- This re-creates get_unlinked_gl_lines and get_account_gl_lines_for_matching
-- with the junction counted as a link, exactly as is_transaction_booked()
-- (20260529120000) already does for the inbox. Signatures, tenant guards and
-- grants are unchanged. The TS twin is fetchJunctionLinkedTxIds in
-- lib/reconciliation/bank-reconciliation.ts.

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
    AND NOT EXISTS (
      SELECT 1
      FROM public.transaction_voucher_links l
      WHERE l.journal_entry_id = je.id
        AND l.company_id = p_company_id
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
    -- Account-scoped: a transaction provably on ANOTHER cash account (its
    -- cash_accounts row resolves to a different ledger_account) does not make
    -- this voucher "matched" for p_account_number. A NULL / unresolvable cash
    -- account keeps counting for every account (conservative legacy behavior).
    -- Junction-linked transactions count exactly like pointer-linked ones.
    (
      (
        SELECT count(*)
        FROM public.transactions t
        LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
        WHERE t.journal_entry_id = je.id
          AND t.company_id = p_company_id
          AND (ca.ledger_account IS NULL OR ca.ledger_account = p_account_number)
      ) + (
        SELECT count(*)
        FROM public.transaction_voucher_links l
        JOIN public.transactions t ON t.id = l.transaction_id
        LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
        WHERE l.journal_entry_id = je.id
          AND l.company_id = p_company_id
          AND t.journal_entry_id IS DISTINCT FROM je.id
          AND (ca.ledger_account IS NULL OR ca.ledger_account = p_account_number)
      )
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
      OR (
        NOT EXISTS (
          SELECT 1
          FROM public.transactions t
          LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
          WHERE t.journal_entry_id = je.id
            AND t.company_id = p_company_id
            AND (ca.ledger_account IS NULL OR ca.ledger_account = p_account_number)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.transaction_voucher_links l
          JOIN public.transactions t ON t.id = l.transaction_id
          LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
          WHERE l.journal_entry_id = je.id
            AND l.company_id = p_company_id
            AND (ca.ledger_account IS NULL OR ca.ledger_account = p_account_number)
        )
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

-- CREATE OR REPLACE preserves the ACL; re-assert least privilege so this
-- migration stands alone on a fresh replay (20260611130000).
REVOKE EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
