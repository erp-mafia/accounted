-- bulk_book_transactions: honor an explicit actor for service-role callers.
--
-- The pending-operations commit path runs on the cookieless service client
-- (createServiceClientNoCookies), where auth.uid() is NULL, so EVERY
-- MCP-approved samlingsverifikation returned BULK_BOOK_UNAUTHORIZED, and the
-- dispatcher then consumed the staged op as 'rejected': the user saw it
-- vanish from /pending and assumed it had been booked (gnubok_feedback
-- 2026-08-24, seq 261545, three op ids). The web /pending path only works
-- because it carries a cookie session.
--
-- Fix: add p_user_id, gated exactly like match_batch_allocate
-- (20260817150000): honored only when auth.role() = 'service_role'; every
-- other caller resolves from its own auth.uid(), so an authenticated
-- PostgREST caller cannot impersonate. v_caller also stamps the journal
-- entry, so service-path commits are attributed to the approving human.
--
-- The body is byte-for-byte the 20260726100000 definition (the latest:
-- currency guard) plus the header parameter and the actor-resolution
-- block. The 4-arg signature is dropped to avoid PostgREST overload
-- ambiguity (the 5th arg has a DEFAULT, so 4-arg call sites still resolve);
-- grants are re-asserted because DROP discards them.
--
-- pg-test: tests/pg/bulk-book-transactions-service-actor.pg.test.ts

DROP FUNCTION IF EXISTS public.bulk_book_transactions(uuid[], uuid, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.bulk_book_transactions(
  p_tx_ids uuid[],
  p_existing_journal_entry_id uuid,
  p_new_entry jsonb,
  p_company_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tx RECORD;
  v_tx_date date;
  v_total_amount numeric := 0;
  v_total_amount_abs numeric;
  v_direction text;
  v_tx_count int := 0;

  -- Currency homogeneity (BFL 4 kap 6 §). A separate "seen" flag rather
  -- than a NULL check on v_currency: the first row's currency can itself
  -- be NULL, and that must still pin the batch to SEK for the rest.
  v_currency text;
  v_currency_seen boolean := false;

  v_voucher RECORD;
  v_voucher_bank_net numeric := 0;

  v_fiscal_period_id uuid;
  v_period_is_closed boolean;
  v_period_locked_at timestamptz;

  v_journal_entry_id uuid;
  v_voucher_series text := 'A';
  v_voucher_number int;
  v_entry_description text;

  v_line jsonb;
  v_line_account text;
  v_line_debit numeric;
  v_line_credit numeric;
  v_line_currency text;
  v_line_dims jsonb;
  v_lines_total_debit numeric := 0;
  v_lines_total_credit numeric := 0;
  v_lines_bank_net numeric := 0;
  v_sort_order int := 0;

  v_docs_linked int := 0;
  v_target_je uuid;

  v_invalid_accounts text[];

  v_now timestamptz := now();
  v_caller uuid;
BEGIN
  -- Actor resolution. p_user_id is an assertion by the caller, so it is
  -- honored only for the service role (the pending-operations commit path
  -- runs on createServiceClientNoCookies, where auth.uid() is NULL). Any
  -- other caller is pinned to its own auth.uid(): an authenticated
  -- PostgREST caller cannot impersonate another member. Mirrors
  -- match_batch_allocate (20260817150000) and undo_sie_import.
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_UNAUTHORIZED');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = v_caller AND company_id = p_company_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_UNAUTHORIZED');
  END IF;

  IF p_tx_ids IS NULL OR array_length(p_tx_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NO_TXS');
  END IF;

  IF (p_existing_journal_entry_id IS NULL AND p_new_entry IS NULL)
     OR (p_existing_journal_entry_id IS NOT NULL AND p_new_entry IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_INVALID_PAYLOAD');
  END IF;

  FOR v_tx IN
    SELECT * FROM public.transactions
    WHERE id = ANY(p_tx_ids) AND company_id = p_company_id
    ORDER BY id
    FOR UPDATE
  LOOP
    v_tx_count := v_tx_count + 1;
    IF v_tx.journal_entry_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TX_ALREADY_BOOKED',
        'details', jsonb_build_object('tx_id', v_tx.id));
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.transaction_voucher_links tvl
      WHERE tvl.transaction_id = v_tx.id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TX_ALREADY_BOOKED',
        'details', jsonb_build_object('tx_id', v_tx.id, 'via', 'transaction_voucher_links'));
    END IF;
    IF v_tx.amount = 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TX_ZERO_AMOUNT',
        'details', jsonb_build_object('tx_id', v_tx.id));
    END IF;

    IF v_tx_date IS NULL THEN
      v_tx_date := v_tx.date;
    ELSIF v_tx_date <> v_tx.date THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_DATE_MISMATCH',
        'details', jsonb_build_object('first_date', v_tx_date, 'other_date', v_tx.date));
    END IF;

    -- Mixed currencies cannot be added into v_total_amount below.
    IF NOT v_currency_seen THEN
      v_currency := COALESCE(v_tx.currency, 'SEK');
      v_currency_seen := true;
    ELSIF v_currency <> COALESCE(v_tx.currency, 'SEK') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_MIXED_CURRENCY',
        'details', jsonb_build_object(
          'currencies', jsonb_build_array(v_currency, COALESCE(v_tx.currency, 'SEK'))));
    END IF;

    IF v_direction IS NULL THEN
      v_direction := CASE WHEN v_tx.amount > 0 THEN 'income' ELSE 'expense' END;
    ELSIF (v_direction = 'income' AND v_tx.amount < 0)
       OR (v_direction = 'expense' AND v_tx.amount > 0) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_DIRECTION_MISMATCH',
        'details', jsonb_build_object('expected', v_direction, 'tx_id', v_tx.id));
    END IF;

    v_total_amount := v_total_amount + v_tx.amount;
  END LOOP;

  IF v_tx_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TXS_NOT_FOUND');
  END IF;

  IF v_tx_count <> COALESCE(array_length(p_tx_ids, 1), 0) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TXS_NOT_FOUND',
      'details', jsonb_build_object('expected', array_length(p_tx_ids, 1), 'found', v_tx_count));
  END IF;

  -- A homogeneous foreign batch is refused too. The debit/credit columns
  -- written below are ALWAYS kronor and this function has no exchange rate:
  -- letting a EUR selection through would post its foreign magnitudes as SEK
  -- and every downstream reader (balansräkning, moms, SIE) would state an
  -- amount matching no affärshändelse. Foreign transactions are booked one at
  -- a time through the FX-aware flows instead.
  IF COALESCE(v_currency, 'SEK') <> 'SEK' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_FOREIGN_CURRENCY',
      'details', jsonb_build_object('currency', v_currency));
  END IF;

  v_total_amount_abs := ABS(v_total_amount);

  IF p_existing_journal_entry_id IS NOT NULL THEN
    SELECT * INTO v_voucher FROM public.journal_entries
    WHERE id = p_existing_journal_entry_id AND company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_JE_NOT_FOUND',
        'details', jsonb_build_object('journal_entry_id', p_existing_journal_entry_id));
    END IF;

    IF v_voucher.status <> 'posted' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_JE_NOT_POSTED',
        'details', jsonb_build_object('status', v_voucher.status));
    END IF;

    SELECT COALESCE(SUM(debit_amount - credit_amount), 0) INTO v_voucher_bank_net
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_existing_journal_entry_id
      AND length(account_number) = 4
      AND account_number BETWEEN '1900' AND '1999';

    IF ABS(v_voucher_bank_net - v_total_amount) > 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_AMOUNT_MISMATCH',
        'details', jsonb_build_object(
          'tx_sum', v_total_amount, 'voucher_bank_net', v_voucher_bank_net));
    END IF;

    FOR v_tx IN
      SELECT * FROM public.transactions
      WHERE id = ANY(p_tx_ids) AND company_id = p_company_id
      ORDER BY id
    LOOP
      INSERT INTO public.transaction_voucher_links
        (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
      VALUES
        (v_caller, p_company_id, v_tx.id, p_existing_journal_entry_id, v_tx.amount, 'bank_line');
    END LOOP;

    IF v_tx_count = 1 THEN
      UPDATE public.transactions
      SET journal_entry_id = p_existing_journal_entry_id,
          reconciliation_method = 'manual',
          is_business = TRUE,
          updated_at = v_now
      WHERE id = p_tx_ids[1];
    ELSE
      UPDATE public.transactions
      SET is_business = TRUE, updated_at = v_now
      WHERE id = ANY(p_tx_ids);
    END IF;

    v_target_je := p_existing_journal_entry_id;
    v_voucher_series := v_voucher.voucher_series;
    v_voucher_number := v_voucher.voucher_number;

  ELSE
    v_entry_description := p_new_entry->>'description';
    IF v_entry_description IS NULL OR LENGTH(TRIM(v_entry_description)) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_MISSING_DESCRIPTION');
    END IF;

    IF jsonb_typeof(p_new_entry->'lines') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_new_entry->'lines') < 2 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NO_LINES');
    END IF;

    WITH submitted AS (
      SELECT DISTINCT value->>'account_number' AS acct
      FROM jsonb_array_elements(p_new_entry->'lines')
    )
    SELECT array_agg(s.acct ORDER BY s.acct) INTO v_invalid_accounts
    FROM submitted s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.chart_of_accounts coa
      WHERE coa.account_number = s.acct
        AND coa.company_id = p_company_id
        AND coa.is_active = true
    );
    IF v_invalid_accounts IS NOT NULL AND array_length(v_invalid_accounts, 1) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_INVALID_ACCOUNT',
        'details', jsonb_build_object('invalid_accounts', v_invalid_accounts));
    END IF;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_entry->'lines')
    LOOP
      v_line_account := v_line->>'account_number';
      v_line_debit := COALESCE((v_line->>'debit_amount')::numeric, 0);
      v_line_credit := COALESCE((v_line->>'credit_amount')::numeric, 0);
      IF v_line_debit < 0 OR v_line_credit < 0 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NEGATIVE_LINE',
          'details', jsonb_build_object('account', v_line_account));
      END IF;
      IF v_line_debit > 0 AND v_line_credit > 0 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_BOTH_SIDES_NONZERO',
          'details', jsonb_build_object('account', v_line_account));
      END IF;
      IF v_line ? 'dimensions'
         AND jsonb_typeof(v_line->'dimensions') IS DISTINCT FROM 'object' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_INVALID_DIMENSIONS',
          'details', jsonb_build_object('account', v_line_account));
      END IF;
      v_lines_total_debit := v_lines_total_debit + v_line_debit;
      v_lines_total_credit := v_lines_total_credit + v_line_credit;
      IF length(v_line_account) = 4 AND v_line_account BETWEEN '1900' AND '1999' THEN
        v_lines_bank_net := v_lines_bank_net + v_line_debit - v_line_credit;
      END IF;
    END LOOP;

    IF ABS(v_lines_total_debit - v_lines_total_credit) > 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_UNBALANCED',
        'details', jsonb_build_object(
          'debit_sum', v_lines_total_debit, 'credit_sum', v_lines_total_credit));
    END IF;

    IF ABS(v_lines_bank_net - v_total_amount) > 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_AMOUNT_MISMATCH',
        'details', jsonb_build_object(
          'tx_sum', v_total_amount,
          'lines_bank_net', v_lines_bank_net));
    END IF;

    SELECT id, is_closed, locked_at INTO v_fiscal_period_id, v_period_is_closed, v_period_locked_at
    FROM public.fiscal_periods
    WHERE company_id = p_company_id AND v_tx_date BETWEEN period_start AND period_end
    ORDER BY period_start DESC LIMIT 1;

    IF v_fiscal_period_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NO_FISCAL_PERIOD',
        'details', jsonb_build_object('tx_date', v_tx_date));
    END IF;

    IF v_period_is_closed OR v_period_locked_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_PERIOD_LOCKED',
        'details', jsonb_build_object('fiscal_period_id', v_fiscal_period_id));
    END IF;

    v_journal_entry_id := gen_random_uuid();

    INSERT INTO public.journal_entries
      (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
       entry_date, description, source_type, status)
    VALUES
      (v_journal_entry_id, v_caller, p_company_id, v_fiscal_period_id, 0, v_voucher_series,
       v_tx_date, v_entry_description, 'manual', 'draft');

    v_sort_order := 0;
    FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_entry->'lines')
    LOOP
      v_line_account := v_line->>'account_number';
      v_line_debit := COALESCE((v_line->>'debit_amount')::numeric, 0);
      v_line_credit := COALESCE((v_line->>'credit_amount')::numeric, 0);
      v_line_currency := COALESCE(v_line->>'currency', 'SEK');

      -- Bag normalization as before (DimensionsBagSchema parity). PR9: the
      -- generated mirrors derive from the stored bag: no explicit columns.
      SELECT COALESCE(jsonb_object_agg(d.key, btrim(d.value)), '{}'::jsonb)
        INTO v_line_dims
      FROM jsonb_each_text(COALESCE(v_line->'dimensions', '{}'::jsonb)) AS d
      WHERE d.key ~ '^[1-9][0-9]*$' AND btrim(d.value) <> '';

      INSERT INTO public.journal_entry_lines
        (journal_entry_id, account_number, debit_amount, credit_amount, currency,
         sort_order, line_description, dimensions)
      VALUES
        (v_journal_entry_id, v_line_account, v_line_debit, v_line_credit, v_line_currency,
         COALESCE((v_line->>'sort_order')::int, v_sort_order),
         v_line->>'line_description',
         v_line_dims);

      v_sort_order := v_sort_order + 1;
    END LOOP;

    SELECT voucher_number INTO v_voucher_number
    FROM public.commit_journal_entry(p_company_id, v_journal_entry_id);

    FOR v_tx IN
      SELECT * FROM public.transactions
      WHERE id = ANY(p_tx_ids) AND company_id = p_company_id
      ORDER BY id
    LOOP
      INSERT INTO public.transaction_voucher_links
        (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
      VALUES
        (v_caller, p_company_id, v_tx.id, v_journal_entry_id, v_tx.amount, 'bank_line');
    END LOOP;

    IF v_tx_count = 1 THEN
      UPDATE public.transactions
      SET journal_entry_id = v_journal_entry_id,
          is_business = TRUE,
          updated_at = v_now
      WHERE id = p_tx_ids[1];
    ELSE
      UPDATE public.transactions
      SET is_business = TRUE, updated_at = v_now
      WHERE id = ANY(p_tx_ids);
    END IF;

    v_target_je := v_journal_entry_id;
  END IF;

  WITH linked AS (
    UPDATE public.document_attachments AS d
    SET journal_entry_id = v_target_je,
        updated_at = v_now
    FROM public.transactions AS t
    WHERE t.id = ANY(p_tx_ids)
      AND t.company_id = p_company_id
      AND t.document_id = d.id
      AND d.company_id = p_company_id
      AND d.journal_entry_id IS NULL
    RETURNING d.id
  )
  SELECT COUNT(*)::int INTO v_docs_linked FROM linked;

  RETURN jsonb_build_object(
    'ok', true,
    'mode', CASE WHEN p_existing_journal_entry_id IS NOT NULL THEN 'link_existing' ELSE 'create_new' END,
    'journal_entry_id', v_target_je,
    'voucher_series', v_voucher_series,
    'voucher_number', v_voucher_number,
    'linked_tx_count', v_tx_count,
    'tx_sum', v_total_amount,
    'docs_linked', v_docs_linked
  );
END;
$$;

COMMENT ON FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid, uuid) IS
  'Bulk-book N SEK bank transactions sharing the same date into a single combined verifikat (samlingsverifikation per BFL 5 kap 6§). Mixed-currency selections are refused with BULK_BOOK_MIXED_CURRENCY (one redovisningsvaluta per BFL 4 kap 6§) and homogeneous non-SEK selections with BULK_BOOK_FOREIGN_CURRENCY (the ledger columns are always kronor and this RPC has no exchange rate). Dimensions PR9: lines write the dimensions bag only: cost_center/project are GENERATED columns derived from keys 1/6. p_user_id is honored only for service_role callers (pending-operations commit path).';

-- Default privileges hand new functions to anon as well (the Supabase
-- template grants EXECUTE ON FUNCTIONS to anon/authenticated/service_role),
-- so PUBLIC and anon are revoked explicitly, as match_batch_allocate does.
REVOKE ALL ON FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_book_transactions(uuid[], uuid, jsonb, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
