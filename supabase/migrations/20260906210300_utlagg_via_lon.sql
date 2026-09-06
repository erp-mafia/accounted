-- Utlägg repaid with the salary ("Betala ut via lön", issue #2331).
--
-- 1. salary_line_items gains the item type 'expense_reimbursement'
--    (kostnadsersättning: utlägg). Tax-free, outside bruttolön, no
--    arbetsgivaravgifter, not in the AGI gross (FK011). Its default account is
--    the claim's liability account (2820 for an employee): the cost and the
--    moms were booked when the claim was registered, so the salary verifikat
--    only relieves the liability, never a 7xxx cost.
-- 2. salary_line_items.source_expense_claim_id links a payslip line to the
--    claim it repays, so the booking flips exactly those claims. ON DELETE
--    RESTRICT: a claim that a payslip line still references cannot be deleted
--    by anyone (PostgREST, a script, a future service), so a booked run's line
--    can never vanish from under its posted verifikat. The app path
--    (deleteExpenseClaim) removes the line first on a draft run and refuses
--    once the run has left draft. The partial unique index keeps a claim on
--    at most one payslip line at a time.
-- 3. settle_expense_claims_via_salary_run is the payroll-side twin of
--    create_expense_payout_batch: same batch table, same status flip, same
--    row locking, but no verifikat of its own. The batch points at the booked
--    run's salary verifikat, which already carries 2820 D and 1930 K.
-- 4. create_expense_payout_batch refuses a claim that sits on a payslip line
--    (ON_PAYSLIP): its repayment belongs to that salary run, and a bank
--    transfer on top would pay the person twice.
--
-- pg-test: covered-by tests/pg/utlagg-via-lon.pg.test.ts
--          and tests/pg/expense-payout-batch-rpc.pg.test.ts (ON_PAYSLIP)

-- ---------------------------------------------------------------------------
-- 1. Item type. Re-added NOT VALID like 20260813143000; the VALIDATE runs in
--    the next migration so the scan does not hold the stronger DDL lock.
-- ---------------------------------------------------------------------------

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT salary_line_items_item_type_check;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_item_type_check
  CHECK (item_type IN (
    'monthly_salary', 'hourly_salary',
    'overtime', 'overtime_50', 'overtime_100',
    'ob_weekday_evening', 'ob_weekend', 'ob_night', 'ob_holiday',
    'bonus', 'commission',
    'gross_deduction_pension', 'gross_deduction_other',
    'benefit_car', 'benefit_housing', 'benefit_meals',
    'benefit_wellness', 'benefit_bike', 'benefit_other',
    'sick_karens', 'sick_day2_14', 'sick_day15_plus',
    'vab', 'parental_leave', 'unpaid_leave',
    'vacation', 'semesterersattning',
    'traktamente_taxfree', 'traktamente_taxable',
    'mileage_taxfree', 'mileage_taxable',
    'expense_reimbursement',
    'net_deduction_advance', 'net_deduction_union',
    'net_deduction_benefit_payment', 'net_deduction_other',
    'oresavrundning',
    'correction', 'other'
  )) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. Claim link. Tenant-scoped by construction (the dimensions pattern): the
--    composite FK binds the claim to the line's company, so a member of one
--    company can never hang another company's claim on a payslip.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'expense_claims_id_company_id_key'
      AND conrelid = 'public.expense_claims'::regclass
  ) THEN
    ALTER TABLE public.expense_claims
      ADD CONSTRAINT expense_claims_id_company_id_key UNIQUE (id, company_id);
  END IF;
END $$;

ALTER TABLE public.salary_line_items
  ADD COLUMN source_expense_claim_id uuid;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_source_expense_claim_fkey
  FOREIGN KEY (source_expense_claim_id, company_id)
  REFERENCES public.expense_claims(id, company_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX salary_line_items_source_expense_claim_uniq
  ON public.salary_line_items (source_expense_claim_id)
  WHERE source_expense_claim_id IS NOT NULL;

COMMENT ON COLUMN public.salary_line_items.source_expense_claim_id IS
  'The registered expense claim (utlägg) this expense_reimbursement line repays. Set by "Lägg till öppna utlägg"; the salary booking marks the claim paid with a payout batch that points at the salary verifikat.';

-- ---------------------------------------------------------------------------
-- 3. Settle the claims a booked run repays.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.settle_expense_claims_via_salary_run(
  p_company_id uuid,
  p_salary_run_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid;
  v_run record;
  v_line record;
  v_group record;
  v_period text;
  v_batch_id uuid;
  v_batches jsonb := '[]'::jsonb;
  v_settled integer := 0;
  v_already integer := 0;
  v_marked integer;
  v_total numeric(15,2) := 0;
BEGIN
  -- Actor resolution mirrors create_expense_payout_batch: p_user_id is
  -- honored only for service_role callers (API-key / MCP paths run on the
  -- cookieless service client where auth.uid() is NULL).
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = v_caller
      AND cm.role IN ('owner', 'admin', 'member')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  -- The run is locked for the duration so two callers (a retry, the MCP path
  -- and the dashboard at once) serialize on it.
  SELECT sr.id, sr.status, sr.salary_entry_id, sr.payment_date, sr.period_year, sr.period_month
    INTO v_run
  FROM public.salary_runs sr
  WHERE sr.id = p_salary_run_id
    AND sr.company_id = p_company_id
  FOR UPDATE;
  IF v_run.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SALARY_RUN_NOT_FOUND');
  END IF;
  IF v_run.status <> 'booked' OR v_run.salary_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SALARY_RUN_NOT_BOOKED',
      'details', jsonb_build_object('status', v_run.status));
  END IF;
  -- The batch points at the salary verifikat; it must be a posted entry of
  -- this company that the run itself claims as its salary entry.
  IF NOT EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = v_run.salary_entry_id
      AND je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.source_type = 'salary_payment'
      AND je.source_id = p_salary_run_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SALARY_ENTRY_NOT_POSTED');
  END IF;

  v_period := v_run.period_year::text || '-' || lpad(v_run.period_month::text, 2, '0');

  -- Lock the claims behind this run's lines and validate every one before
  -- writing anything. A claim already settled by THIS run (retry after a
  -- partial failure) is fine; one paid any other way is a refusal, since the
  -- salary verifikat already debited 2820 for it.
  FOR v_line IN
    SELECT sli.amount AS line_amount,
           sre.employee_id AS line_employee_id,
           ec.id AS claim_id,
           ec.status,
           ec.employee_id AS claim_employee_id,
           ec.amount_sek,
           ec.payout_batch_id
    FROM public.salary_line_items sli
    JOIN public.salary_run_employees sre ON sre.id = sli.salary_run_employee_id
    JOIN public.expense_claims ec
      ON ec.id = sli.source_expense_claim_id
     AND ec.company_id = sli.company_id
    WHERE sre.salary_run_id = p_salary_run_id
      AND sli.company_id = p_company_id
      AND sli.source_expense_claim_id IS NOT NULL
    ORDER BY ec.id
    FOR UPDATE OF ec
  LOOP
    IF v_line.status = 'paid' THEN
      IF EXISTS (
        SELECT 1 FROM public.expense_payout_batches b
        WHERE b.id = v_line.payout_batch_id
          AND b.company_id = p_company_id
          AND b.journal_entry_id = v_run.salary_entry_id
      ) THEN
        v_already := v_already + 1;
        CONTINUE;
      END IF;
      RETURN jsonb_build_object('ok', false, 'code', 'CLAIM_NOT_OPEN',
        'details', jsonb_build_object('claim_id', v_line.claim_id));
    END IF;
    IF v_line.claim_employee_id IS DISTINCT FROM v_line.line_employee_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CLAIM_EMPLOYEE_MISMATCH',
        'details', jsonb_build_object('claim_id', v_line.claim_id));
    END IF;
    IF round(v_line.line_amount, 2) <> v_line.amount_sek THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CLAIM_AMOUNT_MISMATCH',
        'details', jsonb_build_object(
          'claim_id', v_line.claim_id,
          'line_amount', v_line.line_amount,
          'claim_amount', v_line.amount_sek));
    END IF;
  END LOOP;

  -- One batch per person (the batch table's unit: one claimant, one
  -- liability account), pointing at the salary verifikat. The cash side is
  -- the salary entry's 1930 net-pay credit.
  FOR v_group IN
    SELECT sre.employee_id,
           max(ec.claimant_name) AS claimant_name,
           ec.liability_account,
           sum(ec.amount_sek) AS total_sek,
           array_agg(ec.id ORDER BY ec.id) AS claim_ids,
           count(*)::integer AS claim_count
    FROM public.salary_line_items sli
    JOIN public.salary_run_employees sre ON sre.id = sli.salary_run_employee_id
    JOIN public.expense_claims ec
      ON ec.id = sli.source_expense_claim_id
     AND ec.company_id = sli.company_id
    WHERE sre.salary_run_id = p_salary_run_id
      AND sli.company_id = p_company_id
      AND sli.source_expense_claim_id IS NOT NULL
      AND ec.status = 'registered'
    GROUP BY sre.employee_id, ec.liability_account
    ORDER BY sre.employee_id, ec.liability_account
  LOOP
    v_batch_id := gen_random_uuid();
    INSERT INTO public.expense_payout_batches
      (id, company_id, user_id, employee_id, claimant_name, payout_date,
       cash_account, liability_account, total_sek, journal_entry_id, notes)
    VALUES
      (v_batch_id, p_company_id, v_caller, v_group.employee_id, v_group.claimant_name,
       v_run.payment_date, '1930', v_group.liability_account, v_group.total_sek,
       v_run.salary_entry_id, 'Utbetalt via lön ' || v_period);

    UPDATE public.expense_claims
    SET status = 'paid', payout_batch_id = v_batch_id
    WHERE id = ANY(v_group.claim_ids)
      AND company_id = p_company_id
      AND status = 'registered';
    GET DIAGNOSTICS v_marked = ROW_COUNT;
    IF v_marked <> v_group.claim_count THEN
      -- Cannot happen while the rows are locked above; the exception rolls
      -- every batch of this call back together.
      RAISE EXCEPTION 'settle_expense_claims_via_salary_run: marked % of % claims paid',
        v_marked, v_group.claim_count;
    END IF;

    v_settled := v_settled + v_marked;
    v_total := v_total + v_group.total_sek;
    v_batches := v_batches || jsonb_build_object(
      'batch_id', v_batch_id,
      'employee_id', v_group.employee_id,
      'total_sek', v_group.total_sek,
      'claim_count', v_group.claim_count);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'salary_run_id', p_salary_run_id,
    'journal_entry_id', v_run.salary_entry_id,
    'batches', v_batches,
    'claim_count', v_settled,
    'already_settled', v_already,
    'total_sek', v_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_expense_claims_via_salary_run(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_expense_claims_via_salary_run(uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.settle_expense_claims_via_salary_run(uuid, uuid, uuid) IS
  'Marks the expense claims linked to a booked salary run''s payslip lines as paid: one expense_payout_batches row per person pointing at the salary verifikat, no verifikat of its own. Idempotent for a retry.';

-- ---------------------------------------------------------------------------
-- 4. The bank-side payout refuses a claim scheduled on a payslip.
--    Body identical to 20260905183000 except the ON_PAYSLIP check inside the
--    claim loop; same signature, so CREATE OR REPLACE and no DROP.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_expense_payout_batch(
  p_company_id uuid,
  p_claim_ids uuid[],
  p_payout_date date,
  p_cash_account text,
  p_notes text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_transaction_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
     entry_date, description, source_type, source_id, status)
  VALUES
    (v_je_id, v_caller, p_company_id, v_period_id, 0, v_series,
     p_payout_date, v_desc, 'expense_payout', v_batch_id, 'draft');

  INSERT INTO public.journal_entry_lines
    (journal_entry_id, account_number, debit_amount, credit_amount, currency, sort_order, line_description)
  VALUES
    (v_je_id, v_debit, v_total, 0, 'SEK', 0, v_desc),
    (v_je_id, p_cash_account, 0, v_total, 'SEK', 1, v_desc);

  SELECT voucher_number INTO v_voucher_number
  FROM public.commit_journal_entry(p_company_id, v_je_id);

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
$$;

COMMENT ON FUNCTION public.create_expense_payout_batch(uuid, uuid[], date, text, text, uuid, uuid) IS
  'Books one reimbursement transfer for N registered expense claims atomically: locks the claims (and the bank transaction when given), posts liability -> cash via commit_journal_entry, marks the claims paid and links the transaction. Refuses claims scheduled on a payslip line (ON_PAYSLIP).';

NOTIFY pgrst, 'reload schema';
