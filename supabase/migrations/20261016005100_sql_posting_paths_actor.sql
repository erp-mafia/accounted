-- The SQL posting paths record WHO committed their verifikat (attribution
-- step 2, Phase 1 "the actor record on every write", founder-accepted
-- 2026-10-15).
--
-- Four RPCs post a verifikat themselves through commit_journal_entry and
-- passed it no actor, so committed_actor_type / committed_actor_label stayed
-- NULL and the audit_log COMMIT row fell back to 'user' whoever acted:
--   match_batch_allocate              the samlingsverifikat of a bank
--                                     transaction against N invoices
--   create_expense_payout_batch       the reimbursement of N expense claims
--   link_invoice_to_voucher           the kursdifferens verifikat (3960/7960)
--   link_supplier_invoice_to_voucher  the same on the supplier side
--
-- Each gains two defaulted parameters, p_actor_type and p_actor_label, and
-- forwards them to commit_journal_entry, which stamps the verifikat and the
-- audit row (20260619120000). The application doors in engine.ts pass the
-- actor of the request (rpcWithActor). commit_method stays as it was (NULL)
-- on these paths. A positional caller in SQL
-- (commit_provider_migration_followup calls link_supplier_invoice_to_voucher
-- with five arguments) still resolves and records no actor, as before.
--
-- Each function is the newest definition copied byte for byte, with only the
-- two parameters and the commit_journal_entry arguments added; no later
-- migration redefines or patches any of them:
--   match_batch_allocate              20260929144012_match_batch_allocate_dimensions_and_series
--   create_expense_payout_batch       20261012100100_restate_patched_functions
--   link_invoice_to_voucher           20260928201200_link_voucher_rpcs_document_dimensions
--   link_supplier_invoice_to_voucher  20261011153000_link_supplier_invoice_to_voucher_share
-- The old signatures are dropped, so PostgREST never has two candidates;
-- grants (authenticated, service_role; not PUBLIC or anon) and comments are
-- restated as they were.
--
-- Rollout: an older deploy calls without the new parameters and still
-- resolves (defaults). A newer deploy that reaches a database without this
-- migration gets PGRST202 and retries once without them
-- (src/lib/bookkeeping/actor-rpc.ts).
--
-- pg-test: tests/pg/sql-posting-paths-actor.pg.test.ts

DROP FUNCTION IF EXISTS public.match_batch_allocate(uuid, jsonb, uuid, uuid);

CREATE OR REPLACE FUNCTION public.match_batch_allocate(
  p_tx_id uuid,
  p_allocations jsonb,
  p_company_id uuid,
  p_user_id uuid DEFAULT NULL::uuid,
  p_actor_type text DEFAULT NULL::text,
  p_actor_label text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tx RECORD;
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
        -- #1717: a sub-krona overshoot is öresavrundning (whole-krona
        -- settlement of an öre total), absorbed into 3740 below. Only an
        -- excess of >= 1.00 kr is a real overpayment. Mirrors
        -- planInvoicePayment (lib/invoices/apply-invoice-payment.ts).
        IF ROUND((v_alloc_amount - v_inv_remaining) * 100) / 100 >= 1.00 THEN
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
        -- #1717: same öresavrundning band as the customer side above.
        IF ROUND((v_alloc_amount - v_inv_remaining) * 100) / 100 >= 1.00 THEN
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

  -- One invoice: the header names it in the single-invoice match routes'
  -- wording (app/api/transactions/[id]/match-invoice and
  -- match-supplier-invoice), the name part left off when there is none.
  -- The customer invoice number is the one shown everywhere
  -- (invoiceDisplayNumber, lib/invoices/display.ts): a self-billed invoice
  -- has no own number, so its external_invoice_number. Two or more keep
  -- the samlingsverifikation wording.
  IF jsonb_array_length(p_allocations) = 1 THEN
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
  v_source_type := CASE WHEN v_has_customer THEN 'invoice_paid' ELSE 'supplier_invoice_paid' END;

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

  v_alloc_index := 0;
  FOR v_allocation IN
    SELECT value FROM jsonb_array_elements(p_allocations) AS t(value)
    ORDER BY COALESCE(value->>'invoice_id', value->>'supplier_invoice_id', '')
  LOOP
    v_alloc_amount := (v_allocation->>'amount')::numeric;

    IF v_has_customer THEN
      v_invoice_id := (v_allocation->>'invoice_id')::uuid;
      SELECT invoice_number, currency, exchange_rate, remaining_amount, total,
             public.coerce_dimensions_bag(default_dimensions)
        INTO v_invoice_number, v_inv_currency, v_inv_fx_rate, v_inv_remaining, v_inv_total,
             v_doc_dims
      FROM public.invoices
      WHERE id = v_invoice_id AND company_id = p_company_id;
      v_inv_remaining := COALESCE(v_inv_remaining, v_inv_total);
      v_inv_number_short := LEFT(COALESCE(v_invoice_number, ''), 32);

      IF v_inv_currency = v_tx.currency THEN
        -- #1717: inside the öresavrundning band, clear the FULL remaining off
        -- 1510 so the invoice reaches 'paid' and let 3740 carry the residual.
        -- Customer short-paid = Dr 3740 (förlust); over-paid = Cr 3740
        -- (vinst), same polarity as buildInvoicePaymentClearingLines. The
        -- bank leg (tx_abs) is unchanged, so the entry stays balanced: the
        -- net credit of 1510 + 3740 equals the allocation exactly.
        v_ore_diff := ROUND((v_inv_remaining - v_alloc_amount) * 100) / 100;
        IF v_ore_diff <> 0 AND ABS(v_ore_diff) < 1.00 THEN
          INSERT INTO public.journal_entry_lines
            (journal_entry_id, account_number, debit_amount, credit_amount, currency,
             sort_order, line_description, dimensions)
          VALUES
            (v_journal_entry_id, '1510', 0, ROUND(v_inv_remaining * 100) / 100, v_tx.currency, v_line_sort_order,
             'Faktura ' || v_inv_number_short, v_doc_dims);
          v_line_sort_order := v_line_sort_order + 1;
          IF v_ore_diff > 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3740', v_ore_diff, 0, v_tx.currency, v_line_sort_order,
               'Öresavrundning', v_doc_dims);
          ELSE
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3740', 0, ABS(v_ore_diff), v_tx.currency, v_line_sort_order,
               'Öresavrundning', v_doc_dims);
          END IF;
          v_line_sort_order := v_line_sort_order + 1;
        ELSE
          INSERT INTO public.journal_entry_lines
            (journal_entry_id, account_number, debit_amount, credit_amount, currency,
             sort_order, line_description, dimensions)
          VALUES
            (v_journal_entry_id, '1510', 0, v_alloc_amount, v_tx.currency, v_line_sort_order,
             'Faktura ' || v_inv_number_short, v_doc_dims);
          v_line_sort_order := v_line_sort_order + 1;
        END IF;
      ELSE
        v_booked_sek := ROUND(v_inv_remaining * v_inv_fx_rate * 100) / 100;
        v_fx_diff := ROUND((v_booked_sek - v_alloc_amount) * 100) / 100;

        INSERT INTO public.journal_entry_lines
          (journal_entry_id, account_number, debit_amount, credit_amount, currency,
           sort_order, line_description, dimensions)
        VALUES
          (v_journal_entry_id, '1510', 0, v_booked_sek, v_tx.currency, v_line_sort_order,
           'Faktura ' || v_inv_number_short || ' (' || v_inv_currency || ')', v_doc_dims);
        v_line_sort_order := v_line_sort_order + 1;

        IF ABS(v_fx_diff) > 0.005 THEN
          IF v_fx_diff > 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '7960', v_fx_diff, 0, v_tx.currency, v_line_sort_order,
               'Valutakursförlust ' || v_inv_number_short, v_doc_dims);
          ELSE
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3960', 0, ABS(v_fx_diff), v_tx.currency, v_line_sort_order,
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

      IF v_inv_currency = v_tx.currency THEN
        -- #1717: supplier mirror of the customer branch above. Clear the FULL
        -- remaining off 2440; polarity per buildSupplierPaymentClearingLines:
        -- bank paid less than owed = Cr 3740 (vinst), more = Dr 3740
        -- (förlust).
        v_ore_diff := ROUND((v_inv_remaining - v_alloc_amount) * 100) / 100;
        IF v_ore_diff <> 0 AND ABS(v_ore_diff) < 1.00 THEN
          INSERT INTO public.journal_entry_lines
            (journal_entry_id, account_number, debit_amount, credit_amount, currency,
             sort_order, line_description, dimensions)
          VALUES
            (v_journal_entry_id, '2440', ROUND(v_inv_remaining * 100) / 100, 0, v_tx.currency, v_line_sort_order,
             TRIM(BOTH ' - ' FROM COALESCE(v_supplier_name, '') || ' - ' || v_inv_number_short), v_doc_dims);
          v_line_sort_order := v_line_sort_order + 1;
          IF v_ore_diff > 0 THEN
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3740', 0, v_ore_diff, v_tx.currency, v_line_sort_order,
               'Öresavrundning', v_doc_dims);
          ELSE
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '3740', ABS(v_ore_diff), 0, v_tx.currency, v_line_sort_order,
               'Öresavrundning', v_doc_dims);
          END IF;
          v_line_sort_order := v_line_sort_order + 1;
        ELSE
          INSERT INTO public.journal_entry_lines
            (journal_entry_id, account_number, debit_amount, credit_amount, currency,
             sort_order, line_description, dimensions)
          VALUES
            (v_journal_entry_id, '2440', v_alloc_amount, 0, v_tx.currency, v_line_sort_order,
             TRIM(BOTH ' - ' FROM COALESCE(v_supplier_name, '') || ' - ' || v_inv_number_short), v_doc_dims);
          v_line_sort_order := v_line_sort_order + 1;
        END IF;
      ELSE
        v_booked_sek := ROUND(v_inv_remaining * v_inv_fx_rate * 100) / 100;
        v_fx_diff := ROUND((v_booked_sek - v_alloc_amount) * 100) / 100;

        INSERT INTO public.journal_entry_lines
          (journal_entry_id, account_number, debit_amount, credit_amount, currency,
           sort_order, line_description, dimensions)
        VALUES
          (v_journal_entry_id, '2440', v_booked_sek, 0, v_tx.currency, v_line_sort_order,
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
              (v_journal_entry_id, '3960', 0, v_fx_diff, v_tx.currency, v_line_sort_order,
               'Valutakursvinst ' || v_inv_number_short, v_doc_dims);
          ELSE
            INSERT INTO public.journal_entry_lines
              (journal_entry_id, account_number, debit_amount, credit_amount, currency,
               sort_order, line_description, dimensions)
            VALUES
              (v_journal_entry_id, '7960', ABS(v_fx_diff), 0, v_tx.currency, v_line_sort_order,
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

  IF v_has_customer THEN
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency,
       sort_order, line_description, dimensions)
    VALUES
      (v_journal_entry_id, v_bank_account, v_tx_abs, 0, v_tx.currency, v_line_sort_order,
       'Inbetalning ' || v_tx_date_short, v_bank_dims);
  ELSE
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency,
       sort_order, line_description, dimensions)
    VALUES
      (v_journal_entry_id, v_bank_account, 0, v_tx_abs, v_tx.currency, v_line_sort_order,
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

      IF v_invoice.currency = v_tx.currency THEN
        -- #1717: inside the öresavrundning band the invoice settles in full
        -- (the 3740 line carries the difference), so the payment records the
        -- FULL remaining: paid_amount accumulates it, remaining lands on 0
        -- and the status flips to 'paid'. Same convention as
        -- planInvoicePayment.
        v_inv_remaining := ROUND(COALESCE(v_invoice.remaining_amount, v_invoice.total) * 100) / 100;
        v_ore_diff := ROUND((v_inv_remaining - v_alloc_amount) * 100) / 100;
        IF v_ore_diff <> 0 AND ABS(v_ore_diff) < 1.00 THEN
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
        -- #1717: supplier mirror of the customer branch above.
        v_inv_remaining := ROUND(COALESCE(v_si_invoice.remaining_amount, v_si_invoice.total) * 100) / 100;
        v_ore_diff := ROUND((v_inv_remaining - v_alloc_amount) * 100) / 100;
        IF v_ore_diff <> 0 AND ABS(v_ore_diff) < 1.00 THEN
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
$function$;

REVOKE ALL ON FUNCTION public.match_batch_allocate(uuid, jsonb, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_batch_allocate(uuid, jsonb, uuid, uuid, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.match_batch_allocate(uuid, jsonb, uuid, uuid, text, text) IS
  'Books one bank transaction against N invoices/supplier invoices in a single samlingsverifikat. Sub-krona differences between an allocation and the invoice remaining are absorbed to 3740 (öresavrundning) so the invoice settles fully. Every line belonging to one allocation (1510/2440, 3740, 3960/7960) carries that document''s default_dimensions (coerce_dimensions_bag); the bank line carries the bag only when every settled document shares it. p_user_id is honored only for service_role callers (the pending-operations commit path); every other caller resolves from its own auth.uid(). Not callable by anon.';

DROP FUNCTION IF EXISTS public.create_expense_payout_batch(uuid, uuid[], date, text, text, uuid, uuid);

CREATE OR REPLACE FUNCTION public.create_expense_payout_batch(p_company_id uuid, p_claim_ids uuid[], p_payout_date date, p_cash_account text, p_notes text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid, p_transaction_id uuid DEFAULT NULL::uuid, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_ids uuid[];
  v_claim record;
  v_count integer := 0;
  v_first boolean := true;
  v_employee_id uuid;
  v_claimant_name text;
  v_claimant_key text;
  v_liability text;
  v_total numeric(15,2) := 0;
  v_period_id uuid;
  v_period_locked_at timestamptz;
  v_series text := 'A';
  v_series_raw text;
  v_batch_id uuid := gen_random_uuid();
  v_je_id uuid := gen_random_uuid();
  v_voucher_number integer;
  v_desc text;
  v_marked integer;
  v_tx record;
  v_tx_updated integer;
  v_debit text;
  v_payslip record;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  -- Same gate as the expense tables' write policies (owner/admin/member);
  -- SECURITY DEFINER bypasses RLS, so the check has to be explicit.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = v_caller
      AND cm.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  SELECT ARRAY(SELECT DISTINCT unnest(p_claim_ids)) INTO v_ids;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_CLAIMS');
  END IF;
  IF p_cash_account IS NULL OR p_cash_account !~ '^19[0-9]{2}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_CASH_ACCOUNT');
  END IF;

  PERFORM public.lock_cash_account_booking_state(p_company_id);

  -- Lock the claims. A concurrent caller for any of the same rows queues on
  -- this lock and, once this transaction commits, reads them as 'paid'.
  FOR v_claim IN
    SELECT ec.id, ec.status, ec.employee_id, ec.claimant_name, ec.liability_account, ec.amount_sek
    FROM public.expense_claims ec
    WHERE ec.id = ANY(v_ids)
      AND ec.company_id = p_company_id
    ORDER BY ec.id
    FOR UPDATE
  LOOP
    v_count := v_count + 1;
    IF v_claim.status <> 'registered' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_PAID',
        'details', jsonb_build_object('claim_id', v_claim.id));
    END IF;
    -- A claim on a payslip line is repaid by that salary run (#2331): a bank
    -- transfer on top would pay the person twice. Remove the line from the
    -- draft payslip first if the bank path is the intended one.
    SELECT sr.id AS salary_run_id, sr.period_year, sr.period_month, sr.status
      INTO v_payslip
    FROM public.salary_line_items sli
    JOIN public.salary_run_employees sre ON sre.id = sli.salary_run_employee_id
    JOIN public.salary_runs sr ON sr.id = sre.salary_run_id
    WHERE sli.source_expense_claim_id = v_claim.id
      AND sli.company_id = p_company_id
    LIMIT 1;
    IF v_payslip.salary_run_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ON_PAYSLIP',
        'details', jsonb_build_object(
          'claim_id', v_claim.id,
          'salary_run_id', v_payslip.salary_run_id,
          'salary_run_status', v_payslip.status,
          'period', v_payslip.period_year::text || '-' || lpad(v_payslip.period_month::text, 2, '0')));
    END IF;
    IF v_first THEN
      v_employee_id := v_claim.employee_id;
      v_claimant_name := v_claim.claimant_name;
      v_claimant_key := COALESCE(v_claim.employee_id::text, 'name:' || lower(btrim(v_claim.claimant_name)));
      v_liability := v_claim.liability_account;
      v_first := false;
    ELSE
      IF COALESCE(v_claim.employee_id::text, 'name:' || lower(btrim(v_claim.claimant_name))) <> v_claimant_key THEN
        RETURN jsonb_build_object('ok', false, 'code', 'MIXED_CLAIMANTS');
      END IF;
      IF v_claim.liability_account <> v_liability THEN
        RETURN jsonb_build_object('ok', false, 'code', 'MIXED_LIABILITY');
      END IF;
    END IF;
    v_total := v_total + v_claim.amount_sek;
  END LOOP;

  IF v_count <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CLAIMS_NOT_FOUND');
  END IF;

  -- Bank-line mode: the transfer that repays these claims. Locked with the
  -- claims so a concurrent categorisation of the same row waits and then
  -- sees it booked. The amount must equal the claims exactly (öre): a partial
  -- transfer is a different payout, chosen by a different set of claims.
  IF p_transaction_id IS NOT NULL THEN
    SELECT t.id, t.amount, t.currency, t.date
      INTO v_tx
    FROM public.transactions t
    WHERE t.id = p_transaction_id
      AND t.company_id = p_company_id
    FOR UPDATE;
    IF v_tx.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_NOT_FOUND');
    END IF;
    IF public.is_transaction_booked(v_tx.id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_ALREADY_BOOKED');
    END IF;
    IF upper(COALESCE(v_tx.currency, 'SEK')) <> 'SEK' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_CURRENCY',
        'details', jsonb_build_object('currency', v_tx.currency));
    END IF;
    IF v_tx.amount >= 0 OR round(-v_tx.amount, 2) <> v_total THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_AMOUNT_MISMATCH',
        'details', jsonb_build_object('transaction_amount', v_tx.amount, 'claims_total', v_total));
    END IF;
  END IF;

  -- Open fiscal year covering the payout date (mirrors engine.findFiscalPeriod).
  SELECT fp.id, fp.locked_at
    INTO v_period_id, v_period_locked_at
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND fp.period_start <= p_payout_date
    AND fp.period_end >= p_payout_date
    AND fp.is_closed = false
  ORDER BY fp.period_start DESC
  LIMIT 1;
  IF v_period_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_PERIOD_NOT_FOUND');
  END IF;
  IF v_period_locked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PERIOD_LOCKED',
      'details', jsonb_build_object('fiscal_period_id', v_period_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts a
    WHERE a.company_id = p_company_id
      AND a.account_number = p_cash_account
      AND COALESCE(a.is_active, true)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACCOUNT_NOT_IN_CHART',
      'details', jsonb_build_object('account', p_cash_account));
  END IF;
  v_debit := CASE WHEN v_liability = '2018' THEN '2013' ELSE v_liability END;
  IF NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts a
    WHERE a.company_id = p_company_id
      AND a.account_number = v_debit
      AND COALESCE(a.is_active, true)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACCOUNT_NOT_IN_CHART',
      'details', jsonb_build_object('account', v_debit));
  END IF;

  -- Voucher series: the per-source-type default from company_settings, 'A'
  -- otherwise (mirrors resolveDefaultSeriesForSource).
  SELECT cs.default_voucher_series_per_source_type ->> 'expense_payout'
    INTO v_series_raw
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  IF v_series_raw ~ '^[A-Z]$' THEN
    v_series := v_series_raw;
  END IF;

  v_desc := 'Utbetalning utlägg: ' || v_claimant_name || ' (' || v_count || ' st)';

  INSERT INTO public.expense_payout_batches
    (id, company_id, user_id, employee_id, claimant_name, payout_date,
     cash_account, liability_account, total_sek, notes)
  VALUES
    (v_batch_id, p_company_id, v_caller, v_employee_id, v_claimant_name, p_payout_date,
     p_cash_account, v_liability, v_total, p_notes);

  INSERT INTO public.journal_entries
    (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, source_id, status, bank_booking_context)
  VALUES
    (v_je_id, v_caller, p_company_id, v_period_id, 0, v_series,
     p_payout_date, v_desc, 'expense_payout', v_batch_id, 'draft',
     CASE WHEN p_transaction_id IS NULL THEN '[]'::jsonb
       ELSE public.capture_bank_booking_context(p_company_id, ARRAY[p_transaction_id]) END);

  INSERT INTO public.journal_entry_lines
    (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order, line_description)
  VALUES
    (v_je_id, v_debit, v_total, 0, 'SEK', 0, v_desc),
    (v_je_id, p_cash_account, 0, v_total, 'SEK', 1, v_desc);

  -- WHO: the actor the application door passes (commitExpensePayoutBatch).
  SELECT voucher_number INTO v_voucher_number
  FROM public.commit_journal_entry(p_company_id, v_je_id, NULL, NULL, p_actor_type, p_actor_label);

  UPDATE public.expense_payout_batches
  SET journal_entry_id = v_je_id
  WHERE id = v_batch_id AND company_id = p_company_id;

  UPDATE public.expense_claims
  SET status = 'paid', payout_batch_id = v_batch_id
  WHERE id = ANY(v_ids)
    AND company_id = p_company_id
    AND status = 'registered';
  GET DIAGNOSTICS v_marked = ROW_COUNT;
  IF v_marked <> cardinality(v_ids) THEN
    -- Cannot happen while the rows are locked above; if it ever does, the
    -- exception rolls back the batch and the verifikat together.
    RAISE EXCEPTION 'create_expense_payout_batch: marked % of % claims paid', v_marked, cardinality(v_ids);
  END IF;

  IF p_transaction_id IS NOT NULL THEN
    -- Same stamp as the bulk-book RPCs: the 1:1 pointer plus is_business, so
    -- every "unbooked" predicate (inbox, worklist, badges) drops the row.
    UPDATE public.transactions
    SET journal_entry_id = v_je_id,
        is_business = TRUE,
        reconciliation_method = 'manual',
        updated_at = now()
    WHERE id = p_transaction_id
      AND company_id = p_company_id
      AND journal_entry_id IS NULL;
    GET DIAGNOSTICS v_tx_updated = ROW_COUNT;
    IF v_tx_updated <> 1 THEN
      RAISE EXCEPTION 'create_expense_payout_batch: transaction % could not be linked', p_transaction_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', v_batch_id,
    'journal_entry_id', v_je_id,
    'voucher_number', v_voucher_number,
    'total_sek', v_total,
    'claim_count', cardinality(v_ids),
    'transaction_id', p_transaction_id
  );
END;
$function$
;

REVOKE ALL ON FUNCTION public.create_expense_payout_batch(uuid, uuid[], date, text, text, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_expense_payout_batch(uuid, uuid[], date, text, text, uuid, uuid, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_expense_payout_batch(uuid, uuid[], date, text, text, uuid, uuid, text, text) IS
  'Books one reimbursement transfer for N registered expense claims atomically: locks the claims (and the bank transaction when given), posts liability -> cash via commit_journal_entry, marks the claims paid and links the transaction. Refuses claims scheduled on a payslip line (ON_PAYSLIP).';

DROP FUNCTION IF EXISTS public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.link_invoice_to_voucher(
  p_invoice_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_notes text DEFAULT NULL::text,
  p_actor_type text DEFAULT NULL::text,
  p_actor_label text DEFAULT NULL::text
)
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
  v_accounting_method text;
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
  --    INVOICE'S CURRENCY. Branch on the company's accounting method (defaults
  --    to accrual when no settings row).
  SELECT cs.accounting_method INTO v_accounting_method
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  v_accounting_method := COALESCE(v_accounting_method, 'accrual');

  -- `invoices.currency` is `text default 'SEK'` and therefore NULLABLE; a
  -- missing code has always meant kronor, and must not be read as "not SEK".
  v_invoice_currency := COALESCE(v_invoice.currency, 'SEK');
  v_account_prefix := CASE WHEN v_accounting_method = 'cash' THEN '19' ELSE '151' END;

  IF v_invoice_currency = 'SEK' THEN
    -- VERBATIM from 20260620130000. The ledger columns are kronor already, so
    -- the document label on the line is irrelevant here.
    IF v_accounting_method = 'cash' THEN
      -- Kontantmetoden: the payment verifikat debits a liquid-funds account (19xx).
      SELECT COALESCE(SUM(debit_amount), 0), MAX(currency)
        INTO v_ar_credit_total, v_line_currency
      FROM public.journal_entry_lines
      WHERE journal_entry_id = p_journal_entry_id
        AND account_number LIKE '19%'
        AND debit_amount > 0;
    ELSE
      -- Faktureringsmetoden: the payment verifikat credits the AR account (151x).
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
      COALESCE(SUM(CASE WHEN v_accounting_method = 'cash' THEN l.debit_amount ELSE l.credit_amount END) FILTER (
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
      AND l.account_number LIKE v_account_prefix || '%'
      AND (CASE WHEN v_accounting_method = 'cash' THEN l.debit_amount ELSE l.credit_amount END) > 0;

    IF COALESCE(v_unreadable_count, 0) > 0 THEN
      -- FX residual fallback (new): the voucher settles the invoice in plain
      -- kronor. Engage only in the unambiguous case; see the header comment.
      -- The readable gate counts LINES (see the aggregate comment): with
      -- zero readable lines, v_sek_side_total is provably the FULL
      -- matched-side ledger sum and v_line_currency is NULL by construction.
      IF (v_accounting_method = 'accrual'
          OR (v_accounting_method = 'cash' AND v_invoice.journal_entry_id IS NULL))
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
        -- Accrual books the residual verifikat below; kontantmetoden never
        -- does. The gate above let cash through only for an invoice that was
        -- never booked, so there is no receivable for a kursdifferens to
        -- arise against: the revenue is already in the books at the rate the
        -- money actually moved, and the link settles the full remaining and
        -- writes no new bookkeeping at all.
        v_fx_settled := (v_accounting_method = 'accrual');
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
        -- labels, an invoice-labelled line without a figure, a
        -- missing/insane exchange rate, or a kontantmetod invoice that was
        -- booked at issue.
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

  -- Both sides are now in the invoice's currency.
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

  -- 5. Compute the advance.
  v_payment_amount := LEAST(v_ar_credit_total, ROUND(v_remaining * 100) / 100);
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
    exchange_rate, payment_exchange_rate, journal_entry_id, transaction_id, notes
  ) VALUES (
    v_acting_user, p_company_id, p_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice_currency, v_invoice.exchange_rate, v_payment_rate,
    p_journal_entry_id, NULL, p_notes
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
    'fx_settled_sek', CASE WHEN v_fx_settled THEN v_sek_side_total END,
    'fx_residual_sek', CASE WHEN v_fx_settled THEN v_fx_diff END,
    'fx_journal_entry_id', v_fx_entry_id,
    'fx_voucher_number', v_fx_voucher_number
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text, text, text) IS
  'Link a posted verifikat to a customer invoice as its payment. Accounting-method aware (151x credit on faktureringsmetoden, 19xx debit on kontantmetoden). The matched amount is resolved in the INVOICE''S currency: the raw ledger column on a SEK invoice, ABS(amount_in_currency) on a foreign one. A foreign invoice settled by a plain-SEK voucher (accrual only, within 10% of remaining * exchange_rate) is treated as fully settled and the FX residual is booked as its own verifikat to 7960 (loss) / 3960 (gain), both lines carrying the invoice''s default_dimensions (coerce_dimensions_bag); every other unreadable case is refused.';

DROP FUNCTION IF EXISTS public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric);

CREATE OR REPLACE FUNCTION public.link_supplier_invoice_to_voucher(
  p_supplier_invoice_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_notes text DEFAULT NULL::text,
  p_amount numeric DEFAULT NULL::numeric,
  p_actor_type text DEFAULT NULL::text,
  p_actor_label text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
  v_voucher RECORD;
  -- The voucher's settlement side, in the invoice's currency: the 244x debit
  -- (ap_debit) or the 19xx credit (bank_credit).
  v_matched_total numeric := 0;
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
  -- Which side settles this invoice: supplier_invoice_settlement_side().
  v_settlement_side text;
  v_account_prefix text;
  v_entry_side text;
  v_no_side_code text;
  -- Unit resolution (20260726140000).
  v_invoice_currency text;
  v_unreadable_count integer := 0;
  v_unreadable_currency text;
  -- SEK-booked settlement fallback (20260830140000).
  v_readable_count integer := 0;
  v_sek_side_total numeric := 0;
  v_foreign_label_count integer := 0;
  v_booked_sek numeric;
  v_fx_diff numeric := 0;
  v_fx_fallback boolean := false; -- the fallback read the voucher
  v_fx_settled boolean := false;  -- ... and a residual verifikat is due (ap_debit only)
  v_payment_rate numeric;     -- round-6 effective rate (traceability)
  v_fx_account text;
  v_fx_entry_id uuid;
  v_fx_voucher_number int;
  v_fiscal_period_id uuid;
  v_period_is_closed boolean;
  v_period_locked_at timestamptz;
  v_inv_number_short text;
  -- Capacity of the voucher's settlement side, on both sides: what payment
  -- rows for other invoices have already used of it.
  v_used numeric := 0;
  v_used_other_currency integer := 0;
  v_used_rows integer := 0;
  v_side_total numeric;  -- the settlement side before v_used is taken off
  -- The caller's stated share of the voucher (p_amount, öre-rounded), or NULL.
  v_amount numeric;
  v_doc_dims jsonb;  -- the invoice's bag (coerce_dimensions_bag), on both residual legs
BEGIN
  -- Tenant guard (mirrors 20260611140000): anon/authenticated may only act on
  -- their own companies; service_role / direct access bypasses. NULL-safe
  -- caller_is_company_member() form.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND');
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
      'code', 'LINK_SI_VOUCHER_NOTES_TOO_LONG',
      'details', jsonb_build_object('max_length', 2000, 'length', char_length(p_notes))
    );
  END IF;

  -- A stated share is an amount of money in the invoice's currency: positive
  -- to the öre. Refused before any lock is taken, like the note above.
  IF p_amount IS NOT NULL THEN
    v_amount := ROUND(p_amount * 100) / 100;
    IF v_amount <= 0 OR v_amount = 'NaN'::numeric THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_AMOUNT_INVALID',
        'details', jsonb_build_object('amount', p_amount));
    END IF;
  END IF;

  PERFORM public.lock_cash_account_company(p_company_id);

  -- Serialise on the verifikat first, then on the invoice row: the same key
  -- and the same order as attach_supplier_invoice_settlement_voucher, so two
  -- invoices reaching for one voucher cannot both pass the capacity check and
  -- the two functions cannot deadlock each other.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('si-settlement-voucher:' || COALESCE(p_journal_entry_id::text, ''), 0)
  );

  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND');
  END IF;

  IF v_invoice.status NOT IN ('registered', 'approved', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID',
      'details', jsonb_build_object('status', v_invoice.status));
  END IF;

  v_remaining := COALESCE(v_invoice.remaining_amount, v_invoice.total - COALESCE(v_invoice.paid_amount, 0));
  IF v_remaining <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID');
  END IF;

  SELECT * INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_VOUCHER_NOT_FOUND');
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status));
  END IF;

  -- Which side of the voucher settles this invoice. The invoice row was found
  -- above, so the function always answers; the COALESCE keeps the historical
  -- side if it ever did not.
  SELECT s.settlement_side, s.account_prefix, s.entry_side
    INTO v_settlement_side, v_account_prefix, v_entry_side
  FROM public.supplier_invoice_settlement_side(p_supplier_invoice_id, p_company_id) s;
  v_settlement_side := COALESCE(v_settlement_side, 'ap_debit');
  v_account_prefix := COALESCE(v_account_prefix, '244');
  v_entry_side := COALESCE(v_entry_side, 'debit');
  v_no_side_code := CASE WHEN v_settlement_side = 'bank_credit'
                         THEN 'LINK_SI_VOUCHER_NO_BANK_CREDIT'
                         ELSE 'LINK_SI_VOUCHER_NO_AP_DEBIT' END;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object('ok', false, 'code', v_no_side_code,
      'details', jsonb_build_object('source_type', v_voucher.source_type));
  END IF;

  -- Sum the settlement side, EXPRESSED IN THE INVOICE'S CURRENCY.
  -- `supplier_invoices.currency` is NOT NULL DEFAULT 'SEK', but the COALESCE
  -- keeps this symmetric with the customer side.
  v_invoice_currency := COALESCE(v_invoice.currency, 'SEK');

  IF v_invoice_currency = 'SEK' THEN
    -- The ledger column is kronor already.
    SELECT COALESCE(SUM(CASE WHEN v_entry_side = 'credit' THEN credit_amount ELSE debit_amount END), 0),
           MAX(currency)
      INTO v_matched_total, v_line_currency
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE v_account_prefix || '%'
      AND (CASE WHEN v_entry_side = 'credit' THEN credit_amount ELSE debit_amount END) > 0;
  ELSE
    -- Foreign supplier invoice. The three extra aggregates feed the SEK-booked
    -- settlement fallback; the readable gate counts LINES (a readable line
    -- with amount_in_currency = 0 must disable the fallback).
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
      COALESCE(SUM(CASE WHEN v_entry_side = 'credit' THEN l.credit_amount ELSE l.debit_amount END) FILTER (
        WHERE COALESCE(l.currency, 'SEK') = 'SEK'
      ), 0),
      COUNT(*) FILTER (
        WHERE (l.currency IS DISTINCT FROM v_invoice_currency OR l.amount_in_currency IS NULL)
          AND COALESCE(l.currency, 'SEK') <> 'SEK'
      )
      INTO v_matched_total, v_line_currency, v_unreadable_count, v_unreadable_currency,
           v_readable_count, v_sek_side_total, v_foreign_label_count
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = p_journal_entry_id
      AND l.account_number LIKE v_account_prefix || '%'
      AND (CASE WHEN v_entry_side = 'credit' THEN l.credit_amount ELSE l.debit_amount END) > 0;

    IF COALESCE(v_unreadable_count, 0) > 0 THEN
      -- A stated share needs the voucher's side in the invoice's currency.
      -- The fallback below reads a kronor voucher as the payment of the
      -- invoice's WHOLE remainder and books the kursdifferens from that; the
      -- kronor behind a part of it are not in the books, so a share would
      -- book a kursdifferens on a guess. Answered before the fallback, so the
      -- caller reads why and not a deviation the share itself produced.
      IF v_amount IS NOT NULL THEN
        RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
          'details', jsonb_build_object(
            'invoice_currency', v_invoice.currency,
            'line_currency', v_unreadable_currency,
            'reason', 'amount_needs_invoice_currency'
          ));
      END IF;
      IF COALESCE(v_readable_count, 0) = 0
         AND COALESCE(v_foreign_label_count, 0) = 0
         AND v_sek_side_total > 0
         AND v_invoice.exchange_rate IS NOT NULL
         AND v_invoice.exchange_rate > 0
         AND v_invoice.exchange_rate < 100000
      THEN
        v_sek_side_total := ROUND(v_sek_side_total * 100) / 100;
        v_booked_sek := ROUND(v_remaining * v_invoice.exchange_rate * 100) / 100;
        IF ABS(v_sek_side_total - v_booked_sek) > v_booked_sek * 0.10 THEN
          RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
            'details', jsonb_build_object(
              'invoice_currency', v_invoice.currency,
              'line_currency', v_unreadable_currency,
              'reason', 'fx_deviation_too_large',
              'expected_sek', v_booked_sek,
              'voucher_sek', v_sek_side_total
            ));
        END IF;
        v_fx_fallback := true;
        -- A residual verifikat is due only where a skuld was carried at the
        -- invoice rate, which is the ap_debit side. On bank_credit the link
        -- settles the full remaining and writes no bookkeeping at all.
        v_fx_settled := (v_settlement_side = 'ap_debit');
        v_fx_diff := ROUND((v_booked_sek - v_sek_side_total) * 100) / 100;
        v_matched_total := ROUND(v_remaining * 100) / 100;
        -- The rate is stamped on the row only where a residual is trued up
        -- against 244x. On a link row the column reads as "settled through the
        -- FX fallback, a residual verifikat may exist" (that is how an undo has
        -- to read it), so a bank_credit row, which can never have one, leaves
        -- it NULL. Nothing is lost: the rate is the verifikat's 19xx credit
        -- over the row's amount.
        IF v_fx_settled THEN
          v_payment_rate := ROUND((v_sek_side_total / v_remaining) * 1000000) / 1000000;
        END IF;
      ELSE
        RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
          'details', jsonb_build_object(
            'invoice_currency', v_invoice.currency,
            'line_currency', v_unreadable_currency
          ));
      END IF;
    END IF;
  END IF;

  v_matched_total := ROUND(v_matched_total * 100) / 100;

  IF v_matched_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', v_no_side_code);
  END IF;

  -- Label guard: a counterparty discriminator, not a unit check. Compares the
  -- RESOLVED currency on both sides.
  IF COALESCE(v_line_currency, v_invoice_currency) IS DISTINCT FROM v_invoice_currency THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object('invoice_currency', v_invoice.currency, 'line_currency', v_line_currency));
  END IF;

  IF v_settlement_side = 'bank_credit' THEN
    -- The row this link writes is dated at the verifikat. A posted payable
    -- cut-off whose year end is on or after both the verifikat and the invoice
    -- counted this invoice as a skuld: see 20260921084700, same predicate.
    IF EXISTS (
      SELECT 1
      FROM public.kontantmetod_cutoff_entries k
      JOIN public.journal_entries cje ON cje.id = k.journal_entry_id
      JOIN public.fiscal_periods fp ON fp.id = k.fiscal_period_id
      WHERE k.company_id = p_company_id
        AND k.kind = 'payable'
        AND cje.status = 'posted'
        AND fp.period_end >= v_voucher.entry_date
        AND fp.period_end >= v_invoice.invoice_date
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CUTOFF_ALREADY_POSTED',
        'details', jsonb_build_object(
          'voucher_date', v_voucher.entry_date,
          'invoice_date', v_invoice.invoice_date
        ));
    END IF;
  END IF;

  -- Capacity, on both sides: what the settlement side has left after the rows
  -- that already point at this verifikat for OTHER invoices, whichever path
  -- wrote them. One verifikat may pay several invoices, but its rows can never
  -- add up to more than the side they settle against. This invoice's own row
  -- is left to the already-linked guard below, so a repeated link keeps its
  -- own answer.
  SELECT
    COALESCE(SUM(p.amount) FILTER (WHERE COALESCE(p.currency, 'SEK') = v_invoice_currency), 0),
    COUNT(*) FILTER (WHERE COALESCE(p.currency, 'SEK') <> v_invoice_currency),
    COUNT(*)
    INTO v_used, v_used_other_currency, v_used_rows
  FROM public.supplier_invoice_payments p
  WHERE p.company_id = p_company_id
    AND p.journal_entry_id = p_journal_entry_id
    AND p.supplier_invoice_id <> p_supplier_invoice_id;

  IF v_fx_fallback AND v_used_rows > 0 THEN
    -- The kronor voucher was read as settling THIS invoice's full remaining;
    -- it cannot also be the payment of another one.
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
      'details', jsonb_build_object('linked_rows', v_used_rows));
  END IF;
  IF v_used_other_currency > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'reason', 'voucher_settles_other_currency'
      ));
  END IF;
  v_used := ROUND(v_used * 100) / 100;
  v_side_total := v_matched_total;
  IF v_matched_total - v_used <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
      'details', jsonb_build_object(
        CASE WHEN v_settlement_side = 'bank_credit' THEN 'bank_credit' ELSE 'ap_debit' END, v_side_total,
        'already_linked', v_used));
  END IF;
  -- From here on v_matched_total is what the voucher has LEFT.
  v_matched_total := ROUND((v_matched_total - v_used) * 100) / 100;

  -- Both sides are now in the invoice's currency.
  IF v_amount IS NULL THEN
    -- No stated share: nothing is split on a guess. What the voucher has left
    -- must fit inside the invoice's remainder.
    IF v_matched_total > v_remaining + 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
        'details', jsonb_build_object(
          CASE WHEN v_settlement_side = 'bank_credit' THEN 'bank_credit' ELSE 'ap_debit' END, v_matched_total,
          'remaining', ROUND(v_remaining * 100) / 100));
    END IF;
  ELSE
    -- A stated share: bounded by the invoice's remainder and by what the
    -- voucher has left. The rest of the voucher stays available.
    IF v_amount > v_remaining + 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
        'details', jsonb_build_object(
          'amount', v_amount,
          'remaining', ROUND(v_remaining * 100) / 100));
    END IF;
    IF v_amount > v_matched_total + 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
        'details', jsonb_build_object(
          'amount', v_amount,
          'available', v_matched_total,
          CASE WHEN v_settlement_side = 'bank_credit' THEN 'bank_credit' ELSE 'ap_debit' END, v_side_total,
          'already_linked', v_used));
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND supplier_invoice_id = p_supplier_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_ALREADY_LINKED');
  END IF;

  -- Book the FX residual as its OWN verifikat, after every guard (ap_debit
  -- side only: v_fx_settled is never true on bank_credit). Supplier polarity
  -- per match_batch_allocate: paid less SEK than booked = gain (Cr 3960), paid
  -- more = loss (Dr 7960).
  IF v_fx_settled AND ABS(v_fx_diff) > 0.005 THEN
    SELECT l.account_number INTO v_fx_account
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = p_journal_entry_id
      AND l.account_number LIKE '244%'
      AND l.debit_amount > 0
    ORDER BY l.debit_amount DESC, l.account_number ASC
    LIMIT 1;

    SELECT fp.id, fp.is_closed, fp.locked_at
      INTO v_fiscal_period_id, v_period_is_closed, v_period_locked_at
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND v_voucher.entry_date BETWEEN fp.period_start AND fp.period_end
    ORDER BY fp.period_start DESC
    LIMIT 1;

    IF v_fiscal_period_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
        'details', jsonb_build_object(
          'invoice_currency', v_invoice.currency,
          'reason', 'fx_residual_no_fiscal_period',
          'entry_date', v_voucher.entry_date
        ));
    END IF;
    IF v_period_is_closed OR v_period_locked_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
        'details', jsonb_build_object(
          'invoice_currency', v_invoice.currency,
          'reason', 'fx_residual_period_locked',
          'fiscal_period_id', v_fiscal_period_id
        ));
    END IF;

    v_inv_number_short := LEFT(COALESCE(v_invoice.supplier_invoice_number, ''), 32);
    -- Both residual legs belong to this one invoice, so both carry its
    -- dimension bag, as every leg of the TypeScript payment voucher does
    -- (createSupplierInvoicePaymentEntry): the kursdifferens stays inside
    -- the project's or cost centre's result.
    v_doc_dims := public.coerce_dimensions_bag(v_invoice.default_dimensions);
    v_fx_entry_id := gen_random_uuid();
    INSERT INTO public.journal_entries
      (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
       entry_date, description, source_type, status)
    VALUES
      (v_fx_entry_id, v_acting_user, p_company_id, v_fiscal_period_id, 0, 'A',
       v_voucher.entry_date, 'Valutakursdifferens leverantörsfaktura ' || v_inv_number_short,
       'supplier_invoice_paid', 'draft');

    IF v_fx_diff > 0 THEN
      -- Paid less than the booked liability: gain. Dr 244x / Cr 3960.
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description, dimensions)
      VALUES
        (v_fx_entry_id, v_fx_account, v_fx_diff, 0, 'SEK', 0,
         'Leverantörsfaktura ' || v_inv_number_short || ' (' || v_invoice_currency || ')', v_doc_dims),
        (v_fx_entry_id, '3960', 0, v_fx_diff, 'SEK', 1,
         'Valutakursvinst ' || v_inv_number_short, v_doc_dims);
    ELSE
      -- Paid more than the booked liability: loss. Dr 7960 / Cr 244x.
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description, dimensions)
      VALUES
        (v_fx_entry_id, '7960', ABS(v_fx_diff), 0, 'SEK', 0,
         'Valutakursförlust ' || v_inv_number_short, v_doc_dims),
        (v_fx_entry_id, v_fx_account, 0, ABS(v_fx_diff), 'SEK', 1,
         'Leverantörsfaktura ' || v_inv_number_short || ' (' || v_invoice_currency || ')', v_doc_dims);
    END IF;

    -- WHO: the actor the application door passes
    -- (commitSupplierInvoiceVoucherLink).
    SELECT voucher_number INTO v_fx_voucher_number
    FROM public.commit_journal_entry(p_company_id, v_fx_entry_id, NULL, NULL, p_actor_type, p_actor_label);
  END IF;

  -- The stated share, or all the voucher has left; never more than the
  -- invoice's remainder or the voucher's capacity (the half-öre tolerance of
  -- the guards above is clamped away here).
  v_payment_amount := LEAST(COALESCE(v_amount, v_matched_total), v_matched_total, ROUND(v_remaining * 100) / 100);
  v_new_remaining := GREATEST(0, ROUND((v_remaining - v_payment_amount) * 100) / 100);
  v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_payment_amount) * 100) / 100;
  v_is_fully_paid := v_new_remaining <= 0.005;
  v_new_status := CASE WHEN v_is_fully_paid THEN 'paid' ELSE 'partially_paid' END;

  UPDATE public.supplier_invoices
  SET status = v_new_status,
      paid_at = CASE WHEN v_is_fully_paid THEN
        ((v_voucher.entry_date::timestamp + interval '12 hours') AT TIME ZONE 'UTC')
      ELSE paid_at END,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      updated_at = v_now
  WHERE id = p_supplier_invoice_id;

  -- payment_exchange_rate: effective settlement rate on the SEK-booked
  -- fallback of the ap_debit side (settled_sek / remaining), NULL on every
  -- other path, the bank_credit side included.
  INSERT INTO public.supplier_invoice_payments (
    user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
    payment_exchange_rate, journal_entry_id, transaction_id, notes
  ) VALUES (
    v_acting_user, p_company_id, p_supplier_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice_currency, v_payment_rate, p_journal_entry_id, NULL, p_notes
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
    'settlement_side', v_settlement_side,
    'voucher_remaining', ROUND((v_matched_total - v_payment_amount) * 100) / 100,
    'fx_settled_sek', CASE WHEN v_fx_settled THEN v_sek_side_total END,
    'fx_residual_sek', CASE WHEN v_fx_settled THEN v_fx_diff END,
    'fx_journal_entry_id', v_fx_entry_id,
    'fx_voucher_number', v_fx_voucher_number
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text) IS
  'Link a posted verifikat to an OPEN supplier invoice as its payment. The settlement side comes from supplier_invoice_settlement_side(): the 244x debit, or the 19xx credit for a kontantmetod company''s invoice with no registration verifikat. The amount is resolved in the INVOICE''S currency (raw ledger column on SEK, ABS(amount_in_currency) on a foreign one). A foreign invoice paid by a plain-SEK voucher (within 10% of remaining * exchange_rate) is treated as fully settled; on the 244x side the FX residual is booked as its own verifikat to 3960 / 7960, both lines carrying the invoice''s default_dimensions (coerce_dimensions_bag), on the 19xx side nothing is booked. On both sides the voucher''s settlement side is reduced by payment rows that already point at it for other invoices: one verifikat may pay several invoices, never for more than it holds. p_amount states this invoice''s share (invoice currency, bounded by the invoice''s remainder and by what the voucher has left; not on the SEK-booked fallback); without it what the voucher has left must fit inside the remainder. On the 19xx side a posted kontantmetod cut-off the row would contradict refuses. For an ALREADY settled invoice use attach_supplier_invoice_settlement_voucher.';

NOTIFY pgrst, 'reload schema';
