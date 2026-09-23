-- "Markera som betald, Befintlig verifikation" for a supplier invoice in a
-- kontantmetod company (issue #2854).
--
-- THE GAP: link_supplier_invoice_to_voucher (20260830140000) read one thing
-- only, the 244x DEBIT of the voucher. That is the settlement of an invoice
-- whose leverantörsskuld is in the books. Under kontantmetoden nothing is
-- booked at registration: the affärshändelse is the payment, and the payment
-- verifikat is Dr cost, Dr 2641 / Cr 19xx with no 244x line at all. Every such
-- voucher was answered with LINK_SI_VOUCHER_NO_AP_DEBIT, which left mark-paid
-- as the only way to close the invoice, and mark-paid books the cost and the
-- ingående moms a SECOND time when the bank row was booked first. The customer
-- twin learned the method on 2026-06-10 (#705); this side never followed,
-- because the rule "which line of a voucher settles this invoice" was written
-- out separately in each RPC and in each TypeScript matcher.
--
-- THE RULE, ONCE: supplier_invoice_settlement_side() below is the single
-- definition for the supplier side. It answers with the account prefix and the
-- entry side to read, and both this RPC and the TypeScript matcher
-- (lib/invoices/supplier-settlement-side.ts) ask it instead of deciding:
--
--   * kontantmetoden AND no registration verifikat  ->  19xx CREDIT
--     ('bank_credit'): the voucher that moved the money IS the whole booking.
--   * everything else                               ->  244x DEBIT ('ap_debit'),
--     exactly as before. That covers faktureringsmetoden, and a kontantmetod
--     company's invoice that DOES carry registration_journal_entry_id (booked
--     at receipt before a method switch, the explicit Bokför route, migrated
--     data): its skuld sits on 244x and only a 244x debit clears it.
--
--   The predicate is the one mark-paid routes on (useCashEntry: cash AND not
--   booked at registration), so "the verifikat mark-paid would have written"
--   and "the existing verifikat the link accepts" are the same shape.
--
-- WHAT THE LINK WRITES on the bank_credit side: one supplier_invoice_payments
-- row and the invoice's paid state. Never a journal line. In particular:
--
--   * no kursdifferens. The FX fallback (a plain kronor voucher settling a
--     foreign invoice, within 10% of remaining * exchange_rate) settles the
--     full remaining, but with no skuld carried at a historical rate there is
--     nothing for a difference to arise against: the cost is already in the
--     books at the rate the money moved. Same reasoning as the customer side
--     (20260919144500); here the bank_credit side already implies "never
--     booked", so there is no extra condition to get wrong.
--   * a closed or locked period never refuses, because nothing is written to
--     it (the ap_debit side can still refuse when an FX residual verifikat
--     would land in a locked period, unchanged).
--
-- A 19xx CREDIT IS A WEAKER DISCRIMINATOR THAN A 244x DEBIT: every payout a
-- company makes credits 19xx. Two guards exist on the bank_credit side only:
--
--   * capacity. The voucher's 19xx credit is reduced by every payment row that
--     already points at the voucher for ANOTHER invoice (mark-paid rows,
--     earlier links, settlement evidence from 20260921084700). What is left is
--     what this link may settle. Without it, last month's payment of a
--     recurring invoice is a perfect amount match for this month's invoice.
--     A voucher whose rows are in another currency, or a kronor voucher read
--     through the FX fallback that already carries rows, has no readable
--     capacity and is refused.
--   * the posted kontantmetod cut-off guard from 20260921084700, for the same
--     reason: the row is dated at the verifikat, and a posted payable cut-off
--     whose year end is on or after both the verifikat and the invoice counted
--     this invoice as a skuld. That cut-off is corrected first.
--
--   The "amount exceeds remaining" rule is kept as it is on both sides: a
--   voucher that still has more to give than the invoice has left is refused,
--   never split on a guess. The unattended auto-link bar (0.95, in
--   bulk-reconcile-supplier-vouchers.ts) is not touched.
--
-- The ap_debit side is unchanged in every outcome: same sums, same guards in
-- the same order, same codes and details, same FX residual verifikat. Two
-- additions apply to both sides and change no answer: the result carries
-- settlement_side, and the function takes the per-verifikat advisory lock that
-- attach_supplier_invoice_settlement_voucher takes, FIRST and in the same
-- order (verifikat, then invoice row), so the capacity check cannot race and
-- the two functions cannot wait on each other in a cycle.
--
-- No table change, no trigger touched. The migration is safe against existing
-- data: it adds one function and replaces one function body.
-- pg-tests: tests/pg/link-supplier-invoice-voucher-kontantmetod.pg.test.ts,
-- and tests/pg/link-voucher-fx-residual.pg.test.ts replays this file last so
-- its whole supplier suite pins the ap_debit side of THIS body.

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

NOTIFY pgrst, 'reload schema';
