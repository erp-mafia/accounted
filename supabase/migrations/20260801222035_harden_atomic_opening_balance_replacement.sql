-- Harden atomic opening balance replacement authorization and commit metadata.
--
-- This full definition supersedes 20260801221047 without mutating that applied
-- staging migration. Archived companies must remain read-only, and the inner
-- voucher commits retain the engine's existing NULL commit method.
--
-- The replacement entry, storno, original-entry status change, and fiscal
-- period pointer swap must either all commit or all roll back. The period row
-- lock closes the lock-date race, while the expected old entry id provides a
-- compare-and-swap guard against concurrent corrections.

CREATE OR REPLACE FUNCTION public.commit_opening_balance_replacement(
  p_company_id uuid,
  p_period_id uuid,
  p_expected_old_entry_id uuid,
  p_user_id uuid,
  p_entry_date date,
  p_description text,
  p_voucher_series text,
  p_lines jsonb,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(
  new_entry_id uuid,
  storno_entry_id uuid,
  new_voucher_number integer,
  storno_voucher_number integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_claims jsonb := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_jwt_role text := COALESCE(
    NULLIF(v_claims ->> 'role', ''),
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    ''
  );
  v_member_role text;
  v_period public.fiscal_periods%ROWTYPE;
  v_old_entry public.journal_entries%ROWTYPE;
  v_lock_date date;
  v_new_entry_id uuid := uuid_generate_v4();
  v_storno_entry_id uuid := uuid_generate_v4();
  v_new_voucher_number integer;
  v_storno_voucher_number integer;
  v_line_count integer;
  v_updated_count integer;
  v_total_debit numeric;
  v_total_credit numeric;
BEGIN
  IF v_jwt_role = 'authenticated' THEN
    IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'unauthorized: user attribution does not match caller'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_jwt_role <> 'service_role' THEN
    RAISE EXCEPTION 'unauthorized: authenticated or service role required'
      USING ERRCODE = '42501';
  END IF;

  SELECT cm.role
    INTO v_member_role
    FROM public.company_members cm
    JOIN public.companies company
      ON company.id = cm.company_id
     AND company.archived_at IS NULL
   WHERE cm.company_id = p_company_id
     AND cm.user_id = p_user_id;

  IF v_member_role IS NULL
     OR v_member_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'unauthorized: caller cannot write to company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT fp.*
    INTO v_period
    FROM public.fiscal_periods fp
   WHERE fp.id = p_period_id
     AND fp.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found: %', p_period_id;
  END IF;

  IF v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot replace opening balance in locked/closed fiscal period "%"',
      v_period.name;
  END IF;

  IF v_period.opening_balances_set IS NOT TRUE
     OR v_period.opening_balance_entry_id IS DISTINCT FROM p_expected_old_entry_id THEN
    RAISE EXCEPTION 'Opening balance changed concurrently for fiscal period %', p_period_id
      USING ERRCODE = '40001';
  END IF;

  IF p_entry_date IS DISTINCT FROM v_period.period_start THEN
    RAISE EXCEPTION 'Replacement opening balance date must equal fiscal period start %',
      v_period.period_start;
  END IF;

  SELECT cs.bookkeeping_locked_through
    INTO v_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_lock_date IS NOT NULL AND p_entry_date <= v_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_lock_date;
  END IF;

  SELECT je.*
    INTO v_old_entry
    FROM public.journal_entries je
   WHERE je.id = p_expected_old_entry_id
     AND je.company_id = p_company_id
     AND je.fiscal_period_id = p_period_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_old_entry.status <> 'posted'
     OR v_old_entry.source_type <> 'opening_balance' THEN
    RAISE EXCEPTION 'Expected opening balance is not a posted entry in period %', p_period_id;
  END IF;

  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Replacement opening balance requires at least one line';
  END IF;

  SELECT
    round(COALESCE(sum(line.debit_amount), 0), 2),
    round(COALESCE(sum(line.credit_amount), 0), 2)
  INTO v_total_debit, v_total_credit
  FROM jsonb_to_recordset(p_lines) AS line(
    account_number text,
    account_id uuid,
    debit_amount numeric,
    credit_amount numeric,
    currency text,
    amount_in_currency numeric,
    exchange_rate numeric,
    line_description text,
    tax_code text,
    dimensions jsonb,
    sort_order integer
  );

  IF v_total_debit <= 0 OR v_total_debit IS DISTINCT FROM v_total_credit THEN
    RAISE EXCEPTION 'Replacement opening balance is not balanced (debit %, credit %)',
      v_total_debit, v_total_credit;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_lines) AS line(
        account_number text,
        account_id uuid,
        debit_amount numeric,
        credit_amount numeric,
        currency text,
        amount_in_currency numeric,
        exchange_rate numeric,
        line_description text,
        tax_code text,
        dimensions jsonb,
        sort_order integer
      )
      LEFT JOIN public.chart_of_accounts account
        ON account.id = line.account_id
       AND account.company_id = p_company_id
       AND account.account_number = line.account_number
       AND account.is_active = true
     WHERE account.id IS NULL
        OR line.account_number IS NULL
        OR line.debit_amount IS NULL
        OR line.credit_amount IS NULL
        OR line.debit_amount < 0
        OR line.credit_amount < 0
        OR (line.debit_amount > 0 AND line.credit_amount > 0)
        OR (line.debit_amount = 0 AND line.credit_amount = 0)
  ) THEN
    RAISE EXCEPTION 'Replacement opening balance contains an invalid line';
  END IF;

  INSERT INTO public.journal_entries (
    id,
    user_id,
    company_id,
    fiscal_period_id,
    voucher_number,
    voucher_series,
    entry_date,
    description,
    source_type,
    status
  ) VALUES (
    v_new_entry_id,
    p_user_id,
    p_company_id,
    p_period_id,
    0,
    COALESCE(NULLIF(p_voucher_series, ''), 'A'),
    p_entry_date,
    p_description,
    'opening_balance',
    'draft'
  );

  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    account_number,
    account_id,
    debit_amount,
    credit_amount,
    currency,
    amount_in_currency,
    exchange_rate,
    line_description,
    tax_code,
    dimensions,
    sort_order
  )
  SELECT
    v_new_entry_id,
    line.account_number,
    line.account_id,
    round(line.debit_amount, 2),
    round(line.credit_amount, 2),
    COALESCE(NULLIF(line.currency, ''), 'SEK'),
    CASE
      WHEN line.amount_in_currency IS NULL THEN NULL
      ELSE round(line.amount_in_currency, 2)
    END,
    line.exchange_rate,
    line.line_description,
    line.tax_code,
    COALESCE(line.dimensions, '{}'::jsonb),
    COALESCE(line.sort_order, 0)
  FROM jsonb_to_recordset(p_lines) AS line(
    account_number text,
    account_id uuid,
    debit_amount numeric,
    credit_amount numeric,
    currency text,
    amount_in_currency numeric,
    exchange_rate numeric,
    line_description text,
    tax_code text,
    dimensions jsonb,
    sort_order integer
  );

  GET DIAGNOSTICS v_line_count = ROW_COUNT;
  IF v_line_count <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'Replacement opening balance line count changed during insert';
  END IF;

  INSERT INTO public.journal_entries (
    id,
    user_id,
    company_id,
    fiscal_period_id,
    voucher_number,
    voucher_series,
    entry_date,
    description,
    source_type,
    source_id,
    reverses_id,
    status
  ) VALUES (
    v_storno_entry_id,
    p_user_id,
    p_company_id,
    p_period_id,
    0,
    COALESCE(v_old_entry.voucher_series, 'A'),
    p_entry_date,
    'Makulering: ' || v_old_entry.description,
    'storno',
    v_old_entry.source_id,
    v_old_entry.id,
    'draft'
  );

  INSERT INTO public.journal_entry_lines (
    journal_entry_id,
    account_number,
    account_id,
    debit_amount,
    credit_amount,
    currency,
    amount_in_currency,
    exchange_rate,
    line_description,
    tax_code,
    dimensions,
    sort_order
  )
  SELECT
    v_storno_entry_id,
    line.account_number,
    line.account_id,
    line.credit_amount,
    line.debit_amount,
    line.currency,
    CASE
      WHEN line.amount_in_currency IS NULL OR line.amount_in_currency = 0 THEN NULL
      ELSE -line.amount_in_currency
    END,
    line.exchange_rate,
    'Reversal: ' || COALESCE(line.line_description, ''),
    line.tax_code,
    line.dimensions,
    line.sort_order
  FROM public.journal_entry_lines line
  WHERE line.journal_entry_id = v_old_entry.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected opening balance has no lines: %', v_old_entry.id;
  END IF;

  SELECT committed.voucher_number
    INTO v_new_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      v_new_entry_id,
      NULL,
      NULL,
      p_actor_type,
      p_actor_label
    ) committed;

  SELECT committed.voucher_number
    INTO v_storno_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      v_storno_entry_id,
      NULL,
      NULL,
      p_actor_type,
      p_actor_label
    ) committed;

  UPDATE public.journal_entries
     SET status = 'reversed',
         reversed_by_id = v_storno_entry_id
   WHERE id = v_old_entry.id
     AND company_id = p_company_id
     AND status = 'posted';

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Opening balance changed concurrently: %', v_old_entry.id
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.fiscal_periods
     SET opening_balances_set = false
   WHERE id = p_period_id
     AND company_id = p_company_id
     AND opening_balance_entry_id = p_expected_old_entry_id
     AND opening_balances_set = true;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Opening balance pointer changed concurrently for fiscal period %', p_period_id
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.fiscal_periods
     SET opening_balance_entry_id = v_new_entry_id,
         opening_balances_set = true
   WHERE id = p_period_id
     AND company_id = p_company_id
     AND opening_balance_entry_id = p_expected_old_entry_id
     AND opening_balances_set = false;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION 'Opening balance pointer could not be replaced for fiscal period %', p_period_id
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT
    v_new_entry_id,
    v_storno_entry_id,
    v_new_voucher_number,
    v_storno_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_opening_balance_replacement(
  uuid, uuid, uuid, uuid, date, text, text, jsonb, text, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.commit_opening_balance_replacement(
  uuid, uuid, uuid, uuid, date, text, text, jsonb, text, text
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
