-- The bank bridge leaves out a rättelse booked in a later open period.
--
-- A verifikat whose own date is in a locked or closed year, or on or before
-- the company lock date, is corrected with a storno and a corrected
-- verifikat dated in the first open, unlocked period (correctEntry with
-- inFirstOpenPeriodWhenLocked, lib/core/bookkeeping/storno-target.ts).
-- Nothing is written to the original: it stays posted, its bank row stays
-- linked to it in its own year. The storno and the corrected verifikat each
-- carry the bank leg in the open year and cancel there, with no bank row.
--
-- The candidate predicates leave every storno out and keep a posted
-- correction: the corrected verifikat's bank leg was then a ledger-only
-- verifikat in the open year, with nothing to match, and the bridge carried
-- it as an unexplained difference although the ledger moved nothing.
--
-- Both predicates now also leave out a correction whose original is still
-- posted and whose posted storno is dated the same day, when the two cancel
-- on the account. A correction that moves money on the account (its leg
-- differs from the storno's) stays a candidate, as does every correction in
-- an open year (its original is 'reversed'). Bodies verbatim from
-- 20261122160000 otherwise (the live definitions); grants restated.
--
-- pg-test: tests/pg/bank-bridge-moved-correction.pg.test.ts

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
           x.description, x.source_type, x.status, x.correction_of_id
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
    -- A rättelse dated in a later open period for a verifikat whose own date
    -- took no write (lib/core/bookkeeping/storno-target.ts): the original
    -- stays posted with its bank row in its own year, and its storno and the
    -- corrected verifikat share one day in the open year. Where the pair
    -- cancels on this account, neither is bank work: the storno is out by
    -- its type above, the corrected verifikat by this.
    AND NOT (
      je.source_type = 'correction'
      AND EXISTS (
        SELECT 1
        FROM public.journal_entries o
        JOIN public.journal_entries s
          ON s.reverses_id = o.id
         AND s.company_id = p_company_id
         AND s.source_type = 'storno'
         AND s.status = 'posted'
         AND s.entry_date = je.entry_date
        WHERE o.id = je.correction_of_id
          AND o.company_id = p_company_id
          AND o.status = 'posted'
          AND (
            SELECT COALESCE(sum(pl.debit_amount - pl.credit_amount), 0)
            FROM public.journal_entry_lines pl
            WHERE pl.journal_entry_id IN (s.id, je.id)
              AND pl.account_number = p_account_number
          ) = 0
      )
    )
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
           x.description, x.source_type, x.status, x.correction_of_id
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
    -- A rättelse dated in a later open period for a verifikat whose own date
    -- took no write (lib/core/bookkeeping/storno-target.ts): the original
    -- stays posted with its bank row in its own year, and its storno and the
    -- corrected verifikat share one day in the open year. Where the pair
    -- cancels on this account, neither is bank work: the storno is out by
    -- its type above, the corrected verifikat by this.
    AND NOT (
      je.source_type = 'correction'
      AND EXISTS (
        SELECT 1
        FROM public.journal_entries o
        JOIN public.journal_entries s
          ON s.reverses_id = o.id
         AND s.company_id = p_company_id
         AND s.source_type = 'storno'
         AND s.status = 'posted'
         AND s.entry_date = je.entry_date
        WHERE o.id = je.correction_of_id
          AND o.company_id = p_company_id
          AND o.status = 'posted'
          AND (
            SELECT COALESCE(sum(pl.debit_amount - pl.credit_amount), 0)
            FROM public.journal_entry_lines pl
            WHERE pl.journal_entry_id IN (s.id, je.id)
              AND pl.account_number = p_account_number
          ) = 0
      )
    )
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

REVOKE ALL ON FUNCTION public.bank_account_unlinked_lines(uuid, text, date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_account_unlinked_lines(uuid, text, date, date, uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bank_account_candidate_lines(uuid, text, date, date, boolean, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_account_candidate_lines(uuid, text, date, date, boolean, uuid[]) TO authenticated, service_role;
