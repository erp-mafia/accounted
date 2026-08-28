-- Direction-aware NULL-link settlement for get_account_gl_lines_for_matching.
--
-- Since 20260723160000 a linked transaction whose cash_accounts row resolves to
-- ANOTHER ledger account does not settle the voucher for p_account_number,
-- while a transaction with no resolvable cash account (cash_account_id NULL,
-- the unbackfilled legacy shape) kept counting for EVERY account. For an
-- own-account transfer voucher that asymmetry produced a false "oforklarat" on
-- the bankavstamning card: the transfer's near leg counted as settled on the
-- far leg's account through a NULL row that provably belongs to the other side
-- (an outflow row cannot settle an inflow leg), while the far-leg voucher was
-- listed. Reported by a user whose momskonto card showed differens 0 kr with
-- oforklarat -2 593,75.
--
-- New rule for a NULL-attributed link (pointer or junction), per voucher V and
-- requested account L. It counts as settling V for L unless ALL of these hold:
--   1. the company has a primary cash account whose ledger_account differs
--      from L (so L is a NON-primary card; the primary card and companies
--      without a primary keep the legacy behavior, mirroring
--      scopeTransactionsToAccount / resolveCashAccountScope where only the
--      primary claims NULL bank rows),
--   2. V has lines on >= 2 of the company's cash-account ledgers (an
--      own-account transfer; single-leg vouchers keep the legacy behavior so
--      unbackfilled rows that genuinely belong to L are never flagged), and
--   3. the transaction's sign contradicts V's net line on L (sign(t.amount)
--      and sign(net) both non-zero and different: an outflow row cannot be the
--      settlement of an inflow leg).
-- Attributed links are unchanged in both directions.
--
-- Measured on prod 2026-08-28 before shipping: the naive variant (NULL counts
-- only for the primary account) flipped 64 vouchers across 11 cards in 10
-- companies and made 4 cards WORSE, including a -37 000 kr false alarm on
-- single-leg vouchers with no user action available. This three-condition rule
-- flips 24 vouchers across 7 cards in 6 companies; simulated per-card with the
-- exact status formula, 5 cards improve (3 to exactly 0,00) and the 2 that
-- move up do so because a real, user-fixable mislink (two bank rows linked to
-- one transfer voucher while its sibling holds none) stops being hidden.
--
-- get_unlinked_gl_lines is deliberately untouched: it feeds the auto-matcher
-- with vouchers that have NO link at all, and every voucher affected here has
-- one.

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
    -- account keeps counting for every account (conservative legacy behavior)
    -- EXCEPT the one shape where it provably cannot be this account's leg:
    -- non-primary card + own-account-transfer voucher + contradicting sign
    -- (see v.* below). Junction-linked transactions count exactly like
    -- pointer-linked ones.
    (
      (
        SELECT count(*)
        FROM public.transactions t
        LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
        WHERE t.journal_entry_id = je.id
          AND t.company_id = p_company_id
          AND (
            ca.ledger_account = p_account_number
            OR (
              ca.ledger_account IS NULL
              AND (
                v.legacy_null_ok
                OR v.single_bank_leg
                OR sign(t.amount) = 0
                OR sign(v.account_net) = 0
                OR sign(t.amount) = sign(v.account_net)
              )
            )
          )
      ) + (
        SELECT count(*)
        FROM public.transaction_voucher_links l
        JOIN public.transactions t ON t.id = l.transaction_id
        LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
        WHERE l.journal_entry_id = je.id
          AND l.company_id = p_company_id
          AND t.journal_entry_id IS DISTINCT FROM je.id
          AND (
            ca.ledger_account = p_account_number
            OR (
              ca.ledger_account IS NULL
              AND (
                v.legacy_null_ok
                OR v.single_bank_leg
                OR sign(t.amount) = 0
                OR sign(v.account_net) = 0
                OR sign(t.amount) = sign(v.account_net)
              )
            )
          )
      )
    )::int AS linked_transaction_count
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  CROSS JOIN LATERAL (
    SELECT
      -- Legacy behavior applies when L is the primary card or the company has
      -- no primary at all: only a primary elsewhere disqualifies NULL rows,
      -- the same ownership rule the TS bank side applies to NULL rows.
      NOT EXISTS (
        SELECT 1
        FROM public.cash_accounts pca
        WHERE pca.company_id = p_company_id
          AND pca.is_primary
          AND pca.ledger_account <> p_account_number
      ) AS legacy_null_ok,
      -- A voucher touching < 2 of the company's cash-account ledgers is not an
      -- own-account transfer; its NULL links keep settling every account.
      (
        SELECT count(DISTINCT ca4.ledger_account)
        FROM public.journal_entry_lines jel2
        JOIN public.cash_accounts ca4
          ON ca4.company_id = p_company_id
         AND ca4.ledger_account = jel2.account_number
        WHERE jel2.journal_entry_id = je.id
      ) < 2 AS single_bank_leg,
      -- The voucher's net movement on L, for the sign test. Summed over the
      -- voucher's L-lines, matching the voucher-level settled/unsettled
      -- semantics of the NOT EXISTS filter below.
      (
        SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
        FROM public.journal_entry_lines jel3
        WHERE jel3.journal_entry_id = je.id
          AND jel3.account_number = p_account_number
      ) AS account_net
  ) v
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
            AND (
              ca.ledger_account = p_account_number
              OR (
                ca.ledger_account IS NULL
                AND (
                  v.legacy_null_ok
                  OR v.single_bank_leg
                  OR sign(t.amount) = 0
                  OR sign(v.account_net) = 0
                  OR sign(t.amount) = sign(v.account_net)
                )
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.transaction_voucher_links l
          JOIN public.transactions t ON t.id = l.transaction_id
          LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
          WHERE l.journal_entry_id = je.id
            AND l.company_id = p_company_id
            AND (
              ca.ledger_account = p_account_number
              OR (
                ca.ledger_account IS NULL
                AND (
                  v.legacy_null_ok
                  OR v.single_bank_leg
                  OR sign(t.amount) = 0
                  OR sign(v.account_net) = 0
                  OR sign(t.amount) = sign(v.account_net)
                )
              )
            )
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
REVOKE EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
