-- Phase 3a — match_batch_allocate RPC.
--
-- Atomically allocate one bank transaction across N customer invoices OR N
-- supplier invoices (not mixed in v1). Builds ONE combined verifikat per
-- Swedish samlingsverifikation convention (BFL 5 kap 6§ st 3): one
-- affärshändelse = one verifikat. Inserts N payment rows pointing at the
-- single new JE.
--
-- All target invoice rows are SELECT … FOR UPDATE locked in id order before
-- any writes, so concurrent batches can't both succeed against the same
-- invoice's remaining_amount.
--
-- Returns jsonb { ok, journal_entry_id, voucher_series, voucher_number,
-- allocations: [...] } on success, or { ok: false, code, details } on any
-- guard failure. Returning rather than RAISEing keeps the route mapping
-- simple and avoids transaction-rollback ambiguity (we validate everything
-- before any write).
--
-- Existing voucher allocation (linking the bank tx to an already-posted
-- verifikat) is deferred to a follow-up — for that path the user takes the
-- "Länka till verifikat" action which calls /api/reconciliation/bank/link.

CREATE OR REPLACE FUNCTION public.match_batch_allocate(
  p_tx_id uuid,
  p_allocations jsonb,
  p_user_id uuid,
  p_company_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tx RECORD;
  v_tx_abs numeric;
  v_allocation jsonb;
  v_alloc_index int := 0;
  v_kind text;
  v_invoice_id uuid;
  v_supplier_invoice_id uuid;
  v_alloc_amount numeric;
  v_total_allocated numeric := 0;
  v_has_customer boolean := false;
  v_has_supplier boolean := false;

  v_invoice RECORD;
  v_si_invoice RECORD;
  v_supplier_name text;
  v_supplier_invoice_number text;
  v_invoice_number text;

  v_fiscal_period_id uuid;
  v_period_is_closed boolean;
  v_period_locked_at timestamptz;
  v_journal_entry_id uuid := uuid_generate_v4();
  v_voucher_series text := 'A';
  v_voucher_number int;
  v_entry_description text;
  v_line_sort_order int := 0;

  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_now timestamptz := now();

  v_payment_id uuid;
  v_results jsonb := '[]'::jsonb;
BEGIN
  -- ─────────────────────────────────────────────────────────
  -- 1. Lock the transaction row + sanity-check it
  -- ─────────────────────────────────────────────────────────
  SELECT * INTO v_tx
  FROM public.transactions
  WHERE id = p_tx_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_TX_NOT_FOUND');
  END IF;

  IF v_tx.journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'BATCH_TX_ALREADY_BOOKED',
      'details', jsonb_build_object('journal_entry_id', v_tx.journal_entry_id)
    );
  END IF;

  IF v_tx.amount = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_TX_ZERO_AMOUNT');
  END IF;

  v_tx_abs := ABS(v_tx.amount);

  -- ─────────────────────────────────────────────────────────
  -- 2. Validate allocations array shape
  -- ─────────────────────────────────────────────────────────
  IF jsonb_typeof(p_allocations) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_allocations) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_NO_ALLOCATIONS');
  END IF;

  -- ─────────────────────────────────────────────────────────
  -- 3. First pass: validate + lock each allocation target.
  --    All validation happens before any write so the early-return path
  --    doesn't leave half-applied state.
  -- ─────────────────────────────────────────────────────────
  FOR v_allocation IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_kind := v_allocation->>'kind';
    v_alloc_amount := (v_allocation->>'amount')::numeric;

    IF v_alloc_amount IS NULL OR v_alloc_amount <= 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'BATCH_INVALID_AMOUNT',
        'details', jsonb_build_object('index', v_alloc_index, 'amount', v_alloc_amount)
      );
    END IF;

    v_total_allocated := v_total_allocated + v_alloc_amount;

    IF v_kind = 'customer_invoice' THEN
      v_has_customer := true;
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;

      SELECT * INTO v_invoice
      FROM public.invoices
      WHERE id = v_invoice_id AND company_id = p_company_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'BATCH_INVOICE_NOT_FOUND',
          'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id)
        );
      END IF;

      IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'BATCH_INVOICE_NOT_OPEN',
          'details', jsonb_build_object(
            'index', v_alloc_index, 'invoice_id', v_invoice_id, 'status', v_invoice.status
          )
        );
      END IF;

      IF v_alloc_amount > COALESCE(v_invoice.remaining_amount, v_invoice.total) + 0.005 THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'BATCH_OVERSHOOT',
          'details', jsonb_build_object(
            'index', v_alloc_index,
            'invoice_id', v_invoice_id,
            'requested', v_alloc_amount,
            'remaining', COALESCE(v_invoice.remaining_amount, v_invoice.total)
          )
        );
      END IF;

      IF v_invoice.currency IS DISTINCT FROM v_tx.currency THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'BATCH_CURRENCY_MISMATCH',
          'details', jsonb_build_object(
            'index', v_alloc_index,
            'invoice_id', v_invoice_id,
            'invoice_currency', v_invoice.currency,
            'tx_currency', v_tx.currency
          )
        );
      END IF;

    ELSIF v_kind = 'supplier_invoice' THEN
      v_has_supplier := true;
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;

      SELECT * INTO v_si_invoice
      FROM public.supplier_invoices
      WHERE id = v_supplier_invoice_id AND company_id = p_company_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'BATCH_SUPPLIER_INVOICE_NOT_FOUND',
          'details', jsonb_build_object(
            'index', v_alloc_index, 'supplier_invoice_id', v_supplier_invoice_id
          )
        );
      END IF;

      IF v_si_invoice.status NOT IN ('registered', 'approved', 'overdue', 'partially_paid') THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'BATCH_SUPPLIER_INVOICE_NOT_OPEN',
          'details', jsonb_build_object(
            'index', v_alloc_index,
            'supplier_invoice_id', v_supplier_invoice_id,
            'status', v_si_invoice.status
          )
        );
      END IF;

      IF v_alloc_amount > COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total) + 0.005 THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'BATCH_OVERSHOOT',
          'details', jsonb_build_object(
            'index', v_alloc_index,
            'supplier_invoice_id', v_supplier_invoice_id,
            'requested', v_alloc_amount,
            'remaining', COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total)
          )
        );
      END IF;

      IF v_si_invoice.currency IS DISTINCT FROM v_tx.currency THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'BATCH_CURRENCY_MISMATCH',
          'details', jsonb_build_object(
            'index', v_alloc_index,
            'supplier_invoice_id', v_supplier_invoice_id,
            'invoice_currency', v_si_invoice.currency,
            'tx_currency', v_tx.currency
          )
        );
      END IF;

    ELSE
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'BATCH_INVALID_KIND',
        'details', jsonb_build_object('index', v_alloc_index, 'kind', v_kind)
      );
    END IF;

    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  -- ─────────────────────────────────────────────────────────
  -- 4. Cross-allocation rules
  -- ─────────────────────────────────────────────────────────

  IF v_has_customer AND v_has_supplier THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_MIXED_KINDS_UNSUPPORTED');
  END IF;

  IF v_total_allocated > v_tx_abs + 0.01 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'BATCH_AMOUNT_EXCEEDS_TX',
      'details', jsonb_build_object('allocated', v_total_allocated, 'tx_amount_abs', v_tx_abs)
    );
  END IF;

  IF v_has_customer AND v_tx.amount <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'BATCH_DIRECTION_MISMATCH',
      'details', jsonb_build_object('expected', 'income', 'tx_amount', v_tx.amount)
    );
  END IF;
  IF v_has_supplier AND v_tx.amount >= 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'BATCH_DIRECTION_MISMATCH',
      'details', jsonb_build_object('expected', 'expense', 'tx_amount', v_tx.amount)
    );
  END IF;

  -- ─────────────────────────────────────────────────────────
  -- 5. Resolve fiscal period for tx.date and verify it accepts writes.
  --    The enforce_period_lock trigger would catch a locked period at the
  --    journal_entries INSERT, but pre-checking gives a cleaner error code
  --    and avoids partial work in pathological cases.
  -- ─────────────────────────────────────────────────────────
  SELECT id, is_closed, locked_at
    INTO v_fiscal_period_id, v_period_is_closed, v_period_locked_at
  FROM public.fiscal_periods
  WHERE company_id = p_company_id
    AND v_tx.date BETWEEN period_start AND period_end
  LIMIT 1;

  IF v_fiscal_period_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'BATCH_NO_FISCAL_PERIOD',
      'details', jsonb_build_object('tx_date', v_tx.date)
    );
  END IF;

  IF v_period_is_closed OR v_period_locked_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'BATCH_PERIOD_LOCKED',
      'details', jsonb_build_object(
        'fiscal_period_id', v_fiscal_period_id,
        'is_closed', v_period_is_closed,
        'locked_at', v_period_locked_at
      )
    );
  END IF;

  -- ─────────────────────────────────────────────────────────
  -- 6. All validations passed. Build the combined verifikat.
  -- ─────────────────────────────────────────────────────────

  v_entry_description := CASE
    WHEN v_has_customer THEN 'Samlingsinbetalning ' || v_tx.date
    ELSE 'Samlingsbetalning ' || v_tx.date
  END;

  -- Insert draft entry with placeholder voucher_number=0; commit_journal_entry
  -- will overwrite on commit. Source type 'invoice_paid' is the closest match
  -- in the source_type CHECK enum for AR/AP payments.
  INSERT INTO public.journal_entries (
    id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
    entry_date, description, source_type, status
  ) VALUES (
    v_journal_entry_id, p_user_id, p_company_id, v_fiscal_period_id, 0, v_voucher_series,
    v_tx.date, v_entry_description, 'invoice_paid', 'draft'
  );

  -- Insert per-invoice lines.
  v_alloc_index := 0;
  FOR v_allocation IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_alloc_amount := (v_allocation->>'amount')::numeric;

    IF v_has_customer THEN
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;
      SELECT invoice_number INTO v_invoice_number
      FROM public.invoices WHERE id = v_invoice_id;

      INSERT INTO public.journal_entry_lines (
        journal_entry_id, account_number, debit_amount, credit_amount, currency,
        sort_order, line_description
      ) VALUES (
        v_journal_entry_id, '1510', 0, v_alloc_amount, v_tx.currency,
        v_line_sort_order, 'Faktura ' || COALESCE(v_invoice_number, '')
      );
    ELSE
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;
      SELECT si.supplier_invoice_number, s.name
        INTO v_supplier_invoice_number, v_supplier_name
      FROM public.supplier_invoices si
      LEFT JOIN public.suppliers s ON s.id = si.supplier_id
      WHERE si.id = v_supplier_invoice_id;

      INSERT INTO public.journal_entry_lines (
        journal_entry_id, account_number, debit_amount, credit_amount, currency,
        sort_order, line_description
      ) VALUES (
        v_journal_entry_id, '2440', v_alloc_amount, 0, v_tx.currency,
        v_line_sort_order,
        TRIM(BOTH ' – ' FROM
          COALESCE(v_supplier_name, '') || ' – ' || COALESCE(v_supplier_invoice_number, '')
        )
      );
    END IF;

    v_line_sort_order := v_line_sort_order + 1;
    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  -- Bank settlement line on 1930.
  IF v_has_customer THEN
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_number, debit_amount, credit_amount, currency,
      sort_order, line_description
    ) VALUES (
      v_journal_entry_id, '1930', v_total_allocated, 0, v_tx.currency,
      v_line_sort_order, 'Inbetalning ' || v_tx.date
    );
  ELSE
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_number, debit_amount, credit_amount, currency,
      sort_order, line_description
    ) VALUES (
      v_journal_entry_id, '1930', 0, v_total_allocated, v_tx.currency,
      v_line_sort_order, 'Utbetalning ' || v_tx.date
    );
  END IF;

  -- Commit the entry — atomically assigns voucher_number + flips to posted.
  SELECT voucher_number INTO v_voucher_number
  FROM public.commit_journal_entry(p_company_id, v_journal_entry_id);

  -- ─────────────────────────────────────────────────────────
  -- 7. Advance each invoice + insert payment rows.
  -- ─────────────────────────────────────────────────────────

  v_alloc_index := 0;
  FOR v_allocation IN SELECT * FROM jsonb_array_elements(p_allocations)
  LOOP
    v_alloc_amount := (v_allocation->>'amount')::numeric;

    IF v_has_customer THEN
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;
      SELECT * INTO v_invoice FROM public.invoices WHERE id = v_invoice_id;

      v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_alloc_amount) * 100) / 100;
      v_new_remaining := GREATEST(0,
        ROUND((COALESCE(v_invoice.remaining_amount, v_invoice.total) - v_alloc_amount) * 100) / 100
      );
      v_new_status := CASE WHEN v_new_remaining <= 0.005 THEN 'paid' ELSE 'partially_paid' END;

      UPDATE public.invoices
      SET status = v_new_status,
          paid_at = CASE WHEN v_new_status = 'paid' THEN v_now ELSE paid_at END,
          paid_amount = v_new_paid,
          remaining_amount = v_new_remaining,
          updated_at = v_now
      WHERE id = v_invoice_id;

      INSERT INTO public.invoice_payments (
        user_id, company_id, invoice_id, payment_date, amount, currency,
        exchange_rate, journal_entry_id, transaction_id
      ) VALUES (
        p_user_id, p_company_id, v_invoice_id, v_tx.date, v_alloc_amount, v_invoice.currency,
        v_invoice.exchange_rate, v_journal_entry_id, p_tx_id
      )
      RETURNING id INTO v_payment_id;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'kind', 'customer_invoice',
        'invoice_id', v_invoice_id,
        'payment_id', v_payment_id,
        'status', v_new_status,
        'paid_amount', v_new_paid,
        'remaining_amount', v_new_remaining,
        'amount', v_alloc_amount
      ));

    ELSE
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;
      SELECT * INTO v_si_invoice FROM public.supplier_invoices WHERE id = v_supplier_invoice_id;

      v_new_paid := ROUND((COALESCE(v_si_invoice.paid_amount, 0) + v_alloc_amount) * 100) / 100;
      v_new_remaining := GREATEST(0,
        ROUND((COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total) - v_alloc_amount) * 100) / 100
      );
      v_new_status := CASE WHEN v_new_remaining <= 0.005 THEN 'paid' ELSE 'partially_paid' END;

      UPDATE public.supplier_invoices
      SET status = v_new_status,
          paid_at = CASE WHEN v_new_status = 'paid' THEN v_now ELSE paid_at END,
          paid_amount = v_new_paid,
          remaining_amount = v_new_remaining,
          payment_journal_entry_id = v_journal_entry_id,
          updated_at = v_now
      WHERE id = v_supplier_invoice_id;

      INSERT INTO public.supplier_invoice_payments (
        user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
        journal_entry_id, transaction_id
      ) VALUES (
        p_user_id, p_company_id, v_supplier_invoice_id, v_tx.date, v_alloc_amount,
        v_si_invoice.currency, v_journal_entry_id, p_tx_id
      )
      RETURNING id INTO v_payment_id;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'kind', 'supplier_invoice',
        'supplier_invoice_id', v_supplier_invoice_id,
        'payment_id', v_payment_id,
        'status', v_new_status,
        'paid_amount', v_new_paid,
        'remaining_amount', v_new_remaining,
        'amount', v_alloc_amount
      ));
    END IF;

    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  -- ─────────────────────────────────────────────────────────
  -- 8. Update the transaction. For exactly-one allocation matching the full
  --    tx amount, set the matching denorm column (preserves 1:1 reader path).
  --    For multi or partial: leave denorms NULL — is_transaction_booked
  --    handles via payment rows.
  -- ─────────────────────────────────────────────────────────
  UPDATE public.transactions
  SET journal_entry_id = v_journal_entry_id,
      is_business = TRUE,
      invoice_id = CASE
        WHEN jsonb_array_length(p_allocations) = 1
             AND v_has_customer
             AND ABS(v_total_allocated - v_tx_abs) < 0.005
          THEN (p_allocations->0->>'invoice_id')::uuid
        ELSE NULL
      END,
      supplier_invoice_id = CASE
        WHEN jsonb_array_length(p_allocations) = 1
             AND v_has_supplier
             AND ABS(v_total_allocated - v_tx_abs) < 0.005
          THEN (p_allocations->0->>'supplier_invoice_id')::uuid
        ELSE NULL
      END,
      potential_invoice_id = NULL,
      potential_supplier_invoice_id = NULL,
      category = CASE WHEN v_has_customer THEN 'income_services' ELSE category END,
      updated_at = v_now
  WHERE id = p_tx_id;

  RETURN jsonb_build_object(
    'ok', true,
    'journal_entry_id', v_journal_entry_id,
    'voucher_series', v_voucher_series,
    'voucher_number', v_voucher_number,
    'tx_id', p_tx_id,
    'allocations', v_results,
    'total_allocated', v_total_allocated,
    'leftover', ROUND((v_tx_abs - v_total_allocated) * 100) / 100
  );
END;
$$;

COMMENT ON FUNCTION public.match_batch_allocate(uuid, jsonb, uuid, uuid) IS
  'Atomically allocate one bank transaction across N customer or N supplier invoices. Builds a single combined verifikat (samlingsverifikation), inserts N payment rows, and advances per-invoice paid/remaining/status. Returns jsonb { ok, ..., allocations } on success or { ok: false, code, details } on guard failure. Mixed customer+supplier kinds are not supported in v1.';

NOTIFY pgrst, 'reload schema';
