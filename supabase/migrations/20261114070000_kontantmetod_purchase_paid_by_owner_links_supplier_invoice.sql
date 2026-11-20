-- pg-test: tests/pg/link-supplier-invoice-voucher-owner-paid.pg.test.ts
-- link_supplier_invoice_to_voucher: a kontantmetod purchase the owner paid
-- privately links to its supplier invoice (crm#1817).
--
-- THE GAP: under kontantmetoden a supplier invoice with no registration
-- verifikat is settled by the verifikat that booked the purchase at payment,
-- read on its credit side (supplier_invoice_settlement_side() =
-- 'bank_credit'). Only a credit on 19xx counted. When the owner paid the
-- invoice with private money the verifikat is Dr cost, Dr 2641 / Cr 2018
-- Övriga egna insättningar (enskild firma) or Cr 2893 Skulder till närstående
-- personer (aktiebolag): the same verifikat the product's own utlägg writer
-- posts for an invoice registered as paid privately. Booked by hand or by an
-- agent it could not be linked (LINK_SI_VOUCHER_NO_BANK_CREDIT) and the
-- candidate search found nothing, so the invoice stayed open in the
-- reskontra, and mark-paid, the only way left, books the cost and the moms a
-- second time. The customer side got the same repair in 20261031225028.
--
-- THE RULE NOW, in two functions the TypeScript matcher and validator twin
-- (lib/invoices/supplier-settlement-side.ts, pinned by a pg-real parity
-- test):
--   supplier_invoice_settlement_line(side, account, books_purchase): on the
--     bank_credit side a line settles when it is on 19xx, as before, or on
--     2018 or 2893 when the verifikat books a purchase. On the ap_debit side
--     nothing changes: 244x.
--   supplier_invoice_voucher_books_purchase(lines, line_accounts): the
--     verifikat books a purchase when a line DEBITS a cost account (class 4,
--     5, 6 or 7) or an account the invoice's own lines post to
--     (supplier_invoice_items.account_number, never a 19xx one). An owner's
--     deposit or loan (Dr 19xx / Cr 2018 or 2893), a skuld cleared by the
--     owner (Dr 2440 / Cr 2893) and a year-end transfer inside eget kapital
--     debit none of those, so their credit is not a payment of this invoice.
--
-- Deliberately narrow: only the two owner accounts. An employee's utlägg
-- (2820) and a förening's 2890 are not read; 2890 is also where unrelated
-- short-term debts sit. The 19xx credit is read exactly as before, with or
-- without a purchase on the verifikat.
--
-- link_supplier_invoice_to_voucher: the installed definition (20261101045830)
-- with only the two settlement-line predicates reading
-- supplier_invoice_settlement_line() (the SEK sum and the foreign-invoice
-- aggregate) and the purchase check computed before them. Every guard, code,
-- detail, write, lock, grant and attribution is unchanged, the signature is
-- unchanged (so its grants stand), and on the bank_credit side the RPC still
-- books nothing: the link is reskontra only, dated at the verifikat.
-- supplier_invoice_settlement_side() is unchanged. No table change, no
-- trigger touched.

CREATE OR REPLACE FUNCTION public.supplier_invoice_settlement_line(
  p_settlement_side text,
  p_account_number text,
  p_books_purchase boolean
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(CASE
    WHEN p_settlement_side = 'bank_credit'
      THEN p_account_number LIKE '19%'
           OR (COALESCE(p_books_purchase, false) AND p_account_number IN ('2018', '2893'))
    ELSE p_account_number LIKE '244%'
  END, false)
$$;

REVOKE ALL ON FUNCTION public.supplier_invoice_settlement_line(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_invoice_settlement_line(text, text, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.supplier_invoice_settlement_line(text, text, boolean) IS
  'Whether a verifikat line on p_account_number is on the settlement side supplier_invoice_settlement_side() names: bank_credit (a kontantmetod invoice with no registration verifikat) = 19xx, or the owner''s private funds (2018 Övriga egna insättningar, 2893 Skulder till närstående personer) when the verifikat books a purchase (p_books_purchase, crm#1817); ap_debit = 244x. Read by link_supplier_invoice_to_voucher; the TypeScript twin is settlesOnAccount (lib/invoices/supplier-settlement-side.ts).';

CREATE OR REPLACE FUNCTION public.supplier_invoice_voucher_books_purchase(
  p_lines jsonb,
  p_line_accounts text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM (
      SELECT e ->> 'account_number' AS account_number,
             COALESCE((e ->> 'debit_amount')::numeric, 0) AS debit_amount
      FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) AS e
    ) l
    WHERE l.debit_amount > 0
      AND (l.account_number LIKE '4%'
           OR l.account_number LIKE '5%'
           OR l.account_number LIKE '6%'
           OR l.account_number LIKE '7%'
           OR (l.account_number NOT LIKE '19%'
               AND l.account_number = ANY (COALESCE(p_line_accounts, ARRAY[]::text[]))))
  )
$$;

REVOKE ALL ON FUNCTION public.supplier_invoice_voucher_books_purchase(jsonb, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_invoice_voucher_books_purchase(jsonb, text[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.supplier_invoice_voucher_books_purchase(jsonb, text[]) IS
  'Whether a verifikat (p_lines: [{account_number, debit_amount, credit_amount}]) books a purchase for a supplier invoice whose lines post to p_line_accounts (supplier_invoice_items.account_number): a debit on a cost account (class 4 to 7) or on one of p_line_accounts that is not 19xx. Read by link_supplier_invoice_to_voucher on the bank_credit side, where it decides whether a credit on the owner''s private funds settles (crm#1817); the TypeScript twin is voucherBooksPurchase (lib/invoices/supplier-settlement-side.ts).';

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
  -- bank_credit only: the verifikat books a purchase, so a credit on the
  -- owner's private funds (2018, 2893) settles as a 19xx credit does
  -- (supplier_invoice_voucher_books_purchase, crm#1817).
  v_books_purchase boolean := false;
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

  -- A purchase the owner paid privately credits the owner's funds, not 19xx.
  -- That credit counts only on a verifikat that books a purchase, so an
  -- owner's deposit or loan (Dr 19xx / Cr 2018 or 2893) is never a payment.
  IF v_settlement_side = 'bank_credit' THEN
    v_books_purchase := public.supplier_invoice_voucher_books_purchase(
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'account_number', l.account_number,
                'debit_amount', l.debit_amount,
                'credit_amount', l.credit_amount)), '[]'::jsonb)
         FROM public.journal_entry_lines l
        WHERE l.journal_entry_id = p_journal_entry_id),
      ARRAY(SELECT DISTINCT it.account_number
              FROM public.supplier_invoice_items it
             WHERE it.supplier_invoice_id = p_supplier_invoice_id
               AND it.account_number IS NOT NULL)
    );
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
      AND public.supplier_invoice_settlement_line(v_settlement_side, account_number, v_books_purchase)
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
      AND public.supplier_invoice_settlement_line(v_settlement_side, l.account_number, v_books_purchase)
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

COMMENT ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text, uuid[], text, text) IS
  'Link a posted verifikat to an OPEN supplier invoice as its payment. The settlement side comes from supplier_invoice_settlement_side(): the 244x debit, or the 19xx credit for a kontantmetod company''s invoice with no registration verifikat. On that side a credit on the owner''s private funds (2018, 2893) settles too, on a verifikat that books a purchase (supplier_invoice_settlement_line(), supplier_invoice_voucher_books_purchase(), 20261114070000). The amount is resolved in the INVOICE''S currency (raw ledger column on SEK, ABS(amount_in_currency) on a foreign one). A foreign invoice paid by a plain-SEK voucher (within 10% of remaining * exchange_rate) is treated as fully settled; on the 244x side the FX residual is booked as its own verifikat to 3960 / 7960, both lines carrying the invoice''s default_dimensions (coerce_dimensions_bag), on the 19xx side nothing is booked. On both sides the voucher''s settlement side is reduced by payment rows that already point at it for other invoices: one verifikat may pay several invoices, never for more than it holds. p_amount states this invoice''s share (invoice currency, bounded by the invoice''s remainder and by what the voucher has left; not on the SEK-booked fallback); without it what the voucher has left must fit inside the remainder. On the 19xx side a posted kontantmetod cut-off the row would contradict refuses. For an ALREADY settled invoice use attach_supplier_invoice_settlement_voucher. p_event_ids (the posting port''s purchase.paid event) are linked to the kursdifferens verifikat before its number is drawn, when one is posted; p_event_mode strict makes a refused link fail the call, anything else logs it (20261018210400). p_link_basis is the basis the door names for the payment row, resolved against the actor: user_confirmed unless a rule or an import made the pair (20261101045830).';
