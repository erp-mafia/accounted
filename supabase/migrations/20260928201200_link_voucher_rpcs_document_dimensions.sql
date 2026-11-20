-- link_invoice_to_voucher / link_supplier_invoice_to_voucher: the FX residual
-- verifikat carries the settled invoice's dimension bag.
--
-- Why: when a foreign invoice is settled by a plain-SEK voucher these RPCs
-- book the kursdifferens as their own two-line verifikat (7960 or 3960 against
-- the 151x/244x account the voucher settled). Both lines were written
-- untagged, while the TypeScript payment path tags every leg of a payment
-- verifikat with the invoice's default_dimensions, FX lines included, so the
-- kursvinst/kursförlust of a project's invoice landed outside the project's
-- result whenever the settlement went through a voucher link.
--
-- Both residual lines belong to that one invoice, so both carry its bag, read
-- through public.coerce_dimensions_bag (the TypeScript coerceDimensionsBag).
-- An untagged invoice writes '{}' exactly as before. The linked voucher itself
-- is posted and immutable and is never touched; amounts, accounts, sort order,
-- descriptions and balance are unchanged.
--
-- Bodies: the installed definitions (customer: 20260921181008; supplier:
-- 20260922090239, whose reviewed body 20260922123749 verified) verbatim, plus
-- only the dimension changes. Tenant guards, attribution, lock order,
-- SECURITY DEFINER and search_path are untouched; grants and comments are
-- restated. Account dimension rules are not enforced here: they live in
-- TypeScript only, by design (dimension-rules.ts).
--
-- pg-test: covered-by tests/pg/settlement-dimensions.pg.test.ts

CREATE OR REPLACE FUNCTION public.link_invoice_to_voucher(
  p_invoice_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_notes text DEFAULT NULL::text
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

    SELECT voucher_number INTO v_fx_voucher_number
    FROM public.commit_journal_entry(p_company_id, v_fx_entry_id);
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

REVOKE ALL ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) IS
  'Link a posted verifikat to a customer invoice as its payment. Accounting-method aware (151x credit on faktureringsmetoden, 19xx debit on kontantmetoden). The matched amount is resolved in the INVOICE''S currency: the raw ledger column on a SEK invoice, ABS(amount_in_currency) on a foreign one. A foreign invoice settled by a plain-SEK voucher (accrual only, within 10% of remaining * exchange_rate) is treated as fully settled and the FX residual is booked as its own verifikat to 7960 (loss) / 3960 (gain), both lines carrying the invoice''s default_dimensions (coerce_dimensions_bag); every other unreadable case is refused.';

CREATE OR REPLACE FUNCTION public.link_supplier_invoice_to_voucher(
  p_supplier_invoice_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_notes text DEFAULT NULL::text
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
  -- Capacity of the voucher's 19xx credit (bank_credit only).
  v_used numeric := 0;
  v_used_other_currency integer := 0;
  v_used_rows integer := 0;
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
$function$;

REVOKE ALL ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) IS
  'Link a posted verifikat to an OPEN supplier invoice as its payment. The settlement side comes from supplier_invoice_settlement_side(): the 244x debit, or the 19xx credit for a kontantmetod company''s invoice with no registration verifikat. The amount is resolved in the INVOICE''S currency (raw ledger column on SEK, ABS(amount_in_currency) on a foreign one). A foreign invoice paid by a plain-SEK voucher (within 10% of remaining * exchange_rate) is treated as fully settled; on the 244x side the FX residual is booked as its own verifikat to 3960 / 7960, both lines carrying the invoice''s default_dimensions (coerce_dimensions_bag), on the 19xx side nothing is booked. On the 19xx side the voucher''s credit is reduced by payment rows that already point at it for other invoices, and a posted kontantmetod cut-off the row would contradict refuses. For an ALREADY settled invoice use attach_supplier_invoice_settlement_voucher.';

NOTIFY pgrst, 'reload schema';
