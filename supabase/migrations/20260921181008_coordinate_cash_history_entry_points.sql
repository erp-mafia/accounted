-- Coordinate the remaining history/primary writers before their business row
-- locks. Restate the exact relevant current definitions so databases missing
-- these prerequisites receive them too; unrelated migration history is untouched.
-- The only changes to these existing bodies are the first coordination lock.
-- Protected accounting enforcement functions are not changed.

-- Current customer-link behavior: 20260919144500.
CREATE OR REPLACE FUNCTION public.link_invoice_to_voucher(
  p_invoice_id uuid,
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
         sort_order, line_description)
      VALUES
        (v_fx_entry_id, '7960', v_fx_diff, 0, 'SEK', 0,
         'Valutakursförlust ' || v_inv_number_short),
        (v_fx_entry_id, v_fx_account, 0, v_fx_diff, 'SEK', 1,
         'Faktura ' || v_inv_number_short || ' (' || v_invoice_currency || ')');
    ELSE
      -- Settled above booked value: gain. Dr AR / Cr 3960.
      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description)
      VALUES
        (v_fx_entry_id, v_fx_account, ABS(v_fx_diff), 0, 'SEK', 0,
         'Faktura ' || v_inv_number_short || ' (' || v_invoice_currency || ')'),
        (v_fx_entry_id, '3960', 0, ABS(v_fx_diff), 'SEK', 1,
         'Valutakursvinst ' || v_inv_number_short);
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
$$;

-- Current atomic asset lifecycle: 20260920190200.
CREATE OR REPLACE FUNCTION public.block_posted_depreciation_schedule_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  -- Unposted proposals are free to go, and never pay for the flag lookup.
  IF OLD.journal_entry_id IS NULL THEN
    RETURN OLD;
  END IF;

  -- Tenant teardown removes the row together with the verifikat it points at.
  IF current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Cannot delete a posted depreciation schedule (id=%): it is linked to journal entry %',
    OLD.id, OLD.journal_entry_id
    USING ERRCODE = '23514',
          HINT = 'Reverse the depreciation voucher or dispose the asset. The register row is räkenskapsinformation (BFL 7 kap.).';
END;
$function$;

DROP TRIGGER IF EXISTS block_posted_depreciation_schedule_delete ON public.depreciation_schedules;
CREATE TRIGGER block_posted_depreciation_schedule_delete
  BEFORE DELETE ON public.depreciation_schedules
  FOR EACH ROW EXECUTE FUNCTION public.block_posted_depreciation_schedule_delete();

-- =============================================================================
-- 2. commit_asset_depreciation: voucher and register link in one transaction
-- =============================================================================

CREATE OR REPLACE FUNCTION public.commit_asset_depreciation(
  p_company_id uuid,
  p_asset_id uuid,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_planned_depreciation numeric,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer, schedule_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_asset_user_id uuid;
  v_entry_user_id uuid;
  v_draft_debit numeric;
  v_schedule_id uuid;
  v_schedule_entry_id uuid;
  v_voucher_number integer;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- Same NULL-safe membership guard as commit_asset_disposal.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (
       NOT public.caller_is_company_member(p_company_id)
       OR NOT public.current_user_can_write()
     ) THEN
    RAISE EXCEPTION 'unauthorized asset depreciation for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  IF p_planned_depreciation IS NULL OR p_planned_depreciation <= 0 THEN
    RAISE EXCEPTION 'Planned depreciation must be positive'
      USING ERRCODE = '23514';
  END IF;

  -- The asset row lock is what post-versus-delete serialises on:
  -- delete_never_posted_asset takes the same lock before it decides. A
  -- delete that won the race leaves no row here, and no voucher is posted.
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT a.user_id
    INTO v_asset_user_id
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found: %', p_asset_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Pin what this RPC can post: a year_end draft of this company and period.
  SELECT je.user_id
    INTO v_entry_user_id
    FROM public.journal_entries je
   WHERE je.id = p_entry_id
     AND je.company_id = p_company_id
     AND je.fiscal_period_id = p_fiscal_period_id
     AND je.status = 'draft'
     AND je.source_type = 'year_end'
   FOR UPDATE;

  -- 22023, not P0002: a missing ASSET is an expected outcome of a concurrent
  -- delete that the caller skips, while a bad draft is a caller bug. Distinct
  -- SQLSTATEs let the engine tell them apart without parsing message text.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Valid depreciation draft not found: %', p_entry_id
      USING ERRCODE = '22023';
  END IF;

  -- The RPC is independently callable, so the amount the register records
  -- must be the amount the voucher books, not whatever the caller passes.
  SELECT coalesce(sum(l.debit_amount), 0)
    INTO v_draft_debit
    FROM public.journal_entry_lines l
   WHERE l.journal_entry_id = p_entry_id;

  IF abs(v_draft_debit - p_planned_depreciation) > 0.005 THEN
    RAISE EXCEPTION 'Planned depreciation % does not match the draft voucher total %',
      p_planned_depreciation, v_draft_debit
      USING ERRCODE = '23514';
  END IF;

  SELECT ds.id, ds.journal_entry_id
    INTO v_schedule_id, v_schedule_entry_id
    FROM public.depreciation_schedules ds
   WHERE ds.asset_id = p_asset_id
     AND ds.fiscal_period_id = p_fiscal_period_id
   FOR UPDATE;

  -- unique_violation on purpose: it IS the (asset_id, fiscal_period_id)
  -- invariant, met one step earlier than the constraint would meet it.
  IF FOUND AND v_schedule_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Depreciation is already posted for asset % in this fiscal period', p_asset_id
      USING ERRCODE = '23505';
  END IF;

  -- Voucher first, link second: the order the old two-statement code used,
  -- now inside one transaction, so a failure at the link step takes the
  -- voucher commit (and its sequence increment) down with it.
  SELECT committed.voucher_number
    INTO v_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      p_entry_id,
      NULL,
      NULL,
      p_actor_type,
      p_actor_label
    ) AS committed;

  IF v_schedule_id IS NOT NULL THEN
    UPDATE public.depreciation_schedules
       SET planned_depreciation = p_planned_depreciation,
           journal_entry_id = p_entry_id,
           posted_at = now()
     WHERE id = v_schedule_id;
  ELSE
    INSERT INTO public.depreciation_schedules (
      user_id,
      company_id,
      asset_id,
      fiscal_period_id,
      planned_depreciation,
      journal_entry_id,
      posted_at
    ) VALUES (
      coalesce(v_entry_user_id, v_asset_user_id),
      p_company_id,
      p_asset_id,
      p_fiscal_period_id,
      p_planned_depreciation,
      p_entry_id,
      now()
    )
    RETURNING id INTO v_schedule_id;
  END IF;

  RETURN QUERY SELECT v_voucher_number, v_schedule_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, text, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.commit_asset_depreciation(
  uuid, uuid, uuid, uuid, numeric, text, text
) IS 'Atomically posts a planenlig avskrivning voucher and links its depreciation_schedules row, under the asset row lock. Voucher numbering is delegated to commit_journal_entry.';

-- =============================================================================
-- 3. delete_never_posted_asset: the rule decided under the same lock
-- =============================================================================
--
-- SECURITY INVOKER on purpose: the delete keeps running as the caller, so the
-- assets_delete / depreciation_schedules_delete RLS policies and the
-- company-writer-role trigger apply exactly as they did when this was two
-- PostgREST statements. Expected outcomes are returned, not raised: nothing
-- has been written when the answer is a refusal.

CREATE OR REPLACE FUNCTION public.delete_never_posted_asset(
  p_company_id uuid,
  p_asset_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_disposed_at date;
  v_disposal_entry_id uuid;
BEGIN
  SELECT a.disposed_at, a.disposal_journal_entry_id
    INTO v_disposed_at, v_disposal_entry_id
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_disposed_at IS NOT NULL OR v_disposal_entry_id IS NOT NULL THEN
    RETURN 'disposed';
  END IF;

  -- Read AFTER the lock is held. A posting that was in flight has committed
  -- by now and its link is visible; one that starts later waits on the lock.
  IF EXISTS (
    SELECT 1
      FROM public.depreciation_schedules ds
     WHERE ds.company_id = p_company_id
       AND ds.asset_id = p_asset_id
       AND ds.journal_entry_id IS NOT NULL
  ) THEN
    RETURN 'depreciation_posted';
  END IF;

  DELETE FROM public.depreciation_schedules ds
   WHERE ds.company_id = p_company_id
     AND ds.asset_id = p_asset_id
     AND ds.journal_entry_id IS NULL;

  DELETE FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id;

  RETURN 'deleted';
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_never_posted_asset(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_never_posted_asset(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.delete_never_posted_asset(uuid, uuid)
  IS 'Deletes an asset that never reached the books, deciding under the asset row lock so it serialises with commit_asset_depreciation and commit_asset_disposal. Returns deleted, not_found, disposed or depreciation_posted.';

NOTIFY pgrst, 'reload schema';

-- Current primary eligibility and routing audit: 20260921070500.
CREATE OR REPLACE FUNCTION public.audit_cash_account_routing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  -- Same teardown guard as write_audit_log() (20260807130000).
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  )
  VALUES (
    v_user_id, NEW.company_id, 'UPDATE', TG_TABLE_NAME, NEW.id, v_user_id,
    to_jsonb(OLD), to_jsonb(NEW), 'Updated cash_accounts record',
    COALESCE(
      nullif(current_setting('gnubok.actor_type', true), ''),
      CASE WHEN v_user_id IS NULL THEN 'system' ELSE 'user' END
    ),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_cash_account_routing() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS audit_cash_accounts_routing ON public.cash_accounts;
CREATE TRIGGER audit_cash_accounts_routing
  AFTER UPDATE ON public.cash_accounts
  FOR EACH ROW
  WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.is_primary IS DISTINCT FROM NEW.is_primary)
  EXECUTE FUNCTION public.audit_cash_account_routing();

-- 3. make_cash_account_primary: the user action, check and swap in one
--    transaction
--
-- set_cash_account_primary (20260519154800) checks only that the row exists,
-- so the eligibility rule lived in TypeScript and a disable that committed
-- between that read and the swap left a disabled primary for a moment.
--
-- The rule is NOT added to set_cash_account_primary itself: that function is
-- how the PSD2 sync (upsertFromPsd2) and the twin heal carry the flag onto the
-- row a merge keeps, and that row may be disabled or non-SEK (38 primaries in
-- prod on 2026-09-21: 30 disabled, 8 non-SEK, all from the bank side). With
-- the rule inside, those transfers would raise and a company would end up with
-- no primary. It stays byte-identical; "carry the flag" and "choose a primary"
-- are different operations with different rules.
--
-- FOR UPDATE on the target makes it atomic against the toggle: setEnabled()'s
-- UPDATE of the same row waits for this transaction and then re-evaluates its
-- own predicate (is_primary = false), so it no longer matches; a disable that
-- committed first is seen here and refused.
--
-- Owner/admin is checked here as well as in the route, the way
-- cash_accounts_payee_admin_only does it: the function is callable through
-- PostgREST, and the primary decides where automatic bookings land. The
-- service role (auth.uid() IS NULL) passes.
--
-- Mirrored for the UI by primaryIneligibleReason() in
-- lib/cash-accounts/primary.ts; tests/pg/cash-accounts-routing-audit.pg.test.ts
-- holds the two rule sets together.
CREATE OR REPLACE FUNCTION public.make_cash_account_primary(
  p_company_id uuid,
  p_cash_account_id uuid
)
RETURNS public.cash_accounts
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_row public.cash_accounts;
BEGIN
  PERFORM public.lock_cash_account_booking_state(p_company_id);

  SELECT * INTO v_row
    FROM public.cash_accounts
   WHERE id = p_cash_account_id AND company_id = p_company_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.user_is_company_admin(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PRIMARY_ADMIN_ONLY: only owner or admin may choose the primary bank account'
      USING ERRCODE = '42501';
  END IF;

  -- Order and reason tokens match primaryIneligibleReason().
  IF NOT v_row.enabled THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PRIMARY_INELIGIBLE: disabled' USING ERRCODE = '23514';
  END IF;
  IF upper(COALESCE(v_row.currency, '')) <> 'SEK' THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PRIMARY_INELIGIBLE: not_sek' USING ERRCODE = '23514';
  END IF;
  IF v_row.ledger_account !~ '^19[2-9]\d$' THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PRIMARY_INELIGIBLE: not_bank_account' USING ERRCODE = '23514';
  END IF;

  IF v_row.is_primary THEN
    RETURN v_row;
  END IF;

  -- Clear first: idx_cash_accounts_one_primary_per_company is not deferrable.
  UPDATE public.cash_accounts
     SET is_primary = false
   WHERE company_id = p_company_id AND is_primary AND id <> p_cash_account_id;

  UPDATE public.cash_accounts
     SET is_primary = true
   WHERE id = p_cash_account_id AND company_id = p_company_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.make_cash_account_primary(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.make_cash_account_primary(uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- System primary handover keeps its existing eligibility policy.
CREATE OR REPLACE FUNCTION public.set_cash_account_primary(
  p_company_id uuid,
  p_cash_account_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  PERFORM public.lock_cash_account_booking_state(p_company_id);

  -- Guard: refuse to set primary on an account that doesn't exist or that
  -- belongs to a different company. RLS covers the second case but we want a
  -- clean error rather than a no-op silent UPDATE.
  IF NOT EXISTS (
    SELECT 1 FROM public.cash_accounts
    WHERE id = p_cash_account_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'cash_account not found for company';
  END IF;

  -- Both updates execute in the same statement-level transaction. The partial
  -- unique index idx_cash_accounts_one_primary_per_company is deferred to
  -- transaction commit only if explicitly deferred; UPDATE order matters and
  -- the index is non-deferrable today. Postgres still evaluates uniqueness
  -- at statement boundaries within the function body, so we clear first.
  UPDATE public.cash_accounts
  SET is_primary = false
  WHERE company_id = p_company_id
    AND is_primary = true
    AND id <> p_cash_account_id;

  UPDATE public.cash_accounts
  SET is_primary = true
  WHERE company_id = p_company_id
    AND id = p_cash_account_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_cash_account_primary(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- The sanctioned correction RPC must take the company lock before its journal
-- lock, because line writes now serialize keeper history on the same company.
DO $migration$
DECLARE
  v_definition text := replace(pg_get_functiondef('public.correct_entry_lines_inline(uuid,uuid,uuid[],jsonb,uuid)'::regprocedure), E'\r\n', E'\n');
  v_old text := '  SELECT je.id, je.status, je.entry_date, je.source_type,';
BEGIN
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Unexpected inline correction definition';
  END IF;
  EXECUTE replace(v_definition, v_old,
    E'  PERFORM public.lock_cash_account_company(p_company_id);\n\n' || v_old);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
