-- bulk_book_transactions: measure the bank net on the ledger the rows settle on.
--
-- crm#1136. The function compared the selected transactions' sum with the
-- verifikat's net over accounts 1900-1999, in two places: the lines of a new
-- verifikat and the lines of an existing one. A cash account whose ledger
-- account lies outside 19xx could therefore never be bulk-booked or linked:
-- the Stripe balance the product itself sets up on 1686
-- (extensions/general/stripe/lib/transaction-sync.ts) always answered
-- BULK_BOOK_AMOUNT_MISMATCH with a bank net of 0, whatever the lines said.
--
-- The ledger every selected row settles on is already resolved a few lines
-- above both comparisons: v_bank_context, from capture_bank_booking_context
-- (cash_accounts.ledger_account in the row's currency; for a row with no cash
-- account, the company's only enabled account in that currency, else 1930:
-- the answer bank_anchor_settlement_account gives the single-row guards). The
-- comparison now reads that instead of its own idea of what a bank account is:
--
--   a line counts toward the bank net when its account is a ledger one of the
--   selected rows settles on, or, when any of those ledgers is itself in
--   1900-1999, anywhere in 1900-1999 as before.
--
-- What that changes, and what it does not:
--   * Rows on 19xx ledgers meet exactly the rule they met before: the whole
--     1900-1999 range must move by their sum, and a line on another 19xx
--     account than their own is still refused by
--     BANK_BOOKING_SETTLEMENT_CHANGED further down.
--   * A row with no cash account settles where it always did (see above) and
--     is measured by that ledger's rule. That is 1930 unless the company has
--     exactly one enabled account in the currency, so for every such row
--     that could be booked until now it is the 19xx rule, unchanged.
--   * Rows on a ledger outside 19xx are measured on that ledger alone. So a
--     Stripe charge books D 1686 / K 30xx + 26xx, and a payout row links to
--     D 1930 / K 1686: the 1930 debit is the other end of the transfer, not
--     this row's bank side.
--   * A genuine mismatch still answers BULK_BOOK_AMOUNT_MISMATCH.
--
-- Edited in place, not redefined from a file: no migration holds this body
-- whole. It is the 20260824170000 definition as already edited in place by
-- 20260921180432 (company lock, v_bank_context, the per-ledger
-- BANK_BOOKING_SETTLEMENT_CHANGED checks) and 20260921180555. The four edits
-- below are checked the same way: each marker must occur exactly once, or the
-- migration refuses instead of rewriting a body it does not recognise.
-- Signature, SECURITY DEFINER, search_path, grants and comment are untouched
-- (CREATE OR REPLACE of the installed definition keeps them).
-- pg_get_functiondef('public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)')
-- prints the result.
--
-- pg-test: tests/pg/bulk-book-cash-account-ledger.pg.test.ts

DO $migration$
DECLARE
  v_definition text := replace(
    pg_get_functiondef('public.bulk_book_transactions(uuid[],uuid,jsonb,uuid,uuid)'::regprocedure),
    E'\r\n', E'\n');
  v_edit record;
  v_count integer;
BEGIN
  -- Line endings are normalised on both sides (the installed definition above,
  -- the markers here), so a CRLF checkout of this file still matches.
  FOR v_edit IN
    SELECT replace(old_text, E'\r\n', E'\n') AS old_text,
           replace(new_text, E'\r\n', E'\n') AS new_text
    FROM (VALUES
      -- 1. The ledger set, declared beside the context it is read from.
      ($old$  v_bank_context jsonb;
$old$,
       $new$  v_bank_context jsonb;
  -- The ledgers the selected rows settle on (v_bank_context), and whether any
  -- of them is a 19xx account: together they say which lines are the bank side.
  v_bank_ledgers text[];
  v_bank_ledger_in_19xx boolean;
$new$),
      -- 2. Filled once, right after the context is captured.
      ($old$  v_bank_context := public.capture_bank_booking_context(p_company_id, p_tx_ids);
$old$,
       $new$  v_bank_context := public.capture_bank_booking_context(p_company_id, p_tx_ids);

  SELECT array_agg(DISTINCT c->>'settlement_account'),
         COALESCE(bool_or(length(c->>'settlement_account') = 4
                          AND c->>'settlement_account' BETWEEN '1900' AND '1999'), false)
    INTO v_bank_ledgers, v_bank_ledger_in_19xx
  FROM jsonb_array_elements(v_bank_context) c;
$new$),
      -- 3. Link to an existing verifikat: its bank net.
      ($old$    WHERE journal_entry_id = p_existing_journal_entry_id
      AND length(account_number) = 4
      AND account_number BETWEEN '1900' AND '1999';
$old$,
       $new$    WHERE journal_entry_id = p_existing_journal_entry_id
      AND (account_number = ANY(v_bank_ledgers)
        OR (v_bank_ledger_in_19xx
          AND length(account_number) = 4
          AND account_number BETWEEN '1900' AND '1999'));
$new$),
      -- 4. New verifikat: the bank net of the submitted lines.
      ($old$      IF length(v_line_account) = 4 AND v_line_account BETWEEN '1900' AND '1999' THEN
$old$,
       $new$      IF v_line_account = ANY(v_bank_ledgers)
         OR (v_bank_ledger_in_19xx
           AND length(v_line_account) = 4 AND v_line_account BETWEEN '1900' AND '1999') THEN
$new$)
    ) AS edits(old_text, new_text)
  LOOP
    v_count := (length(v_definition) - length(replace(v_definition, v_edit.old_text, ''))) / length(v_edit.old_text);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Unexpected bulk_book_transactions definition: % occurrence(s) of the marker %',
        v_count, quote_literal(v_edit.old_text);
    END IF;
    v_definition := replace(v_definition, v_edit.old_text, v_edit.new_text);
  END LOOP;
  EXECUTE v_definition;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
