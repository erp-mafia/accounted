-- Teach the two bank-matching candidate RPCs that a verifikat can be settled
-- through transaction_voucher_links, not only through transactions.journal_entry_id.
--
-- Both functions decide "is this voucher already settled on this account?" by
-- looking for a transaction whose SCALAR journal_entry_id points at it. A bank
-- row coupled to several verifikat (link_transaction_to_vouchers, 20260815090000)
-- deliberately leaves that scalar NULL, because no single entry is "the" one.
-- So every verifikat settled that way kept surfacing as an omatchad
-- verifikation: get_unlinked_gl_lines offered it to the auto-reconciler as a
-- free candidate, and the Bankavstämning table listed vouchers the user had
-- just finished settling, with no way to make them go away.
--
-- The fix is one extra EXISTS per predicate, over the junction table, mirroring
-- the account-scoping rule the scalar side already uses (20260723160000): a
-- link whose transaction sits on ANOTHER cash account does not settle this
-- voucher for p_account_number, while a transaction with no resolvable cash
-- account keeps counting everywhere (conservative legacy behaviour).
--
-- Signatures, return shapes, tenant guards and grants are otherwise unchanged
-- from 20260519120000 / 20260605130000 / 20260611140000 / 20260723160000.

-- ─────────────────────────────────────────────────────────────────
-- 1. get_unlinked_gl_lines: feeds auto-reconcile
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_unlinked_gl_lines(
  p_company_id     uuid,
  p_account_number text DEFAULT '1930'::text,
  p_date_from      date DEFAULT NULL::date,
  p_date_to        date DEFAULT NULL::date
)
RETURNS TABLE(
  line_id           uuid,
  journal_entry_id  uuid,
  debit_amount      numeric,
  credit_amount     numeric,
  line_description  text,
  entry_date        date,
  voucher_number    integer,
  voucher_series    text,
  entry_description text,
  source_type       text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    -- Settled through the junction table. This path matters most HERE: this
    -- function feeds the auto-reconciler, which WRITES the links it finds, so
    -- without it an already-settled voucher could be auto-linked a second time.
    AND NOT EXISTS (
      SELECT 1
      FROM public.transaction_voucher_links tvl
      JOIN public.transactions t ON t.id = tvl.transaction_id
      WHERE tvl.journal_entry_id = je.id
        AND tvl.company_id = p_company_id
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
$function$;

REVOKE EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────
-- 2. get_account_gl_lines_for_matching: feeds the manual match pickers
-- ─────────────────────────────────────────────────────────────────

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
    -- Account-scoped, and now counting BOTH anchors. A transaction provably on
    -- another cash account does not make this voucher "matched" for
    -- p_account_number; a NULL / unresolvable cash account keeps counting for
    -- every account (conservative legacy behavior). DISTINCT because a
    -- transaction can reach the same voucher through the scalar column AND a
    -- link row (the single-link case keeps both in sync), and counting it twice
    -- would overstate how settled the voucher is.
    (
      SELECT count(DISTINCT t.id)
      FROM public.transactions t
      LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
      WHERE t.company_id = p_company_id
        AND (ca.ledger_account IS NULL OR ca.ledger_account = p_account_number)
        AND (
          t.journal_entry_id = je.id
          OR EXISTS (
            SELECT 1 FROM public.transaction_voucher_links tvl
            WHERE tvl.transaction_id = t.id
              AND tvl.journal_entry_id = je.id
              AND tvl.company_id = p_company_id
          )
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
      OR NOT EXISTS (
        SELECT 1
        FROM public.transactions t
        LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
        WHERE t.company_id = p_company_id
          AND (ca.ledger_account IS NULL OR ca.ledger_account = p_account_number)
          AND (
            t.journal_entry_id = je.id
            OR EXISTS (
              SELECT 1 FROM public.transaction_voucher_links tvl
              WHERE tvl.transaction_id = t.id
                AND tvl.journal_entry_id = je.id
                AND tvl.company_id = p_company_id
            )
          )
      )
    )
    AND (
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

REVOKE EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
