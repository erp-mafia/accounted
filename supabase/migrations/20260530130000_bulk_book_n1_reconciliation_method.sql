-- PR #606 review fix — set reconciliation_method='manual' on the N=1
-- create-new branch of bulk_book_transactions so the two N=1 paths
-- (link-existing vs create-new) leave the transactions row in
-- equivalent state. Without this, downstream readers that filter on
-- reconciliation_method (reconciliation reports, status indicators)
-- would treat a single tx bulk-booked via the template path as
-- "unreconciled" while one linked to an existing voucher reads as
-- "manual".
--
-- Only the create-new branch's final UPDATE changes; everything else is
-- byte-identical to 20260530120000_bulk_book_transactions.sql.

CREATE OR REPLACE FUNCTION public.bulk_book_transactions(
  p_tx_ids uuid[],
  p_existing_journal_entry_id uuid,
  p_new_entry jsonb,
  p_user_id uuid,
  p_company_id uuid
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
  v_lines_total_debit numeric := 0;
  v_lines_total_credit numeric := 0;
  v_lines_bank_net numeric := 0;
  v_sort_order int := 0;
  v_now timestamptz := now();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
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
    ORDER BY id FOR UPDATE
  LOOP
    v_tx_count := v_tx_count + 1;
    IF v_tx.journal_entry_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TX_ALREADY_BOOKED',
        'details', jsonb_build_object('tx_id', v_tx.id));
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.transaction_voucher_links tvl WHERE tvl.transaction_id = v_tx.id
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
      v_direction := CASE WHEN v_tx.amount > 0 THEN 'income' ELSE 'expense' END;
    ELSE
      IF v_tx.date <> v_tx_date THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_DATE_MISMATCH',
          'details', jsonb_build_object('expected', v_tx_date, 'got', v_tx.date, 'tx_id', v_tx.id));
      END IF;
      IF (v_tx.amount > 0 AND v_direction = 'expense')
         OR (v_tx.amount < 0 AND v_direction = 'income') THEN
        RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_DIRECTION_MISMATCH',
          'details', jsonb_build_object('tx_id', v_tx.id));
      END IF;
    END IF;
    v_total_amount := v_total_amount + v_tx.amount;
  END LOOP;
  IF v_tx_count = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TXS_NOT_FOUND');
  END IF;
  IF v_tx_count <> array_length(p_tx_ids, 1) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_TXS_NOT_FOUND',
      'details', jsonb_build_object('expected', array_length(p_tx_ids, 1), 'found', v_tx_count));
  END IF;
  v_total_amount_abs := ABS(v_total_amount);
  IF p_existing_journal_entry_id IS NOT NULL THEN
    SELECT * INTO v_voucher FROM public.journal_entries
    WHERE id = p_existing_journal_entry_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_VOUCHER_NOT_FOUND');
    END IF;
    IF v_voucher.status <> 'posted' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_VOUCHER_NOT_POSTED',
        'details', jsonb_build_object('status', v_voucher.status));
    END IF;
    SELECT COALESCE(SUM(debit_amount - credit_amount), 0) INTO v_voucher_bank_net
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_existing_journal_entry_id
      AND account_number >= '1900' AND account_number <= '1999';
    IF v_voucher_bank_net = 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NO_BANK_LINE');
    END IF;
    IF ABS(v_voucher_bank_net - v_total_amount) > 0.005 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_AMOUNT_MISMATCH',
        'details', jsonb_build_object('tx_sum', v_total_amount, 'voucher_bank_net', v_voucher_bank_net));
    END IF;
    FOR v_tx IN
      SELECT * FROM public.transactions
      WHERE id = ANY(p_tx_ids) AND company_id = p_company_id ORDER BY id
    LOOP
      INSERT INTO public.transaction_voucher_links
        (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
      VALUES (p_user_id, p_company_id, v_tx.id, p_existing_journal_entry_id, v_tx.amount, 'bank_line');
    END LOOP;
    IF v_tx_count = 1 THEN
      UPDATE public.transactions SET journal_entry_id = p_existing_journal_entry_id,
        reconciliation_method = 'manual', is_business = TRUE, updated_at = v_now WHERE id = p_tx_ids[1];
    ELSE
      UPDATE public.transactions SET is_business = TRUE, updated_at = v_now WHERE id = ANY(p_tx_ids);
    END IF;
    RETURN jsonb_build_object('ok', true, 'mode', 'link_existing',
      'journal_entry_id', p_existing_journal_entry_id,
      'voucher_series', v_voucher.voucher_series, 'voucher_number', v_voucher.voucher_number,
      'linked_tx_count', v_tx_count, 'tx_sum', v_total_amount);
  END IF;
  v_entry_description := p_new_entry->>'description';
  IF v_entry_description IS NULL OR LENGTH(TRIM(v_entry_description)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_MISSING_DESCRIPTION');
  END IF;
  IF jsonb_typeof(p_new_entry->'lines') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_new_entry->'lines') < 2 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_NO_LINES');
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_entry->'lines') LOOP
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
    v_lines_total_debit := v_lines_total_debit + v_line_debit;
    v_lines_total_credit := v_lines_total_credit + v_line_credit;
    IF v_line_account >= '1900' AND v_line_account <= '1999' THEN
      v_lines_bank_net := v_lines_bank_net + v_line_debit - v_line_credit;
    END IF;
  END LOOP;
  IF ABS(v_lines_total_debit - v_lines_total_credit) > 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_UNBALANCED',
      'details', jsonb_build_object('debit_sum', v_lines_total_debit, 'credit_sum', v_lines_total_credit));
  END IF;
  IF ABS(v_lines_bank_net - v_total_amount) > 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BULK_BOOK_AMOUNT_MISMATCH',
      'details', jsonb_build_object('tx_sum', v_total_amount, 'lines_bank_net', v_lines_bank_net));
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
    (v_journal_entry_id, p_user_id, p_company_id, v_fiscal_period_id, 0, v_voucher_series,
     v_tx_date, v_entry_description, 'manual', 'draft');
  v_sort_order := 0;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_new_entry->'lines') LOOP
    v_line_account := v_line->>'account_number';
    v_line_debit := COALESCE((v_line->>'debit_amount')::numeric, 0);
    v_line_credit := COALESCE((v_line->>'credit_amount')::numeric, 0);
    v_line_currency := COALESCE(v_line->>'currency', 'SEK');
    INSERT INTO public.journal_entry_lines
      (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order, line_description)
    VALUES
      (v_journal_entry_id, v_line_account, v_line_debit, v_line_credit, v_line_currency,
       COALESCE((v_line->>'sort_order')::int, v_sort_order), v_line->>'line_description');
    v_sort_order := v_sort_order + 1;
  END LOOP;
  SELECT voucher_number INTO v_voucher_number FROM public.commit_journal_entry(p_company_id, v_journal_entry_id);
  FOR v_tx IN
    SELECT * FROM public.transactions
    WHERE id = ANY(p_tx_ids) AND company_id = p_company_id ORDER BY id
  LOOP
    INSERT INTO public.transaction_voucher_links
      (user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
    VALUES (p_user_id, p_company_id, v_tx.id, v_journal_entry_id, v_tx.amount, 'bank_line');
  END LOOP;
  -- PR #606 review fix: branch B N=1 now sets reconciliation_method='manual'
  -- so the two N=1 paths leave the row in equivalent state.
  IF v_tx_count = 1 THEN
    UPDATE public.transactions SET journal_entry_id = v_journal_entry_id,
      reconciliation_method = 'manual', is_business = TRUE, updated_at = v_now WHERE id = p_tx_ids[1];
  ELSE
    UPDATE public.transactions SET is_business = TRUE, updated_at = v_now WHERE id = ANY(p_tx_ids);
  END IF;
  RETURN jsonb_build_object('ok', true, 'mode', 'create_new',
    'journal_entry_id', v_journal_entry_id,
    'voucher_series', v_voucher_series, 'voucher_number', v_voucher_number,
    'linked_tx_count', v_tx_count, 'tx_sum', v_total_amount);
END;
$$;

NOTIFY pgrst, 'reload schema';
