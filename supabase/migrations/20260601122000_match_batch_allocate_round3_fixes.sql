-- PR #607 review round-3 fixes.
--
-- Genuine findings on round 2 (not historical-migration retro):
--
--   1. V4.5 — drop p_user_id from the RPC signature entirely. Round 2
--      added a guard rejecting mismatched values, but the parameter
--      itself is the attack surface; removing it eliminates the
--      possibility of attribute confusion at the API boundary.
--
--   2. V2.2 — DB-level CHECK constraint on invoices.exchange_rate and
--      supplier_invoices.exchange_rate. UI and RPC both apply the
--      0 < rate < 100000 bound; the schema is the third (and most
--      authoritative) layer. We use NOT VALID on the ADD CONSTRAINT
--      then VALIDATE to keep the migration fast on existing rows
--      (and to make legacy rows with NULL pass — they're already
--      handled by the RPC guard).
--
--   3. Swedish-compliance traceability — payment row needs to retain
--      the actual payment-day exchange rate, not just the invoicing
--      rate, so FX diffs are reconstructible from the payment record
--      alone (BFL 7 kap behandlingshistorik, BFNAR 2013:2 kap 8). Adds
--      payment_exchange_rate column to both invoice_payments and
--      supplier_invoice_payments; the RPC populates it as
--      v_alloc_amount / v_inv_remaining for cross-currency rows
--      (= same as invoice exchange_rate for same-currency rows).
--
-- Same-currency invariants unchanged. Function body byte-identical to
-- round 2 except the parameter list and the new payment_exchange_rate
-- writes.

-- 1. CHECK constraints on invoice exchange rates (V2.2)
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_exchange_rate_check;
ALTER TABLE public.invoices ADD CONSTRAINT invoices_exchange_rate_check
  CHECK (exchange_rate IS NULL OR (exchange_rate > 0 AND exchange_rate < 100000)) NOT VALID;
ALTER TABLE public.invoices VALIDATE CONSTRAINT invoices_exchange_rate_check;

ALTER TABLE public.supplier_invoices DROP CONSTRAINT IF EXISTS supplier_invoices_exchange_rate_check;
ALTER TABLE public.supplier_invoices ADD CONSTRAINT supplier_invoices_exchange_rate_check
  CHECK (exchange_rate IS NULL OR (exchange_rate > 0 AND exchange_rate < 100000)) NOT VALID;
ALTER TABLE public.supplier_invoices VALIDATE CONSTRAINT supplier_invoices_exchange_rate_check;

-- 2. payment_exchange_rate column on both payment tables (traceability)
ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS payment_exchange_rate numeric
  CHECK (payment_exchange_rate IS NULL OR (payment_exchange_rate > 0 AND payment_exchange_rate < 100000));

ALTER TABLE public.supplier_invoice_payments
  ADD COLUMN IF NOT EXISTS payment_exchange_rate numeric
  CHECK (payment_exchange_rate IS NULL OR (payment_exchange_rate > 0 AND payment_exchange_rate < 100000));

COMMENT ON COLUMN public.invoice_payments.payment_exchange_rate IS
  'Effective payment-day SEK/foreign rate, derived from v_alloc_amount / v_inv_remaining. Distinct from exchange_rate (invoicing rate). Populated by match_batch_allocate for cross-currency rows; NULL for same-currency.';
COMMENT ON COLUMN public.supplier_invoice_payments.payment_exchange_rate IS
  'Effective payment-day SEK/foreign rate, derived from v_alloc_amount / v_inv_remaining. Distinct from exchange_rate (invoicing rate). Populated by match_batch_allocate for cross-currency rows; NULL for same-currency.';

-- 3. Drop the 4-arg signature and re-create with 3 args (V4.5).
DROP FUNCTION IF EXISTS public.match_batch_allocate(uuid, jsonb, uuid, uuid);

CREATE OR REPLACE FUNCTION public.match_batch_allocate(
  p_tx_id uuid,
  p_allocations jsonb,
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
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_UNAUTHORIZED');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = v_caller AND company_id = p_company_id
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
  v_tx_date_short := LEFT(v_tx.date::text, 10);

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

      v_inv_remaining := COALESCE(v_invoice.remaining_amount, v_invoice.total);
      v_inv_currency := v_invoice.currency;
      v_inv_fx_rate := v_invoice.exchange_rate;

      IF v_inv_currency = v_tx.currency THEN
        IF v_alloc_amount > v_inv_remaining + 0.005 THEN
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
        v_booked_sek := ROUND(v_inv_remaining * v_inv_fx_rate * 100) / 100;
        IF ABS(v_alloc_amount - v_booked_sek) > v_booked_sek * 0.10 THEN
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

      IF v_inv_currency = v_tx.currency THEN
        IF v_alloc_amount > v_inv_remaining + 0.005 THEN
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
        v_booked_sek := ROUND(v_inv_remaining * v_inv_fx_rate * 100) / 100;
        IF ABS(v_alloc_amount - v_booked_sek) > v_booked_sek * 0.10 THEN
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

  IF v_total_allocated > v_tx_abs + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_AMOUNT_EXCEEDS_TX',
      'details', jsonb_build_object('allocated', v_total_allocated, 'tx_amount_abs', v_tx_abs));
  END IF;
  IF v_total_allocated < v_tx_abs - 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BATCH_AMOUNT_BELOW_TX',
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

  v_entry_description := CASE WHEN v_has_customer THEN 'Samlingsinbetalning ' || v_tx_date_short ELSE 'Samlingsbetalning ' || v_tx_date_short END;
  v_source_type := CASE WHEN v_has_customer THEN 'invoice_paid' ELSE 'supplier_invoice_paid' END;

  INSERT INTO public.journal_entries
    (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, status)
  VALUES
    (v_journal_entry_id, v_caller, p_company_id, v_fiscal_period_id, 0, v_voucher_series,
     v_tx.date, v_entry_description, v_source_type, 'draft');

  v_alloc_index := 0;
  FOR v_allocation IN
    SELECT value FROM jsonb_array_elements(p_allocations) AS t(value)
    ORDER BY COALESCE(value->>'invoice_id', value->>'supplier_invoice_id', '')
  LOOP
    v_alloc_amount := (v_allocation->>'amount')::numeric;

    IF v_has_customer THEN
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;
      SELECT invoice_number, currency, exchange_rate, remaining_amount, total
        INTO v_invoice_number, v_inv_currency, v_inv_fx_rate, v_inv_remaining, v_inv_total
      FROM public.invoices
      WHERE id = v_invoice_id AND company_id = p_company_id;
      v_inv_remaining := COALESCE(v_inv_remaining, v_inv_total);
      v_inv_number_short := LEFT(COALESCE(v_invoice_number, ''), 32);

      IF v_inv_currency = v_tx.currency THEN
        INSERT INTO public.journal_entry_lines
          (journal_entry_id, account_number, debit_amount, credit_amount, currency,
           sort_order, line_description)
        VALUES
          (v_journal_entry_id, '1510', 0, v_alloc_amount, v_tx.currency, v_line_sort_order,
           'Faktura ' || v_inv_number_short);
        v_line_sort_order := v_line_sort_order + 1;
      ELSE
        v_booked_sek := ROUND(v_inv_remaining * v_inv_fx_rate * 100) / 100;
        v_fx_diff := ROUND((v_booked_sek - v_alloc_amount) * 100) / 100;

        INSERT INTO public.journal_entry_lines
          (journal_entry_id, account_number, debit_amount, credit_amount, currency,
           sort_order, line_description)
        VALUES
          (v_journal_entry_id, '1510', 0, v_booked_sek, v_tx.currency, v_line_sort_order,
           'Faktura ' || v_inv_number_short || ' (' || v_inv_currency || ')');
        v_line_sort_order := v_line_sort_order + 1;

        IF ABS(v_fx_diff) > 0.005 THEN
          IF v_fx_diff > 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description)
            VALUES
              (v_journal_entry_id, '7960', v_fx_diff, 0, v_tx.currency, v_line_sort_order,
               'Valutakursförlust ' || v_inv_number_short);
          ELSE
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description)
            VALUES
              (v_journal_entry_id, '3960', 0, ABS(v_fx_diff), v_tx.currency, v_line_sort_order,
               'Valutakursvinst ' || v_inv_number_short);
          END IF;
          v_line_sort_order := v_line_sort_order + 1;
        END IF;
      END IF;

    ELSE
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;
      SELECT si.supplier_invoice_number, s.name, si.currency, si.exchange_rate,
             si.remaining_amount, si.total
        INTO v_supplier_invoice_number, v_supplier_name, v_inv_currency, v_inv_fx_rate,
             v_inv_remaining, v_inv_total
      FROM public.supplier_invoices si LEFT JOIN public.suppliers s ON s.id = si.supplier_id
      WHERE si.id = v_supplier_invoice_id AND si.company_id = p_company_id;
      v_inv_remaining := COALESCE(v_inv_remaining, v_inv_total);
      v_inv_number_short := LEFT(COALESCE(v_supplier_invoice_number, ''), 32);

      IF v_inv_currency = v_tx.currency THEN
        INSERT INTO public.journal_entry_lines
          (journal_entry_id, account_number, debit_amount, credit_amount, currency,
           sort_order, line_description)
        VALUES
          (v_journal_entry_id, '2440', v_alloc_amount, 0, v_tx.currency, v_line_sort_order,
           TRIM(BOTH ' - ' FROM COALESCE(v_supplier_name, '') || ' - ' || v_inv_number_short));
        v_line_sort_order := v_line_sort_order + 1;
      ELSE
        v_booked_sek := ROUND(v_inv_remaining * v_inv_fx_rate * 100) / 100;
        v_fx_diff := ROUND((v_booked_sek - v_alloc_amount) * 100) / 100;

        INSERT INTO public.journal_entry_lines
          (journal_entry_id, account_number, debit_amount, credit_amount, currency,
           sort_order, line_description)
        VALUES
          (v_journal_entry_id, '2440', v_booked_sek, 0, v_tx.currency, v_line_sort_order,
           TRIM(BOTH ' - ' FROM
             COALESCE(v_supplier_name, '') || ' - ' || v_inv_number_short
             || ' (' || v_inv_currency || ')'));
        v_line_sort_order := v_line_sort_order + 1;

        IF ABS(v_fx_diff) > 0.005 THEN
          IF v_fx_diff > 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description)
            VALUES
              (v_journal_entry_id, '3960', 0, v_fx_diff, v_tx.currency, v_line_sort_order,
               'Valutakursvinst ' || v_inv_number_short);
          ELSE
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description)
            VALUES
              (v_journal_entry_id, '7960', ABS(v_fx_diff), 0, v_tx.currency, v_line_sort_order,
               'Valutakursförlust ' || v_inv_number_short);
          END IF;
          v_line_sort_order := v_line_sort_order + 1;
        END IF;
      END IF;
    END IF;
    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  IF v_has_customer THEN
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency,
       sort_order, line_description)
    VALUES
      (v_journal_entry_id, '1930', v_tx_abs, 0, v_tx.currency, v_line_sort_order,
       'Inbetalning ' || v_tx_date_short);
  ELSE
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency,
       sort_order, line_description)
    VALUES
      (v_journal_entry_id, '1930', 0, v_tx_abs, v_tx.currency, v_line_sort_order,
       'Utbetalning ' || v_tx_date_short);
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
      SELECT * INTO v_invoice FROM public.invoices
      WHERE id = v_invoice_id AND company_id = p_company_id;

      IF v_invoice.currency = v_tx.currency THEN
        v_paid_in_inv_currency := v_alloc_amount;
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
        paid_at = CASE WHEN v_new_status = 'paid' THEN v_now ELSE paid_at END,
        paid_amount = v_new_paid, remaining_amount = v_new_remaining, updated_at = v_now
      WHERE id = v_invoice_id AND company_id = p_company_id;

      INSERT INTO public.invoice_payments
        (user_id, company_id, invoice_id, payment_date, amount, currency, exchange_rate,
         payment_exchange_rate, journal_entry_id, transaction_id)
      VALUES
        (v_caller, p_company_id, v_invoice_id, v_tx.date, v_paid_in_inv_currency, v_invoice.currency,
         v_invoice.exchange_rate, v_payment_rate, v_journal_entry_id, p_tx_id)
      RETURNING id INTO v_payment_id;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'kind', 'customer_invoice', 'invoice_id', v_invoice_id, 'payment_id', v_payment_id,
        'status', v_new_status, 'paid_amount', v_new_paid, 'remaining_amount', v_new_remaining,
        'amount', v_alloc_amount,
        'cross_currency', v_invoice.currency <> v_tx.currency));
    ELSE
      v_supplier_invoice_id := (v_allocation->>'supplier_invoice_id')::uuid;
      SELECT * INTO v_si_invoice FROM public.supplier_invoices
      WHERE id = v_supplier_invoice_id AND company_id = p_company_id;

      IF v_si_invoice.currency = v_tx.currency THEN
        v_paid_in_inv_currency := v_alloc_amount;
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
        paid_at = CASE WHEN v_new_status = 'paid' THEN v_now ELSE paid_at END,
        paid_amount = v_new_paid, remaining_amount = v_new_remaining,
        payment_journal_entry_id = v_journal_entry_id, updated_at = v_now
      WHERE id = v_supplier_invoice_id AND company_id = p_company_id;

      INSERT INTO public.supplier_invoice_payments
        (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, exchange_rate,
         payment_exchange_rate, journal_entry_id, transaction_id)
      VALUES
        (v_caller, p_company_id, v_supplier_invoice_id, v_tx.date, v_paid_in_inv_currency,
         v_si_invoice.currency, v_si_invoice.exchange_rate, v_payment_rate, v_journal_entry_id, p_tx_id)
      RETURNING id INTO v_payment_id;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'kind', 'supplier_invoice', 'supplier_invoice_id', v_supplier_invoice_id,
        'payment_id', v_payment_id, 'status', v_new_status, 'paid_amount', v_new_paid,
        'remaining_amount', v_new_remaining, 'amount', v_alloc_amount,
        'cross_currency', v_si_invoice.currency <> v_tx.currency));
    END IF;
    v_alloc_index := v_alloc_index + 1;
  END LOOP;

  UPDATE public.transactions SET journal_entry_id = v_journal_entry_id, is_business = TRUE,
    invoice_id = CASE WHEN jsonb_array_length(p_allocations) = 1 AND v_has_customer AND ABS(v_total_allocated - v_tx_abs) < 0.005
      THEN (p_allocations->0->>'invoice_id')::uuid ELSE NULL END,
    supplier_invoice_id = CASE WHEN jsonb_array_length(p_allocations) = 1 AND v_has_supplier AND ABS(v_total_allocated - v_tx_abs) < 0.005
      THEN (p_allocations->0->>'supplier_invoice_id')::uuid ELSE NULL END,
    potential_invoice_id = NULL, potential_supplier_invoice_id = NULL,
    updated_at = v_now WHERE id = p_tx_id AND company_id = p_company_id;

  RETURN jsonb_build_object('ok', true, 'journal_entry_id', v_journal_entry_id,
    'voucher_series', v_voucher_series, 'voucher_number', v_voucher_number,
    'tx_id', p_tx_id, 'allocations', v_results, 'total_allocated', v_total_allocated,
    'leftover', 0);
END;
$$;

NOTIFY pgrst, 'reload schema';
