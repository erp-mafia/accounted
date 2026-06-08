-- PR #603 review round 2 — compliance + Swedish-accounting fixes.
--
-- 1. (GDPR Art.5(1)(f) / ISO A.8.2) Caller verification — SECURITY DEFINER
--    bypasses RLS. Now require auth.uid() to be a member of p_company_id
--    before any read or write. Pattern lifted from harden_invoice_number_rpcs
--    (#20260510140000) and other security-hardened RPCs in this codebase.
--    Returns structured BATCH_UNAUTHORIZED so the API layer can map cleanly.
--
-- 2. (Swedish-accounting) source_type — supplier batches now write
--    'supplier_invoice_paid' instead of 'invoice_paid'. Customer batches
--    keep 'invoice_paid'. behandlingshistorik filters and report queries
--    that route by source_type now see the correct channel.
--
-- 3. (Swedish-accounting) Fiscal-period lookup gets ORDER BY period_start DESC
--    so an overlap (e.g. corrected broken year) deterministically picks the
--    most recent period rather than an arbitrary one.
--
-- 4. (Swedish-accounting) Cross-allocation tolerance harmonised to 0.005
--    (was 0.01). The per-allocation overshoot uses 0.005; matching the
--    sum check prevents a two-row batch from each passing per-row while
--    collectively drifting ~0.01 SEK.
--
-- 5. (Swedish-accounting) transactions.category no longer forced to
--    'income_services' for customer batches. The category is only valid
--    1:1 with a single invoice; for multi-invoice batches the existing
--    category (typically 'uncategorized') is preserved, matching the
--    supplier-side `ELSE category` branch.

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
BEGIN
  -- (1) Caller membership check. SECURITY DEFINER means we run with elevated
  -- privileges; without this, an authenticated user could call the RPC with
  -- a p_company_id they don't belong to and the FOR UPDATE locks would still
  -- succeed. Pattern from 20260510140000_harden_invoice_number_rpcs.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_UNAUTHORIZED');
  END IF;

  SELECT * INTO v_tx FROM public.transactions
  WHERE id = p_tx_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'BATCH_TX_NOT_FOUND'); END IF;
  IF v_tx.journal_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_TX_ALREADY_BOOKED',
      'details', jsonb_build_object('journal_entry_id', v_tx.journal_entry_id));
  END IF;
  IF v_tx.amount = 0 THEN RETURN jsonb_build_object('ok', false, 'code', 'BATCH_TX_ZERO_AMOUNT'); END IF;
  v_tx_abs := ABS(v_tx.amount);
  IF jsonb_typeof(p_allocations) IS DISTINCT FROM 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_NO_ALLOCATIONS');
  END IF;

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
      IF v_alloc_amount > COALESCE(v_invoice.remaining_amount, v_invoice.total) + 0.005 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_OVERSHOOT',
          'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
            'requested', v_alloc_amount, 'remaining', COALESCE(v_invoice.remaining_amount, v_invoice.total)));
      END IF;
      IF v_invoice.currency IS DISTINCT FROM v_tx.currency THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CURRENCY_MISMATCH',
          'details', jsonb_build_object('index', v_alloc_index, 'invoice_id', v_invoice_id,
            'invoice_currency', v_invoice.currency, 'tx_currency', v_tx.currency));
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
      IF v_alloc_amount > COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total) + 0.005 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_OVERSHOOT',
          'details', jsonb_build_object('index', v_alloc_index, 'supplier_invoice_id', v_supplier_invoice_id,
            'requested', v_alloc_amount, 'remaining', COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total)));
      END IF;
      IF v_si_invoice.currency IS DISTINCT FROM v_tx.currency THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BATCH_CURRENCY_MISMATCH',
          'details', jsonb_build_object('index', v_alloc_index, 'supplier_invoice_id', v_supplier_invoice_id,
            'invoice_currency', v_si_invoice.currency, 'tx_currency', v_tx.currency));
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

  -- (4) Cross-allocation tolerance was 0.01 — harmonised to 0.005 to match
  -- the per-row overshoot guard and prevent a 1-öre drift accumulating
  -- across multi-allocation batches.
  IF v_total_allocated > v_tx_abs + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_AMOUNT_EXCEEDS_TX',
      'details', jsonb_build_object('allocated', v_total_allocated, 'tx_amount_abs', v_tx_abs));
  END IF;

  IF v_has_customer AND v_tx.amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_DIRECTION_MISMATCH',
      'details', jsonb_build_object('expected', 'income', 'tx_amount', v_tx.amount));
  END IF;
  IF v_has_supplier AND v_tx.amount >= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_DIRECTION_MISMATCH',
      'details', jsonb_build_object('expected', 'expense', 'tx_amount', v_tx.amount));
  END IF;

  -- (3) Deterministic period selection on overlap. ORDER BY period_start DESC
  -- picks the most recent matching period when, e.g., a corrected broken year
  -- has two periods covering the same date.
  SELECT id, is_closed, locked_at INTO v_fiscal_period_id, v_period_is_closed, v_period_locked_at
  FROM public.fiscal_periods
  WHERE company_id = p_company_id AND v_tx.date BETWEEN period_start AND period_end
  ORDER BY period_start DESC
  LIMIT 1;

  IF v_fiscal_period_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_NO_FISCAL_PERIOD',
      'details', jsonb_build_object('tx_date', v_tx.date));
  END IF;

  IF v_period_is_closed OR v_period_locked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_PERIOD_LOCKED',
      'details', jsonb_build_object('fiscal_period_id', v_fiscal_period_id,
        'is_closed', v_period_is_closed, 'locked_at', v_period_locked_at));
  END IF;

  v_entry_description := CASE WHEN v_has_customer THEN 'Samlingsinbetalning ' || v_tx.date ELSE 'Samlingsbetalning ' || v_tx.date END;

  -- (2) Direction-specific source_type so behandlingshistorik and
  -- source-type filters route correctly.
  v_source_type := CASE WHEN v_has_customer THEN 'invoice_paid' ELSE 'supplier_invoice_paid' END;

  INSERT INTO public.journal_entries
    (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, status)
  VALUES
    (v_journal_entry_id, p_user_id, p_company_id, v_fiscal_period_id, 0, v_voucher_series,
     v_tx.date, v_entry_description, v_source_type, 'draft');

  v_alloc_index := 0;
  FOR v_allocation IN
    SELECT value FROM jsonb_array_elements(p_allocations) AS t(value)
    ORDER BY COALESCE(value->>'invoice_id', value->>'supplier_invoice_id', '')
  LOOP
    v_alloc_amount := (v_allocation->>'amount')::numeric;
    IF v_has_customer THEN
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;
      SELECT invoice_number INTO v_invoice_number FROM public.invoices WHERE id = v_invoice_id;
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order, line_description)
      VALUES
        (v_journal_entry_id, '1510', 0, v_alloc_amount, v_tx.currency, v_line_sort_order,
         'Faktura ' || COALESCE(v_invoice_number, ''));
    ELSE
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;
      SELECT si.supplier_invoice_number, s.name
        INTO v_supplier_invoice_number, v_supplier_name
      FROM public.supplier_invoices si LEFT JOIN public.suppliers s ON s.id = si.supplier_id
      WHERE si.id = v_supplier_invoice_id;
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order, line_description)
      VALUES
        (v_journal_entry_id, '2440', v_alloc_amount, 0, v_tx.currency, v_line_sort_order,
         TRIM(BOTH ' - ' FROM COALESCE(v_supplier_name, '') || ' - ' || COALESCE(v_supplier_invoice_number, '')));
    END IF;
    v_line_sort_order := v_line_sort_order + 1;
    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  IF v_has_customer THEN
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order, line_description)
    VALUES
      (v_journal_entry_id, '1930', v_total_allocated, 0, v_tx.currency, v_line_sort_order,
       'Inbetalning ' || v_tx.date);
  ELSE
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order, line_description)
    VALUES
      (v_journal_entry_id, '1930', 0, v_total_allocated, v_tx.currency, v_line_sort_order,
       'Utbetalning ' || v_tx.date);
  END IF;

  SELECT voucher_number INTO v_voucher_number FROM public.commit_journal_entry(p_company_id, v_journal_entry_id);

  v_alloc_index := 0;
  FOR v_allocation IN
    SELECT value FROM jsonb_array_elements(p_allocations) AS t(value)
    ORDER BY COALESCE(value->>'invoice_id', value->>'supplier_invoice_id', '')
  LOOP
    v_alloc_amount := (v_allocation->>'amount')::numeric;
    IF v_has_customer THEN
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;
      SELECT * INTO v_invoice FROM public.invoices WHERE id = v_invoice_id;
      v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_alloc_amount) * 100) / 100;
      v_new_remaining := GREATEST(0,
        ROUND((COALESCE(v_invoice.remaining_amount, v_invoice.total) - v_alloc_amount) * 100) / 100);
      v_new_status := CASE WHEN v_new_remaining <= 0.005 THEN 'paid' ELSE 'partially_paid' END;
      UPDATE public.invoices SET status = v_new_status,
        paid_at = CASE WHEN v_new_status = 'paid' THEN v_now ELSE paid_at END,
        paid_amount = v_new_paid, remaining_amount = v_new_remaining, updated_at = v_now
      WHERE id = v_invoice_id;
      INSERT INTO public.invoice_payments
        (user_id, company_id, invoice_id, payment_date, amount, currency, exchange_rate,
         journal_entry_id, transaction_id)
      VALUES
        (p_user_id, p_company_id, v_invoice_id, v_tx.date, v_alloc_amount, v_invoice.currency,
         v_invoice.exchange_rate, v_journal_entry_id, p_tx_id)
      RETURNING id INTO v_payment_id;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'kind', 'customer_invoice', 'invoice_id', v_invoice_id, 'payment_id', v_payment_id,
        'status', v_new_status, 'paid_amount', v_new_paid, 'remaining_amount', v_new_remaining,
        'amount', v_alloc_amount));
    ELSE
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;
      SELECT * INTO v_si_invoice FROM public.supplier_invoices WHERE id = v_supplier_invoice_id;
      v_new_paid := ROUND((COALESCE(v_si_invoice.paid_amount, 0) + v_alloc_amount) * 100) / 100;
      v_new_remaining := GREATEST(0,
        ROUND((COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total) - v_alloc_amount) * 100) / 100);
      v_new_status := CASE WHEN v_new_remaining <= 0.005 THEN 'paid' ELSE 'partially_paid' END;
      UPDATE public.supplier_invoices SET status = v_new_status,
        paid_at = CASE WHEN v_new_status = 'paid' THEN v_now ELSE paid_at END,
        paid_amount = v_new_paid, remaining_amount = v_new_remaining,
        payment_journal_entry_id = v_journal_entry_id, updated_at = v_now
      WHERE id = v_supplier_invoice_id;
      INSERT INTO public.supplier_invoice_payments
        (user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
         journal_entry_id, transaction_id)
      VALUES
        (p_user_id, p_company_id, v_supplier_invoice_id, v_tx.date, v_alloc_amount,
         v_si_invoice.currency, v_journal_entry_id, p_tx_id)
      RETURNING id INTO v_payment_id;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'kind', 'supplier_invoice', 'supplier_invoice_id', v_supplier_invoice_id,
        'payment_id', v_payment_id, 'status', v_new_status, 'paid_amount', v_new_paid,
        'remaining_amount', v_new_remaining, 'amount', v_alloc_amount));
    END IF;
    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  -- (5) transactions.category is only meaningful 1:1 with a single invoice.
  -- Forcing 'income_services' (→ BAS 3001 at 25% VAT) for multi-allocation
  -- customer batches misrepresents reduced/zero-rated revenue. For
  -- single-allocation full-amount batches the existing
  -- match-invoice/match-supplier-invoice path is the canonical writer;
  -- this RPC leaves the category as-is.
  UPDATE public.transactions SET journal_entry_id = v_journal_entry_id, is_business = TRUE,
    invoice_id = CASE WHEN jsonb_array_length(p_allocations) = 1 AND v_has_customer AND ABS(v_total_allocated - v_tx_abs) < 0.005
      THEN (p_allocations->0->>'invoice_id')::uuid ELSE NULL END,
    supplier_invoice_id = CASE WHEN jsonb_array_length(p_allocations) = 1 AND v_has_supplier AND ABS(v_total_allocated - v_tx_abs) < 0.005
      THEN (p_allocations->0->>'supplier_invoice_id')::uuid ELSE NULL END,
    potential_invoice_id = NULL, potential_supplier_invoice_id = NULL,
    updated_at = v_now WHERE id = p_tx_id;

  RETURN jsonb_build_object('ok', true, 'journal_entry_id', v_journal_entry_id,
    'voucher_series', v_voucher_series, 'voucher_number', v_voucher_number,
    'tx_id', p_tx_id, 'allocations', v_results, 'total_allocated', v_total_allocated,
    'leftover', ROUND((v_tx_abs - v_total_allocated) * 100) / 100);
END;
$$;

NOTIFY pgrst, 'reload schema';
