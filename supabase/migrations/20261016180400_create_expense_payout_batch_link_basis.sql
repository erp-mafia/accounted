-- create_expense_payout_batch records why the bank row is linked (link
-- basis, src/lib/links/link-basis.ts).
-- pg-test: tests/pg/link-basis-sql-writers.pg.test.ts
--
-- With p_transaction_id the caller names the bank outflow that repays the
-- claims, and the function points that row at the payout verifikat
-- (reconciliation_method 'manual'). The pointer records user_confirmed, the
-- basis linkBasisForReconciliationMethod gives 'manual', resolved through
-- public.resolve_link_basis (20261016180100) with the p_actor_type the
-- engine door passes: client_asserted for an API key, MCP connector,
-- service account or the in-app agent, system_derived for cron or system.
-- Without p_transaction_id nothing is linked, as before.
--
-- What does not change: the signature, SECURITY DEFINER, search_path, owner,
-- grants and comment (CREATE OR REPLACE keeps them), every check, refusal,
-- lock, voucher number (commit_journal_entry), line and claim. The body
-- below is the newest definition, 20261016005100_sql_posting_paths_actor,
-- copied byte for byte; the only edit is the two columns added to the
-- transactions update.

CREATE OR REPLACE FUNCTION public.create_expense_payout_batch(p_company_id uuid, p_claim_ids uuid[], p_payout_date date, p_cash_account text, p_notes text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid, p_transaction_id uuid DEFAULT NULL::uuid, p_actor_type text DEFAULT NULL::text, p_actor_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_ids uuid[];
  v_claim record;
  v_count integer := 0;
  v_first boolean := true;
  v_employee_id uuid;
  v_claimant_name text;
  v_claimant_key text;
  v_liability text;
  v_total numeric(15,2) := 0;
  v_period_id uuid;
  v_period_locked_at timestamptz;
  v_series text := 'A';
  v_series_raw text;
  v_batch_id uuid := gen_random_uuid();
  v_je_id uuid := gen_random_uuid();
  v_voucher_number integer;
  v_desc text;
  v_marked integer;
  v_tx record;
  v_tx_updated integer;
  v_debit text;
  v_payslip record;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  -- Same gate as the expense tables' write policies (owner/admin/member);
  -- SECURITY DEFINER bypasses RLS, so the check has to be explicit.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = v_caller
      AND cm.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  SELECT ARRAY(SELECT DISTINCT unnest(p_claim_ids)) INTO v_ids;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_CLAIMS');
  END IF;
  IF p_cash_account IS NULL OR p_cash_account !~ '^19[0-9]{2}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_CASH_ACCOUNT');
  END IF;

  PERFORM public.lock_cash_account_booking_state(p_company_id);

  -- Lock the claims. A concurrent caller for any of the same rows queues on
  -- this lock and, once this transaction commits, reads them as 'paid'.
  FOR v_claim IN
    SELECT ec.id, ec.status, ec.employee_id, ec.claimant_name, ec.liability_account, ec.amount_sek
    FROM public.expense_claims ec
    WHERE ec.id = ANY(v_ids)
      AND ec.company_id = p_company_id
    ORDER BY ec.id
    FOR UPDATE
  LOOP
    v_count := v_count + 1;
    IF v_claim.status <> 'registered' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_PAID',
        'details', jsonb_build_object('claim_id', v_claim.id));
    END IF;
    -- A claim on a payslip line is repaid by that salary run (#2331): a bank
    -- transfer on top would pay the person twice. Remove the line from the
    -- draft payslip first if the bank path is the intended one.
    SELECT sr.id AS salary_run_id, sr.period_year, sr.period_month, sr.status
      INTO v_payslip
    FROM public.salary_line_items sli
    JOIN public.salary_run_employees sre ON sre.id = sli.salary_run_employee_id
    JOIN public.salary_runs sr ON sr.id = sre.salary_run_id
    WHERE sli.source_expense_claim_id = v_claim.id
      AND sli.company_id = p_company_id
    LIMIT 1;
    IF v_payslip.salary_run_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ON_PAYSLIP',
        'details', jsonb_build_object(
          'claim_id', v_claim.id,
          'salary_run_id', v_payslip.salary_run_id,
          'salary_run_status', v_payslip.status,
          'period', v_payslip.period_year::text || '-' || lpad(v_payslip.period_month::text, 2, '0')));
    END IF;
    IF v_first THEN
      v_employee_id := v_claim.employee_id;
      v_claimant_name := v_claim.claimant_name;
      v_claimant_key := COALESCE(v_claim.employee_id::text, 'name:' || lower(btrim(v_claim.claimant_name)));
      v_liability := v_claim.liability_account;
      v_first := false;
    ELSE
      IF COALESCE(v_claim.employee_id::text, 'name:' || lower(btrim(v_claim.claimant_name))) <> v_claimant_key THEN
        RETURN jsonb_build_object('ok', false, 'code', 'MIXED_CLAIMANTS');
      END IF;
      IF v_claim.liability_account <> v_liability THEN
        RETURN jsonb_build_object('ok', false, 'code', 'MIXED_LIABILITY');
      END IF;
    END IF;
    v_total := v_total + v_claim.amount_sek;
  END LOOP;

  IF v_count <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CLAIMS_NOT_FOUND');
  END IF;

  -- Bank-line mode: the transfer that repays these claims. Locked with the
  -- claims so a concurrent categorisation of the same row waits and then
  -- sees it booked. The amount must equal the claims exactly (öre): a partial
  -- transfer is a different payout, chosen by a different set of claims.
  IF p_transaction_id IS NOT NULL THEN
    SELECT t.id, t.amount, t.currency, t.date
      INTO v_tx
    FROM public.transactions t
    WHERE t.id = p_transaction_id
      AND t.company_id = p_company_id
    FOR UPDATE;
    IF v_tx.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_NOT_FOUND');
    END IF;
    IF public.is_transaction_booked(v_tx.id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_ALREADY_BOOKED');
    END IF;
    IF upper(COALESCE(v_tx.currency, 'SEK')) <> 'SEK' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_CURRENCY',
        'details', jsonb_build_object('currency', v_tx.currency));
    END IF;
    IF v_tx.amount >= 0 OR round(-v_tx.amount, 2) <> v_total THEN
      RETURN jsonb_build_object('ok', false, 'code', 'TX_AMOUNT_MISMATCH',
        'details', jsonb_build_object('transaction_amount', v_tx.amount, 'claims_total', v_total));
    END IF;
  END IF;

  -- Open fiscal year covering the payout date (mirrors engine.findFiscalPeriod).
  SELECT fp.id, fp.locked_at
    INTO v_period_id, v_period_locked_at
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND fp.period_start <= p_payout_date
    AND fp.period_end >= p_payout_date
    AND fp.is_closed = false
  ORDER BY fp.period_start DESC
  LIMIT 1;
  IF v_period_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FISCAL_PERIOD_NOT_FOUND');
  END IF;
  IF v_period_locked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PERIOD_LOCKED',
      'details', jsonb_build_object('fiscal_period_id', v_period_id));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts a
    WHERE a.company_id = p_company_id
      AND a.account_number = p_cash_account
      AND COALESCE(a.is_active, true)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACCOUNT_NOT_IN_CHART',
      'details', jsonb_build_object('account', p_cash_account));
  END IF;
  v_debit := CASE WHEN v_liability = '2018' THEN '2013' ELSE v_liability END;
  IF NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts a
    WHERE a.company_id = p_company_id
      AND a.account_number = v_debit
      AND COALESCE(a.is_active, true)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACCOUNT_NOT_IN_CHART',
      'details', jsonb_build_object('account', v_debit));
  END IF;

  -- Voucher series: the per-source-type default from company_settings, 'A'
  -- otherwise (mirrors resolveDefaultSeriesForSource).
  SELECT cs.default_voucher_series_per_source_type ->> 'expense_payout'
    INTO v_series_raw
  FROM public.company_settings cs
  WHERE cs.company_id = p_company_id;
  IF v_series_raw ~ '^[A-Z]$' THEN
    v_series := v_series_raw;
  END IF;

  v_desc := 'Utbetalning utlägg: ' || v_claimant_name || ' (' || v_count || ' st)';

  INSERT INTO public.expense_payout_batches
    (id, company_id, user_id, employee_id, claimant_name, payout_date,
     cash_account, liability_account, total_sek, notes)
  VALUES
    (v_batch_id, p_company_id, v_caller, v_employee_id, v_claimant_name, p_payout_date,
     p_cash_account, v_liability, v_total, p_notes);

  INSERT INTO public.journal_entries
    (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, source_id, status, bank_booking_context)
  VALUES
    (v_je_id, v_caller, p_company_id, v_period_id, 0, v_series,
     p_payout_date, v_desc, 'expense_payout', v_batch_id, 'draft',
     CASE WHEN p_transaction_id IS NULL THEN '[]'::jsonb
       ELSE public.capture_bank_booking_context(p_company_id, ARRAY[p_transaction_id]) END);

  INSERT INTO public.journal_entry_lines
    (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order, line_description)
  VALUES
    (v_je_id, v_debit, v_total, 0, 'SEK', 0, v_desc),
    (v_je_id, p_cash_account, 0, v_total, 'SEK', 1, v_desc);

  -- WHO: the actor the application door passes (commitExpensePayoutBatch).
  SELECT voucher_number INTO v_voucher_number
  FROM public.commit_journal_entry(p_company_id, v_je_id, NULL, NULL, p_actor_type, p_actor_label);

  UPDATE public.expense_payout_batches
  SET journal_entry_id = v_je_id
  WHERE id = v_batch_id AND company_id = p_company_id;

  UPDATE public.expense_claims
  SET status = 'paid', payout_batch_id = v_batch_id
  WHERE id = ANY(v_ids)
    AND company_id = p_company_id
    AND status = 'registered';
  GET DIAGNOSTICS v_marked = ROW_COUNT;
  IF v_marked <> cardinality(v_ids) THEN
    -- Cannot happen while the rows are locked above; if it ever does, the
    -- exception rolls back the batch and the verifikat together.
    RAISE EXCEPTION 'create_expense_payout_batch: marked % of % claims paid', v_marked, cardinality(v_ids);
  END IF;

  IF p_transaction_id IS NOT NULL THEN
    -- Same stamp as the bulk-book RPCs: the 1:1 pointer plus is_business, so
    -- every "unbooked" predicate (inbox, worklist, badges) drops the row.
    UPDATE public.transactions
    SET journal_entry_id = v_je_id,
        is_business = TRUE,
        reconciliation_method = 'manual',
        link_basis = public.resolve_link_basis('user_confirmed', p_actor_type),
        link_evidence = NULL,
        updated_at = now()
    WHERE id = p_transaction_id
      AND company_id = p_company_id
      AND journal_entry_id IS NULL;
    GET DIAGNOSTICS v_tx_updated = ROW_COUNT;
    IF v_tx_updated <> 1 THEN
      RAISE EXCEPTION 'create_expense_payout_batch: transaction % could not be linked', p_transaction_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'batch_id', v_batch_id,
    'journal_entry_id', v_je_id,
    'voucher_number', v_voucher_number,
    'total_sek', v_total,
    'claim_count', cardinality(v_ids),
    'transaction_id', p_transaction_id
  );
END;
$function$
;
