-- Main advanced while cash repair coordination was under review. Its newer
-- supplier linker replaces an earlier coordinated body, and its SIE relinker
-- introduces another writer. Preserve those features with company-first locks.
-- Missing staging prerequisites are restored from unchanged main definitions;
-- existing SIE objects and the settlement-side helper are left in place.
DO $alignment$
DECLARE v_definition text; v_source_hash text; v_old text; v_new text;
BEGIN
  IF to_regprocedure('public.supplier_invoice_settlement_side(uuid,uuid)') IS NULL THEN
    EXECUTE $helper$
CREATE OR REPLACE FUNCTION public.supplier_invoice_settlement_side(
  p_supplier_invoice_id uuid,
  p_company_id uuid
)
RETURNS TABLE (settlement_side text, account_prefix text, entry_side text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT
    CASE WHEN s.cash_unbooked THEN 'bank_credit' ELSE 'ap_debit' END,
    CASE WHEN s.cash_unbooked THEN '19' ELSE '244' END,
    CASE WHEN s.cash_unbooked THEN 'credit' ELSE 'debit' END
  FROM (
    SELECT (COALESCE(cs.accounting_method, 'accrual') = 'cash'
            AND si.registration_journal_entry_id IS NULL) AS cash_unbooked
    FROM public.supplier_invoices si
    LEFT JOIN public.company_settings cs ON cs.company_id = si.company_id
    WHERE si.id = p_supplier_invoice_id
      AND si.company_id = p_company_id
  ) s
$$;

REVOKE ALL ON FUNCTION public.supplier_invoice_settlement_side(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_invoice_settlement_side(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.supplier_invoice_settlement_side(uuid, uuid) IS
  'The single definition of which line of a posted verifikat settles a supplier invoice: bank_credit (19xx credit) for a kontantmetod company''s invoice with no registration verifikat, ap_debit (244x debit) otherwise. Read by link_supplier_invoice_to_voucher and by the TypeScript candidate matcher, so the two cannot disagree. SECURITY INVOKER: RLS decides which invoices a caller can ask about; no row means the invoice is not visible.';
$helper$;
  END IF;
  SELECT md5(prosrc) INTO v_source_hash FROM pg_proc
    WHERE oid = 'public.link_supplier_invoice_to_voucher(uuid,uuid,uuid,uuid,text)'::regprocedure;
  IF v_source_hash NOT IN ('1203247910b44f50730f3df5d71f5aed','890ec0fb8aa5f7dc42b3f5add2185131','a88a72a1e83d2f0fdecd44f405f9dbc9','fa6eb705b2ce31e1610b1c74a2258bca') THEN
    RAISE EXCEPTION 'Unexpected supplier linker definition; review before applying cash coordination';
  END IF;
  EXECUTE $supplier$
CREATE OR REPLACE FUNCTION public.link_supplier_invoice_to_voucher(
  p_supplier_invoice_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  -- Capacity of the voucher's 19xx credit (bank_credit only).
  v_used numeric := 0;
  v_used_other_currency integer := 0;
  v_used_rows integer := 0;
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

    -- Capacity: what the 19xx credit has left after the rows that already
    -- point at this verifikat for OTHER invoices. This invoice's own row is
    -- left to the already-linked guard below, so a repeated link keeps its
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
    IF v_matched_total - v_used <= 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_FULLY_ALLOCATED',
        'details', jsonb_build_object('bank_credit', v_matched_total, 'already_linked', v_used));
    END IF;
    v_matched_total := ROUND((v_matched_total - v_used) * 100) / 100;
  END IF;

  -- Both sides are now in the invoice's currency.
  IF v_matched_total > v_remaining + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      'details', jsonb_build_object(
        CASE WHEN v_settlement_side = 'bank_credit' THEN 'bank_credit' ELSE 'ap_debit' END, v_matched_total,
        'remaining', ROUND(v_remaining * 100) / 100));
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
         sort_order, line_description)
      VALUES
        (v_fx_entry_id, v_fx_account, v_fx_diff, 0, 'SEK', 0,
         'Leverantörsfaktura ' || v_inv_number_short || ' (' || v_invoice_currency || ')'),
        (v_fx_entry_id, '3960', 0, v_fx_diff, 'SEK', 1,
         'Valutakursvinst ' || v_inv_number_short);
    ELSE
      -- Paid more than the booked liability: loss. Dr 7960 / Cr 244x.
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description)
      VALUES
        (v_fx_entry_id, '7960', ABS(v_fx_diff), 0, 'SEK', 0,
         'Valutakursförlust ' || v_inv_number_short),
        (v_fx_entry_id, v_fx_account, 0, ABS(v_fx_diff), 'SEK', 1,
         'Leverantörsfaktura ' || v_inv_number_short || ' (' || v_invoice_currency || ')');
    END IF;

    SELECT voucher_number INTO v_fx_voucher_number
    FROM public.commit_journal_entry(p_company_id, v_fx_entry_id);
  END IF;

  v_payment_amount := LEAST(v_matched_total, ROUND(v_remaining * 100) / 100);
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
    'fx_settled_sek', CASE WHEN v_fx_settled THEN v_sek_side_total END,
    'fx_residual_sek', CASE WHEN v_fx_settled THEN v_fx_diff END,
    'fx_journal_entry_id', v_fx_entry_id,
    'fx_voucher_number', v_fx_voucher_number
  );
END;
$$;

-- Grants are unchanged and restated because CREATE OR REPLACE does not alter
-- them: `authenticated` covers user-session clients, `service_role` the
-- MCP / API-key paths.
REVOKE ALL ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) IS
  'Link a posted verifikat to an OPEN supplier invoice as its payment. The settlement side comes from supplier_invoice_settlement_side(): the 244x debit, or the 19xx credit for a kontantmetod company''s invoice with no registration verifikat. The amount is resolved in the INVOICE''S currency (raw ledger column on SEK, ABS(amount_in_currency) on a foreign one). A foreign invoice paid by a plain-SEK voucher (within 10% of remaining * exchange_rate) is treated as fully settled; on the 244x side the FX residual is booked as its own verifikat to 3960 / 7960, on the 19xx side nothing is booked. On the 19xx side the voucher''s credit is reduced by payment rows that already point at it for other invoices, and a posted kontantmetod cut-off the row would contradict refuses. For an ALREADY settled invoice use attach_supplier_invoice_settlement_voucher.';
$supplier$;

  IF to_regprocedure('public.relink_stranded_transactions(uuid,boolean,boolean,jsonb,uuid)') IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.sie_imports'::regclass AND attname='bank_sweep' AND NOT attisdropped)
      OR to_regprocedure('public.claim_sie_import_bank_sweep(uuid,uuid)') IS NOT NULL
      OR to_regprocedure('public.record_sie_import_bank_sweep(uuid,uuid,jsonb)') IS NOT NULL THEN
      RAISE EXCEPTION 'Unexpected partial SIE sweep prerequisite; review before restoration';
    END IF;
    EXECUTE $sie$
ALTER TABLE public.sie_imports ADD COLUMN bank_sweep jsonb;

COMMENT ON COLUMN public.sie_imports.bank_sweep IS
  'Receipt of the verifikat matcher run that follows a completed SIE import (issue #2835). NULL: not run. {state: running, started_at, attempt}: claimed. {state: done, ...SieSweepSummary}: finished. Written only by claim_sie_import_bank_sweep / record_sie_import_bank_sweep.';

CREATE FUNCTION public.claim_sie_import_bank_sweep(p_company_id uuid, p_import_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- A claim older than ten minutes is a dead function (max duration is five),
  -- so it may be taken over; five attempts bound a sweep that keeps dying.
  UPDATE public.sie_imports
    SET bank_sweep = jsonb_build_object(
      'state', 'running',
      'started_at', clock_timestamp(),
      'attempt', coalesce((bank_sweep->>'attempt')::integer, 0) + 1)
    WHERE id = p_import_id AND company_id = p_company_id
      AND job_state = 'completed' AND job_kind = 'import'
      AND (bank_sweep IS NULL OR (
        bank_sweep->>'state' = 'running'
        AND (bank_sweep->>'started_at')::timestamptz < clock_timestamp() - interval '10 minutes'
        AND coalesce((bank_sweep->>'attempt')::integer, 0) < 5));
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_sie_import_bank_sweep(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sie_import_bank_sweep(uuid, uuid) TO service_role;

CREATE FUNCTION public.record_sie_import_bank_sweep(p_company_id uuid, p_import_id uuid, p_summary jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_summary IS NULL OR jsonb_typeof(p_summary) <> 'object' THEN
    RAISE EXCEPTION 'record_sie_import_bank_sweep: p_summary must be a JSON object' USING ERRCODE = '22023';
  END IF;
  -- Only a claimed sweep can be recorded, and the receipt keeps its attempt.
  UPDATE public.sie_imports
    SET bank_sweep = p_summary || jsonb_build_object(
      'state', 'done',
      'attempt', coalesce((bank_sweep->>'attempt')::integer, 1))
    WHERE id = p_import_id AND company_id = p_company_id
      AND bank_sweep->>'state' = 'running';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.record_sie_import_bank_sweep(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sie_import_bank_sweep(uuid, uuid, jsonb) TO service_role;

-- ------------------------------------------------------------------
-- 2. One-off re-link for rows stranded before #2820
-- ------------------------------------------------------------------

INSERT INTO public.processing_event_types (event_type) VALUES
  ('BankTransactionStrandedRelinked')
ON CONFLICT (event_type) DO NOTHING;

CREATE FUNCTION public.relink_stranded_transactions(
  p_company_id uuid,
  p_dry_run boolean DEFAULT true,
  p_pair_balanced_groups boolean DEFAULT false,
  p_actor jsonb DEFAULT NULL,
  p_correlation_id uuid DEFAULT NULL
)
RETURNS TABLE (
  transaction_id uuid,
  transaction_date date,
  amount numeric,
  currency text,
  ledger_account text,
  lock_state text,
  competing_rows integer,
  candidate_lines integer,
  outcome text,
  journal_entry_id uuid,
  selected boolean,
  relinked boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
-- The result columns share names with table columns (amount, currency,
-- journal_entry_id, ...); inside the query a bare name always means the column.
#variable_conflict use_column
DECLARE
  v_correlation_id uuid := COALESCE(p_correlation_id, gen_random_uuid());
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'relink_stranded_transactions: p_company_id is required, this never runs across companies'
      USING ERRCODE = '22023';
  END IF;
  IF NOT p_dry_run AND (
       p_actor IS NULL
       OR jsonb_typeof(p_actor) <> 'object'
       OR COALESCE(p_actor->>'type', '') = ''
       OR COALESCE(p_actor->>'id', '') = '') THEN
    RAISE EXCEPTION 'relink_stranded_transactions: p_actor {type, id} is required for a write'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH primary_account AS (
    SELECT ca.ledger_account
    FROM public.cash_accounts ca
    WHERE ca.company_id = p_company_id AND ca.is_primary
    LIMIT 1
  ),
  -- Every bank row that still needs a verifikat, stranded or not: an open row
  -- with the same key competes for the same line and makes the pairing a guess.
  unbooked AS (
    SELECT
      t.id,
      t.date,
      t.amount,
      t.currency,
      t.category,
      t.reconciliation_method,
      (t.is_business IS TRUE) AS is_stranded,
      -- Same attribution as the unattended sweep: a row with no cash account
      -- belongs to the primary account; a company with none reconciles on 1930.
      COALESCE(ca.ledger_account, (SELECT pa.ledger_account FROM primary_account pa), '1930') AS ledger_account,
      (t.currency = 'SEK' AND COALESCE(ca.currency, 'SEK') = 'SEK') AS is_sek
    FROM public.transactions t
    LEFT JOIN public.cash_accounts ca ON ca.id = t.cash_account_id AND ca.company_id = t.company_id
    WHERE t.company_id = p_company_id
      AND t.is_ignored = false
      AND t.journal_entry_id IS NULL
      AND NOT public.is_transaction_booked(t.id)
  ),
  -- The matcher's candidate set (get_unlinked_gl_lines), for every 19xx account.
  free_lines AS (
    SELECT
      jel.id AS line_id,
      je.id AS entry_id,
      jel.account_number,
      je.entry_date,
      je.voucher_series,
      je.voucher_number,
      round(jel.debit_amount - jel.credit_amount, 2) AS signed_amount
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.source_type IS DISTINCT FROM 'opening_balance'
      AND je.source_type IS DISTINCT FROM 'storno'
      AND je.source_type IS DISTINCT FROM 'correction'
      AND jel.account_number LIKE '19%'
      AND round(jel.debit_amount - jel.credit_amount, 2) <> 0
      AND NOT EXISTS (
        SELECT 1 FROM public.transactions lt
        WHERE lt.journal_entry_id = je.id AND lt.company_id = p_company_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.transaction_voucher_links l
        WHERE l.journal_entry_id = je.id AND l.company_id = p_company_id)
  ),
  ranked_rows AS (
    SELECT u.*,
      count(*) OVER w AS competing_rows,
      bool_and(u.is_stranded) OVER w AS all_stranded,
      row_number() OVER (PARTITION BY u.ledger_account, u.date, round(u.amount, 2) ORDER BY u.id) AS pair_no
    FROM unbooked u
    WINDOW w AS (PARTITION BY u.ledger_account, u.date, round(u.amount, 2))
  ),
  ranked_lines AS (
    SELECT f.*,
      count(*) OVER (PARTITION BY f.account_number, f.entry_date, f.signed_amount) AS candidate_lines,
      row_number() OVER (PARTITION BY f.account_number, f.entry_date, f.signed_amount
        ORDER BY f.voucher_series, f.voucher_number, f.line_id) AS pair_no
    FROM free_lines f
  ),
  line_counts AS (
    SELECT DISTINCT f.account_number, f.entry_date, f.signed_amount, f.candidate_lines
    FROM ranked_lines f
  ),
  judged AS (
    SELECT
      r.id,
      r.date,
      r.amount,
      r.currency,
      r.category,
      r.reconciliation_method,
      r.ledger_account,
      r.competing_rows::integer AS competing_rows,
      COALESCE(lc.candidate_lines, 0)::integer AS candidate_lines,
      CASE
        WHEN NOT r.is_sek THEN 'unsupported_currency'
        WHEN COALESCE(lc.candidate_lines, 0) = 0 THEN 'no_counterpart'
        WHEN r.competing_rows = 1 AND lc.candidate_lines = 1 THEN 'unique'
        WHEN r.competing_rows = lc.candidate_lines AND r.all_stranded THEN 'balanced_group'
        ELSE 'ambiguous'
      END AS outcome,
      r.pair_no
    FROM ranked_rows r
    LEFT JOIN line_counts lc
      ON lc.account_number = r.ledger_account
     AND lc.entry_date = r.date
     AND lc.signed_amount = round(r.amount, 2)
    WHERE r.is_stranded
  ),
  paired AS (
    SELECT j.*,
      CASE WHEN j.outcome IN ('unique', 'balanced_group') THEN rl.entry_id END AS entry_id,
      (j.outcome = 'unique' OR (j.outcome = 'balanced_group' AND p_pair_balanced_groups)) AS selected,
      CASE
        WHEN cs.bookkeeping_locked_through IS NOT NULL
             AND j.date <= cs.bookkeeping_locked_through THEN 'company_lock_date'
        WHEN fp.id IS NULL THEN 'no_period'
        WHEN fp.is_closed THEN 'closed'
        WHEN fp.locked_at IS NOT NULL THEN 'locked'
        ELSE 'open'
      END AS lock_state
    FROM judged j
    LEFT JOIN ranked_lines rl
      ON rl.account_number = j.ledger_account
     AND rl.entry_date = j.date
     AND rl.signed_amount = round(j.amount, 2)
     AND rl.pair_no = j.pair_no
    LEFT JOIN public.company_settings cs ON cs.company_id = p_company_id
    LEFT JOIN LATERAL (
      SELECT p.id, p.is_closed, p.locked_at
      FROM public.fiscal_periods p
      WHERE p.company_id = p_company_id
        AND p.period_start <= j.date
        AND p.period_end >= j.date
      ORDER BY p.period_start DESC
      LIMIT 1
    ) fp ON true
  ),
  updated AS (
    UPDATE public.transactions t
    SET journal_entry_id = g.entry_id,
        reconciliation_method = 'auto_exact',
        updated_at = now()
    FROM paired g
    WHERE NOT p_dry_run
      AND g.selected
      AND g.entry_id IS NOT NULL
      AND t.id = g.id
      AND t.company_id = p_company_id
      -- Re-asserted inside the write: a row that was booked, released or
      -- ignored between the scan and the update is left exactly as it is.
      AND t.is_business = true
      AND t.is_ignored = false
      AND t.journal_entry_id IS NULL
      AND NOT public.is_transaction_booked(t.id)
    RETURNING t.id
  ),
  logged AS (
    INSERT INTO public.processing_history
      (company_id, correlation_id, aggregate_type, aggregate_id, event_type,
       payload, actor, occurred_at)
    SELECT
      p_company_id,
      v_correlation_id,
      'BankTransaction',
      g.id,
      'BankTransactionStrandedRelinked',
      jsonb_build_object(
        'issue', 2835,
        'rule', CASE g.outcome WHEN 'unique' THEN 'auto_exact_unique' ELSE 'auto_exact_balanced_group' END,
        'lock_state', g.lock_state,
        'previous', jsonb_build_object(
          'journal_entry_id', NULL,
          'reconciliation_method', g.reconciliation_method
        ),
        'after', jsonb_build_object(
          'journal_entry_id', g.entry_id,
          'reconciliation_method', 'auto_exact'
        )
      ),
      p_actor,
      now()
    FROM paired g
    JOIN updated u ON u.id = g.id
    RETURNING aggregate_id
  )
  SELECT
    g.id,
    g.date,
    g.amount,
    g.currency,
    g.ledger_account,
    g.lock_state,
    g.competing_rows,
    g.candidate_lines,
    g.outcome,
    g.entry_id,
    g.selected,
    (u.id IS NOT NULL) AS relinked
  FROM paired g
  LEFT JOIN updated u ON u.id = g.id
  ORDER BY g.date, g.id;
END;
$$;

COMMENT ON FUNCTION public.relink_stranded_transactions(uuid, boolean, boolean, jsonb, uuid) IS
  'Issue #2835. Lists (dry run, default) or re-links, for ONE company, bank rows stranded as is_business = true with no verifikat anchor whose bank event sits on an unlinked posted 19xx line of the same signed amount and date. Links only a unique pairing, plus balanced n:n groups when p_pair_balanced_groups is true; everything else is reported and left alone. Writes transactions.journal_entry_id and reconciliation_method only, never a journal entry, and logs one BankTransactionStrandedRelinked event per row. service_role only; a write requires p_actor.';

REVOKE ALL ON FUNCTION public.relink_stranded_transactions(uuid, boolean, boolean, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.relink_stranded_transactions(uuid, boolean, boolean, jsonb, uuid) TO service_role;
$sie$;
  END IF;

  v_definition := pg_get_functiondef('public.attach_supplier_invoice_settlement_voucher(uuid,uuid,uuid,uuid,text,boolean)'::regprocedure);
  IF strpos(v_definition, 'PERFORM public.lock_cash_account_company(p_company_id);') = 0 THEN
    v_old := E'  PERFORM pg_advisory_xact_lock(\n';
    v_new := E'  PERFORM public.lock_cash_account_company(p_company_id);\n\n' || v_old;
    IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
      RAISE EXCEPTION 'Unexpected supplier attachment definition; company lock position is ambiguous';
    END IF;
    EXECUTE replace(v_definition,v_old,v_new);
  END IF;

  v_definition := pg_get_functiondef('public.relink_stranded_transactions(uuid,boolean,boolean,jsonb,uuid)'::regprocedure);
  IF strpos(v_definition, 'PERFORM public.lock_cash_account_company(p_company_id);') = 0 THEN
    v_old := E'  RETURN QUERY\n  WITH primary_account AS (';
    v_new := E'  IF NOT p_dry_run THEN\n    PERFORM public.lock_cash_account_company(p_company_id);\n  END IF;\n\n' || v_old;
    IF (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 THEN
      RAISE EXCEPTION 'Unexpected SIE relinker definition; company lock position is ambiguous';
    END IF;
    EXECUTE replace(v_definition,v_old,v_new);
  END IF;
END;
$alignment$;
NOTIFY pgrst, 'reload schema';
