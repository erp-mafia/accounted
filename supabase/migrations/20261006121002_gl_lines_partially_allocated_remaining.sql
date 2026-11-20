-- Keep a partially allocated verifikat among the unmatched ledger lines, with
-- its remainder.
--
-- A 1:N split (linkTransactionToVouchers) may settle only part of a verifikat:
-- a bank row whose slice on a verifikat is smaller than the verifikat's line
-- on the account (one supplier payment of an invoice also settled elsewhere,
-- a slice the user typed). get_unlinked_gl_lines dropped a verifikat with ANY
-- junction row, and get_account_gl_lines_for_matching with any junction row on
-- the account, so the unexplained part vanished from unmatched_ledger while
-- the verifikat's full line still counted in the ledger movement: the bridge
-- showed an unexplained difference with nothing left to act on (agent
-- feedback seq 854089).
--
-- Rule, the same in both RPCs: when EVERY junction row of the verifikat is a
-- bank_line slice of a transaction bound to a SEK cash account on this ledger
-- account, the verifikat stays a candidate while its net on the account minus
-- the sum of those slices is at least half an öre, and remaining_amount
-- carries that difference (ledger sign, debit positive). Any other junction
-- shape keeps the previous behaviour (dropped; remaining_amount NULL): a
-- clearing or residual row, a slice on another cash account (the other leg of
-- a transfer) and a foreign-currency slice, whose allocated_amount is not in
-- the SEK unit of the verifikat's lines. A pointer link
-- (transactions.journal_entry_id) still means fully settled. remaining_amount
-- is NULL for a verifikat with no junction row: its lines are the open amount.
--
-- The return type gains a column, which CREATE OR REPLACE cannot do, so each
-- function is dropped and recreated with its grants. Bodies otherwise verbatim
-- from 20260923150000_gl_lines_offer_correction_vouchers.sql (the latest
-- definition of both).

DROP FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date);

CREATE FUNCTION public.get_unlinked_gl_lines(
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
  source_type        TEXT,
  remaining_amount   NUMERIC
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
    r.remaining_amount
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  -- The verifikat's junction rows: how many, whether every one is a SEK
  -- bank_line slice on this account, and what those slices sum to.
  CROSS JOIN LATERAL (
    SELECT
      count(*) AS link_count,
      bool_and(COALESCE(
        l.role = 'bank_line' AND ca.ledger_account = p_account_number AND ca.currency = 'SEK',
        false)) AS slices_here,
      sum(l.allocated_amount) AS allocated
    FROM public.transaction_voucher_links l
    JOIN public.transactions t ON t.id = l.transaction_id
    LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
    WHERE l.journal_entry_id = je.id
      AND l.company_id = p_company_id
  ) k
  CROSS JOIN LATERAL (
    SELECT CASE WHEN k.link_count > 0 AND k.slices_here THEN round(
      (SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
         FROM public.journal_entry_lines jel3
        WHERE jel3.journal_entry_id = je.id
          AND jel3.account_number = p_account_number)
      - k.allocated, 2) END AS remaining_amount
  ) r
  WHERE jel.account_number = p_account_number
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    AND je.source_type IS DISTINCT FROM 'storno'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to   IS NULL OR je.entry_date <= p_date_to)
    AND NOT EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
    )
    -- No junction row, or slices that leave part of the verifikat open.
    AND (k.link_count = 0 OR abs(r.remaining_amount) >= 0.005)
    -- Tenant guard: anon/authenticated may only read their own companies;
    -- service_role and direct/superuser access (no JWT role) bypass.
    AND (
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

DROP FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean);

CREATE FUNCTION public.get_account_gl_lines_for_matching(
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
  linked_transaction_count INT,
  remaining_amount         NUMERIC
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
    )::int AS linked_transaction_count,
    r.remaining_amount
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
  -- The verifikat's junction rows (same rule as get_unlinked_gl_lines): when
  -- every one is a SEK bank_line slice on this account, the part of the
  -- verifikat's net on the account those slices leave open.
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN count(*) > 0
        AND bool_and(COALESCE(
          l.role = 'bank_line' AND ca.ledger_account = p_account_number AND ca.currency = 'SEK',
          false))
      THEN round(v.account_net - sum(l.allocated_amount), 2)
    END AS remaining_amount
    FROM public.transaction_voucher_links l
    JOIN public.transactions t ON t.id = l.transaction_id
    LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
    WHERE l.journal_entry_id = je.id
      AND l.company_id = p_company_id
  ) r
  WHERE jel.account_number = p_account_number
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    AND je.source_type IS DISTINCT FROM 'storno'
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
        AND (
          NOT EXISTS (
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
          -- Slices on this account that leave part of the verifikat open.
          OR abs(r.remaining_amount) >= 0.005
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

REVOKE EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
