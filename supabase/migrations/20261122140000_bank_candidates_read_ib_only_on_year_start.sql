-- The bank bridge reads an IB verifikat only on its fiscal year's first day.
--
-- Until 20261006121003, "Märk som IB" in bank reconciliation re-tagged
-- ordinary mid-year verifikat (bank fees, payments) as source_type
-- 'opening_balance'. 20261025120000 and 20261101180100 read such a verifikat
-- as what it is: the derived IB and the bank status's floor (account_ib_floor)
-- count an IB only on a fiscal year's first day, so get_bank_reconciliation_facts
-- leaves a labelled verifikat on any other day in the ledger movement.
--
-- The two candidate predicates kept the label alone: every opening_balance
-- verifikat was out of the ledger-only lines. A labelled verifikat with no
-- bank row was then in the movement and in no list, and the bridge carried
-- its amount as an unexplained difference while the bank and the ledger
-- agreed to the öre; dated before the bank's history, it also stayed out of
-- the split and moved the opening difference by the same amount.
--
-- Both predicates now drop an opening_balance verifikat only on a fiscal
-- year's first day. Bodies verbatim from 20261023094100 otherwise (the live
-- definitions). A real IB, on a year's first day, stays out of every list.
--
-- pg-test: tests/pg/bank-bridge-ib-label-off-year-start.pg.test.ts

-- 1. get_unlinked_gl_lines' predicate --------------------------------------

CREATE OR REPLACE FUNCTION public.bank_account_unlinked_lines(
  p_company_id     uuid,
  p_account_number text,
  p_date_from      date,
  p_date_to        date,
  p_entry_ids      uuid[]
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT c.id AS entry_id, x.id, x.debit_amount, x.credit_amount, x.line_description
    FROM unnest(p_entry_ids) AS c(id)
    CROSS JOIN LATERAL (
      SELECT l.id, l.debit_amount, l.credit_amount, l.line_description
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = c.id
        AND l.account_number = p_account_number
      OFFSET 0
    ) x
  )
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
  FROM hits jel
  CROSS JOIN LATERAL (
    SELECT x.id, x.company_id, x.entry_date, x.voucher_number, x.voucher_series,
           x.description, x.source_type, x.status
    FROM public.journal_entries x
    WHERE x.id = jel.entry_id
    OFFSET 0
  ) je
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
  WHERE je.company_id = p_company_id
    AND je.status = 'posted'
    -- An ingående balans is an opening_balance verifikat on a fiscal year's
    -- first day, account_ib_floor's rule. One labelled so on any other day
    -- (marked as IB before 20261006121003) is an ordinary verifikat.
    AND (
      je.source_type IS DISTINCT FROM 'opening_balance'
      OR NOT EXISTS (
        SELECT 1 FROM public.fiscal_periods fp
        WHERE fp.company_id = p_company_id
          AND fp.period_start = je.entry_date
      )
    )
    AND je.source_type IS DISTINCT FROM 'storno'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to   IS NULL OR je.entry_date <= p_date_to)
    AND NOT EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
    )
    AND (k.link_count = 0 OR abs(r.remaining_amount) >= 0.005)
    AND (
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
END;
$$;

-- 2. get_account_gl_lines_for_matching's predicate -----------------------

CREATE OR REPLACE FUNCTION public.bank_account_candidate_lines(
  p_company_id      uuid,
  p_account_number  text,
  p_date_from       date,
  p_date_to         date,
  p_include_matched boolean,
  p_entry_ids       uuid[]
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH hits AS MATERIALIZED (
    SELECT c.id AS entry_id, x.id, x.debit_amount, x.credit_amount, x.line_description
    FROM unnest(p_entry_ids) AS c(id)
    CROSS JOIN LATERAL (
      SELECT l.id, l.debit_amount, l.credit_amount, l.line_description
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = c.id
        AND l.account_number = p_account_number
      OFFSET 0
    ) x
  )
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
                (NOT EXISTS (
                SELECT 1
                FROM public.cash_accounts pca
                WHERE pca.company_id = p_company_id
                  AND pca.is_primary
                  AND pca.ledger_account <> p_account_number
              ))
                OR ((
                SELECT count(DISTINCT ca4.ledger_account)
                FROM public.journal_entry_lines jel2
                JOIN public.cash_accounts ca4
                  ON ca4.company_id = p_company_id
                 AND ca4.ledger_account = jel2.account_number
                WHERE jel2.journal_entry_id = je.id
              ) < 2)
                OR sign(t.amount) = 0
                OR sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              )) = 0
                OR sign(t.amount) = sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ))
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
                (NOT EXISTS (
                SELECT 1
                FROM public.cash_accounts pca
                WHERE pca.company_id = p_company_id
                  AND pca.is_primary
                  AND pca.ledger_account <> p_account_number
              ))
                OR ((
                SELECT count(DISTINCT ca4.ledger_account)
                FROM public.journal_entry_lines jel2
                JOIN public.cash_accounts ca4
                  ON ca4.company_id = p_company_id
                 AND ca4.ledger_account = jel2.account_number
                WHERE jel2.journal_entry_id = je.id
              ) < 2)
                OR sign(t.amount) = 0
                OR sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              )) = 0
                OR sign(t.amount) = sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ))
              )
            )
          )
      )
    )::int AS linked_transaction_count,
    r.remaining_amount
  FROM hits jel
  CROSS JOIN LATERAL (
    SELECT x.id, x.company_id, x.entry_date, x.voucher_number, x.voucher_series,
           x.description, x.source_type, x.status
    FROM public.journal_entries x
    WHERE x.id = jel.entry_id
    OFFSET 0
  ) je
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN count(*) > 0
        AND bool_and(COALESCE(
          l.role = 'bank_line' AND ca.ledger_account = p_account_number AND ca.currency = 'SEK',
          false))
      THEN round((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ) - sum(l.allocated_amount), 2)
    END AS remaining_amount
    FROM public.transaction_voucher_links l
    JOIN public.transactions t ON t.id = l.transaction_id
    LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id
    WHERE l.journal_entry_id = je.id
      AND l.company_id = p_company_id
  ) r
  WHERE je.company_id = p_company_id
    AND je.status = 'posted'
    -- An ingående balans is an opening_balance verifikat on a fiscal year's
    -- first day, account_ib_floor's rule. One labelled so on any other day
    -- (marked as IB before 20261006121003) is an ordinary verifikat.
    AND (
      je.source_type IS DISTINCT FROM 'opening_balance'
      OR NOT EXISTS (
        SELECT 1 FROM public.fiscal_periods fp
        WHERE fp.company_id = p_company_id
          AND fp.period_start = je.entry_date
      )
    )
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
                  (NOT EXISTS (
                SELECT 1
                FROM public.cash_accounts pca
                WHERE pca.company_id = p_company_id
                  AND pca.is_primary
                  AND pca.ledger_account <> p_account_number
              ))
                  OR ((
                SELECT count(DISTINCT ca4.ledger_account)
                FROM public.journal_entry_lines jel2
                JOIN public.cash_accounts ca4
                  ON ca4.company_id = p_company_id
                 AND ca4.ledger_account = jel2.account_number
                WHERE jel2.journal_entry_id = je.id
              ) < 2)
                  OR sign(t.amount) = 0
                  OR sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              )) = 0
                  OR sign(t.amount) = sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ))
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
                    (NOT EXISTS (
                SELECT 1
                FROM public.cash_accounts pca
                WHERE pca.company_id = p_company_id
                  AND pca.is_primary
                  AND pca.ledger_account <> p_account_number
              ))
                    OR ((
                SELECT count(DISTINCT ca4.ledger_account)
                FROM public.journal_entry_lines jel2
                JOIN public.cash_accounts ca4
                  ON ca4.company_id = p_company_id
                 AND ca4.ledger_account = jel2.account_number
                WHERE jel2.journal_entry_id = je.id
              ) < 2)
                    OR sign(t.amount) = 0
                    OR sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              )) = 0
                    OR sign(t.amount) = sign((
                SELECT COALESCE(sum(jel3.debit_amount - jel3.credit_amount), 0)
                FROM public.journal_entry_lines jel3
                WHERE jel3.journal_entry_id = je.id
                  AND jel3.account_number = p_account_number
              ))
                  )
                )
              )
          )
          OR abs(r.remaining_amount) >= 0.005
        )
      )
    )
    AND (
      coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        NOT IN ('anon', 'authenticated')
      OR je.company_id IN (SELECT public.user_company_ids())
    )
  ORDER BY je.entry_date, je.voucher_number;
END;
$$;
