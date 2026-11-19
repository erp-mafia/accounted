-- link_invoice_to_voucher: a verifikat that settles several customer invoices
-- can settle one of them with its share (crm#1434). The customer-side mirror
-- of 20261011153000_link_supplier_invoice_to_voucher_share.
--
-- THE GAP: one verifikat often clears several kundfordringar at once: a
-- bankgiro bundle that pays three invoices, or a konstaterad kundförlust
-- booked as one verifikat for several invoices in the old system (Dr 635x,
-- Dr 26xx / Cr 1510 for the sum). The link read the WHOLE 151x credit (or
-- 19xx debit) of that verifikat as the settlement of the one invoice it was
-- asked about and refused with LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING as soon
-- as the credit was larger than the invoice's remainder. The invoices then
-- stayed open in the kundreskontra although the ledger had cleared them, and
-- the only way out was to change a correct verifikat, often in a closed and
-- declared year. The supplier side got the share on 2026-10-11; the customer
-- side was left open then on purpose and is closed here.
--
-- WHAT THE REFUSAL PROTECTS: an invoice must not be settled by an amount that
-- settled something else. That is a rule about amounts: the payment rows
-- pointing at one verifikat may never add up to more than its settlement side,
-- and a row may never be larger than its invoice's remainder. Before this
-- migration the customer side had no capacity rule at all: the same verifikat
-- could be linked in full to a second invoice as long as each fit on its own.
--
-- THE RULE NOW, ON BOTH SIDES (151x credit and 19xx debit):
--
--   * capacity. What a verifikat can settle is its settlement side less every
--     invoice_payments row that already points at it for ANOTHER invoice
--     (earlier links, bank matches, batch allocations). A verifikat with
--     nothing left answers LINK_VOUCHER_FULLY_ALLOCATED.
--   * p_amount, new and optional: the share of the verifikat that is this
--     invoice's, in the invoice's currency. It is bounded by the invoice's
--     remainder (LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING) and by what the
--     verifikat has left (LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER). The rest of the
--     verifikat stays available for the other invoices it covers.
--   * without p_amount nothing is split on a guess, as before: what the
--     verifikat has left must fit inside the invoice's remainder, or the answer
--     is LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING with the same details as before.
--
-- A SHARE NEEDS THE VERIFIKAT IN THE INVOICE'S CURRENCY. The SEK-booked
-- fallback reads a kronor verifikat as the settlement of a foreign invoice's
-- WHOLE remainder and books the kursdifferens from that; the kronor behind a
-- part of such a verifikat are not in the books, so p_amount is refused there
-- (LINK_VOUCHER_CURRENCY_MISMATCH, reason amount_needs_invoice_currency)
-- before any kursdifferens verifikat is drafted.
--
-- WHAT CHANGES FOR A CALL WITHOUT p_amount: only a verifikat that already
-- carries payment rows for other invoices. It used to be read at its full
-- side again (and could settle a second invoice with the same amount); now it
-- is read at what it has left.
--
-- Every other outcome, the order of the guards, the codes and their details
-- are unchanged, and so is everything the function writes: one
-- invoice_payments row, the invoice's paid state and, on the SEK-booked
-- fallback of the 151x side only, the kursdifferens verifikat. The linked
-- verifikat is posted and is never touched. The result gains
-- voucher_remaining: what the verifikat has left after this link.
--
-- Concurrency: two invoices reaching for one verifikat are already serialised
-- by lock_cash_account_company (a row lock on the company, taken first), so
-- the capacity read and the row insert cannot interleave.
--
-- SIGNATURE: p_amount is a sixth parameter with a default, placed as on the
-- supplier side (after p_notes). The old function is dropped first: two
-- overloads that accept the same named arguments cannot be told apart by
-- PostgREST (PGRST203). Callers that pass four or five positional arguments,
-- or name their arguments, resolve unchanged. The application sends p_amount
-- only when a share is stated, so a link without one reads the same against a
-- database that does not have this migration yet.
--
-- Body: the installed definition (20261018210300) plus only the changes
-- above.
-- Kept: the tenant guard, attribution, link basis, business-event linking,
-- lock order, SECURITY DEFINER, search_path, grants and the comment's
-- existing text. No table change, no trigger touched.
--
-- What this does NOT do: record an invoice as written off (status
-- 'written_off') against a verifikat booked elsewhere. That is the
-- kundförlust register (invoice_write_offs, record_invoice_write_off), which
-- stays behind CUSTOMER_LOSS_ENABLED and needs its own decision.
--
-- pg-test: tests/pg/link-invoice-voucher-share.pg.test.ts; the existing suites
-- (link-basis-sql-writers, sql-posting-business-events, sql-posting-paths-actor,
-- link-voucher-rpcs-tenant-guard, link-invoice-voucher-carried,
-- settlement-dimensions, voucher-matching) pin every unchanged outcome.

DROP FUNCTION IF EXISTS public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text, text, text, uuid[], text);

CREATE OR REPLACE FUNCTION public.link_invoice_to_voucher(p_invoice_id uuid, p_journal_entry_id uuid, p_user_id uuid, p_company_id uuid, p_notes text DEFAULT NULL::text, p_amount numeric DEFAULT NULL::numeric, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text, p_event_ids uuid[] DEFAULT NULL::uuid[], p_event_mode text DEFAULT NULL::text)
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
  -- Which side settles this invoice: invoice_settlement_side() (#3440).
  v_settlement_side text;
  v_entry_side text;
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
  -- The SEK-booked fallback read the voucher (as the whole remainder).
  v_fx_fallback boolean := false;
  -- Capacity of the voucher's settlement side, on both sides: what payment
  -- rows for other invoices have already used of it (crm#1434).
  v_used numeric := 0;
  v_used_other_currency integer := 0;
  v_used_rows integer := 0;
  v_side_total numeric;  -- the settlement side before v_used is taken off
  v_side_key text;       -- 'ar_credit' or 'bank_debit', for the details
  -- The caller's stated share of the voucher (p_amount, öre-rounded), or NULL.
  v_amount numeric;
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

  -- A stated share is an amount of money in the invoice's currency: positive
  -- to the öre. Refused before any lock is taken, like the note above.
  IF p_amount IS NOT NULL THEN
    v_amount := ROUND(p_amount * 100) / 100;
    IF v_amount <= 0 OR v_amount = 'NaN'::numeric THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_AMOUNT_INVALID',
        'details', jsonb_build_object('amount', p_amount));
    END IF;
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
  --    INVOICE'S CURRENCY, on the side invoice_settlement_side() names: the
  --    19xx debit for a kontantmetod invoice that was never booked, the 151x
  --    credit for every other invoice (faktureringsmetoden, and a kontantmetod
  --    invoice carried at the year end or otherwise booked). The invoice row
  --    is locked and visible here, so the helper always answers; the
  --    COALESCE keeps the receivable side as the safe default regardless.
  SELECT s.settlement_side, s.account_prefix, s.entry_side
    INTO v_settlement_side, v_account_prefix, v_entry_side
  FROM public.invoice_settlement_side(p_invoice_id, p_company_id) s;
  v_settlement_side := COALESCE(v_settlement_side, 'ar_credit');
  v_account_prefix := COALESCE(v_account_prefix, '151');
  v_entry_side := COALESCE(v_entry_side, 'credit');

  -- `invoices.currency` is `text default 'SEK'` and therefore NULLABLE; a
  -- missing code has always meant kronor, and must not be read as "not SEK".
  v_invoice_currency := COALESCE(v_invoice.currency, 'SEK');

  IF v_invoice_currency = 'SEK' THEN
    -- From 20260620130000, branching on the settlement side instead of the
    -- company's method. The ledger columns are kronor already, so the
    -- document label on the line is irrelevant here.
    IF v_settlement_side = 'bank_debit' THEN
      -- Kontantmetoden, unbooked invoice: the payment verifikat debits a
      -- liquid-funds account (19xx).
      SELECT COALESCE(SUM(debit_amount), 0), MAX(currency)
        INTO v_ar_credit_total, v_line_currency
      FROM public.journal_entry_lines
      WHERE journal_entry_id = p_journal_entry_id
        AND account_number LIKE '19%'
        AND debit_amount > 0;
    ELSE
      -- The invoice is booked (faktureringsmetoden, or a kontantmetod carry):
      -- the payment verifikat credits the AR account (151x).
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
      COALESCE(SUM(CASE WHEN v_entry_side = 'debit' THEN l.debit_amount ELSE l.credit_amount END) FILTER (
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
      AND (CASE WHEN v_entry_side = 'debit' THEN l.debit_amount ELSE l.credit_amount END) > 0;

    IF COALESCE(v_unreadable_count, 0) > 0 THEN
      -- A stated share needs the voucher's side in the invoice's currency.
      -- The fallback below reads a kronor voucher as the settlement of the
      -- invoice's WHOLE remainder and books the kursdifferens from that; the
      -- kronor behind a part of it are not in the books, so a share would
      -- book a kursdifferens on a guess. Answered before the fallback, so the
      -- caller reads why and not a deviation the share itself produced.
      IF v_amount IS NOT NULL THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
          'details', jsonb_build_object(
            'invoice_currency', v_invoice.currency,
            'line_currency', v_unreadable_currency,
            'reason', 'amount_needs_invoice_currency'
          )
        );
      END IF;
      -- FX residual fallback (new): the voucher settles the invoice in plain
      -- kronor. Engage only in the unambiguous case; see the header comment.
      -- The readable gate counts LINES (see the aggregate comment): with
      -- zero readable lines, v_sek_side_total is provably the FULL
      -- matched-side ledger sum and v_line_currency is NULL by construction.
      -- Both sides are unambiguous now that the side follows the invoice's
      -- own booking: a booked invoice (accrual, or a kontantmetod carry) is
      -- read on its 151x credit and trued up below, an unbooked kontantmetod
      -- invoice on its 19xx debit with nothing to true up. Before #3440 a
      -- booked kontantmetod invoice was read on the 19xx side and had to be
      -- refused here.
      IF v_settlement_side IN ('ar_credit', 'bank_debit')
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
        -- The receivable side books the residual verifikat below; the 19xx
        -- side never does. Only an invoice that was never booked reads the
        -- 19xx side, so there is no receivable for a kursdifferens to arise
        -- against: the revenue is already in the books at the rate the money
        -- actually moved, and the link settles the full remaining and writes
        -- no new bookkeeping at all.
        v_fx_fallback := true;
        v_fx_settled := (v_settlement_side = 'ar_credit');
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
        -- labels, an invoice-labelled line without a figure, or a
        -- missing/insane exchange rate.
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

  -- Capacity, on both sides: what the settlement side has left after the rows
  -- that already point at this verifikat for OTHER invoices, whichever path
  -- wrote them. One verifikat may settle several invoices, but its rows can
  -- never add up to more than the side they settle against. This invoice's
  -- own row is left to the already-linked guard below, so a repeated link
  -- keeps its own answer.
  v_side_key := CASE WHEN v_settlement_side = 'bank_debit' THEN 'bank_debit' ELSE 'ar_credit' END;
  SELECT
    COALESCE(SUM(p.amount) FILTER (WHERE COALESCE(p.currency, 'SEK') = v_invoice_currency), 0),
    COUNT(*) FILTER (WHERE COALESCE(p.currency, 'SEK') <> v_invoice_currency),
    COUNT(*)
    INTO v_used, v_used_other_currency, v_used_rows
  FROM public.invoice_payments p
  WHERE p.company_id = p_company_id
    AND p.journal_entry_id = p_journal_entry_id
    AND p.invoice_id <> p_invoice_id;

  IF v_fx_fallback AND v_used_rows > 0 THEN
    -- The kronor voucher was read as settling THIS invoice's full remaining;
    -- it cannot also be the settlement of another one.
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_FULLY_ALLOCATED',
      'details', jsonb_build_object('linked_rows', v_used_rows));
  END IF;
  IF v_used_other_currency > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'reason', 'voucher_settles_other_currency'
      )
    );
  END IF;
  v_used := ROUND(v_used * 100) / 100;
  v_side_total := v_ar_credit_total;
  IF v_ar_credit_total - v_used <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_FULLY_ALLOCATED',
      'details', jsonb_build_object(v_side_key, v_side_total, 'already_linked', v_used));
  END IF;
  -- From here on v_ar_credit_total is what the voucher has LEFT.
  v_ar_credit_total := ROUND((v_ar_credit_total - v_used) * 100) / 100;

  -- Both sides are now in the invoice's currency.
  IF v_amount IS NULL THEN
    -- No stated share: nothing is split on a guess. What the voucher has left
    -- must fit inside the invoice's remainder. Details as before this change.
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
  ELSE
    -- A stated share: bounded by the invoice's remainder and by what the
    -- voucher has left. The rest of the voucher stays available.
    IF v_amount > v_remaining + 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
        'details', jsonb_build_object(
          'amount', v_amount,
          'remaining', ROUND(v_remaining * 100) / 100));
    END IF;
    IF v_amount > v_ar_credit_total + 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_AMOUNT_EXCEEDS_VOUCHER',
        'details', jsonb_build_object(
          'amount', v_amount,
          'available', v_ar_credit_total,
          v_side_key, v_side_total,
          'already_linked', v_used));
    END IF;
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

    -- The posting port's events: sale.payment_received of the
    -- invoice. Linked to the draft
    -- before commit_journal_entry draws its number (20261018210000).
    PERFORM public.link_business_events_to_draft(
      p_company_id, v_fx_entry_id, p_event_ids, 'produced', p_event_mode);

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

  -- 5. Compute the advance: the stated share, or all the voucher has left;
  --    never more than the invoice's remainder or the voucher's capacity (the
  --    half-öre tolerance of the guards above is clamped away here).
  v_payment_amount := LEAST(COALESCE(v_amount, v_ar_credit_total), v_ar_credit_total, ROUND(v_remaining * 100) / 100);
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
    exchange_rate, payment_exchange_rate, journal_entry_id, transaction_id, notes,
    link_basis, link_evidence
  ) VALUES (
    v_acting_user, p_company_id, p_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice_currency, v_invoice.exchange_rate, v_payment_rate,
    p_journal_entry_id, NULL, p_notes,
    public.resolve_link_basis('user_confirmed', p_actor_type), NULL
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
    'voucher_remaining', ROUND((v_ar_credit_total - v_payment_amount) * 100) / 100,
    'fx_settled_sek', CASE WHEN v_fx_settled THEN v_sek_side_total END,
    'fx_residual_sek', CASE WHEN v_fx_settled THEN v_fx_diff END,
    'fx_journal_entry_id', v_fx_entry_id,
    'fx_voucher_number', v_fx_voucher_number
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text, uuid[], text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text, numeric, text, text, uuid[], text) IS
  'Link a posted verifikat to a customer invoice as its payment. The settlement side comes from invoice_settlement_side(): the 19xx debit for a kontantmetod company''s invoice with no booking verifikat, the 151x credit otherwise (faktureringsmetoden, and a kontantmetod invoice carried over the year end or otherwise booked). The matched amount is resolved in the INVOICE''S currency: the raw ledger column on a SEK invoice, ABS(amount_in_currency) on a foreign one. A foreign invoice settled by a plain-SEK voucher (within 10% of remaining * exchange_rate) is treated as fully settled; on the 151x side the FX residual is booked as its own verifikat to 7960 (loss) / 3960 (gain), both lines carrying the invoice''s default_dimensions (coerce_dimensions_bag), on the 19xx side nothing is booked; every other unreadable case is refused. p_event_ids (the posting port''s sale.payment_received event) are linked to the kursdifferens verifikat before its number is drawn, when one is posted; p_event_mode strict makes a refused link fail the call, anything else logs it (20261018210300). On both sides the voucher''s settlement side is reduced by invoice_payments rows that already point at it for other invoices: one verifikat may settle several invoices, never for more than it holds. p_amount states this invoice''s share (invoice currency, bounded by the invoice''s remainder and by what the voucher has left; not on the SEK-booked fallback); without it what the voucher has left must fit inside the remainder (20261026007000).';

NOTIFY pgrst, 'reload schema';
