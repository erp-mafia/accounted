-- link_transaction_to_vouchers: couple ONE bank transaction to N already-posted
-- verifikat (the 1:N direction).
--
-- The reported gap (Discord, 2026-08): "Jag har tex bokfört flera utlägg men
-- gjort en utbetalning." The verifikat already exist; the user only wants the
-- bank row coupled to all of them. Today transactions.journal_entry_id is a
-- single scalar FK, so the second link is refused (LINK_TX_TX_ALREADY_LINKED)
-- and the row can never be reconciled: getReconciliationStatus sums
-- transactions.amount against the ledger movement on the settlement account, so
-- the user is left with a differens they cannot explain away.
--
-- No new schema is needed. transaction_voucher_links (20260529120000) already
-- carries (transaction_id, journal_entry_id, allocated_amount, role) with the
-- UNIQUE constraint on the PAIR, so N verifikat per transaction is already
-- legal, and is_transaction_booked() already treats a link row as an anchor
-- alongside the scalar column and the two payment tables.
--
-- Deliberately NOT child transaction rows: transactions has UNIQUE
-- (user_id, external_id) and the Enable Banking external_id formula is frozen
-- (changing it re-orphans existing rows), so synthetic child ids would put this
-- change next to the import path. Splitting the row would also force
-- getReconciliationStatus to count parent or children but never both. The
-- junction table avoids both risks; its cost is read-site plumbing, which is
-- safer than touching import. See DECISIONS.md.
--
-- This function creates NO bookkeeping. It writes link rows only, never touches
-- a posted entry, and therefore has no period-lock or voucher-sequence
-- interaction at all: the entries it points at were already committed through
-- the sanctioned path. The complementary "split an unbooked row into N NEW
-- verifikat" flow is a separate RPC (split_book_transaction) precisely because
-- that one does write to the ledger.
--
-- Foreign-currency transactions are permitted here, unlike bulk_book_transactions.
-- That RPC refuses non-SEK because it WRITES debit/credit columns, which are
-- always kronor, with no exchange rate to convert with. This one writes no
-- ledger amounts: allocated_amount is denominated in the transaction's own
-- currency by the column's contract, so there is nothing to mis-state.
--
-- Per-voucher amount equality is deliberately NOT enforced. A partial
-- allocation is legitimate (the table's own comment says so): one verifikat may
-- be settled by two bank rows, so a single link covering part of a voucher's
-- bank side is a valid intermediate state. What IS enforced, öre-tight, is that
-- the links together account for the WHOLE transaction: no remainder may be
-- left stranded on the row, because a partially-accounted bank row reproduces
-- the very differens this feature exists to remove.

CREATE OR REPLACE FUNCTION public.link_transaction_to_vouchers(
  p_transaction_id uuid,
  p_links jsonb,
  p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_tx RECORD;
  v_je RECORD;
  v_link jsonb;
  v_je_id uuid;
  v_alloc numeric;
  v_total numeric := 0;
  v_tx_abs numeric;
  v_link_count int := 0;
  v_index int := 0;
  v_seen_je uuid[] := ARRAY[]::uuid[];
  v_settlement text;
  v_now timestamptz := now();
  v_first_je uuid;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_UNAUTHORIZED');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = v_caller AND company_id = p_company_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_UNAUTHORIZED');
  END IF;

  IF jsonb_typeof(p_links) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_links) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_NO_LINKS');
  END IF;

  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = p_transaction_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_TX_NOT_FOUND');
  END IF;

  IF v_tx.amount = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_TX_ZERO_AMOUNT');
  END IF;

  -- Already anchored? Mirror hasLiveJournalEntryLink (lib/transactions/
  -- link-journal-entry.ts): only a LIVE (posted) scalar pointer blocks. A
  -- pointer left behind by a storno/correction references a 'reversed' entry
  -- and the UI already shows such a row as "utan koppling" (issue #988), so it
  -- must stay re-linkable here too.
  IF v_tx.journal_entry_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = v_tx.journal_entry_id
      AND je.company_id = p_company_id
      AND je.status = 'posted'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_TX_ALREADY_BOOKED',
      'details', jsonb_build_object('via', 'journal_entry_id',
                                    'journal_entry_id', v_tx.journal_entry_id));
  END IF;

  IF EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.transaction_id = p_transaction_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_TX_ALREADY_BOOKED',
      'details', jsonb_build_object('via', 'invoice_payments'));
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments sip
    WHERE sip.transaction_id = p_transaction_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_TX_ALREADY_BOOKED',
      'details', jsonb_build_object('via', 'supplier_invoice_payments'));
  END IF;

  -- Re-linking an already-split row must go through the undo path first, so the
  -- previous allocation is removed deliberately rather than silently widened.
  IF EXISTS (
    SELECT 1 FROM public.transaction_voucher_links tvl
    WHERE tvl.transaction_id = p_transaction_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_TX_ALREADY_BOOKED',
      'details', jsonb_build_object('via', 'transaction_voucher_links'));
  END IF;

  -- Which settlement account must the verifikat touch? cash_accounts is the
  -- source of truth; companies predating the seeding reconcile against 1930.
  -- Requiring the line is what stops a 1930 bank row being coupled to a
  -- voucher that only moves 1931: a cross-account link would hide a real
  -- imbalance instead of resolving one (same rule as manualLink).
  SELECT ca.ledger_account INTO v_settlement
  FROM public.cash_accounts ca
  WHERE ca.id = v_tx.cash_account_id AND ca.company_id = p_company_id;
  v_settlement := COALESCE(v_settlement, '1930');

  FOR v_link IN SELECT * FROM jsonb_array_elements(p_links)
  LOOP
    v_index := v_index + 1;

    BEGIN
      v_je_id := (v_link->>'journal_entry_id')::uuid;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_INVALID_PAYLOAD',
        'details', jsonb_build_object('index', v_index, 'field', 'journal_entry_id'));
    END;

    IF v_je_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_INVALID_PAYLOAD',
        'details', jsonb_build_object('index', v_index, 'field', 'journal_entry_id'));
    END IF;

    v_alloc := (v_link->>'allocated_amount')::numeric;
    IF v_alloc IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_INVALID_PAYLOAD',
        'details', jsonb_build_object('index', v_index, 'field', 'allocated_amount'));
    END IF;

    -- A zero-amount leg is not an allocation; it would satisfy the sum check
    -- while claiming a verifikat the bank row does not actually settle.
    IF ABS(v_alloc) < 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_ZERO_ALLOCATION',
        'details', jsonb_build_object('index', v_index));
    END IF;

    -- Every leg moves money the same way the bank row did. A mixed-sign
    -- allocation could sum to the right magnitude out of two wrong ones.
    IF SIGN(v_alloc) <> SIGN(v_tx.amount) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_DIRECTION_MISMATCH',
        'details', jsonb_build_object('index', v_index,
                                      'allocated_amount', v_alloc,
                                      'tx_amount', v_tx.amount));
    END IF;

    -- The UNIQUE (transaction_id, journal_entry_id) constraint would catch this
    -- as a 23505 at insert time; catching it here returns a code the UI can act
    -- on and names the offending index.
    IF v_je_id = ANY(v_seen_je) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_DUPLICATE_JE',
        'details', jsonb_build_object('index', v_index, 'journal_entry_id', v_je_id));
    END IF;
    v_seen_je := array_append(v_seen_je, v_je_id);

    SELECT * INTO v_je
    FROM public.journal_entries
    WHERE id = v_je_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_JE_NOT_FOUND',
        'details', jsonb_build_object('index', v_index, 'journal_entry_id', v_je_id));
    END IF;

    IF v_je.status <> 'posted' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_JE_NOT_POSTED',
        'details', jsonb_build_object('index', v_index, 'status', v_je.status));
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines jel
      WHERE jel.journal_entry_id = v_je_id
        AND jel.account_number = v_settlement
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHERS_JE_NO_SETTLEMENT_LINE',
        'details', jsonb_build_object('index', v_index,
                                      'journal_entry_id', v_je_id,
                                      'account_number', v_settlement));
    END IF;

    v_total := v_total + v_alloc;
    v_link_count := v_link_count + 1;
    IF v_first_je IS NULL THEN
      v_first_je := v_je_id;
    END IF;

    v_results := v_results || jsonb_build_object(
      'journal_entry_id', v_je_id,
      'allocated_amount', v_alloc,
      'voucher_series', v_je.voucher_series,
      'voucher_number', v_je.voucher_number);
  END LOOP;

  -- The links must account for the WHOLE bank row, öre-tight. Same vocabulary
  -- as match_batch_allocate (20260601120000) so the UI reuses one error path.
  v_tx_abs := ABS(v_tx.amount);
  IF ABS(v_total) > v_tx_abs + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_AMOUNT_EXCEEDS_TX',
      'details', jsonb_build_object('allocated', ABS(v_total), 'tx_amount_abs', v_tx_abs));
  END IF;
  IF ABS(v_total) < v_tx_abs - 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_AMOUNT_BELOW_TX',
      'details', jsonb_build_object('allocated', ABS(v_total), 'tx_amount_abs', v_tx_abs));
  END IF;

  FOR v_link IN SELECT * FROM jsonb_array_elements(p_links)
  LOOP
    INSERT INTO public.transaction_voucher_links
      (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
    VALUES
      (v_caller, p_company_id, p_transaction_id,
       (v_link->>'journal_entry_id')::uuid,
       (v_link->>'allocated_amount')::numeric,
       'bank_line');
  END LOOP;

  -- Keep the scalar column populated for the single-link case so every reader
  -- that still consults it behaves exactly as before. For N > 1 it stays NULL
  -- on purpose: no single verifikat is "the" entry, and a reader picking an
  -- arbitrary one would state something untrue. Those readers go through
  -- lib/transactions/is-booked.ts instead.
  IF v_link_count = 1 THEN
    UPDATE public.transactions
    SET journal_entry_id = v_first_je,
        reconciliation_method = 'manual',
        is_business = TRUE,
        potential_journal_entry_id = NULL,
        potential_match_method = NULL,
        potential_match_confidence = NULL,
        updated_at = v_now
    WHERE id = p_transaction_id;
  ELSE
    UPDATE public.transactions
    SET reconciliation_method = 'manual',
        is_business = TRUE,
        potential_journal_entry_id = NULL,
        potential_match_method = NULL,
        potential_match_confidence = NULL,
        updated_at = v_now
    WHERE id = p_transaction_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'transaction_id', p_transaction_id,
    'link_count', v_link_count,
    'allocated_total', v_total,
    'settlement_account', v_settlement,
    'links', v_results
  );
END;
$$;

COMMENT ON FUNCTION public.link_transaction_to_vouchers(uuid, jsonb, uuid) IS
  'Couple ONE bank transaction to N already-posted verifikat by writing transaction_voucher_links rows. Creates no bookkeeping and never mutates a posted entry, so it has no period-lock or voucher-sequence interaction. Allocations must sum to the whole transaction amount (BATCH_AMOUNT_EXCEEDS_TX / BATCH_AMOUNT_BELOW_TX) and every target must carry a line on the transaction''s settlement account. The scalar transactions.journal_entry_id is kept in sync only for the single-link case.';

REVOKE ALL ON FUNCTION public.link_transaction_to_vouchers(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_transaction_to_vouchers(uuid, jsonb, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
