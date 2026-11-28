-- The bank rows a year books twice, for the year-end check.
--
-- A bank row is booked twice when two or more verifikat booked from it
-- (source_type 'bank_transaction', source_id the row) stand in the year and
-- are copies of each other: the bank account then carries the row's amount
-- more than once. guard_bank_row_single_booking (20261113133511) refuses such
-- a second posting from then on; the copies posted before it stay, and the
-- readiness report names them so the owner can reverse the extra ones before
-- the year is closed. A reminder, never a blocker.
--
-- bank_rows_booked_twice(company, fiscal period): one row per bank row booked
-- twice in the period, with the verifikat that stays and the extra copies.
-- Of the posted verifikat of the period booked from the row, two kinds do not
-- count:
--   - one a posted storno reverses (reverses_id), whatever its own status
--     says: a storno moved into a later year, or one whose status update never
--     landed, leaves the original labelled posted;
--   - one another bank row is booked on, by its pointer or a voucher link of
--     any role: that verifikat is the other row's booking, not a copy.
-- The rest are grouped by their lines (account, debit and credit in öre); a
-- group of two or more is a set of copies. In each set the one the bank row
-- names (its pointer or a bank_line link, as bank_row_anchors reads them)
-- stays, else the first posted (committed_at, then voucher number); the others
-- are extra. kept_* names the set the row names, else the set posted first.
-- Verifikat booked from one row with different lines are not reported.
--
-- How a bank row legitimately carries more than one verifikat, none of which
-- this reports: bulk-book's samlingsverifikat is 'manual' and
-- match_batch_allocate's (a Bankgirot split among them) an invoice payment; a
-- 1:N split links the row to verifikat that exist already; a storno and a
-- correction are 'storno' and 'correction', and the original they replace is
-- 'reversed'; a supplementary link (role 'other' or 'clearing') books no bank
-- amount.
--
-- Cheap on a large ledger: the rows two or more posted verifikat were booked
-- from, in any year, are counted on journal_entries_posted_bank_source_idx
-- (company_id, source_id) alone, which holds every column the count reads;
-- the period, the exclusions and the line comparison then run for those rows
-- only.
--
-- SECURITY INVOKER: the caller's row level security applies, so a caller with
-- no access to the company reads no rows.
--
-- pg-test: tests/pg/bank-rows-booked-twice.pg.test.ts

CREATE FUNCTION public.bank_rows_booked_twice(p_company_id uuid, p_fiscal_period_id uuid)
RETURNS TABLE (
  transaction_id uuid,
  kept_journal_entry_id uuid,
  kept_voucher_series text,
  kept_voucher_number integer,
  extra_entries jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $function$
  WITH candidates AS MATERIALIZED (
    -- The plain count: rows two or more posted verifikat were booked from.
    SELECT j.source_id AS row_id
    FROM public.journal_entries j
    WHERE j.company_id = p_company_id
      AND j.status = 'posted'
      AND j.source_type = 'bank_transaction'
      AND j.source_id IS NOT NULL
    GROUP BY j.source_id
    HAVING count(*) >= 2
  ),
  standing AS MATERIALIZED (
    -- Their verifikat in the period that stand as the row's own booking.
    SELECT j.id, j.source_id AS row_id, j.voucher_series, j.voucher_number, j.committed_at
    FROM candidates c
    JOIN public.journal_entries j
      ON j.company_id = p_company_id
     AND j.source_id = c.row_id
     AND j.status = 'posted'
     AND j.source_type = 'bank_transaction'
    WHERE j.fiscal_period_id = p_fiscal_period_id
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entries s
        WHERE s.reverses_id = j.id
          AND s.company_id = p_company_id
          AND s.status = 'posted'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.transactions t
        WHERE t.journal_entry_id = j.id
          AND t.company_id = p_company_id
          AND t.id <> j.source_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.transaction_voucher_links k
        WHERE k.journal_entry_id = j.id
          AND k.company_id = p_company_id
          AND k.transaction_id <> j.source_id
      )
  ),
  shaped AS (
    SELECT
      s.id, s.row_id, s.voucher_series, s.voucher_number, s.committed_at,
      -- The lines as one value: account, debit and credit, in one order.
      (
        SELECT string_agg(
                 l.account_number || ':' || round(coalesce(l.debit_amount, 0), 2)::text
                   || ':' || round(coalesce(l.credit_amount, 0), 2)::text,
                 ',' ORDER BY l.account_number, round(coalesce(l.debit_amount, 0), 2), round(coalesce(l.credit_amount, 0), 2))
        FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = s.id
      ) AS lines,
      (
        EXISTS (
          SELECT 1 FROM public.transactions t
          WHERE t.id = s.row_id
            AND t.company_id = p_company_id
            AND t.journal_entry_id = s.id
        )
        OR EXISTS (
          SELECT 1 FROM public.transaction_voucher_links k
          WHERE k.transaction_id = s.row_id
            AND k.journal_entry_id = s.id
            AND k.company_id = p_company_id
            AND k.role = 'bank_line'
        )
      ) AS named
    FROM standing s
  ),
  sets AS (
    SELECT
      h.id, h.row_id, h.voucher_series, h.voucher_number, h.committed_at, h.named,
      count(*) OVER (PARTITION BY h.row_id, h.lines) AS copies,
      row_number() OVER (
        PARTITION BY h.row_id, h.lines
        ORDER BY h.named DESC, h.committed_at, h.voucher_number, h.id
      ) AS place
    FROM shaped h
  ),
  kept AS (
    SELECT DISTINCT ON (x.row_id) x.row_id, x.id, x.voucher_series, x.voucher_number
    FROM sets x
    WHERE x.copies >= 2 AND x.place = 1
    ORDER BY x.row_id, x.named DESC, x.committed_at, x.voucher_number, x.id
  ),
  extra AS (
    SELECT
      x.row_id,
      jsonb_agg(
        jsonb_build_object('journal_entry_id', x.id, 'voucher_series', x.voucher_series, 'voucher_number', x.voucher_number)
        ORDER BY x.voucher_series, x.voucher_number, x.id
      ) AS entries
    FROM sets x
    WHERE x.copies >= 2 AND x.place > 1
    GROUP BY x.row_id
  )
  SELECT k.row_id, k.id, k.voucher_series, k.voucher_number, e.entries
  FROM kept k
  JOIN extra e ON e.row_id = k.row_id
  ORDER BY k.voucher_series, k.voucher_number, k.row_id;
$function$;

REVOKE ALL ON FUNCTION public.bank_rows_booked_twice(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_rows_booked_twice(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.bank_rows_booked_twice(uuid, uuid) IS
  'The bank rows booked twice in a fiscal period: two or more posted verifikat of the period booked from the row (source_type bank_transaction, source_id) with the same lines, none reversed by a posted storno or booked on by another bank row. One row per bank row: the verifikat that stays (the one the row names, else the first posted) and the extra copies (extra_entries: journal_entry_id, voucher_series, voucher_number). SECURITY INVOKER. Read by the year-end readiness report as a reminder.';

NOTIFY pgrst, 'reload schema';
