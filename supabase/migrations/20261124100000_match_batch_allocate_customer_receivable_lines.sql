-- match_batch_allocate books the rest of a customer payment against a
-- customer receivable from before the company kept its books here: the
-- customer side of the supplier debt rows (20261120150000).
--
-- A company that moved in with SIE files has its kundfordringar in 1510 as
-- one balance: SIE carries no reskontra, so an invoice issued in the old
-- system has no invoices row. One incoming bank row that pays several
-- invoices at once, some issued here and some in the old system (a Bankgirot
-- deposit, which the bank feed carries as one total), could not be split:
-- the customer batch had to equal the invoices less the fees, and the single
-- match offers only 2420 or 3740 for an excess. The right booking for the
-- rest is a credit on the receivable the old system booked.
--
-- p_debt_lines (unchanged signature) now carries the rows from before on
-- either side, read by the batch's side:
--   supplier batch: a debit each on an active 244x account, as before;
--   customer batch: a credit each on an active 151x account, the text the
--   request's, else 'Kundfordran från tidigare bokföring'.
-- At most five rows, and five extra rows with the fee rows; above zero in
-- whole öre; no VAT line; no dimensions. The invoices less the fees plus the
-- receivable rows equal a customer bank row. A verifikat with a receivable
-- row keeps the samlingsinbetalning header and does not link the bank row to
-- its one invoice (transactions.invoice_id), since the row pays more than
-- that invoice.
--
-- Refusals on a customer batch: BATCH_RECEIVABLE_INVALID and
-- BATCH_RECEIVABLE_ACCOUNT_INVALID, the customer counterparts of
-- BATCH_DEBT_INVALID and BATCH_DEBT_ACCOUNT_INVALID. BATCH_DEBT_SUPPLIER_ONLY
-- is no longer answered: a customer batch's rows are receivable rows.
--
-- What does not change: the signature, every other check, refusal, line,
-- voucher number (commit_journal_entry), attribution, link basis, fee row,
-- kontantmetoden line, event link and every supplier batch; SECURITY
-- DEFINER, search_path, owner and grants are restated, the comment names the
-- customer rows. The body is copied from
--   20261120150000_match_batch_allocate_supplier_debt_lines
-- the newest definition; the edits are two declarations, the row check (the
-- side's account group and refusal codes, the SUPPLIER_ONLY refusal gone),
-- the customer net, the line insert (credit on a customer batch, the side's
-- default text), the one-invoice link on the transaction and the comment.
--
-- Deploy window: the application sends p_debt_lines on a customer batch only
-- with receivable rows (customer_receivables), which a database without this
-- migration refuses (BATCH_DEBT_SUPPLIER_ONLY): a refusal, never a booking.
--
-- pg-test: tests/pg/match-batch-allocate-receivable-lines.pg.test.ts

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
        -- full of an invoice with a verifikat and öre left to pay. 1510 then
        -- gives up what it carries and 3740 takes only the rest of the öre,
        -- so the rounding is not booked twice; a part allocation clears its
        -- own kronor.
        v_booked_ore := 0;
        IF (v_ore_diff <> 0 OR ROUND(v_alloc_amount, 2) = ROUND(v_inv_remaining, 2))
           AND v_inv_journal_entry_id IS NOT NULL
           AND ROUND(v_inv_remaining, 2) > 0.005
           AND ROUND(v_inv_remaining, 2) <> TRUNC(ROUND(v_inv_remaining, 2)) THEN
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

REVOKE ALL ON FUNCTION public.match_batch_allocate(uuid, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_batch_allocate(uuid, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, uuid[], text) TO authenticated, service_role;

COMMENT ON FUNCTION public.match_batch_allocate(uuid, jsonb, uuid, uuid, text, text, jsonb, jsonb, jsonb, uuid[], text) IS
  'Books one bank transaction against N invoices/supplier invoices in a single samlingsverifikat. Sub-krona differences between an allocation and the invoice remaining are absorbed to 3740 (öresavrundning) so the invoice settles fully. p_fee_lines (20261028231700): at most five exempt payment-service fees, each a debit on an active class 6 account with no VAT; the invoices less the fees (customer) or plus the fees (supplier) equal the bank row, and the fees are smaller than the invoices. Every line belonging to one allocation (1510/2440, 3740, 3960/7960) carries that document''s default_dimensions (coerce_dimensions_bag); the bank line and the fee lines carry the bag only when every settled document shares it. p_user_id is honored only for service_role callers (the pending-operations commit path); every other caller resolves from its own auth.uid(). Not callable by anon. p_event_ids (the posting port''s sale.payment_received or purchase.paid events, one per allocation) are linked to the samlingsverifikat before its number is drawn; p_event_mode strict makes a refused link fail the booking, anything else logs it (20261018210200). p_cash_lines (20261031100700): kontantmetoden, an object keyed by customer invoice id with the revenue, moms and öresavrundning lines of an unbooked SEK invoice paid in full (the single cash match''s entry without its bank leg); every allocation or none, the lines crediting net exactly the allocation; the verifikat then takes source_type invoice_cash_payment. Without lines an unbooked invoice of a kontantmetoden company is refused (BATCH_CASH_METHOD_UNBOOKED_INVOICE). A row a posted verifikat books (the pointer or a bank_line link) answers BATCH_TX_ALREADY_BOOKED and an ignored row BANK_ROW_IGNORED, as decideBankRowRebooking reads them (20261101023500). A foreign row answers BATCH_FOREIGN_CURRENCY, as bulk_book_transactions and create_expense_payout_batch; a foreign invoice is cleared at what the ledger carries (document_clearing_sek), öresavrundning is ore_settlement_residual and the limit on a kursdifferens fx_deviation_too_large (20261101120200). A SEK customer invoice whose issue verifikat booked the öresavrundning clears what 1510 carries on a settlement in full, and 3740 takes only the rest of the öre, as bookedOreRounding (20261119090000). p_debt_lines (20261120150000, 20261124100000): the rows from before, at most five (and five extra rows with the fee rows), each with no VAT, for an invoice the row also pays that was registered or issued before the company kept its books here: on a supplier batch a debit on an active 244x account (the invoices plus the fees plus the rows equal the bank row; refusals BATCH_DEBT_*), on a customer batch a credit on an active 151x account (the invoices less the fees plus the rows equal the bank row; refusals BATCH_RECEIVABLE_*); not a fee, so a row may be larger than the invoices; such a verifikat keeps the samlings header and does not link the row to its one invoice.';

NOTIFY pgrst, 'reload schema';
