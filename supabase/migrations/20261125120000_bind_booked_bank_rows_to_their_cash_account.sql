-- Bind the booked bank rows that still have no cash account to the one their
-- verifikat books on (issue #1299).
--
-- A bank row with cash_account_id NULL is claimed by the company's primary
-- cash account: the reconciliation cannot tell which account it belongs to,
-- and pooling it into every same-currency account would count it twice
-- (scopeTransactionsToAccount, get_bank_reconciliation_facts). For an
-- unbooked row that is the only answer there is. A booked row says where its
-- money went: its verifikat's bank line. When that line is on another of the
-- company's cash accounts, the primary account counts the row on its bank
-- side with nothing on its ledger side, and the account it was booked on
-- misses it. Both show a difference with no unmatched row to point at, and
-- the VAT close check raises bank_unreconciled for it.
--
-- 20260606120100 and 20260609120000 bound these rows once (their pass (a)).
-- Rows booked after them stayed NULL until the writers bound at ingest and
-- guard_cash_transaction_binding (20260921183218) began to refuse new ones.
-- This repeats that pass for the rows the reconciliation attributes wrongly:
--
--   - cash_account_id is NULL and the row points at a posted verifikat;
--   - the verifikat has exactly one bank-class (19xx) line, and it is the
--     ledger account of one of the company's cash accounts in the row's
--     currency. A verifikat with two bank lines is a transfer between the
--     company's own accounts, and which leg is the row cannot be read from it:
--     those stay NULL;
--   - that cash account is not the primary one. A row booked on the primary
--     account is already counted there; binding it would change no figure.
--
-- Each row is bound through guard_cash_transaction_binding, which checks the
-- verifikat books the account in the row's direction and that every other
-- claim on the row agrees. A row the guard refuses stays NULL, as before, and
-- the count is reported. Every row this touches is NULL before it, so the
-- migration is idempotent.
--
-- No journal entry or line is written (BFL 5 kap 5 §): only the bank row's
-- pointer to the account it was booked on.
--
-- pg-test: tests/pg/bind-booked-bank-rows.pg.test.ts

DO $migration$
DECLARE
  v_row record;
  v_bound integer := 0;
  v_refused integer := 0;
BEGIN
  FOR v_row IN
    SELECT t.id, t.company_id, ca.id AS cash_account_id
    FROM public.transactions t
    JOIN public.journal_entries e
      ON e.id = t.journal_entry_id AND e.company_id = t.company_id AND e.status = 'posted'
    JOIN public.journal_entry_lines l
      ON l.journal_entry_id = e.id AND l.account_number BETWEEN '1900' AND '1999'
    JOIN public.cash_accounts ca
      ON ca.company_id = t.company_id
     AND ca.ledger_account = l.account_number
     AND ca.currency = t.currency
    WHERE t.cash_account_id IS NULL
      AND NOT coalesce(ca.is_primary, false)
      AND (
        SELECT count(*)
        FROM public.journal_entry_lines x
        WHERE x.journal_entry_id = e.id
          AND x.account_number BETWEEN '1900' AND '1999'
      ) = 1
    ORDER BY t.company_id, t.id
  LOOP
    BEGIN
      UPDATE public.transactions
         SET cash_account_id = v_row.cash_account_id
       WHERE id = v_row.id
         AND company_id = v_row.company_id
         AND cash_account_id IS NULL;
      v_bound := v_bound + 1;
    EXCEPTION
      -- The binding guard's refusals: the verifikat or another claim on the
      -- row does not book this account in the row's direction, or the
      -- company is busy. The row keeps its NULL.
      WHEN SQLSTATE 'PT409' OR foreign_key_violation THEN
        v_refused := v_refused + 1;
    END;
  END LOOP;

  RAISE NOTICE 'bind_booked_bank_rows_to_their_cash_account: % bound, % left NULL by the binding guard',
    v_bound, v_refused;
END;
$migration$;
