-- Offer posted rättelse vouchers (source_type 'correction') as bank matching
-- candidates in get_unlinked_gl_lines and get_account_gl_lines_for_matching.
--
-- 20260605130000 excluded both 'storno' and 'correction' on the premise that
-- neither is ever the target of a bank link. That holds for the storno (it
-- cancels a reversed original; the pair nets to zero on the bank account) but
-- not for the correction: it is the LIVE booking of the affärshändelse after a
-- storno-and-rebook, and correctEntry (lib/core/bookkeeping/storno-service.ts,
-- relinkTransactionsToEntry) already re-points the original's bank links onto
-- it. So:
--   * a correction whose original was matched arrives already linked and stays
--     out of the unmatched set through the NOT EXISTS link checks below;
--   * a correction whose original was NEVER matched is a real, unmatched bank
--     movement, and hiding it made it impossible to match by hand (the dialog
--     could not find it by voucher number or amount) while the reconciliation
--     card still counted its line in the ledger movement, leaving the amount
--     as an unexplained difference with no list to act on.
-- Measured on prod 2026-09-23 before shipping: 133 posted, unlinked correction
-- vouchers on a cash-account ledger (67 companies), all with an unlinked
-- original; 0 unlinked corrections whose original still carries a link (the
-- stale pre-relink shape the old premise guarded against).
--
-- The rule is now structural: a candidate is a posted (not reversed) voucher
-- with a line on the account and no settling link. The storno and opening
-- balance exclusions stay: a storno cancels its reversed original, and an IB is
-- no bank movement. Signatures, tenant guards and grants are unchanged; the only
-- change to each body is the removed source_type 'correction' filter.

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
REVOKE EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
