-- A set-off clears what 151x carries when the invoice's issue verifikat
-- booked its öresavrundning (crm#2283).
-- pg-test: tests/pg/counterparty-setoff.pg.test.ts
--
-- An issue verifikat may book a SEK invoice's öresavrundning itself: 151x at
-- the rounded "Att betala" and the öre on 3740 (total 999,75, Att betala
-- 1 000: Dr 1510 1 000, Cr 3740 0,25). The payment builders already clear
-- what the ledger carries for such an invoice and book only the rest of the
-- öre (bookedOreRounding, lib/bookkeeping/ore-rounding.ts; carriedSekOf). The
-- set-off did not: set off for 1 000 it credited 151x the remaining 999,75
-- and booked the 0,25 on 3740 a second time, leaving 0,25 on 151x of an
-- invoice marked paid.
--
-- A set-off that settles the customer invoice in full (within a krona of what
-- it owes, or exactly that) now reads what 151x carries
-- (document_carried_sek, 20261101120200). When the issue verifikat booked öre
-- (ore_settlement_residual of the remaining amount and what is carried), 151x
-- is credited all it carries and 3740 takes only the set-off's own gap less
-- that öre. For every other invoice (nothing carried beyond the remaining
-- amount, or a ledger the function cannot read) the verifikat is the one the
-- previous definition booked. A partial set-off is unchanged. The payment
-- rows, paid_amount and remaining_amount stay the debt settled, so
-- reverse_counterparty_setoff (which gives back the payment row's amount and
-- stornoes the verifikat's own lines) needs no change.
--
-- Copied from 20261104100600_counterparty_setoff_ore_rounding.sql, the latest
-- definition; the changes are marked crm#2283.

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
  -- crm#2283: what 151x carries, the öre the issue verifikat booked, the 151x
  -- credit and the 3740 amount the set-off books.
  v_carried jsonb;
  v_issue_ore numeric := 0;
  v_inv_ledger numeric;
  v_ore_booked numeric;
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
  -- crm#2283: a set-off that settles the customer invoice in full clears what
  -- 151x carries for it. When the issue verifikat booked its öresavrundning
  -- (151x at the rounded Att betala, the öre on 3740), 151x is credited all it
  -- carries and 3740 takes only the set-off's own gap less that öre, the rule
  -- of the payment builders (bookedOreRounding). A ledger the function cannot
  -- read, or one carrying just the remaining amount, books as before. Only a
  -- total with öre can have had one (hasOreToRound): the total, not the
  -- remainder, since a part payment can leave whole kronor open while 151x
  -- still carries the öre. Any other invoice costs no ledger read.
  IF v_inv_applied = v_inv_remaining AND v_inv.total <> round(v_inv.total) THEN
    v_carried := public.document_carried_sek(p_company_id, 'customer', p_invoice_id);
    IF COALESCE((v_carried ->> 'ok')::boolean, false) THEN
      v_issue_ore := public.ore_settlement_residual(v_inv_remaining, (v_carried ->> 'sek')::numeric);
    END IF;
  END IF;
  v_ore_booked := v_ore - v_issue_ore;
  v_inv_ledger := CASE WHEN v_issue_ore <> 0 THEN v_inv_remaining - v_issue_ore ELSE v_inv_applied END;

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
    (v_entry_id, v_receivable, 0, v_inv_ledger, 'SEK', 1,
     left('Kundfaktura ' || v_inv_number, 200), v_inv_dims);
  -- Set off less than owed = Dr 3740 (förlust), more = Cr 3740 (vinst), the
  -- customer polarity of oreRoundingLine; 3740 carries no VAT. crm#2283: less
  -- the öre the issue verifikat already booked.
  IF v_ore_booked <> 0 THEN
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency,
       sort_order, line_description, dimensions)
    VALUES
      (v_entry_id, '3740', GREATEST(v_ore_booked, 0), GREATEST(-v_ore_booked, 0), 'SEK', 2,
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
    'ore_rounding', v_ore_booked,
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
  'Kvittning: books Dr 244x / Cr 151x for p_amount (and 3740 for a sub-krona gap to what the customer invoice owes, which then settles in full: ore_settlement_residual, crm#1644; a full settlement credits 151x all it carries and books on 3740 only that gap less the öre the issue verifikat booked, document_carried_sek, crm#2283) between a customer invoice and a supplier invoice of the same party (canonical_party_id), lowers both remaining amounts, writes a payment row on each side and the counterparty_setoffs row, in one transaction. Every refusal is answered as {ok: false, code} before anything is written. p_user_id is honoured only for service_role callers. p_event_ids (the posting port''s counterparty.set_off event) are linked to the draft before its number is drawn (crm#1367).';
