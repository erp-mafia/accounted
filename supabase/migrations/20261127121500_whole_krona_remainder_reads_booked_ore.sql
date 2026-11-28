-- A remainder in whole kronor no longer skips the read of what 151x carries.
-- pg-test: tests/pg/match-batch-allocate-booked-ore.pg.test.ts
-- pg-test: tests/pg/counterparty-setoff.pg.test.ts
-- pg-test: tests/pg/link-invoice-voucher-booked-ore.pg.test.ts
--
-- A customer invoice whose own verifikat booked its öresavrundning (1510 at
-- the rounded "Att betala", the öre on 3740: an issuance edited by hand, an
-- import) is settled against what 1510 carries, so the öre is neither left
-- on 1510 nor booked twice on 3740 (20261119090000, 20261125224500,
-- 20261126170500). All three doors read that only when the remainder had
-- öre. A part payment can leave whole kronor open while 1510 still carries
-- the issue's öre: total 999.75 issued Dr 1510 1 000 / Cr 3740 0.25, a part
-- payment of 499.75 leaves 500 open and 500.25 on 1510, and the payment of
-- the last 500 credited 1510 with 500, so 0.25 stayed on 1510 of a paid
-- invoice and 3740 kept a rounding the customer never got.
--
-- The gate now also reads the invoice's total, as the application does
-- (hasOreToRound in src/lib/bookkeeping/invoice-rounding.ts, read by
-- carriedSekOf): a kronor total with öre can have had an öresavrundning
-- booked, whatever is left to pay. A remainder with öre is read as before,
-- so no read the doors made is dropped. The read itself, the rule it
-- answers (ore_settlement_residual over document_carried_sek) and
-- everything a door does with it are unchanged; an invoice whose 1510
-- carries the remainder reads 0 and books as before. One condition of each
-- function changes, plus the comment above it.
--
-- Nothing here rewrites a row. Grants and comments stay as they are (CREATE
-- OR REPLACE keeps them).
--
-- Copied from the newest definitions:
--   match_batch_allocate      20261124100000_match_batch_allocate_customer_receivable_lines
--   book_counterparty_setoff  20261125224500_counterparty_setoff_clears_booked_ore
--   link_invoice_to_voucher   20261126170500_link_invoice_voucher_clears_booked_ore

CREATE OR REPLACE FUNCTION public.match_batch_allocate(p_tx_id uuid, p_allocations jsonb, p_company_id uuid, p_user_id uuid DEFAULT NULL::uuid, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text, p_fee_lines jsonb DEFAULT NULL::jsonb, p_cash_lines jsonb DEFAULT NULL::jsonb, p_debt_lines jsonb DEFAULT NULL::jsonb, p_event_ids uuid[] DEFAULT NULL::uuid[], p_event_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tx RECORD;
  v_booked_by uuid;           -- the posted verifikat that already books the row
  v_bank_context jsonb;
  v_bank_account text;
  v_tx_abs numeric;
  v_tx_date_short text;
  v_allocation jsonb;
  v_alloc_index int := 0;
  v_kind text;
  v_invoice_id uuid;
  v_supplier_invoice_id uuid;
  v_alloc_amount numeric;
  v_total_allocated numeric := 0;
  v_has_customer boolean := false;
  v_has_supplier boolean := false;
  v_seen_ids text[] := ARRAY[]::text[];
  v_target_id text;
  v_invoice RECORD;
  v_si_invoice RECORD;
  v_supplier_name text;
  v_supplier_invoice_number text;
  v_invoice_number text;
  v_fiscal_period_id uuid;
  v_period_is_closed boolean;
  v_period_locked_at timestamptz;
  v_journal_entry_id uuid := gen_random_uuid();
  v_voucher_series text := 'A';
  v_voucher_number int;
  v_entry_description text;
  v_source_type text;
  v_line_sort_order int := 0;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_now timestamptz := now();
  v_payment_id uuid;
  v_results jsonb := '[]'::jsonb;
  v_inv_remaining numeric;
  v_inv_currency text;
  v_inv_fx_rate numeric;
  v_inv_total numeric;
  v_booked_sek numeric;
  v_fx_diff numeric;
  v_paid_in_inv_currency numeric;
  v_payment_rate numeric;     -- round-3 (swedish-compliance traceability)
  v_inv_number_short text;
  v_caller uuid;
  v_ore_diff numeric;         -- remaining - allocation, öre-rounded (#1717)
  v_doc_dims jsonb := '{}'::jsonb;   -- the settled document's bag (coerce_dimensions_bag)
  v_bank_dims jsonb := '{}'::jsonb;  -- the bank leg's bag: shared by every document, else {}
  v_series_raw text;          -- the company's series for v_source_type
  v_counterparty_name text;   -- customer or supplier named in a one-invoice header
  v_fee jsonb;                -- one row of p_fee_lines
  v_fee_index int := 0;
  v_fee_account text;
  v_fee_amount numeric;
  v_total_fees numeric := 0;  -- the fee rows together
  v_net_settled numeric;      -- what the bank row must carry: invoices -/+ fees
  v_cash_given boolean := false;  -- p_cash_lines names at least one invoice
  v_accounting_method text;   -- company_settings.accounting_method
  v_cash_lines jsonb;         -- p_cash_lines for the current invoice
  v_cash_line jsonb;
  v_cash_line_index int;
  v_cash_debit numeric;
  v_cash_credit numeric;
  v_cash_account text;
  v_cash_net numeric;         -- one invoice's lines: credit - debit
  v_cash_count int := 0;      -- allocations booked from p_cash_lines
  v_inv_journal_entry_id uuid; -- the customer invoice's issue verifikat
  v_carried jsonb;            -- document_carried_sek for that invoice
  v_booked_ore numeric;       -- öresavrundning that verifikat booked (bookedOreRounding, 20261119090000)
  v_debt jsonb;               -- one row of p_debt_lines (20261120150000, 20261124100000)
  v_debt_index int := 0;
  v_debt_account text;
  v_debt_code text;           -- BATCH_DEBT on a supplier batch, BATCH_RECEIVABLE on a customer batch (20261124100000)
  v_debt_pattern text;        -- the side's account group: ^244[0-9]$ supplier, ^151[0-9]$ customer (20261124100000)
  v_debt_amount numeric;
  v_total_debts numeric := 0; -- the rows from before together (supplier debt or customer receivable)
BEGIN
  -- Actor resolution. p_user_id is an assertion by the caller, so it is
  -- honored ONLY when the caller holds the service role (the cookieless
  -- server client used by the pending-operations commit path, where
  -- auth.uid() is NULL). Any other caller is pinned to its own auth.uid():
  -- otherwise an authenticated PostgREST caller could pass another user's
  -- UUID and walk through the membership gate below. Same shape as
  -- undo_sie_import (20260727121000).
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_UNAUTHORIZED');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = v_caller AND company_id = p_company_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_UNAUTHORIZED');
  END IF;

  PERFORM public.lock_cash_account_booking_state(p_company_id);

  SELECT * INTO v_tx FROM public.transactions
  WHERE id = p_tx_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'BATCH_TX_NOT_FOUND'); END IF;
  -- The row as decideBankRowRebooking reads it (lib/transactions/is-booked.ts,
  -- 20261101023500): the pointer and the bank_line links to a posted verifikat
  -- book it, a pointer at a verifikat no longer posted does not, and an
  -- ignored row can carry no verifikat.
  IF v_tx.is_ignored THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BANK_ROW_IGNORED');
  END IF;
  v_booked_by := public.bank_row_posted_anchor(p_company_id, v_tx.id, v_tx.journal_entry_id);
  IF v_booked_by IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_TX_ALREADY_BOOKED',
      'details', jsonb_build_object('journal_entry_id', v_booked_by));
  END IF;
  -- A foreign row, as bulk_book_transactions and create_expense_payout_batch
  -- refuse one (20261101120200): the debit and credit columns are kronor, this
  -- function has no way to read a foreign row in them, and the figure it wrote
  -- balanced, so no trigger saw 1000 EUR booked as 1000 kr.
  IF upper(COALESCE(v_tx.currency, 'SEK')) <> 'SEK' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FOREIGN_CURRENCY',
      'details', jsonb_build_object('currency', v_tx.currency));
  END IF;
  IF v_tx.amount = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'BATCH_TX_ZERO_AMOUNT'); END IF;
  v_tx_abs := ABS(v_tx.amount);
  v_tx_date_short := LEFT(v_tx.date::text, 10);

  IF jsonb_typeof(p_allocations) IS DISTINCT FROM 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_NO_ALLOCATIONS');
  END IF;

  -- Kontantmetoden (20261031100700): p_cash_lines is an object keyed by
  -- customer invoice id; SQL NULL, JSON null or {} names none.
  IF p_cash_lines IS NOT NULL AND jsonb_typeof(p_cash_lines) <> 'null' THEN
    IF jsonb_typeof(p_cash_lines) <> 'object' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CASH_LINES_INVALID',
        'details', jsonb_build_object('reason', 'not_an_object'));
    END IF;
    v_cash_given := EXISTS (SELECT 1 FROM jsonb_object_keys(p_cash_lines));
  END IF;
  SELECT cs.accounting_method INTO v_accounting_method
  FROM public.company_settings cs WHERE cs.company_id = p_company_id;

  FOR v_allocation IN
    SELECT value FROM jsonb_array_elements(p_allocations) AS t(value)
    ORDER BY COALESCE(value->>'invoice_id', value->>'supplier_invoice_id', '')
  LOOP
    v_kind := v_allocation->>'kind';
    v_alloc_amount := (v_allocation->>'amount')::numeric;
    v_target_id := COALESCE(v_allocation->>'invoice_id', v_allocation->>'supplier_invoice_id');

    IF v_alloc_amount IS NULL OR v_alloc_amount <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BATCH_INVALID_AMOUNT',
        'details', jsonb_build_object('index', v_alloc_index, 'amount', v_alloc_amount));
    END IF;
    IF v_target_id IS NOT NULL AND v_target_id = ANY(v_seen_ids) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BATCH_DUPLICATE_ALLOCATION',
        'details', jsonb_build_object('id', v_target_id, 'index', v_alloc_index));
    END IF;
    IF v_target_id IS NOT NULL THEN v_seen_ids := array_append(v_seen_ids, v_target_id); END IF;
    v_total_allocated := v_total_allocated + v_alloc_amount;

    IF v_kind = 'customer_invoice' THEN
      v_has_customer := true;
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;
      SELECT * INTO v_invoice FROM public.invoices
      WHERE id = v_invoice_id AND company_id = p_company_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_INVOICE_NOT_FOUND',
          'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id));
      END IF;
      IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_INVOICE_NOT_OPEN',
          'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id, 'status', v_invoice.status));
      END IF;

      -- Kontantmetoden (20261031100700): an invoice with no verifikat has no
      -- 1510 to clear; its sale is booked at payment. p_cash_lines carries
      -- that part of the verifikat (buildBatchCashLines,
      -- lib/invoices/batch-cash-method-guard.ts: the single cash match's entry
      -- without its bank leg). Accepted only for an unbooked invoice of a
      -- kontantmetoden company, SEK on a SEK row, nothing paid before and
      -- settled in full (inside the öresavrundning band), each line one side
      -- in whole öre on an active account, the lines crediting net exactly
      -- the allocation. Without lines such an invoice is refused, as the
      -- application already refused it.
      v_cash_lines := CASE WHEN v_cash_given THEN p_cash_lines -> v_invoice_id::text END;
      IF v_cash_lines IS NOT NULL AND jsonb_typeof(v_cash_lines) <> 'null' THEN
        IF v_accounting_method IS DISTINCT FROM 'cash'
           OR v_invoice.journal_entry_id IS NOT NULL
           OR ROUND(COALESCE(v_invoice.paid_amount, 0) * 100) <> 0
           OR COALESCE(v_invoice.currency, 'SEK') <> 'SEK'
           OR (ROUND(COALESCE(v_invoice.remaining_amount, v_invoice.total) - v_alloc_amount, 2) <> 0
               AND public.ore_settlement_residual(COALESCE(v_invoice.remaining_amount, v_invoice.total), v_alloc_amount) = 0) THEN
          RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CASH_LINES_INVALID',
            'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
              'reason', 'not_an_unbooked_cash_invoice_paid_in_full'));
        END IF;
        IF jsonb_typeof(v_cash_lines) <> 'array' OR jsonb_array_length(v_cash_lines) = 0
           OR jsonb_array_length(v_cash_lines) > 50 THEN
          RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CASH_LINES_INVALID',
            'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id, 'reason', 'lines'));
        END IF;
        v_cash_net := 0;
        v_cash_line_index := 0;
        FOR v_cash_line IN
          SELECT value FROM jsonb_array_elements(v_cash_lines) WITH ORDINALITY AS t(value, n) ORDER BY n
        LOOP
          IF jsonb_typeof(v_cash_line) IS DISTINCT FROM 'object'
             OR jsonb_typeof(v_cash_line->'debit_amount') IS DISTINCT FROM 'number'
             OR jsonb_typeof(v_cash_line->'credit_amount') IS DISTINCT FROM 'number' THEN
            RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CASH_LINES_INVALID',
              'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
                'line', v_cash_line_index, 'reason', 'line'));
          END IF;
          v_cash_debit := (v_cash_line->>'debit_amount')::numeric;
          v_cash_credit := (v_cash_line->>'credit_amount')::numeric;
          IF v_cash_debit < 0 OR v_cash_credit < 0
             OR v_cash_debit <> ROUND(v_cash_debit, 2) OR v_cash_credit <> ROUND(v_cash_credit, 2)
             OR (v_cash_debit > 0) = (v_cash_credit > 0) THEN
            RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CASH_LINES_INVALID',
              'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
                'line', v_cash_line_index, 'reason', 'amount'));
          END IF;
          v_cash_account := v_cash_line->>'account_number';
          IF v_cash_account IS NULL OR v_cash_account !~ '^[0-9]{4}$' OR NOT EXISTS (
            SELECT 1 FROM public.chart_of_accounts
            WHERE company_id = p_company_id AND account_number = v_cash_account AND is_active
          ) THEN
            RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CASH_LINES_INVALID',
              'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
                'line', v_cash_line_index, 'reason', 'account', 'account', v_cash_account));
          END IF;
          v_cash_net := v_cash_net + v_cash_credit - v_cash_debit;
          v_cash_line_index := v_cash_line_index + 1;
        END LOOP;
        IF ABS(v_cash_net - v_alloc_amount) >= 0.005 THEN
          RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CASH_LINES_INVALID',
            'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
              'reason', 'unbalanced', 'lines_net', v_cash_net, 'amount', v_alloc_amount));
        END IF;
        v_cash_count := v_cash_count + 1;
      ELSIF v_accounting_method = 'cash' AND v_invoice.journal_entry_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CASH_METHOD_UNBOOKED_INVOICE',
          'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id));
      END IF;

      v_inv_remaining := COALESCE(v_invoice.remaining_amount, v_invoice.total);
      v_inv_currency := COALESCE(v_invoice.currency, 'SEK');
      v_inv_fx_rate := v_invoice.exchange_rate;

      IF v_inv_currency = 'SEK' THEN
        -- #1717: a sub-krona overshoot is öresavrundning (whole-krona
        -- settlement of an öre total), absorbed into 3740 below. Only an
        -- excess of >= 1.00 kr is a real overpayment. Mirrors
        -- planInvoicePayment (lib/invoices/apply-invoice-payment.ts).
        IF ROUND(v_alloc_amount - v_inv_remaining, 2) > 0
           AND public.ore_settlement_residual(v_inv_remaining, v_alloc_amount) = 0 THEN
          RETURN jsonb_build_object('ok', false, 'code', 'BATCH_OVERSHOOT',
            'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
              'requested', v_alloc_amount, 'remaining', v_inv_remaining));
        END IF;
      ELSE
        IF v_inv_fx_rate IS NULL OR v_inv_fx_rate <= 0 OR v_inv_fx_rate >= 100000 THEN
          RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FX_RATE_MISSING',
            'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
              'invoice_currency', v_inv_currency));
        END IF;
        v_booked_sek := public.document_clearing_sek(p_company_id, 'customer', v_invoice_id, v_inv_remaining, v_inv_fx_rate);
        IF public.fx_deviation_too_large(v_alloc_amount, v_booked_sek) THEN
          RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FX_DEVIATION_TOO_LARGE',
            'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
              'allocation_amount', v_alloc_amount, 'expected_sek', v_booked_sek));
        END IF;
      END IF;

    ELSIF v_kind = 'supplier_invoice' THEN
      v_has_supplier := true;
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;
      SELECT * INTO v_si_invoice FROM public.supplier_invoices
      WHERE id = v_supplier_invoice_id AND company_id = p_company_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_SUPPLIER_INVOICE_NOT_FOUND',
          'details', jsonb_build_object('index', v_alloc_index, 'supplier_invoice_id', v_supplier_invoice_id));
      END IF;
      IF v_si_invoice.status NOT IN ('registered', 'approved', 'overdue', 'partially_paid') THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_SUPPLIER_INVOICE_NOT_OPEN',
          'details', jsonb_build_object('index', v_alloc_index, 'supplier_invoice_id', v_supplier_invoice_id, 'status', v_si_invoice.status));
      END IF;

      v_inv_remaining := COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total);
      v_inv_currency := v_si_invoice.currency;
      v_inv_fx_rate := v_si_invoice.exchange_rate;

      IF v_inv_currency = 'SEK' THEN
        -- #1717: same öresavrundning band as the customer side above.
        IF ROUND(v_alloc_amount - v_inv_remaining, 2) > 0
           AND public.ore_settlement_residual(v_inv_remaining, v_alloc_amount) = 0 THEN
          RETURN jsonb_build_object('ok', false, 'code', 'BATCH_OVERSHOOT',
            'details', jsonb_build_object('index', v_alloc_index, 'supplier_invoice_id', v_supplier_invoice_id,
              'requested', v_alloc_amount, 'remaining', v_inv_remaining));
        END IF;
      ELSE
        IF v_inv_fx_rate IS NULL OR v_inv_fx_rate <= 0 OR v_inv_fx_rate >= 100000 THEN
          RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FX_RATE_MISSING',
            'details', jsonb_build_object('index', v_alloc_index, 'supplier_invoice_id', v_supplier_invoice_id,
              'invoice_currency', v_inv_currency));
        END IF;
        v_booked_sek := public.document_clearing_sek(p_company_id, 'supplier', v_supplier_invoice_id, v_inv_remaining, v_inv_fx_rate);
        IF public.fx_deviation_too_large(v_alloc_amount, v_booked_sek) THEN
          RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FX_DEVIATION_TOO_LARGE',
            'details', jsonb_build_object('index', v_alloc_index, 'supplier_invoice_id', v_supplier_invoice_id,
              'allocation_amount', v_alloc_amount, 'expected_sek', v_booked_sek));
        END IF;
      END IF;
    ELSE
      RETURN jsonb_build_object('ok', false, 'code', 'BATCH_INVALID_KIND',
        'details', jsonb_build_object('index', v_alloc_index, 'kind', v_kind));
    END IF;
    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  IF v_has_customer AND v_has_supplier THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_MIXED_KINDS_UNSUPPORTED');
  END IF;

  -- One verifikat, one source type: every allocation books from
  -- p_cash_lines (invoice_cash_payment) or none does (invoice_paid), and
  -- every key names an allocation of this batch.
  IF v_cash_given AND (
       v_has_supplier
       OR v_cash_count <> jsonb_array_length(p_allocations)
       OR v_cash_count <> (SELECT count(*) FROM jsonb_object_keys(p_cash_lines))
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CASH_LINES_MIXED',
      'details', jsonb_build_object('cash_allocations', v_cash_count,
        'allocations', jsonb_array_length(p_allocations)));
  END IF;

  -- Fee rows (20261028231700): a payment service's fee on the row, at most
  -- five, each a debit on an active class 6 cost account of this company's
  -- chart in whole öre. An exempt payment service (ML 10 kap. 33 §): no VAT
  -- line, and class 6 is read by no momsdeklaration ruta. The fees are
  -- smaller than the invoices they settle. SQL NULL or JSON null: no fees.
  IF p_fee_lines IS NOT NULL AND jsonb_typeof(p_fee_lines) <> 'null' THEN
    IF jsonb_typeof(p_fee_lines) <> 'array' OR jsonb_array_length(p_fee_lines) > 5 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FEE_INVALID',
        'details', jsonb_build_object('reason', 'at_most_five_rows'));
    END IF;
    FOR v_fee IN
      SELECT value FROM jsonb_array_elements(p_fee_lines) WITH ORDINALITY AS t(value, n) ORDER BY n
    LOOP
      IF jsonb_typeof(v_fee) IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_fee->'amount') IS DISTINCT FROM 'number' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FEE_INVALID',
          'details', jsonb_build_object('index', v_fee_index));
      END IF;
      v_fee_amount := (v_fee->>'amount')::numeric;
      IF v_fee_amount <= 0 OR v_fee_amount <> ROUND(v_fee_amount, 2) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FEE_INVALID',
          'details', jsonb_build_object('index', v_fee_index, 'amount', v_fee_amount));
      END IF;
      v_fee_account := v_fee->>'account';
      IF v_fee_account IS NULL OR v_fee_account !~ '^6[0-9]{3}$' OR NOT EXISTS (
        SELECT 1 FROM public.chart_of_accounts
        WHERE company_id = p_company_id AND account_number = v_fee_account AND is_active
      ) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FEE_ACCOUNT_INVALID',
          'details', jsonb_build_object('index', v_fee_index, 'account', v_fee_account));
      END IF;
      v_total_fees := v_total_fees + v_fee_amount;
      v_fee_index := v_fee_index + 1;
    END LOOP;
    IF v_total_fees >= v_total_allocated THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BATCH_FEE_TOO_LARGE',
        'details', jsonb_build_object('fees', v_total_fees, 'allocated', v_total_allocated));
    END IF;
  END IF;

  -- Rows from before (20261120150000, 20261124100000): an invoice the row
  -- also pays that was registered or issued before the company kept its books
  -- here, so it has no supplier_invoices or invoices row and its balance is
  -- in what the import brought. On a supplier batch each row is a debit on
  -- an active 244x account (the skuld in 2440); on a customer batch a credit
  -- on an active 151x account (the fordran in 1510). At most five rows, and
  -- at most five extra rows with the fee rows; each in whole öre. No VAT
  -- line: the moms was booked with the invoice. Not a fee, so not in the
  -- check above: a row from before may be larger than the invoices. The
  -- refusals name the side: BATCH_DEBT_* on a supplier batch,
  -- BATCH_RECEIVABLE_* on a customer batch. SQL NULL or JSON null: no rows.
  IF p_debt_lines IS NOT NULL AND jsonb_typeof(p_debt_lines) <> 'null' THEN
    v_debt_code := CASE WHEN v_has_customer THEN 'BATCH_RECEIVABLE' ELSE 'BATCH_DEBT' END;
    v_debt_pattern := CASE WHEN v_has_customer THEN '^151[0-9]$' ELSE '^244[0-9]$' END;
    IF jsonb_typeof(p_debt_lines) <> 'array' OR jsonb_array_length(p_debt_lines) > 5 THEN
      RETURN jsonb_build_object('ok', false, 'code', v_debt_code || '_INVALID',
        'details', jsonb_build_object('reason', 'at_most_five_rows'));
    END IF;
    IF v_fee_index + jsonb_array_length(p_debt_lines) > 5 THEN
      RETURN jsonb_build_object('ok', false, 'code', v_debt_code || '_INVALID',
        'details', jsonb_build_object('reason', 'at_most_five_extra_rows',
          'fees', v_fee_index, 'debts', jsonb_array_length(p_debt_lines)));
    END IF;
    FOR v_debt IN
      SELECT value FROM jsonb_array_elements(p_debt_lines) WITH ORDINALITY AS t(value, n) ORDER BY n
    LOOP
      IF jsonb_typeof(v_debt) IS DISTINCT FROM 'object'
         OR jsonb_typeof(v_debt->'amount') IS DISTINCT FROM 'number' THEN
        RETURN jsonb_build_object('ok', false, 'code', v_debt_code || '_INVALID',
          'details', jsonb_build_object('index', v_debt_index));
      END IF;
      v_debt_amount := (v_debt->>'amount')::numeric;
      IF v_debt_amount <= 0 OR v_debt_amount <> ROUND(v_debt_amount, 2) THEN
        RETURN jsonb_build_object('ok', false, 'code', v_debt_code || '_INVALID',
          'details', jsonb_build_object('index', v_debt_index, 'amount', v_debt_amount));
      END IF;
      v_debt_account := v_debt->>'account';
      IF v_debt_account IS NULL
         OR v_debt_account !~ v_debt_pattern
         OR NOT EXISTS (
           SELECT 1 FROM public.chart_of_accounts
           WHERE company_id = p_company_id AND account_number = v_debt_account AND is_active
         ) THEN
        RETURN jsonb_build_object('ok', false, 'code', v_debt_code || '_ACCOUNT_INVALID',
          'details', jsonb_build_object('index', v_debt_index, 'account', v_debt_account));
      END IF;
      v_total_debts := v_total_debts + v_debt_amount;
      v_debt_index := v_debt_index + 1;
    END LOOP;
  END IF;

  -- A payout is the invoices less the fees the provider withheld, plus the
  -- customer receivable from before that the row also pays; a payment is the
  -- invoices plus the fees the bank charged on top, plus the supplier debt
  -- from before that the row also pays.
  v_net_settled := CASE WHEN v_has_customer THEN v_total_allocated - v_total_fees + v_total_debts
                        ELSE v_total_allocated + v_total_fees + v_total_debts END;

  IF v_net_settled > v_tx_abs + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_AMOUNT_EXCEEDS_TX',
      'details', jsonb_build_object('allocated', v_total_allocated, 'fees', v_total_fees, 'debts', v_total_debts, 'tx_amount_abs', v_tx_abs));
  END IF;
  IF v_net_settled < v_tx_abs - 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_AMOUNT_BELOW_TX',
      'details', jsonb_build_object('allocated', v_total_allocated, 'fees', v_total_fees, 'debts', v_total_debts, 'tx_amount_abs', v_tx_abs));
  END IF;

  IF v_has_customer AND v_tx.amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_DIRECTION_MISMATCH',
      'details', jsonb_build_object('expected', 'income', 'tx_amount', v_tx.amount));
  END IF;
  IF v_has_supplier AND v_tx.amount >= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_DIRECTION_MISMATCH',
      'details', jsonb_build_object('expected', 'expense', 'tx_amount', v_tx.amount));
  END IF;

  SELECT id, is_closed, locked_at INTO v_fiscal_period_id, v_period_is_closed, v_period_locked_at
  FROM public.fiscal_periods
  WHERE company_id = p_company_id AND v_tx.date BETWEEN period_start AND period_end
  ORDER BY period_start DESC LIMIT 1;
  IF v_fiscal_period_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_NO_FISCAL_PERIOD',
      'details', jsonb_build_object('tx_date', v_tx.date));
  END IF;
  IF v_period_is_closed OR v_period_locked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_PERIOD_LOCKED',
      'details', jsonb_build_object('fiscal_period_id', v_fiscal_period_id,
        'is_closed', v_period_is_closed, 'locked_at', v_period_locked_at));
  END IF;

  -- One invoice: the header names it in the single-invoice match routes'
  -- wording (app/api/transactions/[id]/match-invoice and
  -- match-supplier-invoice), the name part left off when there is none.
  -- The customer invoice number is the one shown everywhere
  -- (invoiceDisplayNumber, lib/invoices/display.ts): a self-billed invoice
  -- has no own number, so its external_invoice_number. Two or more, or one
  -- with a row from before beside it (20261120150000, 20261124100000), keep
  -- the samlingsverifikation wording.
  IF jsonb_array_length(p_allocations) = 1 AND v_total_debts = 0 THEN
    IF v_has_customer THEN
      SELECT COALESCE(i.invoice_number, i.external_invoice_number), c.name
        INTO v_invoice_number, v_counterparty_name
      FROM public.invoices i LEFT JOIN public.customers c ON c.id = i.customer_id
      WHERE i.id = (p_allocations->0->>'invoice_id')::uuid AND i.company_id = p_company_id;
      v_entry_description := 'Inbetalning kundfaktura'
        || COALESCE(' ' || NULLIF(v_invoice_number, ''), '')
        || COALESCE(', ' || NULLIF(v_counterparty_name, ''), '');
    ELSE
      SELECT si.supplier_invoice_number, s.name INTO v_supplier_invoice_number, v_counterparty_name
      FROM public.supplier_invoices si LEFT JOIN public.suppliers s ON s.id = si.supplier_id
      WHERE si.id = (p_allocations->0->>'supplier_invoice_id')::uuid AND si.company_id = p_company_id;
      v_entry_description := 'Utbetalning leverantörsfaktura'
        || COALESCE(' ' || NULLIF(v_supplier_invoice_number, ''), '')
        || COALESCE(', ' || NULLIF(v_counterparty_name, ''), '');
    END IF;
  ELSE
    v_entry_description := CASE WHEN v_has_customer THEN 'Samlingsinbetalning ' || v_tx_date_short ELSE 'Samlingsbetalning ' || v_tx_date_short END;
  END IF;
  -- invoice_cash_payment: the source type the single cash match books, which
  -- the kontantmetod cut-off and the ROT/RUT payout recognition read.
  v_source_type := CASE WHEN v_cash_count > 0 THEN 'invoice_cash_payment'
                        WHEN v_has_customer THEN 'invoice_paid' ELSE 'supplier_invoice_paid' END;

  -- Voucher series: the company's default for this source_type, 'A' when
  -- there is no settings row, no key or no single A-Z letter. The rule
  -- createDraftEntry applies to every engine write
  -- (resolveDefaultSeriesForSource, lib/bookkeeping/voucher-series-resolver.ts).
  SELECT cs.default_voucher_series_per_source_type ->> v_source_type
    INTO v_series_raw
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  IF v_series_raw ~ '^[A-Z]$' THEN
    v_voucher_series := v_series_raw;
  END IF;

  v_bank_context := public.capture_bank_booking_context(p_company_id, ARRAY[p_tx_id]);
  v_bank_account := v_bank_context #>> '{0,settlement_account}';

  INSERT INTO public.journal_entries
    (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, status, bank_booking_context)
  VALUES
    (v_journal_entry_id, v_caller, p_company_id, v_fiscal_period_id, 0, v_voucher_series,
     v_tx.date, v_entry_description, v_source_type, 'draft', v_bank_context);

  -- The posting port's events: sale.payment_received or
  -- purchase.paid, one per allocation. Linked to the draft
  -- before commit_journal_entry draws its number (20261018210000).
  PERFORM public.link_business_events_to_draft(
    p_company_id, v_journal_entry_id, p_event_ids, 'produced', p_event_mode);

  v_alloc_index := 0;
  FOR v_allocation IN
    SELECT value FROM jsonb_array_elements(p_allocations) AS t(value)
    ORDER BY COALESCE(value->>'invoice_id', value->>'supplier_invoice_id', '')
  LOOP
    v_alloc_amount := (v_allocation->>'amount')::numeric;

    IF v_has_customer THEN
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;
      SELECT invoice_number, currency, exchange_rate, remaining_amount, total,
             public.coerce_dimensions_bag(default_dimensions), journal_entry_id
        INTO v_invoice_number, v_inv_currency, v_inv_fx_rate, v_inv_remaining, v_inv_total,
             v_doc_dims, v_inv_journal_entry_id
      FROM public.invoices
      WHERE id = v_invoice_id AND company_id = p_company_id;
      v_inv_remaining := COALESCE(v_inv_remaining, v_inv_total);
      v_inv_currency := COALESCE(v_inv_currency, 'SEK');
      v_inv_number_short := LEFT(COALESCE(v_invoice_number, ''), 32);

      IF v_cash_count > 0 THEN
        -- Kontantmetoden: the invoice's revenue, moms and öresavrundning
        -- lines as planned, each with its own dimensions (the invoice's bag
        -- merged per item by the builder), else the invoice's bag.
        FOR v_cash_line IN
          SELECT value FROM jsonb_array_elements(p_cash_lines -> v_invoice_id::text) WITH ORDINALITY AS t(value, n)
          ORDER BY n
        LOOP
          INSERT INTO public.journal_entry_lines
            (journal_entry_id, account_number, debit_amount, credit_amount, currency,
             sort_order, line_description, dimensions)
          VALUES
            (v_journal_entry_id, v_cash_line->>'account_number',
             (v_cash_line->>'debit_amount')::numeric, (v_cash_line->>'credit_amount')::numeric,
             'SEK', v_line_sort_order,
             LEFT(COALESCE(NULLIF(BTRIM(v_cash_line->>'line_description'), ''), 'Faktura ' || v_inv_number_short), 200),
             CASE WHEN jsonb_typeof(v_cash_line->'dimensions') = 'object'
               THEN public.coerce_dimensions_bag(v_cash_line->'dimensions') ELSE v_doc_dims END);
          v_line_sort_order := v_line_sort_order + 1;
        END LOOP;
      ELSIF v_inv_currency = 'SEK' THEN
        -- #1717: inside the öresavrundning band, clear the FULL remaining off
        -- 1510 so the invoice reaches 'paid' and let 3740 carry the residual.
        -- Customer short-paid = Dr 3740 (förlust); over-paid = Cr 3740
        -- (vinst), same polarity as buildInvoicePaymentClearingLines. The
        -- bank leg (tx_abs) is unchanged, so the entry stays balanced: the
        -- net credit of 1510 + 3740 equals the allocation exactly.
        v_ore_diff := public.ore_settlement_residual(v_inv_remaining, v_alloc_amount);
        -- 20261119090000: the öresavrundning the invoice's own verifikat
        -- already booked (1510 at the rounded "Att betala", the öre on 3740):
        -- the remainder less what 1510 carries, inside the öre band, else 0
        -- (bookedOreRounding over carriedSekOf). Read only on a settlement in
        -- full of an invoice with a verifikat and öre in its remainder or its
        -- total (hasOreToRound, 20261127121500): the total too, since a part
        -- payment can leave whole kronor open while 1510 still carries the
        -- issue's öre. 1510 then gives up what it carries and 3740 takes
        -- only the rest of the öre, so the rounding is not booked twice; a
        -- part allocation clears its own kronor.
        v_booked_ore := 0;
        IF (v_ore_diff <> 0 OR ROUND(v_alloc_amount, 2) = ROUND(v_inv_remaining, 2))
           AND v_inv_journal_entry_id IS NOT NULL
           AND ROUND(v_inv_remaining, 2) > 0.005
           AND (ROUND(v_inv_remaining, 2) <> TRUNC(ROUND(v_inv_remaining, 2))
                OR ROUND(COALESCE(v_inv_total, 0), 2) <> TRUNC(ROUND(COALESCE(v_inv_total, 0), 2))) THEN
          v_carried := public.document_carried_sek(p_company_id, 'customer', v_invoice_id);
          IF (v_carried ->> 'ok')::boolean THEN
            v_booked_ore := public.ore_settlement_residual(v_inv_remaining, (v_carried ->> 'sek')::numeric);
          END IF;
        END IF;
        IF v_ore_diff <> 0 OR v_booked_ore <> 0 THEN
          v_ore_diff := v_ore_diff - v_booked_ore;
          INSERT INTO public.journal_entry_lines
            (journal_entry_id, account_number, debit_amount, credit_amount, currency,
             sort_order, line_description, dimensions)
          VALUES
            (v_journal_entry_id, '1510', 0, ROUND(v_inv_remaining * 100) / 100 - v_booked_ore, 'SEK', v_line_sort_order,
             'Faktura ' || v_inv_number_short, v_doc_dims);
          v_line_sort_order := v_line_sort_order + 1;
          IF v_ore_diff > 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3740', v_ore_diff, 0, 'SEK', v_line_sort_order,
               'Öresavrundning', v_doc_dims);
            v_line_sort_order := v_line_sort_order + 1;
          ELSIF v_ore_diff < 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3740', 0, ABS(v_ore_diff), 'SEK', v_line_sort_order,
               'Öresavrundning', v_doc_dims);
            v_line_sort_order := v_line_sort_order + 1;
          END IF;
        ELSE
          INSERT INTO public.journal_entry_lines
            (journal_entry_id, account_number, debit_amount, credit_amount, currency,
             sort_order, line_description, dimensions)
          VALUES
            (v_journal_entry_id, '1510', 0, v_alloc_amount, 'SEK', v_line_sort_order,
             'Faktura ' || v_inv_number_short, v_doc_dims);
          v_line_sort_order := v_line_sort_order + 1;
        END IF;
      ELSE
        v_booked_sek := public.document_clearing_sek(p_company_id, 'customer', v_invoice_id, v_inv_remaining, v_inv_fx_rate);
        v_fx_diff := ROUND((v_booked_sek - v_alloc_amount) * 100) / 100;

        INSERT INTO public.journal_entry_lines
          (journal_entry_id, account_number, debit_amount, credit_amount, currency,
           sort_order, line_description, dimensions)
        VALUES
          (v_journal_entry_id, '1510', 0, v_booked_sek, 'SEK', v_line_sort_order,
           'Faktura ' || v_inv_number_short || ' (' || v_inv_currency || ')', v_doc_dims);
        v_line_sort_order := v_line_sort_order + 1;

        IF ABS(v_fx_diff) > 0.005 THEN
          IF v_fx_diff > 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '7960', v_fx_diff, 0, 'SEK', v_line_sort_order,
               'Valutakursförlust ' || v_inv_number_short, v_doc_dims);
          ELSE
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3960', 0, ABS(v_fx_diff), 'SEK', v_line_sort_order,
               'Valutakursvinst ' || v_inv_number_short, v_doc_dims);
          END IF;
          v_line_sort_order := v_line_sort_order + 1;
        END IF;
      END IF;

    ELSE
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;
      SELECT si.supplier_invoice_number, s.name, si.currency, si.exchange_rate,
             si.remaining_amount, si.total,
             public.coerce_dimensions_bag(si.default_dimensions)
        INTO v_supplier_invoice_number, v_supplier_name, v_inv_currency, v_inv_fx_rate,
             v_inv_remaining, v_inv_total, v_doc_dims
      FROM public.supplier_invoices si LEFT JOIN public.suppliers s ON s.id = si.supplier_id
      WHERE si.id = v_supplier_invoice_id AND si.company_id = p_company_id;
      v_inv_remaining := COALESCE(v_inv_remaining, v_inv_total);
      v_inv_number_short := LEFT(COALESCE(v_supplier_invoice_number, ''), 32);

      IF v_inv_currency = 'SEK' THEN
        -- #1717: supplier mirror of the customer branch above. Clear the FULL
        -- remaining off 2440; polarity per buildSupplierPaymentClearingLines:
        -- bank paid less than owed = Cr 3740 (vinst), more = Dr 3740
        -- (förlust).
        v_ore_diff := public.ore_settlement_residual(v_inv_remaining, v_alloc_amount);
        IF v_ore_diff <> 0 THEN
          INSERT INTO public.journal_entry_lines
            (journal_entry_id, account_number, debit_amount, credit_amount, currency,
             sort_order, line_description, dimensions)
          VALUES
            (v_journal_entry_id, '2440', ROUND(v_inv_remaining * 100) / 100, 0, 'SEK', v_line_sort_order,
             TRIM(BOTH ' - ' FROM COALESCE(v_supplier_name, '') || ' - ' || v_inv_number_short), v_doc_dims);
          v_line_sort_order := v_line_sort_order + 1;
          IF v_ore_diff > 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3740', 0, v_ore_diff, 'SEK', v_line_sort_order,
               'Öresavrundning', v_doc_dims);
          ELSE
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3740', ABS(v_ore_diff), 0, 'SEK', v_line_sort_order,
               'Öresavrundning', v_doc_dims);
          END IF;
          v_line_sort_order := v_line_sort_order + 1;
        ELSE
          INSERT INTO public.journal_entry_lines
            (journal_entry_id, account_number, debit_amount, credit_amount, currency,
             sort_order, line_description, dimensions)
          VALUES
            (v_journal_entry_id, '2440', v_alloc_amount, 0, 'SEK', v_line_sort_order,
             TRIM(BOTH ' - ' FROM COALESCE(v_supplier_name, '') || ' - ' || v_inv_number_short), v_doc_dims);
          v_line_sort_order := v_line_sort_order + 1;
        END IF;
      ELSE
        v_booked_sek := public.document_clearing_sek(p_company_id, 'supplier', v_supplier_invoice_id, v_inv_remaining, v_inv_fx_rate);
        v_fx_diff := ROUND((v_booked_sek - v_alloc_amount) * 100) / 100;

        INSERT INTO public.journal_entry_lines
          (journal_entry_id, account_number, debit_amount, credit_amount, currency,
           sort_order, line_description, dimensions)
        VALUES
          (v_journal_entry_id, '2440', v_booked_sek, 0, 'SEK', v_line_sort_order,
           TRIM(BOTH ' - ' FROM
             COALESCE(v_supplier_name, '') || ' - ' || v_inv_number_short
             || ' (' || v_inv_currency || ')'), v_doc_dims);
        v_line_sort_order := v_line_sort_order + 1;

        IF ABS(v_fx_diff) > 0.005 THEN
          IF v_fx_diff > 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3960', 0, v_fx_diff, 'SEK', v_line_sort_order,
               'Valutakursvinst ' || v_inv_number_short, v_doc_dims);
          ELSE
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '7960', ABS(v_fx_diff), 0, 'SEK', v_line_sort_order,
               'Valutakursförlust ' || v_inv_number_short, v_doc_dims);
          END IF;
          v_line_sort_order := v_line_sort_order + 1;
        END IF;
      END IF;
    END IF;
    -- The bank leg below settles every allocation at once, so it carries a
    -- bag only when all settled documents carry the same one (a single
    -- allocation always does); documents with different bags leave it
    -- untagged. Every other line above belongs to exactly one document.
    IF v_alloc_index = 0 THEN
      v_bank_dims := v_doc_dims;
    ELSIF v_bank_dims IS DISTINCT FROM v_doc_dims THEN
      v_bank_dims := '{}'::jsonb;
    END IF;
    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  -- The fee rows, a debit each on both sides (withheld from a payout, or
  -- added to a payment), in the order given, before the bank leg. Their text
  -- is the request's, else the single-invoice fee line's. A fee belongs to
  -- the row as a whole, so it carries the bank leg's bag.
  IF v_total_fees > 0 THEN
    FOR v_fee IN
      SELECT value FROM jsonb_array_elements(p_fee_lines) WITH ORDINALITY AS t(value, n) ORDER BY n
    LOOP
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description, dimensions)
      VALUES
        (v_journal_entry_id, v_fee->>'account', (v_fee->>'amount')::numeric, 0, 'SEK', v_line_sort_order,
         LEFT(COALESCE(NULLIF(BTRIM(v_fee->>'description'), ''), 'Avgift betaltjänst'), 100), v_bank_dims);
      v_line_sort_order := v_line_sort_order + 1;
    END LOOP;
  END IF;

  -- The rows from before (20261120150000, 20261124100000), in the order
  -- given, after the fee rows and before the bank leg: on a supplier batch a
  -- debit each on the 244x skuld, on a customer batch a credit each on the
  -- 151x fordran. Their text is the request's, else the side's default. The
  -- row belongs to none of the settled documents, so it carries no dimensions.
  IF v_total_debts > 0 THEN
    FOR v_debt IN
      SELECT value FROM jsonb_array_elements(p_debt_lines) WITH ORDINALITY AS t(value, n) ORDER BY n
    LOOP
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description, dimensions)
      VALUES
        (v_journal_entry_id, v_debt->>'account',
         CASE WHEN v_has_customer THEN 0 ELSE (v_debt->>'amount')::numeric END,
         CASE WHEN v_has_customer THEN (v_debt->>'amount')::numeric ELSE 0 END,
         'SEK', v_line_sort_order,
         LEFT(COALESCE(NULLIF(BTRIM(v_debt->>'description'), ''),
           CASE WHEN v_has_customer THEN 'Kundfordran från tidigare bokföring'
                ELSE 'Leverantörsskuld från tidigare bokföring' END), 100),
         '{}'::jsonb);
      v_line_sort_order := v_line_sort_order + 1;
    END LOOP;
  END IF;

  IF v_has_customer THEN
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency,
       sort_order, line_description, dimensions)
    VALUES
      (v_journal_entry_id, v_bank_account, v_tx_abs, 0, 'SEK', v_line_sort_order,
       'Inbetalning ' || v_tx_date_short, v_bank_dims);
  ELSE
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency,
       sort_order, line_description, dimensions)
    VALUES
      (v_journal_entry_id, v_bank_account, 0, v_tx_abs, 'SEK', v_line_sort_order,
       'Utbetalning ' || v_tx_date_short, v_bank_dims);
  END IF;

  -- WHO: the actor the application door passes (commitMatchBatchAllocation),
  -- stamped by commit_journal_entry like any other commit.
  SELECT voucher_number INTO v_voucher_number FROM public.commit_journal_entry(p_company_id, v_journal_entry_id, NULL, NULL, p_actor_type, p_actor_label);

  v_alloc_index := 0;
  FOR v_allocation IN
    SELECT value FROM jsonb_array_elements(p_allocations) AS t(value)
    ORDER BY COALESCE(value->>'invoice_id', value->>'supplier_invoice_id', '')
  LOOP
    v_alloc_amount := (v_allocation->>'amount')::numeric;

    IF v_has_customer THEN
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;
      SELECT * INTO v_invoice FROM public.invoices
      WHERE id = v_invoice_id AND company_id = p_company_id;

      IF COALESCE(v_invoice.currency, 'SEK') = 'SEK' THEN
        -- #1717: inside the öresavrundning band the invoice settles in full
        -- (the 3740 line carries the difference), so the payment records the
        -- FULL remaining: paid_amount accumulates it, remaining lands on 0
        -- and the status flips to 'paid'. Same convention as
        -- planInvoicePayment.
        v_inv_remaining := ROUND(COALESCE(v_invoice.remaining_amount, v_invoice.total) * 100) / 100;
        IF public.ore_settlement_residual(v_inv_remaining, v_alloc_amount) <> 0 THEN
          v_paid_in_inv_currency := v_inv_remaining;
        ELSE
          v_paid_in_inv_currency := v_alloc_amount;
        END IF;
        v_payment_rate := NULL;        -- same-currency: no FX context
      ELSE
        v_paid_in_inv_currency := COALESCE(v_invoice.remaining_amount, v_invoice.total);
        -- Round-3: effective payment-day rate. SEK_paid / foreign_remaining.
        IF v_paid_in_inv_currency > 0 THEN
          v_payment_rate := ROUND((v_alloc_amount / v_paid_in_inv_currency) * 1000000) / 1000000;
        ELSE
          v_payment_rate := NULL;
        END IF;
      END IF;

      v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_paid_in_inv_currency) * 100) / 100;
      v_new_remaining := GREATEST(0,
        ROUND((COALESCE(v_invoice.remaining_amount, v_invoice.total) - v_paid_in_inv_currency) * 100) / 100);
      v_new_status := CASE WHEN v_new_remaining <= 0.005 THEN 'paid' ELSE 'partially_paid' END;

      UPDATE public.invoices SET status = v_new_status,
        paid_at = CASE WHEN v_new_status = 'paid' THEN
          ((v_tx.date::timestamp + interval '12 hours') AT TIME ZONE 'UTC')
        ELSE paid_at END,
        paid_amount = v_new_paid, remaining_amount = v_new_remaining, updated_at = v_now
      WHERE id = v_invoice_id AND company_id = p_company_id;

      INSERT INTO public.invoice_payments
        (user_id, company_id, invoice_id, payment_date, amount, currency, exchange_rate,
         payment_exchange_rate, journal_entry_id, transaction_id, link_basis, link_evidence)
      VALUES
        (v_caller, p_company_id, v_invoice_id, v_tx.date, v_paid_in_inv_currency, v_invoice.currency,
         v_invoice.exchange_rate, v_payment_rate, v_journal_entry_id, p_tx_id,
         public.resolve_link_basis('user_confirmed', p_actor_type), NULL)
      RETURNING id INTO v_payment_id;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'kind', 'customer_invoice', 'invoice_id', v_invoice_id, 'payment_id', v_payment_id,
        'status', v_new_status, 'paid_amount', v_new_paid, 'remaining_amount', v_new_remaining,
        'amount', v_alloc_amount,
        'cross_currency', COALESCE(v_invoice.currency, 'SEK') <> 'SEK'));
    ELSE
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;
      SELECT * INTO v_si_invoice FROM public.supplier_invoices
      WHERE id = v_supplier_invoice_id AND company_id = p_company_id;

      IF v_si_invoice.currency = 'SEK' THEN
        -- #1717: supplier mirror of the customer branch above.
        v_inv_remaining := ROUND(COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total) * 100) / 100;
        IF public.ore_settlement_residual(v_inv_remaining, v_alloc_amount) <> 0 THEN
          v_paid_in_inv_currency := v_inv_remaining;
        ELSE
          v_paid_in_inv_currency := v_alloc_amount;
        END IF;
        v_payment_rate := NULL;
      ELSE
        v_paid_in_inv_currency := COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total);
        IF v_paid_in_inv_currency > 0 THEN
          v_payment_rate := ROUND((v_alloc_amount / v_paid_in_inv_currency) * 1000000) / 1000000;
        ELSE
          v_payment_rate := NULL;
        END IF;
      END IF;

      v_new_paid := ROUND((COALESCE(v_si_invoice.paid_amount, 0) + v_paid_in_inv_currency) * 100) / 100;
      v_new_remaining := GREATEST(0,
        ROUND((COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total) - v_paid_in_inv_currency) * 100) / 100);
      v_new_status := CASE WHEN v_new_remaining <= 0.005 THEN 'paid' ELSE 'partially_paid' END;

      UPDATE public.supplier_invoices SET status = v_new_status,
        paid_at = CASE WHEN v_new_status = 'paid' THEN
          ((v_tx.date::timestamp + interval '12 hours') AT TIME ZONE 'UTC')
        ELSE paid_at END,
        paid_amount = v_new_paid, remaining_amount = v_new_remaining,
        payment_journal_entry_id = v_journal_entry_id, updated_at = v_now
      WHERE id = v_supplier_invoice_id AND company_id = p_company_id;

      INSERT INTO public.supplier_invoice_payments
        (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, exchange_rate,
         payment_exchange_rate, journal_entry_id, transaction_id, link_basis, link_evidence)
      VALUES
        (v_caller, p_company_id, v_supplier_invoice_id, v_tx.date, v_paid_in_inv_currency,
         v_si_invoice.currency, v_si_invoice.exchange_rate, v_payment_rate, v_journal_entry_id, p_tx_id,
         public.resolve_link_basis('user_confirmed', p_actor_type), NULL)
      RETURNING id INTO v_payment_id;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'kind', 'supplier_invoice', 'supplier_invoice_id', v_supplier_invoice_id,
        'payment_id', v_payment_id, 'status', v_new_status, 'paid_amount', v_new_paid,
        'remaining_amount', v_new_remaining, 'amount', v_alloc_amount,
        'cross_currency', v_si_invoice.currency <> 'SEK'));
    END IF;
    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  UPDATE public.transactions SET journal_entry_id = v_journal_entry_id, is_business = TRUE,
    reconciliation_method = NULL,
    link_basis = public.resolve_link_basis('user_confirmed', p_actor_type), link_evidence = NULL,
    invoice_id = CASE WHEN jsonb_array_length(p_allocations) = 1 AND v_has_customer AND ABS(v_net_settled - v_tx_abs) < 0.005
           AND v_total_debts = 0
      THEN (p_allocations->0->>'invoice_id')::uuid ELSE NULL END,
    supplier_invoice_id = CASE WHEN jsonb_array_length(p_allocations) = 1 AND v_has_supplier AND ABS(v_net_settled - v_tx_abs) < 0.005
           AND v_total_debts = 0
      THEN (p_allocations->0->>'supplier_invoice_id')::uuid ELSE NULL END,
    potential_invoice_id = NULL, potential_supplier_invoice_id = NULL,
    updated_at = v_now WHERE id = p_tx_id AND company_id = p_company_id;

  RETURN jsonb_build_object('ok', true, 'journal_entry_id', v_journal_entry_id,
    'voucher_series', v_voucher_series, 'voucher_number', v_voucher_number,
    'tx_id', p_tx_id, 'allocations', v_results, 'total_allocated', v_total_allocated,
    'total_fees', v_total_fees, 'total_debts', v_total_debts, 'cash_method', v_cash_count > 0, 'leftover', 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.book_counterparty_setoff(
  p_company_id uuid,
  p_setoff_id uuid,
  p_invoice_id uuid,
  p_supplier_invoice_id uuid,
  p_amount numeric,
  p_setoff_date date,
  p_note text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL,
  p_event_ids uuid[] DEFAULT NULL,
  p_event_mode text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_inv RECORD;
  v_si RECORD;
  v_inv_party uuid;
  v_si_party uuid;
  v_inv_remaining numeric;
  v_si_remaining numeric;
  v_ore numeric;
  v_inv_applied numeric;
  v_carried jsonb;            -- document_carried_sek for the customer invoice
  v_booked_ore numeric := 0;  -- öresavrundning its issue verifikat booked (bookedOreRounding)
  v_receivable_cleared numeric; -- what the set-off credits 151x
  v_receivable text;
  v_payable text;
  v_fiscal_period_id uuid;
  v_period_is_closed boolean;
  v_period_locked_at timestamptz;
  v_lock_date date;
  v_series_raw text;
  v_series text := 'A';
  v_entry_id uuid := gen_random_uuid();
  v_voucher_number int;
  v_inv_number text;
  v_si_number text;
  v_counterparty text;
  v_description text;
  v_inv_dims jsonb;
  v_si_dims jsonb;
  v_inv_new_paid numeric;
  v_inv_new_remaining numeric;
  v_inv_new_status text;
  v_si_new_paid numeric;
  v_si_new_remaining numeric;
  v_si_new_status text;
  v_inv_payment_id uuid;
  v_si_payment_id uuid;
  v_paid_at timestamptz;
  v_now timestamptz := now();
  v_today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role <> 'viewer'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_FORBIDDEN');
  END IF;

  IF p_setoff_id IS NULL OR p_invoice_id IS NULL OR p_supplier_invoice_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVALID_REQUEST');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVALID_AMOUNT',
      'details', jsonb_build_object('amount', p_amount));
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVALID_REQUEST',
      'details', jsonb_build_object('field', 'note'));
  END IF;

  -- The invoice first, then the supplier invoice: every caller locks in this order.
  SELECT * INTO v_inv FROM public.invoices
    WHERE id = p_invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_FOUND',
      'details', jsonb_build_object('invoice_id', p_invoice_id));
  END IF;
  SELECT * INTO v_si FROM public.supplier_invoices
    WHERE id = p_supplier_invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_SUPPLIER_INVOICE_NOT_FOUND',
      'details', jsonb_build_object('supplier_invoice_id', p_supplier_invoice_id));
  END IF;

  IF COALESCE(v_inv.document_type, 'invoice') <> 'invoice' OR v_inv.credited_invoice_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_ELIGIBLE',
      'details', jsonb_build_object('invoice_id', p_invoice_id, 'document_type', v_inv.document_type));
  END IF;
  IF COALESCE(v_si.is_credit_note, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_SUPPLIER_INVOICE_NOT_ELIGIBLE',
      'details', jsonb_build_object('supplier_invoice_id', p_supplier_invoice_id));
  END IF;
  IF v_inv.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_OPEN',
      'details', jsonb_build_object('invoice_id', p_invoice_id, 'status', v_inv.status));
  END IF;
  IF v_si.status NOT IN ('registered', 'approved', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_SUPPLIER_INVOICE_NOT_OPEN',
      'details', jsonb_build_object('supplier_invoice_id', p_supplier_invoice_id, 'status', v_si.status));
  END IF;
  IF COALESCE(v_inv.currency, 'SEK') <> 'SEK' OR COALESCE(v_si.currency, 'SEK') <> 'SEK' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_CURRENCY_UNSUPPORTED',
      'details', jsonb_build_object('invoice_currency', v_inv.currency, 'supplier_invoice_currency', v_si.currency));
  END IF;
  IF COALESCE(v_inv.deduction_total, 0) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_DEDUCTION_UNSUPPORTED',
      'details', jsonb_build_object('invoice_id', p_invoice_id));
  END IF;
  IF v_inv.journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_BOOKED',
      'details', jsonb_build_object('side', 'customer', 'invoice_id', p_invoice_id));
  END IF;
  IF v_si.registration_journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_BOOKED',
      'details', jsonb_build_object('side', 'supplier', 'supplier_invoice_id', p_supplier_invoice_id));
  END IF;

  SELECT public.canonical_party_id(c.party_id) INTO v_inv_party
    FROM public.customers c WHERE c.id = v_inv.customer_id AND c.company_id = p_company_id;
  SELECT public.canonical_party_id(s.party_id) INTO v_si_party
    FROM public.suppliers s WHERE s.id = v_si.supplier_id AND s.company_id = p_company_id;
  IF v_inv_party IS NULL OR v_si_party IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_NO_PARTY',
      'details', jsonb_build_object('customer_party', v_inv_party IS NOT NULL, 'supplier_party', v_si_party IS NOT NULL));
  END IF;
  IF v_inv_party <> v_si_party THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_PARTY_MISMATCH');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.collection_cases cc
    WHERE cc.company_id = p_company_id AND cc.invoice_id = p_invoice_id AND cc.is_open
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_COLLECTION_OPEN',
      'details', jsonb_build_object('invoice_id', p_invoice_id));
  END IF;

  -- A payment the bank may still carry out for the full amount: entered at
  -- the bank, in a payment file not cancelled, or in an open payment order
  -- (isOpenPaymentOrder, lib/payments/orders/status.ts).
  IF v_si.bank_entered_at IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM public.supplier_payment_batch_items bi
         JOIN public.supplier_payment_batches b ON b.id = bi.batch_id AND b.company_id = bi.company_id
        WHERE bi.company_id = p_company_id
          AND bi.supplier_invoice_id = p_supplier_invoice_id
          AND b.status = 'created'
     )
     OR EXISTS (
       SELECT 1 FROM public.payment_orders po
        WHERE po.company_id = p_company_id
          AND po.supplier_invoice_id = p_supplier_invoice_id
          AND (po.status IN ('draft', 'approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted')
               OR (po.status = 'executed' AND po.supplier_invoice_payment_id IS NULL))
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_PAYMENT_IN_FLIGHT',
      'details', jsonb_build_object('supplier_invoice_id', p_supplier_invoice_id));
  END IF;

  v_inv_remaining := round(COALESCE(v_inv.remaining_amount, v_inv.total), 2);
  v_si_remaining := round(COALESCE(v_si.remaining_amount, v_si.total), 2);
  -- crm#1644: a set-off within a krona of what the customer invoice still
  -- owes settles it in full and 3740 carries the gap (öresavrundning), the
  -- rule of match_batch_allocate and planSetoff (oreSettlementResidual). Both
  -- invoices are SEK here. The supplier side stays exact: its rounding is an
  -- item inside its total.
  v_ore := public.ore_settlement_residual(v_inv_remaining, p_amount);
  v_inv_applied := CASE WHEN v_ore <> 0 THEN v_inv_remaining ELSE p_amount END;
  IF (p_amount > v_inv_remaining AND v_ore = 0) OR p_amount > v_si_remaining THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_AMOUNT_EXCEEDS_REMAINING',
      'details', jsonb_build_object('amount', p_amount,
        'invoice_remaining', v_inv_remaining, 'supplier_invoice_remaining', v_si_remaining));
  END IF;
  -- The öresavrundning the invoice's own verifikat already booked (1510 at
  -- the rounded "Att betala", the öre on 3740): the remainder less what 1510
  -- carries, inside the öre band, else 0 (bookedOreRounding over
  -- carriedSekOf, the rule match_batch_allocate reads since 20261119090000).
  -- Read only on a set-off that settles the invoice in full and has öre in
  -- its remainder or its total (hasOreToRound, 20261127121500): the total
  -- too, since a part set-off or payment can leave whole kronor open while
  -- 151x still carries the issue's öre. 151x then gives up what it carries and
  -- 3740 takes only the rest of the öre, so the rounding is not booked twice
  -- and 151x ends at zero; a part set-off clears its own kronor. The invoice
  -- still settles its whole remainder (v_inv_applied).
  IF (v_ore <> 0 OR p_amount = v_inv_remaining)
     AND v_inv_remaining > 0.005
     AND (v_inv_remaining <> trunc(v_inv_remaining)
          OR round(COALESCE(v_inv.total, 0), 2) <> trunc(round(COALESCE(v_inv.total, 0), 2))) THEN
    v_carried := public.document_carried_sek(p_company_id, 'customer', p_invoice_id);
    IF (v_carried ->> 'ok')::boolean THEN
      v_booked_ore := public.ore_settlement_residual(v_inv_remaining, (v_carried ->> 'sek')::numeric);
    END IF;
  END IF;
  v_receivable_cleared := round(v_inv_applied - v_booked_ore, 2);
  v_ore := round(v_ore - v_booked_ore, 2);

  IF p_setoff_date IS NULL OR p_setoff_date > v_today THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_DATE_INVALID',
      'details', jsonb_build_object('reason', 'future', 'setoff_date', p_setoff_date));
  END IF;
  IF p_setoff_date < v_inv.invoice_date OR p_setoff_date < v_si.invoice_date THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_DATE_INVALID',
      'details', jsonb_build_object('reason', 'before_invoice', 'setoff_date', p_setoff_date));
  END IF;

  SELECT fp.id, fp.is_closed, fp.locked_at INTO v_fiscal_period_id, v_period_is_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.company_id = p_company_id AND p_setoff_date BETWEEN fp.period_start AND fp.period_end
   ORDER BY fp.period_start DESC LIMIT 1;
  IF v_fiscal_period_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_NO_FISCAL_PERIOD',
      'details', jsonb_build_object('setoff_date', p_setoff_date));
  END IF;
  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs WHERE cs.company_id = p_company_id;
  IF v_period_is_closed OR v_period_locked_at IS NOT NULL
     OR (v_lock_date IS NOT NULL AND p_setoff_date <= v_lock_date) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_PERIOD_LOCKED',
      'details', jsonb_build_object('setoff_date', p_setoff_date, 'fiscal_period_id', v_fiscal_period_id,
        'locked_through', v_lock_date));
  END IF;

  SELECT l.account_number INTO v_receivable
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
   WHERE je.id = v_inv.journal_entry_id
     AND je.company_id = p_company_id
     AND je.status = 'posted'
     AND l.account_number ~ '^151[0-9]$'
     AND l.account_number NOT IN ('1513', '1519')
     AND l.debit_amount > 0
   ORDER BY l.debit_amount DESC, l.account_number
   LIMIT 1;
  IF v_receivable IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_LEDGER_MISMATCH',
      'details', jsonb_build_object('side', 'customer', 'journal_entry_id', v_inv.journal_entry_id));
  END IF;
  SELECT l.account_number INTO v_payable
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
   WHERE je.id = v_si.registration_journal_entry_id
     AND je.company_id = p_company_id
     AND je.status = 'posted'
     AND l.account_number ~ '^244[0-9]$'
     AND l.credit_amount > 0
   ORDER BY l.credit_amount DESC, l.account_number
   LIMIT 1;
  IF v_payable IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_LEDGER_MISMATCH',
      'details', jsonb_build_object('side', 'supplier', 'journal_entry_id', v_si.registration_journal_entry_id));
  END IF;

  -- Voucher series: the company's default for counterparty_setoff, 'A' when
  -- there is no settings row, no key or no single A-Z letter (the rule of
  -- resolveDefaultSeriesForSource, lib/bookkeeping/voucher-series-resolver.ts).
  SELECT cs.default_voucher_series_per_source_type ->> 'counterparty_setoff'
    INTO v_series_raw
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;
  IF v_series_raw ~ '^[A-Z]$' THEN
    v_series := v_series_raw;
  END IF;

  -- The numbers shown everywhere: a self-billed sale has no own number, so its
  -- external_invoice_number (invoiceDisplayNumber, lib/invoices/display.ts);
  -- a supplier invoice without a printed number is named by its löpnummer.
  v_inv_number := COALESCE(NULLIF(v_inv.invoice_number, ''), NULLIF(v_inv.external_invoice_number, ''), '');
  v_si_number := COALESCE(NULLIF(v_si.supplier_invoice_number, ''), 'ankomstnr ' || v_si.arrival_number::text);
  SELECT c.name INTO v_counterparty FROM public.customers c WHERE c.id = v_inv.customer_id;
  v_description := left(
    'Kvittning kundfaktura ' || v_inv_number || ' mot leverantörsfaktura ' || v_si_number
      || COALESCE(', ' || NULLIF(v_counterparty, ''), ''),
    500);
  v_inv_dims := public.coerce_dimensions_bag(v_inv.default_dimensions);
  v_si_dims := public.coerce_dimensions_bag(v_si.default_dimensions);

  INSERT INTO public.journal_entries
    (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, source_id, status)
  VALUES
    (v_entry_id, v_caller, p_company_id, v_fiscal_period_id, 0, v_series,
     p_setoff_date, v_description, 'counterparty_setoff', p_setoff_id, 'draft');

  -- The posting port's counterparty.set_off event, linked to the draft
  -- before commit_journal_entry draws its number (20261018210000).
  PERFORM public.link_business_events_to_draft(
    p_company_id, v_entry_id, p_event_ids, 'produced', p_event_mode);

  INSERT INTO public.journal_entry_lines
    (journal_entry_id, account_number, debit_amount, credit_amount, currency,
     sort_order, line_description, dimensions)
  VALUES
    (v_entry_id, v_payable, p_amount, 0, 'SEK', 0,
     left('Leverantörsfaktura ' || v_si_number, 200), v_si_dims),
    (v_entry_id, v_receivable, 0, v_receivable_cleared, 'SEK', 1,
     left('Kundfaktura ' || v_inv_number, 200), v_inv_dims);
  -- Set off less than owed = Dr 3740 (förlust), more = Cr 3740 (vinst), the
  -- customer polarity of oreRoundingLine; 3740 carries no VAT.
  IF v_ore <> 0 THEN
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency,
       sort_order, line_description, dimensions)
    VALUES
      (v_entry_id, '3740', GREATEST(v_ore, 0), GREATEST(-v_ore, 0), 'SEK', 2,
       'Öresavrundning', v_inv_dims);
  END IF;

  -- WHO: the actor the application door passes (commitCounterpartySetoff),
  -- stamped by commit_journal_entry like any other commit.
  SELECT voucher_number INTO v_voucher_number
    FROM public.commit_journal_entry(p_company_id, v_entry_id, NULL, NULL, p_actor_type, p_actor_label);

  v_paid_at := (p_setoff_date::timestamp + interval '12 hours') AT TIME ZONE 'UTC';

  v_inv_new_paid := round(COALESCE(v_inv.paid_amount, 0) + v_inv_applied, 2);
  v_inv_new_remaining := GREATEST(0, round(v_inv_remaining - v_inv_applied, 2));
  v_inv_new_status := CASE WHEN v_inv_new_remaining <= 0 THEN 'paid' ELSE 'partially_paid' END;
  UPDATE public.invoices SET
      status = v_inv_new_status,
      paid_at = CASE WHEN v_inv_new_status = 'paid' THEN v_paid_at ELSE paid_at END,
      paid_amount = v_inv_new_paid,
      remaining_amount = v_inv_new_remaining,
      updated_at = v_now
    WHERE id = p_invoice_id AND company_id = p_company_id;

  INSERT INTO public.invoice_payments
    (user_id, company_id, invoice_id, payment_date, amount, currency, exchange_rate,
     journal_entry_id, transaction_id, source, notes, link_basis, link_evidence)
  VALUES
    (v_caller, p_company_id, p_invoice_id, p_setoff_date, v_inv_applied, 'SEK', v_inv.exchange_rate,
     v_entry_id, NULL, 'setoff', left('Kvittning mot leverantörsfaktura ' || v_si_number, 500),
     public.resolve_link_basis('user_created', p_actor_type), NULL)
  RETURNING id INTO v_inv_payment_id;

  v_si_new_paid := round(COALESCE(v_si.paid_amount, 0) + p_amount, 2);
  v_si_new_remaining := GREATEST(0, round(v_si_remaining - p_amount, 2));
  v_si_new_status := CASE WHEN v_si_new_remaining <= 0 THEN 'paid' ELSE 'partially_paid' END;
  UPDATE public.supplier_invoices SET
      status = v_si_new_status,
      paid_at = CASE WHEN v_si_new_status = 'paid' THEN v_paid_at ELSE paid_at END,
      paid_amount = v_si_new_paid,
      remaining_amount = v_si_new_remaining,
      payment_journal_entry_id = v_entry_id,
      updated_at = v_now
    WHERE id = p_supplier_invoice_id AND company_id = p_company_id;

  INSERT INTO public.supplier_invoice_payments
    (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, exchange_rate,
     journal_entry_id, transaction_id, notes, link_basis, link_evidence)
  VALUES
    (v_caller, p_company_id, p_supplier_invoice_id, p_setoff_date, p_amount, 'SEK', v_si.exchange_rate,
     v_entry_id, NULL, left('Kvittning mot kundfaktura ' || v_inv_number, 500),
     public.resolve_link_basis('user_created', p_actor_type), NULL)
  RETURNING id INTO v_si_payment_id;

  INSERT INTO public.counterparty_setoffs
    (id, company_id, user_id, party_id, invoice_id, supplier_invoice_id, amount, currency,
     setoff_date, journal_entry_id, invoice_payment_id, supplier_invoice_payment_id, note)
  VALUES
    (p_setoff_id, p_company_id, v_caller, v_inv_party, p_invoice_id, p_supplier_invoice_id, p_amount, 'SEK',
     p_setoff_date, v_entry_id, v_inv_payment_id, v_si_payment_id, v_note);

  RETURN jsonb_build_object(
    'ok', true,
    'setoff_id', p_setoff_id,
    'journal_entry_id', v_entry_id,
    'voucher_series', v_series,
    'voucher_number', v_voucher_number,
    'party_id', v_inv_party,
    'amount', p_amount,
    'ore_rounding', v_ore,
    'receivable_account', v_receivable,
    'payable_account', v_payable,
    'invoice', jsonb_build_object(
      'invoice_id', p_invoice_id, 'payment_id', v_inv_payment_id, 'status', v_inv_new_status,
      'paid_amount', v_inv_new_paid, 'remaining_amount', v_inv_new_remaining),
    'supplier_invoice', jsonb_build_object(
      'supplier_invoice_id', p_supplier_invoice_id, 'payment_id', v_si_payment_id, 'status', v_si_new_status,
      'paid_amount', v_si_new_paid, 'remaining_amount', v_si_new_remaining)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.link_invoice_to_voucher(p_invoice_id uuid, p_journal_entry_id uuid, p_user_id uuid, p_company_id uuid, p_notes text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text, p_event_ids uuid[] DEFAULT NULL::uuid[], p_event_mode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
  v_voucher RECORD;
  v_ar_credit_total numeric := 0;
  v_line_currency text;
  v_remaining numeric;
  v_payment_amount numeric;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_is_fully_paid boolean;
  v_now timestamptz := now();
  v_payment_id uuid;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_acting_user uuid := p_user_id;
  -- Which side settles this invoice: invoice_settlement_side() (#3440).
  v_settlement_side text;
  v_entry_side text;
  -- Unit resolution (20260726140000): the currency the invoice's amounts are
  -- quoted in, plus the matched-side lines that cannot be expressed in it.
  v_invoice_currency text;
  v_account_prefix text;
  v_unreadable_count integer := 0;
  v_unreadable_currency text;
  -- FX residual settlement (new): a foreign invoice whose matched side is
  -- booked plain SEK. See the header comment.
  v_readable_count integer := 0;
  v_sek_side_total numeric := 0;
  v_foreign_label_count integer := 0;
  v_booked_sek numeric;
  v_fx_diff numeric := 0;
  v_fx_settled boolean := false;
  v_payment_rate numeric;     -- round-6 effective rate (traceability)
  v_fx_account text;
  v_fx_entry_id uuid;
  v_fx_voucher_number int;
  v_fiscal_period_id uuid;
  v_period_is_closed boolean;
  v_period_locked_at timestamptz;
  v_inv_number_short text;
  v_doc_dims jsonb;  -- the invoice's bag (coerce_dimensions_bag), on both residual legs
  -- The SEK-booked fallback read the voucher (as the whole remainder).
  v_fx_fallback boolean := false;
  -- Capacity of the voucher's settlement side, on both sides: what payment
  -- rows for other invoices have already used of it (crm#1434).
  v_used numeric := 0;
  v_used_other_currency integer := 0;
  v_used_rows integer := 0;
  v_side_total numeric;  -- the settlement side before v_used is taken off
  v_side_key text;       -- 'ar_credit' or 'bank_debit', for the details
  -- The caller's stated share of the voucher (p_amount, öre-rounded), or NULL.
  v_amount numeric;
  -- The öresavrundning the invoice's own verifikat booked (20261126170500).
  v_carried jsonb;                     -- document_carried_sek for the invoice
  v_booked_ore numeric := 0;           -- the remainder less what 151x carries (bookedOreRounding)
  v_receivable numeric;                -- what 151x carries for the invoice
  v_clears_carried boolean := false;   -- the link settles the invoice in full on what 151x carries
  v_cleared numeric;                   -- what the link takes of what the voucher has left
BEGIN
  -- 0. Tenant guard (mirrors 20260611140000): anon/authenticated may only act
  --    on their own companies; service_role / direct access bypasses. The
  --    NULL-safe caller_is_company_member() form (20260703180000): the raw
  --    membership-subquery shape skips the deny branch on UNKNOWN and is
  --    banned by the pg-real ratchet (tests/pg/null-safe-tenant-guards
  --    .pg.test.ts, which scans prosrc, comments included).
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_NOT_FOUND');
    END IF;
    -- Attribution: the JWT sub is authoritative for user-session callers:
    -- p_user_id cannot point the payment row at someone else.
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_NOTES_TOO_LONG',
      'details', jsonb_build_object('max_length', 2000, 'length', char_length(p_notes))
    );
  END IF;

  -- A stated share is an amount of money in the invoice's currency: positive
  -- to the öre. Refused before any lock is taken, like the note above.
  IF p_amount IS NOT NULL THEN
    v_amount := ROUND(p_amount * 100) / 100;
    IF v_amount <= 0 OR v_amount = 'NaN'::numeric THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_AMOUNT_INVALID',
        'details', jsonb_build_object('amount', p_amount));
    END IF;
  END IF;

  -- 1. Lock the invoice for the duration of this transaction. FOR UPDATE so a
  --    concurrent linker has to wait until we commit (or roll back).
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_NOT_FOUND');
  END IF;

  IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_INVOICE_FULLY_PAID',
      'details', jsonb_build_object('status', v_invoice.status)
    );
  END IF;

  v_remaining := COALESCE(v_invoice.remaining_amount,
                          v_invoice.total - COALESCE(v_invoice.paid_amount, 0));
  IF v_remaining <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_FULLY_PAID');
  END IF;

  -- 2. Resolve the voucher.
  SELECT * INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_VOUCHER_NOT_FOUND');
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status)
    );
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_NO_AR_CREDIT',
      'details', jsonb_build_object('source_type', v_voucher.source_type)
    );
  END IF;

  -- 3. Sum the matched amount across the voucher's lines, EXPRESSED IN THE
  --    INVOICE'S CURRENCY, on the side invoice_settlement_side() names: the
  --    19xx debit for a kontantmetod invoice that was never booked, the 151x
  --    credit for every other invoice (faktureringsmetoden, and a kontantmetod
  --    invoice carried at the year end or otherwise booked). The invoice row
  --    is locked and visible here, so the helper always answers; the
  --    COALESCE keeps the receivable side as the safe default regardless.
  SELECT s.settlement_side, s.account_prefix, s.entry_side
    INTO v_settlement_side, v_account_prefix, v_entry_side
  FROM public.invoice_settlement_side(p_invoice_id, p_company_id) s;
  v_settlement_side := COALESCE(v_settlement_side, 'ar_credit');
  v_account_prefix := COALESCE(v_account_prefix, '151');
  v_entry_side := COALESCE(v_entry_side, 'credit');

  -- `invoices.currency` is `text default 'SEK'` and therefore NULLABLE; a
  -- missing code has always meant kronor, and must not be read as "not SEK".
  v_invoice_currency := COALESCE(v_invoice.currency, 'SEK');

  IF v_invoice_currency = 'SEK' THEN
    -- From 20260620130000, branching on the settlement side instead of the
    -- company's method. The ledger columns are kronor already, so the
    -- document label on the line is irrelevant here.
    IF v_settlement_side = 'bank_debit' THEN
      -- Kontantmetoden, unbooked invoice: the payment verifikat debits
      -- where the money landed, a liquid-funds account (19xx) or the owner's
      -- private funds (2013): invoice_settlement_line() (20261031225028).
      SELECT COALESCE(SUM(debit_amount), 0), MAX(currency)
        INTO v_ar_credit_total, v_line_currency
      FROM public.journal_entry_lines
      WHERE journal_entry_id = p_journal_entry_id
        AND public.invoice_settlement_line('bank_debit', account_number)
        AND debit_amount > 0;
    ELSE
      -- The invoice is booked (faktureringsmetoden, or a kontantmetod carry):
      -- the payment verifikat credits the AR account (151x).
      SELECT COALESCE(SUM(credit_amount), 0), MAX(currency)
        INTO v_ar_credit_total, v_line_currency
      FROM public.journal_entry_lines
      WHERE journal_entry_id = p_journal_entry_id
        AND account_number LIKE '151%'
        AND credit_amount > 0;
    END IF;
  ELSE
    -- Foreign invoice: `amount_in_currency` is the only column quoted in the
    -- invoice's currency. Magnitude from ABS() because a handful of production
    -- rows store the foreign figure negatively while the debit/credit side is
    -- authoritative, and that side is already pinned by the `> 0` predicate.
    --
    -- Three additional aggregates (new) feed the FX residual fallback:
    --   * how many matched-side lines are readable at all: the gate below
    --     must count LINES, not test the sum, because a readable line with
    --     amount_in_currency = 0 sums to 0 while its SEK ledger movement is
    --     real and excluded from the SEK sum: engaging the fallback over it
    --     would understate the settlement and fabricate an FX residual;
    --   * the matched side's raw SEK ledger sum over SEK-booked lines
    --     (label 'SEK' or NULL);
    --   * how many unreadable lines are NOT SEK-booked (third-currency label,
    --     or the invoice's label without a figure): any such line keeps the
    --     fallback disabled.
    SELECT
      COALESCE(SUM(ABS(l.amount_in_currency)) FILTER (
        WHERE l.currency = v_invoice_currency AND l.amount_in_currency IS NOT NULL
      ), 0),
      MAX(l.currency) FILTER (
        WHERE l.currency = v_invoice_currency AND l.amount_in_currency IS NOT NULL
      ),
      COUNT(*) FILTER (
        WHERE l.currency IS DISTINCT FROM v_invoice_currency OR l.amount_in_currency IS NULL
      ),
      MIN(l.currency) FILTER (
        WHERE l.currency IS DISTINCT FROM v_invoice_currency OR l.amount_in_currency IS NULL
      ),
      COUNT(*) FILTER (
        WHERE l.currency = v_invoice_currency AND l.amount_in_currency IS NOT NULL
      ),
      COALESCE(SUM(CASE WHEN v_entry_side = 'debit' THEN l.debit_amount ELSE l.credit_amount END) FILTER (
        WHERE COALESCE(l.currency, 'SEK') = 'SEK'
      ), 0),
      COUNT(*) FILTER (
        WHERE (l.currency IS DISTINCT FROM v_invoice_currency OR l.amount_in_currency IS NULL)
          AND COALESCE(l.currency, 'SEK') <> 'SEK'
      )
      INTO v_ar_credit_total, v_line_currency, v_unreadable_count, v_unreadable_currency,
           v_readable_count, v_sek_side_total, v_foreign_label_count
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = p_journal_entry_id
      AND public.invoice_settlement_line(v_settlement_side, l.account_number)
      AND (CASE WHEN v_entry_side = 'debit' THEN l.debit_amount ELSE l.credit_amount END) > 0;

    IF COALESCE(v_unreadable_count, 0) > 0 THEN
      -- A stated share needs the voucher's side in the invoice's currency.
      -- The fallback below reads a kronor voucher as the settlement of the
      -- invoice's WHOLE remainder and books the kursdifferens from that; the
      -- kronor behind a part of it are not in the books, so a share would
      -- book a kursdifferens on a guess. Answered before the fallback, so the
      -- caller reads why and not a deviation the share itself produced.
      IF v_amount IS NOT NULL THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
          'details', jsonb_build_object(
            'invoice_currency', v_invoice.currency,
            'line_currency', v_unreadable_currency,
            'reason', 'amount_needs_invoice_currency'
          )
        );
      END IF;
      -- FX residual fallback (new): the voucher settles the invoice in plain
      -- kronor. Engage only in the unambiguous case; see the header comment.
      -- The readable gate counts LINES (see the aggregate comment): with
      -- zero readable lines, v_sek_side_total is provably the FULL
      -- matched-side ledger sum and v_line_currency is NULL by construction.
      -- Both sides are unambiguous now that the side follows the invoice's
      -- own booking: a booked invoice (accrual, or a kontantmetod carry) is
      -- read on its 151x credit and trued up below, an unbooked kontantmetod
      -- invoice on its 19xx debit with nothing to true up. Before #3440 a
      -- booked kontantmetod invoice was read on the 19xx side and had to be
      -- refused here.
      IF v_settlement_side IN ('ar_credit', 'bank_debit')
         AND COALESCE(v_readable_count, 0) = 0
         AND COALESCE(v_foreign_label_count, 0) = 0
         AND v_sek_side_total > 0
         AND v_invoice.exchange_rate IS NOT NULL
         AND v_invoice.exchange_rate > 0
         AND v_invoice.exchange_rate < 100000
      THEN
        v_sek_side_total := ROUND(v_sek_side_total * 100) / 100;
        v_booked_sek := ROUND(v_remaining * v_invoice.exchange_rate * 100) / 100;
        -- Same 10% deviation band as match_batch_allocate: outside it the
        -- voucher is simply the wrong voucher (e.g. 1 000 kr against a
        -- 1 000 EUR remainder), not an FX difference.
        IF ABS(v_sek_side_total - v_booked_sek) > v_booked_sek * 0.10 THEN
          RETURN jsonb_build_object(
            'ok', false,
            'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
            'details', jsonb_build_object(
              'invoice_currency', v_invoice.currency,
              'line_currency', v_unreadable_currency,
              'reason', 'fx_deviation_too_large',
              'expected_sek', v_booked_sek,
              'voucher_sek', v_sek_side_total
            )
          );
        END IF;
        -- The receivable side books the residual verifikat below; the 19xx
        -- side never does. Only an invoice that was never booked reads the
        -- 19xx side, so there is no receivable for a kursdifferens to arise
        -- against: the revenue is already in the books at the rate the money
        -- actually moved, and the link settles the full remaining and writes
        -- no new bookkeeping at all.
        v_fx_fallback := true;
        v_fx_settled := (v_settlement_side = 'ar_credit');
        v_fx_diff := ROUND((v_booked_sek - v_sek_side_total) * 100) / 100;
        -- The voucher settles the FULL remaining (match_batch_allocate's
        -- cross-currency convention); the residual verifikat below trues up
        -- the receivable. v_line_currency is NULL here (no readable line),
        -- so the label guard further down passes by COALESCE.
        v_ar_credit_total := ROUND(v_remaining * 100) / 100;
        v_payment_rate := ROUND((v_sek_side_total / v_remaining) * 1000000) / 1000000;
      ELSE
        -- Fail CLOSED, exactly as before, on everything the fallback cannot
        -- read unambiguously: mixed readable/SEK vouchers, third-currency
        -- labels, an invoice-labelled line without a figure, or a
        -- missing/insane exchange rate.
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
          'details', jsonb_build_object(
            'invoice_currency', v_invoice.currency,
            'line_currency', v_unreadable_currency
          )
        );
      END IF;
    END IF;
  END IF;

  v_ar_credit_total := ROUND(v_ar_credit_total * 100) / 100;

  IF v_ar_credit_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_NO_AR_CREDIT');
  END IF;

  -- On the bank_debit side the verifikat must book this invoice's sale or its
  -- receivable, not a private withdrawal or an owner's deposit that happens
  -- to debit 19xx or 2013: invoice_voucher_books_sale() (#146). Before any
  -- write, so a refused link changes nothing.
  IF v_settlement_side = 'bank_debit' AND NOT public.invoice_voucher_books_sale(
    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'account_number', l.account_number,
              'debit_amount', l.debit_amount,
              'credit_amount', l.credit_amount)), '[]'::jsonb)
       FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = p_journal_entry_id),
    ARRAY(SELECT DISTINCT it.revenue_account
            FROM public.invoice_items it
           WHERE it.invoice_id = p_invoice_id
             AND it.revenue_account IS NOT NULL)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_NO_SALE');
  END IF;

  -- Label guard, still load-bearing, but no longer as a unit check:
  -- v_ar_credit_total is already in the invoice's currency. What it catches
  -- now is a counterparty discriminator, a matched line stamped with some
  -- other document's currency. Always passes on a foreign invoice, because
  -- only same-labelled lines could be read at all. Both sides compare the
  -- RESOLVED v_invoice_currency, never the raw nullable column: with the raw
  -- column, a legacy NULL-currency invoice (which has always meant SEK) hit
  -- 'SEK' IS DISTINCT FROM NULL = true and an ordinary domestic payment
  -- raised LINK_VOUCHER_CURRENCY_MISMATCH forever.
  IF COALESCE(v_line_currency, v_invoice_currency) IS DISTINCT FROM v_invoice_currency THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'line_currency', v_line_currency
      )
    );
  END IF;

  -- Capacity, on both sides: what the settlement side has left after the rows
  -- that already point at this verifikat for OTHER invoices, whichever path
  -- wrote them. One verifikat may settle several invoices, but its rows can
  -- never add up to more than the side they settle against. This invoice's
  -- own row is left to the already-linked guard below, so a repeated link
  -- keeps its own answer.
  v_side_key := CASE WHEN v_settlement_side = 'bank_debit' THEN 'bank_debit' ELSE 'ar_credit' END;
  SELECT
    COALESCE(SUM(p.amount) FILTER (WHERE COALESCE(p.currency, 'SEK') = v_invoice_currency), 0),
    COUNT(*) FILTER (WHERE COALESCE(p.currency, 'SEK') <> v_invoice_currency),
    COUNT(*)
    INTO v_used, v_used_other_currency, v_used_rows
  FROM public.invoice_payments p
  WHERE p.company_id = p_company_id
    AND p.journal_entry_id = p_journal_entry_id
    AND p.invoice_id <> p_invoice_id;

  IF v_fx_fallback AND v_used_rows > 0 THEN
    -- The kronor voucher was read as settling THIS invoice's full remaining;
    -- it cannot also be the settlement of another one.
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_FULLY_ALLOCATED',
      'details', jsonb_build_object('linked_rows', v_used_rows));
  END IF;
  IF v_used_other_currency > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'reason', 'voucher_settles_other_currency'
      )
    );
  END IF;
  v_used := ROUND(v_used * 100) / 100;
  v_side_total := v_ar_credit_total;
  IF v_ar_credit_total - v_used <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_FULLY_ALLOCATED',
      'details', jsonb_build_object(v_side_key, v_side_total, 'already_linked', v_used));
  END IF;
  -- From here on v_ar_credit_total is what the voucher has LEFT.
  v_ar_credit_total := ROUND((v_ar_credit_total - v_used) * 100) / 100;

  -- The öresavrundning the invoice's own verifikat already booked (1510 at
  -- the rounded "Att betala", the öre on 3740): the remainder less what 151x
  -- carries for it, inside the öre band, else 0 (bookedOreRounding over
  -- carriedSekOf, the rule match_batch_allocate and book_counterparty_setoff
  -- read). Read only for a SEK invoice settled on its 151x side with öre in
  -- its remainder or its total (hasOreToRound, 20261127121500): the total
  -- too, since a part payment can leave whole kronor open while 151x still
  -- carries the issue's öre. When it is there, the voucher that clears what
  -- 151x carries is the payment of the whole remainder: a payment booked at
  -- the rounded amount, or a kreditfaktura whose verifikat mirrored the
  -- rounding.
  v_receivable := ROUND(v_remaining * 100) / 100;
  IF v_invoice_currency = 'SEK'
     AND v_settlement_side = 'ar_credit'
     AND (v_receivable <> trunc(v_receivable)
          OR ROUND(COALESCE(v_invoice.total, 0), 2) <> trunc(ROUND(COALESCE(v_invoice.total, 0), 2))) THEN
    v_carried := public.document_carried_sek(p_company_id, 'customer', p_invoice_id);
    IF (v_carried ->> 'ok')::boolean THEN
      v_booked_ore := public.ore_settlement_residual(v_receivable, (v_carried ->> 'sek')::numeric);
    END IF;
    v_receivable := ROUND((v_receivable - v_booked_ore) * 100) / 100;
  END IF;
  -- Only a voucher with exactly what 151x carries left: then the whole of it
  -- is this invoice's, and nothing of it is left for another one. A voucher
  -- with more or less left is judged on the remainder, as before. With no
  -- stated share, or a share of the whole remainder or of what 151x carries
  -- (the rounded amount the customer was asked to pay).
  IF v_booked_ore <> 0 AND ABS(v_ar_credit_total - v_receivable) <= 0.005 THEN
    v_clears_carried := v_amount IS NULL
      OR ABS(v_amount - ROUND(v_remaining * 100) / 100) <= 0.005
      OR ABS(v_amount - v_receivable) <= 0.005;
  END IF;

  -- Both sides are now in the invoice's currency.
  IF v_clears_carried THEN
    -- The voucher's rest is what 151x carries: the invoice settles in full.
    NULL;
  ELSIF v_amount IS NULL THEN
    -- No stated share: nothing is split on a guess. What the voucher has left
    -- must fit inside the invoice's remainder. Details as before this change.
    IF v_ar_credit_total > v_remaining + 0.005 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
        'details', jsonb_build_object(
          'ar_credit', v_ar_credit_total,
          'remaining', ROUND(v_remaining * 100) / 100
        )
      );
    END IF;
  ELSE
    -- A stated share: bounded by the invoice's remainder and by what the
    -- voucher has left. The rest of the voucher stays available.
    IF v_amount > v_remaining + 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
        'details', jsonb_build_object(
          'amount', v_amount,
          'remaining', ROUND(v_remaining * 100) / 100));
    END IF;
    IF v_amount > v_ar_credit_total + 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
        'details', jsonb_build_object(
          'amount', v_amount,
          'available', v_ar_credit_total,
          v_side_key, v_side_total,
          'already_linked', v_used));
    END IF;
  END IF;

  -- 4. Reject re-link of the same voucher to the same invoice. Authoritative
  --    under the FOR UPDATE lock; the partial unique index
  --    idx_invoice_payments_je_inv_unique stays as the last line of defence
  --    for non-RPC writers.
  IF EXISTS (
    SELECT 1 FROM public.invoice_payments
    WHERE company_id = p_company_id
      AND invoice_id = p_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_ALREADY_LINKED');
  END IF;

  -- 4b. Book the FX residual as its OWN verifikat: the linked voucher is
  --     posted and immutable, so the difference between the receivable's
  --     booked kronor and the kronor the voucher settled cannot live inside
  --     it. Placed AFTER every guard so a rejected link never creates a
  --     verifikat; the RPC body is one transaction, so a later failure rolls
  --     it back. v_fx_diff is öre-rounded from öre-rounded inputs: it is
  --     either exactly 0.00 (nothing to book) or >= 0.01.
  IF v_fx_settled AND ABS(v_fx_diff) > 0.005 THEN
    -- Counter-leg account: the AR account the voucher actually settled
    -- (largest matched-side line). Non-null: the fallback required
    -- v_sek_side_total > 0, so at least one such line exists.
    SELECT l.account_number INTO v_fx_account
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = p_journal_entry_id
      AND l.account_number LIKE v_account_prefix || '%'
      AND l.credit_amount > 0
    ORDER BY l.credit_amount DESC, l.account_number ASC
    LIMIT 1;

    -- Same period resolution + openness check as match_batch_allocate: the
    -- residual is dated on the payment voucher's entry_date so the FX result
    -- lands in the period the settlement happened in.
    SELECT fp.id, fp.is_closed, fp.locked_at
      INTO v_fiscal_period_id, v_period_is_closed, v_period_locked_at
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND v_voucher.entry_date BETWEEN fp.period_start AND fp.period_end
    ORDER BY fp.period_start DESC
    LIMIT 1;

    IF v_fiscal_period_id IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
        'details', jsonb_build_object(
          'invoice_currency', v_invoice.currency,
          'reason', 'fx_residual_no_fiscal_period',
          'entry_date', v_voucher.entry_date
        )
      );
    END IF;
    IF v_period_is_closed OR v_period_locked_at IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
        'details', jsonb_build_object(
          'invoice_currency', v_invoice.currency,
          'reason', 'fx_residual_period_locked',
          'fiscal_period_id', v_fiscal_period_id
        )
      );
    END IF;

    v_inv_number_short := LEFT(COALESCE(v_invoice.invoice_number, ''), 32);
    -- Both residual legs belong to this one invoice, so both carry its
    -- dimension bag, as every leg of the TypeScript payment voucher does
    -- (createInvoicePaymentJournalEntry): the kursdifferens stays inside the
    -- project's or cost centre's result.
    v_doc_dims := public.coerce_dimensions_bag(v_invoice.default_dimensions);
    v_fx_entry_id := gen_random_uuid();
    INSERT INTO public.journal_entries
      (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
       entry_date, description, source_type, status)
    VALUES
      (v_fx_entry_id, v_acting_user, p_company_id, v_fiscal_period_id, 0, 'A',
       v_voucher.entry_date, 'Valutakursdifferens faktura ' || v_inv_number_short,
       'invoice_paid', 'draft');

    -- The posting port's events: sale.payment_received of the
    -- invoice. Linked to the draft
    -- before commit_journal_entry draws its number (20261018210000).
    PERFORM public.link_business_events_to_draft(
      p_company_id, v_fx_entry_id, p_event_ids, 'produced', p_event_mode);

    IF v_fx_diff > 0 THEN
      -- Settled below booked value: loss. Dr 7960 / Cr AR, the polarity
      -- match_batch_allocate books for a customer allocation under booked_sek.
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description, dimensions)
      VALUES
        (v_fx_entry_id, '7960', v_fx_diff, 0, 'SEK', 0,
         'Valutakursförlust ' || v_inv_number_short, v_doc_dims),
        (v_fx_entry_id, v_fx_account, 0, v_fx_diff, 'SEK', 1,
         'Faktura ' || v_inv_number_short || ' (' || v_invoice_currency || ')', v_doc_dims);
    ELSE
      -- Settled above booked value: gain. Dr AR / Cr 3960.
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description, dimensions)
      VALUES
        (v_fx_entry_id, v_fx_account, ABS(v_fx_diff), 0, 'SEK', 0,
         'Faktura ' || v_inv_number_short || ' (' || v_invoice_currency || ')', v_doc_dims),
        (v_fx_entry_id, '3960', 0, ABS(v_fx_diff), 'SEK', 1,
         'Valutakursvinst ' || v_inv_number_short, v_doc_dims);
    END IF;

    -- WHO: the actor the application door passes (commitInvoiceVoucherLink).
    SELECT voucher_number INTO v_fx_voucher_number
    FROM public.commit_journal_entry(p_company_id, v_fx_entry_id, NULL, NULL, p_actor_type, p_actor_label);
  END IF;

  -- 5. Compute the advance: the stated share, or all the voucher has left;
  --    never more than the invoice's remainder or the voucher's capacity (the
  --    half-öre tolerance of the guards above is clamped away here). A
  --    settlement in full on what 151x carries pays the whole remainder and
  --    takes all the voucher has left. Its payment row then differs from the
  --    151x credit by the öre the issue verifikat booked: more than the
  --    credit when rounded down (a later link finds the voucher used up),
  --    less when rounded up.
  IF v_clears_carried THEN
    v_payment_amount := ROUND(v_remaining * 100) / 100;
    v_cleared := v_ar_credit_total;
  ELSE
    v_payment_amount := LEAST(COALESCE(v_amount, v_ar_credit_total), v_ar_credit_total, ROUND(v_remaining * 100) / 100);
    v_cleared := v_payment_amount;
  END IF;
  v_new_remaining := GREATEST(0,
    ROUND((v_remaining - v_payment_amount) * 100) / 100
  );
  v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_payment_amount) * 100) / 100;
  v_is_fully_paid := v_new_remaining <= 0.005;
  v_new_status := CASE WHEN v_is_fully_paid THEN 'paid' ELSE 'partially_paid' END;

  -- 6. Apply both writes. The RPC body is one transaction; a failure on the
  --    INSERT triggers PG's own rollback of the UPDATE: no manual rollback
  --    path needed.
  UPDATE public.invoices
  SET status = v_new_status,
      paid_at = CASE WHEN v_is_fully_paid THEN
        ((v_voucher.entry_date::timestamp + interval '12 hours') AT TIME ZONE 'UTC')
      ELSE paid_at END,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      updated_at = v_now
  WHERE id = p_invoice_id;

  -- The payment row persists the RESOLVED currency: writing the raw column
  -- would store NULL for a legacy NULL-currency invoice, and the payment's
  -- unit is a fact this row must state, not inherit as "unknown".
  -- payment_exchange_rate carries the effective settlement rate on the FX
  -- fallback (settled_sek / remaining) and stays NULL on every other path.
  INSERT INTO public.invoice_payments (
    user_id, company_id, invoice_id, payment_date, amount, currency,
    exchange_rate, payment_exchange_rate, journal_entry_id, transaction_id, notes,
    link_basis, link_evidence
  ) VALUES (
    v_acting_user, p_company_id, p_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice_currency, v_invoice.exchange_rate, v_payment_rate,
    p_journal_entry_id, NULL, p_notes,
    public.resolve_link_basis('user_confirmed', p_actor_type), NULL
  )
  RETURNING id INTO v_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', v_payment_id,
    'invoice_status', v_new_status,
    'paid_amount', v_new_paid,
    'remaining_amount', v_new_remaining,
    'payment_amount', v_payment_amount,
    'journal_entry_id', p_journal_entry_id,
    'currency', v_invoice_currency,
    'payment_date', v_voucher.entry_date,
    'voucher_remaining', ROUND((v_ar_credit_total - v_cleared) * 100) / 100,
    'fx_settled_sek', CASE WHEN v_fx_settled THEN v_sek_side_total END,
    'fx_residual_sek', CASE WHEN v_fx_settled THEN v_fx_diff END,
    'fx_journal_entry_id', v_fx_entry_id,
    'fx_voucher_number', v_fx_voucher_number
  );
END;
$function$;
