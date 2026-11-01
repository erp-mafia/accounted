-- pg-test: tests/pg/supplier-payment-link-basis.pg.test.ts
-- Every supplier payment row records why it is linked, as invoice_payments does.
--
-- 20261016180300 stamped link_basis on the rows match_batch_allocate writes and
-- 20261026007000 on link_invoice_to_voucher's. link_supplier_invoice_to_voucher
-- was restated two days after the feature (20261018210400) without it, and
-- attach_supplier_invoice_settlement_voucher never had it, so a link through
-- either read as NULL on the Kopplingar view and in the audit package: 157 rows
-- since 2026-10-17, none on the customer side. Those rows stay as they are.
--
-- Neither function can pick the basis alone. A person names the pair on both,
-- but the auto-linker (bulk-reconcile-supplier-vouchers.ts), the provider
-- migration's settle phase (commit_provider_migration_followup, which links what
-- that same matcher planned), the migration's linker
-- (link-migrated-registration-vouchers.ts) and the Bokio completion
-- (complete_bokio_supplier_invoice) reach them too, and nothing in those calls
-- tells a rule or an import from a person. A fixed 'user_confirmed' would say a
-- person chose 40 of those 157 pairs. So each function takes p_link_basis, the
-- door's own basis. The default is the customer twin's 'user_confirmed'; the
-- doors no person chose for name theirs: the settle phase the rule its plan
-- recorded (a plan from before this release has none and records NULL, never a
-- guess), the linker and the Bokio completion the import, because the old system
-- named that voucher. resolve_link_basis resolves it against the actor: a
-- person-shaped door on an API key or an agent records client_asserted, a rule
-- or an import stays as named. attach has no actor parameter: it reads the
-- request's gnubok.actor_type, which is what resolve_link_basis falls back on.
--
-- A trailing parameter changes a function's identity, so both are dropped and
-- recreated here, in one transaction, with their grants and comments, as
-- 20261018210400 did. The two SQL callers are restated from the installed
-- definitions with one change each: the named basis. All four bodies are
-- otherwise those definitions (migrations replayed). The person's doors send no
-- p_link_basis, so they work on either side of this migration; a rule or import
-- door that runs before it is refused and reports its pair for review.
--
-- The TypeScript writers' rule is recordSupplierInvoicePaymentRow
-- (src/lib/invoices/supplier-invoice-payment-row.ts).

DROP FUNCTION IF EXISTS public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text, uuid[], text);

CREATE OR REPLACE FUNCTION public.link_supplier_invoice_to_voucher(p_supplier_invoice_id uuid, p_journal_entry_id uuid, p_user_id uuid, p_company_id uuid, p_notes text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text, p_event_ids uuid[] DEFAULT NULL::uuid[], p_event_mode text DEFAULT NULL::text, p_link_basis text DEFAULT 'user_confirmed'::text)
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

    -- The posting port's events: purchase.paid of the invoice. Linked to the draft
    -- before commit_journal_entry draws its number (20261018210000).
    PERFORM public.link_business_events_to_draft(
      p_company_id, v_fx_entry_id, p_event_ids, 'produced', p_event_mode);

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
    payment_exchange_rate, journal_entry_id, transaction_id, notes,
    link_basis, link_evidence
  ) VALUES (
    v_acting_user, p_company_id, p_supplier_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice_currency, v_payment_rate, p_journal_entry_id, NULL, p_notes,
    public.resolve_link_basis(p_link_basis, p_actor_type), NULL
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

REVOKE ALL ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text, uuid[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text, uuid[], text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text, uuid[], text, text) IS
  'Link a posted verifikat to an OPEN supplier invoice as its payment. The settlement side comes from supplier_invoice_settlement_side(): the 244x debit, or the 19xx credit for a kontantmetod company''s invoice with no registration verifikat. The amount is resolved in the INVOICE''S currency (raw ledger column on SEK, ABS(amount_in_currency) on a foreign one). A foreign invoice paid by a plain-SEK voucher (within 10% of remaining * exchange_rate) is treated as fully settled; on the 244x side the FX residual is booked as its own verifikat to 3960 / 7960, both lines carrying the invoice''s default_dimensions (coerce_dimensions_bag), on the 19xx side nothing is booked. On both sides the voucher''s settlement side is reduced by payment rows that already point at it for other invoices: one verifikat may pay several invoices, never for more than it holds. p_amount states this invoice''s share (invoice currency, bounded by the invoice''s remainder and by what the voucher has left; not on the SEK-booked fallback); without it what the voucher has left must fit inside the remainder. On the 19xx side a posted kontantmetod cut-off the row would contradict refuses. For an ALREADY settled invoice use attach_supplier_invoice_settlement_voucher. p_event_ids (the posting port''s purchase.paid event) are linked to the kursdifferens verifikat before its number is drawn, when one is posted; p_event_mode strict makes a refused link fail the call, anything else logs it (20261018210400). p_link_basis is the basis the door names for the payment row, resolved against the actor: user_confirmed unless a rule or an import made the pair (20261101045830).';

DROP FUNCTION IF EXISTS public.attach_supplier_invoice_settlement_voucher(uuid, uuid, uuid, uuid, text, boolean);

CREATE OR REPLACE FUNCTION public.attach_supplier_invoice_settlement_voucher(p_supplier_invoice_id uuid, p_journal_entry_id uuid, p_user_id uuid, p_company_id uuid, p_notes text DEFAULT NULL::text, p_dry_run boolean DEFAULT false, p_link_basis text DEFAULT 'user_confirmed'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice RECORD;
  v_voucher RECORD;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_acting_user uuid := p_user_id;
  v_accounting_method text;
  v_settled numeric;
  v_explained numeric;
  v_unexplained numeric;
  v_matched numeric;
  v_used numeric;
  v_capacity numeric;
  v_payment_id uuid;
  -- An explicit NULL fails safe: nothing is written and the result says so.
  -- Left raw, `IF NOT NULL` would skip the INSERT and still answer ok, which
  -- reads as a write that never happened.
  v_dry_run boolean := COALESCE(p_dry_run, true);
BEGIN
  -- Attribution, as in link_supplier_invoice_to_voucher: for a user session the
  -- JWT sub is authoritative, so p_user_id cannot point the row at someone else.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ATTACH_SI_SETTLEMENT_NOTES_TOO_LONG',
      'details', jsonb_build_object('max_length', 2000, 'length', char_length(p_notes))
    );
  END IF;

  -- Serialise on the verifikat first, then on the invoice row. Two invoices
  -- attaching to one batch-payment verifikat at the same moment would otherwise
  -- both pass the capacity check below. The order is fixed (verifikat, then
  -- invoice) and link_supplier_invoice_to_voucher takes the invoice row lock
  -- only, so no two callers can wait on each other in a cycle.
  BEGIN
    PERFORM public.lock_cash_account_company(p_company_id);
  EXCEPTION WHEN insufficient_privilege THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND');
  END;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('si-settlement-voucher:' || p_journal_entry_id::text, 0)
  );

  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_INVOICE_NOT_FOUND');
  END IF;

  SELECT id, status, source_type, entry_date, reversed_by_id INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_FOUND');
  END IF;

  -- Before every state check, so a batch that is run twice reports the pair as
  -- already attached instead of as an invoice with nothing left to explain.
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND supplier_invoice_id = p_supplier_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_ALREADY_LINKED');
  END IF;

  -- Before the status check, so a credit note always gets this answer. The
  -- supplier_invoices_credit_note_not_payable constraint keeps a new credit
  -- note out of 'paid', but it is NOT VALID: a row that predates it can still
  -- stand as a paid credit note, and must not slip through as an invoice.
  IF COALESCE(v_invoice.is_credit_note, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_CREDIT_NOTE_UNSUPPORTED');
  END IF;

  -- An open invoice is link_supplier_invoice_to_voucher's business: that one
  -- records the payment. This one only explains a settlement that already stands.
  IF v_invoice.status NOT IN ('paid', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NOT_SETTLED',
      'details', jsonb_build_object('status', v_invoice.status));
  END IF;

  IF COALESCE(v_invoice.currency, 'SEK') <> 'SEK' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_CURRENCY_UNSUPPORTED',
      'details', jsonb_build_object('invoice_currency', v_invoice.currency));
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status));
  END IF;

  -- reverseEntry() flips a cancelled verifikat to status 'reversed', which the
  -- check above already refuses; reversed_by_id is read as well so a cancelled
  -- verifikat can never pass on the status alone.
  IF v_voucher.reversed_by_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_ELIGIBLE',
      'details', jsonb_build_object('reason', 'reversed'));
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_NOT_ELIGIBLE',
      'details', jsonb_build_object('reason', 'source_type', 'source_type', v_voucher.source_type));
  END IF;

  -- A closed or locked period is NOT a reason to refuse: the row is reskontra,
  -- no verifikat is written or changed, and the payments this exists for sit in
  -- imported years that are closed by nature (link_supplier_invoice_to_voucher
  -- allows a locked period on the same ground). What must not happen is that a
  -- figure already ACTED ON shifts silently. A posted kontantmetoden cut-off for
  -- a year ending on E counted this invoice as a skuld when the invoice is
  -- dated on or before E and no payment on or before E was known. Evidence
  -- dated on or before E would make a recomputation disagree with that posted
  -- verifikat, with no rättelse to say why. So it is refused: the wrong cut-off
  -- is corrected first (storno the pair, which then reads as absent here exactly
  -- as it does in inspectKontantmetodCutoffPostings, and post it again).
  -- Evidence dated after E leaves that cut-off right and passes.
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
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_CUTOFF_ALREADY_POSTED',
      'details', jsonb_build_object(
        'voucher_date', v_voucher.entry_date,
        'invoice_date', v_invoice.invoice_date
      ));
  END IF;

  -- What stands as settled. 'paid' means the whole total by definition of the
  -- status, and the total is also what the cut-off measures the rows against;
  -- 'partially_paid' is settled to the extent paid_amount says.
  v_settled := ROUND((CASE WHEN v_invoice.status = 'paid'
                           THEN COALESCE(v_invoice.total, 0)
                           ELSE COALESCE(v_invoice.paid_amount, 0) END) * 100) / 100;

  SELECT COALESCE(SUM(amount), 0) INTO v_explained
  FROM public.supplier_invoice_payments
  WHERE company_id = p_company_id
    AND supplier_invoice_id = p_supplier_invoice_id;
  v_explained := ROUND(v_explained * 100) / 100;

  v_unexplained := ROUND((v_settled - v_explained) * 100) / 100;
  IF v_unexplained <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NOTHING_TO_EXPLAIN',
      'details', jsonb_build_object('settled', v_settled, 'explained', v_explained));
  END IF;

  -- The settlement side, by accounting method (defaults to accrual when there
  -- is no settings row, as in link_invoice_to_voucher).
  SELECT cs.accounting_method INTO v_accounting_method
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  v_accounting_method := COALESCE(v_accounting_method, 'accrual');

  IF v_accounting_method = 'cash' THEN
    -- Kontantmetoden: the paying verifikat credits a liquid-funds account (19xx).
    SELECT COALESCE(SUM(credit_amount), 0) INTO v_matched
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE '19%'
      AND credit_amount > 0;
  ELSE
    -- Faktureringsmetoden: the paying verifikat debits leverantörsskulder (244x).
    SELECT COALESCE(SUM(debit_amount), 0) INTO v_matched
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id
      AND account_number LIKE '244%'
      AND debit_amount > 0;
  END IF;
  v_matched := ROUND(v_matched * 100) / 100;

  IF v_matched <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_NO_SETTLEMENT_SIDE',
      'details', jsonb_build_object(
        'accounting_method', v_accounting_method,
        'expected', CASE WHEN v_accounting_method = 'cash' THEN '19xx credit' ELSE '244x debit' END
      ));
  END IF;

  -- A row in another currency on the same verifikat has used an amount of the
  -- kronor side that cannot be read off the row, so the capacity is unknown.
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND journal_entry_id = p_journal_entry_id
      AND COALESCE(currency, 'SEK') <> 'SEK'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_VOUCHER_CURRENCY_UNSUPPORTED');
  END IF;

  -- Every row already pointing at this verifikat, whichever invoice and
  -- whichever path wrote it, has used part of its settlement side.
  SELECT COALESCE(SUM(amount), 0) INTO v_used
  FROM public.supplier_invoice_payments
  WHERE company_id = p_company_id
    AND journal_entry_id = p_journal_entry_id;
  v_used := ROUND(v_used * 100) / 100;

  v_capacity := ROUND((v_matched - v_used) * 100) / 100;
  IF v_unexplained > v_capacity + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ATTACH_SI_SETTLEMENT_EXCEEDS_VOUCHER',
      'details', jsonb_build_object(
        'unexplained', v_unexplained,
        'voucher_settlement_side', v_matched,
        'already_attached', v_used,
        'capacity', v_capacity
      ));
  END IF;

  IF NOT v_dry_run THEN
    -- The fixed prefix marks every row this function wrote, so one run can be
    -- found and undone with a single DELETE (same idea as backfill:#2019).
    INSERT INTO public.supplier_invoice_payments (
      user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
      journal_entry_id, transaction_id, notes, link_basis, link_evidence
    ) VALUES (
      v_acting_user, p_company_id, p_supplier_invoice_id, v_voucher.entry_date,
      v_unexplained, 'SEK', p_journal_entry_id, NULL,
      'settlement-evidence' || CASE WHEN p_notes IS NULL THEN '' ELSE ': ' || p_notes END,
      public.resolve_link_basis(p_link_basis), NULL
    )
    RETURNING id INTO v_payment_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', v_dry_run,
    'payment_id', v_payment_id,
    'supplier_invoice_id', p_supplier_invoice_id,
    'journal_entry_id', p_journal_entry_id,
    'payment_date', v_voucher.entry_date,
    'amount', v_unexplained,
    'settled', v_settled,
    'explained_before', v_explained,
    'voucher_settlement_side', v_matched,
    'voucher_capacity_after', ROUND((v_capacity - v_unexplained) * 100) / 100
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.attach_supplier_invoice_settlement_voucher(uuid, uuid, uuid, uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_supplier_invoice_settlement_voucher(uuid, uuid, uuid, uuid, text, boolean, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.attach_supplier_invoice_settlement_voucher(uuid, uuid, uuid, uuid, text, boolean, text) IS
  'Attach the posted verifikat that paid an ALREADY settled supplier invoice (status paid or partially_paid) as the evidence for the part of the settled amount no supplier_invoice_payments row explains yet. Writes one payment row dated at the verifikat and nothing else: the invoice row and the journal are never touched. Accounting-method aware (19xx credit on kontantmetoden, 244x debit on faktureringsmetoden); one verifikat may settle several invoices up to its settlement side. SEK invoices only, no credit notes. A closed period does not refuse; a posted kontantmetoden cut-off that the evidence would contradict does. p_dry_run runs every check without writing. For an OPEN invoice use link_supplier_invoice_to_voucher, which records the payment. p_link_basis is the basis the door names for the payment row, resolved against the actor: user_confirmed unless a rule or an import made the pair (20261101045830).';

CREATE OR REPLACE FUNCTION public.commit_provider_migration_followup(p_job_id uuid, p_worker_id uuid, p_attempt integer, p_records jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; entry uuid; outcome jsonb; message text; si supplier_invoices; source jsonb;
  replaced uuid;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase NOT IN ('link','reconcile','settle') OR jsonb_array_length(p_records)>25 THEN
    RAISE EXCEPTION 'MIGRATION_PHASE_CONFLICT'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    SELECT * INTO STRICT c FROM migration_job_chunks WHERE id=(r->>'id')::uuid AND job_id=j.id FOR UPDATE;
    IF (j.phase='link' AND c.state<>'imported') OR (j.phase='reconcile' AND c.state<>'linked')
      OR (j.phase='settle' AND c.state<>'planned') THEN CONTINUE; END IF;
    BEGIN
      IF r ? 'error' THEN RAISE EXCEPTION '%',r->>'error'; END IF;
      IF j.phase='link' THEN
        entry:=NULLIF(r->>'journal_entry_id','')::uuid;
        IF entry IS NOT NULL THEN
          IF NOT EXISTS(SELECT 1 FROM journal_entries WHERE id=entry AND company_id=j.company_id AND status='posted') THEN
            RAISE EXCEPTION 'MIGRATION_VOUCHER_UNAVAILABLE'; END IF;
          IF EXISTS(SELECT 1 FROM invoices WHERE company_id=j.company_id AND journal_entry_id=entry AND id<>c.target_id)
            OR EXISTS(SELECT 1 FROM supplier_invoices WHERE company_id=j.company_id AND registration_journal_entry_id=entry AND id<>c.target_id) THEN
            RAISE EXCEPTION 'MIGRATION_REGISTRATION_AMBIGUOUS'; END IF;
          -- A matching source ref on multiple invoices is ambiguous across the
          -- whole job, including invoices in other worker batches.
          IF (SELECT count(*) FROM migration_job_chunks other
            JOIN journal_entries e ON e.id=entry
            JOIN fiscal_periods fp ON fp.id=e.fiscal_period_id
            WHERE other.job_id=j.id AND other.target_id IS NOT NULL
              AND other.receipt->'link'->'sourceVoucher'=c.receipt->'link'->'sourceVoucher'
              AND COALESCE((other.receipt#>>'{link,sourceVoucher,date}')::date,(other.receipt->'link'->>'invoiceDate')::date) BETWEEN fp.period_start AND fp.period_end)>1 THEN
            RAISE EXCEPTION 'MIGRATION_REGISTRATION_AMBIGUOUS'; END IF;
          -- A link that moves from the reversed copy an SIE re-sync left: only
          -- the same source voucher, proven here, never the worker's word.
          replaced:=NULLIF(r#>>'{report,replacesJournalEntryId}','')::uuid;
          IF replaced IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries rev
              JOIN journal_entries tgt ON tgt.id=entry AND tgt.company_id=j.company_id
              WHERE rev.id=replaced AND rev.company_id=j.company_id AND rev.status='reversed'
                AND rev.fiscal_period_id=tgt.fiscal_period_id
                AND rev.source_voucher_number=tgt.source_voucher_number
                AND upper(rev.source_voucher_series)=upper(tgt.source_voucher_series)) THEN
            RAISE EXCEPTION 'MIGRATION_VOUCHER_UNAVAILABLE'; END IF;
          IF c.resource='salesInvoices' THEN
            -- A draft the source booked was issued there: the link marks it
            -- sent in the same row write (invoices_draft_has_no_verifikat).
            -- The second UPDATE then finds the link set and changes nothing.
            UPDATE invoices SET journal_entry_id=entry,status='sent' WHERE id=c.target_id AND company_id=j.company_id
              AND journal_entry_id IS NULL AND status='draft';
            UPDATE invoices SET journal_entry_id=entry WHERE id=c.target_id AND company_id=j.company_id
              AND (journal_entry_id IS NULL OR journal_entry_id=replaced);
          ELSIF r#>>'{report,linkType}' IS DISTINCT FROM 'settlement' THEN
            UPDATE supplier_invoices SET registration_journal_entry_id=entry
              WHERE id=c.target_id AND company_id=j.company_id
                AND (registration_journal_entry_id IS NULL OR registration_journal_entry_id=replaced);
          END IF;
        END IF;
        IF j.provider='bokio' AND c.resource='supplierInvoices' AND c.receipt#>'{link,bokioSource}' IS NOT NULL THEN
          SELECT * INTO STRICT si FROM supplier_invoices WHERE id=c.target_id AND company_id=j.company_id;
          source:=c.receipt#>'{link,bokioSource}' || jsonb_build_object('supplier_id',si.supplier_id);
          outcome:=complete_bokio_supplier_invoice(j.company_id,j.consent_id,si.id,j.id,source,
            jsonb_build_object('updated_at',si.updated_at,'total',si.total,'supplier_id',si.supplier_id),
            jsonb_build_object('origin','import') || CASE WHEN entry IS NOT NULL AND r#>>'{report,linkType}'='settlement'
              THEN jsonb_build_object('voucher_id',entry,'voucher_kind','cash_purchase') ELSE '{}'::jsonb END,false);
          IF outcome->>'outcome'='concurrent_change' OR (outcome->'settlement' IS NOT NULL AND outcome->'settlement'<>'null'::jsonb
            AND NOT COALESCE((outcome#>>'{settlement,ok}')::boolean,false)
            AND outcome#>>'{settlement,code}'<>'ATTACH_SI_SETTLEMENT_ALREADY_LINKED') THEN
            RAISE EXCEPTION 'MIGRATION_BOKIO_COMPLETION_REJECTED'; END IF;
        END IF;
        UPDATE migration_job_chunks SET state=CASE WHEN resource='supplierInvoices' THEN 'linked' ELSE 'done' END,
          receipt=(receipt-'review'-'previous_error_code')||jsonb_build_object('registration',r->'report') WHERE id=c.id;
      ELSIF j.phase='reconcile' THEN
        UPDATE migration_job_chunks SET state='planned',
          receipt=(receipt-'review'-'previous_error_code')||jsonb_build_object('payment',r->'payment') WHERE id=c.id;
      ELSE
        entry:=NULLIF(c.receipt->'payment'->>'journal_entry_id','')::uuid;
        IF entry IS NOT NULL THEN
          IF (SELECT count(*) FROM migration_job_chunks WHERE job_id=j.id
            AND receipt->'payment'->>'journal_entry_id'=entry::text)>1 THEN
            RAISE EXCEPTION 'MIGRATION_PAYMENT_AMBIGUOUS'; END IF;
          IF EXISTS(SELECT 1 FROM supplier_invoice_payments WHERE company_id=j.company_id AND journal_entry_id=entry) THEN
            RAISE EXCEPTION 'MIGRATION_PAYMENT_AMBIGUOUS'; END IF;
          outcome:=link_supplier_invoice_to_voucher(c.target_id,entry,j.user_id,j.company_id,'Provider migration',
            p_link_basis=>c.receipt#>>'{payment,link_basis}');
          IF NOT COALESCE((outcome->>'ok')::boolean,false) THEN
            RAISE EXCEPTION 'MIGRATION_PAYMENT_REJECTED'; END IF;
        END IF;
        UPDATE migration_job_chunks SET state='done',receipt=receipt-'review'-'previous_error_code' WHERE id=c.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
      -- Codes only: Postgres constraint errors can contain source personal
      -- data. A code raised by name keeps that name; anything else its
      -- SQLSTATE. The review detail the worker sent (receipt.review) explains
      -- a review outcome; one left from an earlier attempt is cleared.
      UPDATE migration_job_chunks SET state='needs_attention',error_phase=j.phase,
        error_code=COALESCE(substring(message FROM '^((?:MIGRATION|BOKIO|PROVIDER)_[A-Z0-9_]+)'),SQLSTATE),
        receipt=CASE WHEN jsonb_typeof(r->'review')='object' THEN receipt||jsonb_build_object('review',r->'review')
          ELSE receipt-'review' END
        WHERE id=c.id;
    END;
  END LOOP;
END $function$;

CREATE OR REPLACE FUNCTION public.complete_bokio_supplier_invoice(p_company_id uuid, p_consent_id uuid, p_invoice_id uuid, p_run_id uuid, p_source jsonb, p_expected jsonb, p_plan jsonb, p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
 SET lock_timeout TO '1s'
AS $function$
DECLARE
  c record; w bokio_supplier_completion_work; i supplier_invoices; previous bokio_supplier_completion_entries;
  je journal_entries; before_row jsonb; after_row jsonb; result jsonb; attachment jsonb;
  header jsonb:=p_plan->'header'; rows jsonb:=p_plan->'items'; item jsonb;
  voucher_id uuid:=(p_plan->>'voucher_id')::uuid; document_uuid uuid; target uuid;
  row_count integer:=0; net numeric; vat numeric; ap numeric; bank numeric; booked_vat numeric;
  document_count integer; upload_count integer; resolved_count integer;
  changed boolean:=false; header_changed boolean:=false;
  previous_metadata jsonb; batch_item jsonb; batch_receipts jsonb:='[]'::jsonb; batch_expected jsonb;
  import_mode boolean:=COALESCE(p_plan->>'origin'='import',false); key text; provenance_new boolean:=false;
  dry boolean:=COALESCE(p_dry_run,true); outcome text:=COALESCE(p_plan->>'reason','unresolved');
  event_uuid uuid; payment_date date; fabricated boolean; actor jsonb;
BEGIN
  IF COALESCE(auth.role(),'')<>'service_role' AND (auth.uid() IS NULL OR NOT EXISTS(
    SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=auth.uid() AND role IN ('owner','admin','member')
  )) THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT (SELECT cm.user_id FROM company_members cm WHERE cm.company_id=pc.company_id AND cm.role='owner' ORDER BY cm.user_id LIMIT 1) AS user_id,COALESCE(NULLIF(regexp_replace(pc.org_number,'[^[:alnum:]]','','g'),''),NULLIF(t.provider_company_id,''),pc.id::text) account_key
    INTO c FROM provider_consents pc JOIN provider_consent_tokens t ON t.consent_id=pc.id
    WHERE pc.id=p_consent_id AND pc.company_id=p_company_id AND pc.provider='bokio' AND pc.status IN (0,1);
  IF NOT FOUND THEN RAISE EXCEPTION 'BOKIO_CONSENT_NOT_FOUND'; END IF;
  IF import_mode AND (p_plan - ARRAY['origin','voucher_id','voucher_kind'])<>'{}'::jsonb THEN RAISE EXCEPTION 'BOKIO_IMPORT_PLAN_INVALID'; END IF;
  IF import_mode AND p_invoice_id IS NULL THEN
    IF jsonb_typeof(p_source) IS DISTINCT FROM 'array' OR jsonb_array_length(p_source)>100 THEN
      RAISE EXCEPTION 'BOKIO_IMPORT_BATCH_INVALID'; END IF;
    FOR batch_item IN SELECT value FROM jsonb_array_elements(p_source) LOOP
      SELECT jsonb_build_object('updated_at',updated_at,'total',total,'supplier_id',supplier_id) INTO batch_expected
        FROM supplier_invoices WHERE id=(batch_item->>'invoice_id')::uuid AND company_id=p_company_id;
      batch_receipts:=batch_receipts||jsonb_build_array(complete_bokio_supplier_invoice(p_company_id,p_consent_id,
        (batch_item->>'invoice_id')::uuid,p_run_id,batch_item->'source',batch_expected,
        jsonb_build_object('origin','import')||CASE WHEN batch_item->>'voucher_id' IS NOT NULL
          THEN jsonb_build_object('voucher_id',batch_item->>'voucher_id','voucher_kind','cash_purchase') ELSE '{}'::jsonb END,dry));
    END LOOP;
    RETURN jsonb_build_object('receipts',batch_receipts);
  END IF;
  IF NOT dry AND NOT import_mode THEN
    SELECT * INTO w FROM bokio_supplier_completion_work WHERE company_id=p_company_id FOR UPDATE;
    IF NOT FOUND OR p_run_id IS NULL OR w.run_id IS DISTINCT FROM p_run_id OR w.lease_until IS NULL OR w.lease_until<clock_timestamp()
      OR w.consent_id IS DISTINCT FROM p_consent_id OR w.account_key<>c.account_key THEN RAISE EXCEPTION 'BOKIO_COMPLETION_LEASE_LOST'; END IF;
    SELECT * INTO previous FROM bokio_supplier_completion_entries WHERE company_id=p_company_id AND invoice_id=p_invoice_id;
    IF previous.run_id=p_run_id THEN RETURN previous.receipt; END IF;
  END IF;
  -- Same lock order as settlement attachment, including when called inside
  -- this transaction. No provider/network operation holds these locks.
  IF voucher_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('si-settlement-voucher:'||voucher_id::text,0));
  END IF;
  SELECT * INTO i FROM supplier_invoices WHERE id=p_invoice_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','changed',false); END IF;
  before_row:=jsonb_build_object('subtotal',i.subtotal,'subtotal_sek',i.subtotal_sek,'vat_amount',i.vat_amount,'vat_amount_sek',i.vat_amount_sek,'document_id',i.document_id,'paid_at',i.paid_at);
  IF i.updated_at IS DISTINCT FROM (p_expected->>'updated_at')::timestamptz
    OR i.total IS DISTINCT FROM (p_expected->>'total')::numeric
    OR i.supplier_id IS DISTINCT FROM (p_expected->>'supplier_id')::uuid THEN
    RETURN jsonb_build_object('outcome','concurrent_change','changed',false);
  END IF;
  IF p_source IS NOT NULL THEN
    IF COALESCE(p_source->>'id','')='' OR i.total IS DISTINCT FROM (p_source->>'total')::numeric
      OR i.currency IS DISTINCT FROM p_source->>'currency'
      OR i.invoice_date IS DISTINCT FROM (p_source->>'invoice_date')::date
      OR (i.supplier_invoice_number IS DISTINCT FROM p_source->>'invoice_number'
        -- A reused source number the import stored as payment_reference
        -- (commit_provider_migration_records) is the same invoice.
        AND NOT (i.supplier_invoice_number IS NULL
          AND i.payment_reference IS NOT DISTINCT FROM p_source->>'invoice_number'))
      OR i.supplier_id IS DISTINCT FROM (p_source->>'supplier_id')::uuid
      OR COALESCE(i.is_credit_note,false) IS DISTINCT FROM COALESCE((p_source->>'is_credit_note')::boolean,false) THEN
      RAISE EXCEPTION 'BOKIO_SOURCE_IDENTITY_MISMATCH';
    END IF;
    SELECT target_id,source_metadata INTO target,previous_metadata FROM migration_source_records WHERE company_id=p_company_id AND provider='bokio'
      AND account_key=c.account_key AND resource='supplierInvoices' AND source_id=p_source->>'id';
    provenance_new:=target IS NULL OR NOT (previous_metadata ? 'rule_version');
    IF import_mode AND target IS NULL AND i.created_at<now()-interval '15 minutes' THEN RAISE EXCEPTION 'BOKIO_IMPORT_NOT_FRESH'; END IF;
    IF target IS NOT NULL AND target<>i.id THEN RAISE EXCEPTION 'BOKIO_SOURCE_IDENTITY_MISMATCH'; END IF;
    IF EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=p_company_id AND provider='bokio'
      AND account_key=c.account_key AND resource='supplierInvoices' AND target_id=i.id AND source_id<>p_source->>'id') THEN
      RAISE EXCEPTION 'BOKIO_SOURCE_IDENTITY_MISMATCH';
    END IF;
  ELSIF import_mode OR header IS NOT NULL OR rows IS NOT NULL OR voucher_id IS NOT NULL THEN
    RAISE EXCEPTION 'BOKIO_SOURCE_REQUIRED';
  END IF;
  IF voucher_id IS NOT NULL THEN
    SELECT * INTO je FROM journal_entries WHERE id=voucher_id AND company_id=p_company_id;
    IF NOT FOUND OR je.status<>'posted' OR je.reversed_by_id IS NOT NULL OR je.source_type IN ('opening_balance','storno')
      OR je.source_voucher_series IS DISTINCT FROM p_source#>>'{voucher,series}'
      OR je.source_voucher_number IS DISTINCT FROM (p_source#>>'{voucher,number}')::integer
      OR je.entry_date IS DISTINCT FROM (p_source#>>'{voucher,date}')::date THEN
      RAISE EXCEPTION 'BOKIO_VOUCHER_MISMATCH';
    END IF;
    SELECT COALESCE(sum(credit_amount-debit_amount) FILTER(WHERE account_number LIKE '244%'),0),
      COALESCE(sum(credit_amount-debit_amount) FILTER(WHERE account_number LIKE '19%'),0),
      COALESCE(sum(debit_amount-credit_amount) FILTER(WHERE account_number IN ('2640','2641')),0)
      INTO ap,bank,booked_vat FROM journal_entry_lines WHERE journal_entry_id=voucher_id;
  END IF;
  IF i.currency='SEK' AND NOT COALESCE(i.is_credit_note,false) AND p_source IS NOT NULL THEN
    IF header IS NOT NULL THEN
      net:=(header->>'subtotal')::numeric; vat:=(header->>'vat_amount')::numeric;
      IF net IS NULL OR vat IS NULL OR net<0 OR vat<0 OR net+vat<>i.total
        OR net::text IN ('NaN','Infinity','-Infinity') OR vat::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'BOKIO_HEADER_INVALID';
      END IF;
      IF p_source->>'vat_source'='voucher' AND (voucher_id IS NULL OR round(booked_vat,2)<>vat
        OR NOT ((round(ap,2)=i.total AND bank=0) OR (ap=0 AND round(bank,2)=i.total AND NOT EXISTS(SELECT 1 FROM journal_entry_lines WHERE journal_entry_id=voucher_id AND account_number LIKE '244%')))
        OR EXISTS(SELECT 1 FROM journal_entry_lines WHERE journal_entry_id=voucher_id AND account_number LIKE '26%'
          AND account_number NOT IN ('2640','2641'))) THEN RAISE EXCEPTION 'BOKIO_VAT_NOT_CORROBORATED'; END IF;
      IF COALESCE(p_source->>'vat_source','') NOT IN ('voucher','invoice_lines') THEN RAISE EXCEPTION 'BOKIO_VAT_NOT_CORROBORATED'; END IF;
      -- Missing header and existing rows are separate eligibility decisions.
      IF i.subtotal=i.total AND i.vat_amount=0 AND (NOT EXISTS(
        SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=i.id
      ) OR EXISTS(SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=i.id
        HAVING sum(line_total)=net AND sum(vat_amount)=vat)) THEN
        header_changed:=i.subtotal<>net OR i.vat_amount<>vat;
        i.subtotal:=net; i.subtotal_sek:=net; i.vat_amount:=vat; i.vat_amount_sek:=vat;
      END IF;
    END IF;
    IF rows IS NOT NULL AND NOT EXISTS(SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=i.id) THEN
      IF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
      SELECT sum((r->>'line_total')::numeric),sum((r->>'vat_amount')::numeric) INTO net,vat FROM jsonb_array_elements(rows) r;
      IF net IS DISTINCT FROM i.subtotal OR vat IS DISTINCT FROM i.vat_amount THEN RAISE EXCEPTION 'BOKIO_ROWS_MISMATCH'; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
        FOREACH key IN ARRAY ARRAY['description','quantity','unit_price','line_total','vat_amount','vat_rate','account_number','sort_order'] LOOP
          IF item->>key IS NULL THEN RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
        END LOOP;
        IF EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN
          ('description','quantity','unit','unit_price','line_total','vat_amount','vat_rate','account_number','sort_order'))
          OR item->>'account_number' !~ '^[0-9]{4}$'
          OR (item->>'quantity')::numeric<=0 OR (item->>'sort_order')::integer<0 THEN RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
        FOREACH key IN ARRAY ARRAY['quantity','unit_price','line_total','vat_amount','vat_rate'] LOOP
          IF (item->>key)::numeric<0 OR (item->>key)::numeric::text IN ('NaN','Infinity','-Infinity') THEN
            RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
        END LOOP;
        IF round((item->>'line_total')::numeric*(item->>'vat_rate')::numeric,2)<>(item->>'vat_amount')::numeric THEN
          RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
      END LOOP;
      row_count:=jsonb_array_length(rows);
      IF NOT dry THEN
        INSERT INTO supplier_invoice_items(supplier_invoice_id,sort_order,description,quantity,unit,unit_price,line_total,account_number,vat_rate,vat_amount)
        SELECT i.id,r.sort_order,r.description,r.quantity,r.unit,r.unit_price,r.line_total,r.account_number,r.vat_rate,r.vat_amount
        FROM jsonb_to_recordset(rows) r(sort_order integer,description text,quantity numeric,unit text,unit_price numeric,
          line_total numeric,account_number text,vat_rate numeric,vat_amount numeric);
      END IF;
    END IF;
    IF voucher_id IS NOT NULL AND p_plan->>'voucher_kind'='cash_purchase' AND round(bank,2)=i.total AND ap=0
      AND (p_source->>'remaining_amount')::numeric=0 AND i.registration_journal_entry_id IS NULL THEN
      IF i.status='paid' THEN
        attachment:=attach_supplier_invoice_settlement_voucher(i.id,voucher_id,COALESCE(auth.uid(),c.user_id),p_company_id,
          'Bokio source invoice reference',dry,p_link_basis=>'import_carried_over');
        IF COALESCE((attachment->>'ok')::boolean,false) THEN payment_date:=(attachment->>'payment_date')::date;
        ELSIF attachment->>'code'='ATTACH_SI_SETTLEMENT_ALREADY_LINKED' THEN
          SELECT p.payment_date INTO payment_date FROM supplier_invoice_payments p
            WHERE p.company_id=p_company_id AND p.supplier_invoice_id=i.id AND p.journal_entry_id=voucher_id;
        END IF;
      ELSE attachment:=jsonb_build_object('ok',false,'code','PAYMENT_REFRESH_REQUIRED');
      END IF;
    END IF;
    fabricated:=i.status='paid' AND i.created_at<'2026-09-20T14:09:27Z'::timestamptz
      AND i.paid_at=(i.invoice_date::timestamp AT TIME ZONE 'UTC')
      AND NOT EXISTS(SELECT 1 FROM supplier_invoice_payments WHERE supplier_invoice_id=i.id AND journal_entry_id IS DISTINCT FROM voucher_id);
    IF payment_date IS NOT NULL AND (i.paid_at IS NULL OR fabricated) THEN
      i.paid_at:=(payment_date::timestamp+interval '12 hours') AT TIME ZONE 'UTC';
    ELSIF fabricated AND COALESCE((p_plan->>'clear_fabricated_date')::boolean,false) AND attachment IS NULL THEN i.paid_at:=NULL;
    END IF;
  END IF;
  IF i.document_id IS NULL AND jsonb_typeof(p_source->'upload_ids')='array' THEN
    SELECT count(DISTINCT value) INTO upload_count FROM jsonb_array_elements_text(p_source->'upload_ids');
    SELECT count(DISTINCT m.source_id),count(DISTINCT m.target_id),(array_agg(m.target_id))[1]
      INTO resolved_count,document_count,document_uuid
      FROM migration_source_records m JOIN document_attachments d ON d.id=m.target_id AND d.company_id=p_company_id
      WHERE m.company_id=p_company_id AND m.provider='bokio' AND m.account_key=c.account_key AND m.resource='uploads'
        AND m.source_id IN (SELECT value FROM jsonb_array_elements_text(p_source->'upload_ids'));
    IF upload_count>0 AND resolved_count=upload_count AND document_count=1 THEN i.document_id:=document_uuid; END IF;
  END IF;
  after_row:=jsonb_build_object('subtotal',i.subtotal,'subtotal_sek',i.subtotal_sek,'vat_amount',i.vat_amount,'vat_amount_sek',i.vat_amount_sek,'document_id',i.document_id,'paid_at',i.paid_at);
  changed:=before_row IS DISTINCT FROM after_row OR row_count>0 OR COALESCE((attachment->>'ok')::boolean,false);
  IF changed THEN outcome:='completed'; END IF;
  IF NOT dry AND (changed OR (import_mode AND provenance_new)) THEN
    UPDATE supplier_invoices SET subtotal=i.subtotal,subtotal_sek=i.subtotal_sek,vat_amount=i.vat_amount,vat_amount_sek=i.vat_amount_sek,
      document_id=i.document_id,paid_at=i.paid_at WHERE id=i.id AND company_id=p_company_id;
    event_uuid:=gen_random_uuid();
    actor:=CASE WHEN auth.uid() IS NOT NULL THEN jsonb_build_object('type','user','id',auth.uid())
      ELSE jsonb_build_object('type','cron','id','complete-bokio-supplier-invoices') END;
    INSERT INTO processing_history(event_id,company_id,correlation_id,aggregate_type,aggregate_id,event_type,payload,payload_schema_version,actor,occurred_at)
      VALUES(event_uuid,p_company_id,p_run_id,'SupplierInvoice',i.id,'SupplierInvoiceCompleted',
        jsonb_build_object('source',CASE WHEN import_mode THEN 'bokio-import' ELSE 'complete-bokio-supplier-invoices' END,'provider','bokio','consent_id',p_consent_id,
          'source_id',p_source->>'id','rule_version',1,'vat_source',p_source->>'vat_source',
          'voucher_id',voucher_id,'before',before_row,'after',after_row,'rows_inserted',row_count,'settlement',attachment),1,actor,clock_timestamp());
  END IF;
  result:=jsonb_build_object('outcome',outcome,'changed',changed,'dry_run',dry,'rows',row_count,
    'header_updated',header_changed,'event_id',event_uuid,'settlement',attachment,'before',before_row,'after',after_row);
  IF NOT dry THEN
    IF p_source IS NOT NULL THEN
      INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id,source_metadata)
        VALUES(p_company_id,COALESCE(auth.uid(),c.user_id),'bokio',c.account_key,'supplierInvoices',p_source->>'id',i.id,
          jsonb_build_object('upload_ids',COALESCE(p_source->'upload_ids','[]'::jsonb),'vat_source',p_source->>'vat_source','voucher',p_source->'voucher','rule_version',1))
        ON CONFLICT(company_id,provider,account_key,resource,source_id) DO UPDATE SET source_metadata=EXCLUDED.source_metadata;
    END IF;
    IF NOT import_mode THEN
    INSERT INTO bokio_supplier_completion_entries(company_id,invoice_id,source_id,outcome,run_id,receipt,next_attempt_at)
      VALUES(p_company_id,i.id,p_source->>'id',outcome,p_run_id,result,now()+CASE WHEN outcome IN ('provider_evidence_deferred','write_rejected') THEN interval '15 minutes' ELSE interval '1 day' END)
      ON CONFLICT(company_id,invoice_id) DO UPDATE SET source_id=EXCLUDED.source_id,outcome=EXCLUDED.outcome,
        run_id=EXCLUDED.run_id,receipt=EXCLUDED.receipt,next_attempt_at=EXCLUDED.next_attempt_at;
    END IF;
  END IF;
  RETURN result;
END $function$;

NOTIFY pgrst, 'reload schema';
