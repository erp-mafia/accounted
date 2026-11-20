-- Kvittning absorbs öresavrundning on the customer invoice (crm#1644).
-- pg-test: tests/pg/counterparty-setoff.pg.test.ts
--
-- A customer invoice whose "Att betala" is rounded to whole kronor (total
-- 3 136,18, Att betala 3 136) set off for 3 136 left 0,18 open on the invoice
-- and the shown net 0,18 off, while a bank payment of the same 3 136 settles
-- the invoice and books the öre on 3740 (match_batch_allocate,
-- planInvoicePayment). The set-off now books by the same rule
-- (ore_settlement_residual, 20261101120200): within a krona of what the
-- customer invoice owes, the invoice settles in full, 151x is credited the
-- whole remaining amount and 3740 Öres- och kronutjämning carries the gap
-- (no VAT). The supplier side and the set-off amount (244x, the set-off row)
-- stay what was set off.
--
-- The customer invoice's payment row records what the set-off applied to it
-- (the single-writer rule of invoice_payments.amount), and
-- reverse_counterparty_setoff gives the invoice back that amount, so a
-- storno still restores both invoices exactly.
--
-- Both functions are copied from 20261022130100_counterparty_setoffs.sql,
-- the only definition; the changes are marked crm#1644.

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
    (v_entry_id, v_receivable, 0, v_inv_applied, 'SEK', 1,
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

REVOKE ALL ON FUNCTION public.book_counterparty_setoff(
  uuid, uuid, uuid, uuid, numeric, date, text, uuid, text, text, uuid[], text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.book_counterparty_setoff(
  uuid, uuid, uuid, uuid, numeric, date, text, uuid, text, text, uuid[], text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.book_counterparty_setoff(
  uuid, uuid, uuid, uuid, numeric, date, text, uuid, text, text, uuid[], text
) IS
  'Kvittning: books Dr 244x / Cr 151x for p_amount (and 3740 for a sub-krona gap to what the customer invoice owes, which then settles in full: ore_settlement_residual, crm#1644) between a customer invoice and a supplier invoice of the same party (canonical_party_id), lowers both remaining amounts, writes a payment row on each side and the counterparty_setoffs row, in one transaction. Every refusal is answered as {ok: false, code} before anything is written. p_user_id is honoured only for service_role callers. p_event_ids (the posting port''s counterparty.set_off event) are linked to the draft before its number is drawn (crm#1367).';

CREATE OR REPLACE FUNCTION public.reverse_counterparty_setoff(
  p_company_id uuid,
  p_setoff_id uuid,
  p_storno_entry_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_row public.counterparty_setoffs%ROWTYPE;
  v_storno RECORD;
  v_inv RECORD;
  v_si RECORD;
  v_inv_applied numeric;
  v_inv_new_paid numeric;
  v_inv_new_remaining numeric;
  v_inv_new_status text;
  v_si_new_paid numeric;
  v_si_new_remaining numeric;
  v_si_new_status text;
  v_today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
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

  SELECT * INTO v_row FROM public.counterparty_setoffs
    WHERE id = p_setoff_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_NOT_FOUND');
  END IF;
  IF v_row.status <> 'booked' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_ALREADY_REVERSED');
  END IF;

  SELECT je.id, je.source_type, je.status, je.reverses_id INTO v_storno
    FROM public.journal_entries je
   WHERE je.id = p_storno_entry_id AND je.company_id = p_company_id;
  IF NOT FOUND OR v_storno.source_type <> 'storno' OR v_storno.status <> 'posted'
     OR v_storno.reverses_id IS DISTINCT FROM v_row.journal_entry_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_STORNO_MISMATCH');
  END IF;

  -- Same lock order as book_counterparty_setoff: the invoice first.
  SELECT * INTO v_inv FROM public.invoices
    WHERE id = v_row.invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_REVERSAL_BLOCKED',
      'details', jsonb_build_object('reason', 'invoice_missing'));
  END IF;
  SELECT * INTO v_si FROM public.supplier_invoices
    WHERE id = v_row.supplier_invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_REVERSAL_BLOCKED',
      'details', jsonb_build_object('reason', 'supplier_invoice_missing'));
  END IF;
  -- What the set-off cleared off the customer invoice: its payment row, which
  -- includes an öresavrundning the set-off absorbed (crm#1644).
  SELECT p.amount INTO v_inv_applied FROM public.invoice_payments p
   WHERE p.id = v_row.invoice_payment_id AND p.company_id = p_company_id;
  v_inv_applied := COALESCE(v_inv_applied, v_row.amount);

  IF v_inv.status IN ('written_off', 'credited', 'cancelled', 'draft')
     OR v_si.status IN ('credited', 'reversed')
     OR COALESCE(v_inv.paid_amount, 0) < v_inv_applied
     OR COALESCE(v_si.paid_amount, 0) < v_row.amount THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_REVERSAL_BLOCKED',
      'details', jsonb_build_object('invoice_status', v_inv.status, 'supplier_invoice_status', v_si.status));
  END IF;

  v_inv_new_paid := round(COALESCE(v_inv.paid_amount, 0) - v_inv_applied, 2);
  v_inv_new_remaining := round(COALESCE(v_inv.remaining_amount, 0) + v_inv_applied, 2);
  v_inv_new_status := CASE
    WHEN v_inv_new_paid > 0 THEN 'partially_paid'
    WHEN v_inv.due_date IS NOT NULL AND v_inv.due_date < v_today THEN 'overdue'
    ELSE 'sent'
  END;
  UPDATE public.invoices SET
      status = v_inv_new_status,
      paid_at = NULL,
      paid_amount = v_inv_new_paid,
      remaining_amount = v_inv_new_remaining,
      updated_at = now()
    WHERE id = v_row.invoice_id AND company_id = p_company_id;

  v_si_new_paid := round(COALESCE(v_si.paid_amount, 0) - v_row.amount, 2);
  v_si_new_remaining := round(COALESCE(v_si.remaining_amount, 0) + v_row.amount, 2);
  v_si_new_status := CASE
    WHEN v_si_new_paid > 0 THEN 'partially_paid'
    WHEN v_si.due_date IS NOT NULL AND v_si.due_date < v_today THEN 'overdue'
    WHEN v_si.approved_at IS NOT NULL THEN 'approved'
    ELSE 'registered'
  END;
  UPDATE public.supplier_invoices SET
      status = v_si_new_status,
      paid_at = NULL,
      paid_amount = v_si_new_paid,
      remaining_amount = v_si_new_remaining,
      payment_journal_entry_id = CASE
        WHEN payment_journal_entry_id = v_row.journal_entry_id THEN NULL
        ELSE payment_journal_entry_id
      END,
      updated_at = now()
    WHERE id = v_row.supplier_invoice_id AND company_id = p_company_id;

  DELETE FROM public.invoice_payments
   WHERE id = v_row.invoice_payment_id AND company_id = p_company_id;
  DELETE FROM public.supplier_invoice_payments
   WHERE id = v_row.supplier_invoice_payment_id AND company_id = p_company_id;

  UPDATE public.counterparty_setoffs SET
      status = 'reversed',
      reversed_at = now(),
      reversal_journal_entry_id = p_storno_entry_id
    WHERE id = p_setoff_id AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'ok', true,
    'setoff_id', p_setoff_id,
    'invoice', jsonb_build_object('invoice_id', v_row.invoice_id, 'status', v_inv_new_status,
      'paid_amount', v_inv_new_paid, 'remaining_amount', v_inv_new_remaining),
    'supplier_invoice', jsonb_build_object('supplier_invoice_id', v_row.supplier_invoice_id,
      'status', v_si_new_status, 'paid_amount', v_si_new_paid, 'remaining_amount', v_si_new_remaining)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_counterparty_setoff(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_counterparty_setoff(uuid, uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.reverse_counterparty_setoff(uuid, uuid, uuid, uuid) IS
  'The set-off side of a storno of a counterparty_setoff voucher: gives both invoices the set-off amount back, removes the two payment rows and marks the set-off reversed. Refused unless p_storno_entry_id is the posted storno of the set-off''s voucher. p_user_id is honoured only for service_role callers (crm#1367).';

NOTIFY pgrst, 'reload schema';
