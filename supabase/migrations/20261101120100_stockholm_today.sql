-- Today in SQL is the Swedish calendar day: public.stockholm_today().
--
-- The database runs in UTC, so CURRENT_DATE is still yesterday between midnight
-- and 01:00/02:00 in Sweden. Application code has one definition of today
-- (todayIsoStockholm, lib/dates/iso.ts); SQL had no name for it. Some functions
-- spell the Stockholm date out by hand, the ones below read the session's date.
-- What that did, in the first hours of a Swedish day:
--
--   apply_migrated_invoice_deduction refused a payment dated the Swedish today
--   as a future date (PAYMENT_DATE_MISSING).
--   generate_delivery_note_number numbered a note of the new year with the old
--   year, on New Year's night.
--   revert_migrated_invoice_deduction, revert_rot_rut_reclaim_invoice and
--   record_invoice_write_off wrote a status with a day-old idea of "past due",
--   against isPastDue in lib/dates/iso.ts.
--   update_overdue_supplier_invoices runs at 06:00 UTC, where the two dates
--   agree: it moves to the one definition so the nightly flip and isPastDue
--   cannot drift, with no change in what it does.
--
-- Each function below is its live definition with CURRENT_DATE swapped for
-- public.stockholm_today() and nothing else: same signature, same SET clauses.
-- CREATE OR REPLACE keeps the grants and comments.
--
-- Not moved, on purpose:
--   save_bank_account_selection: its current_date mirrors the provider cursor,
--   which the Enable Banking handler checks against UTC midnight.
--   delete_last_voucher: pending work restates the same body; the one
--   word follows once that has landed.
--   block_document_deletion and enforce_retention_journal_entries (the
--   enforcement triggers), enforce_invoice_delivery_immutability,
--   redact_expired_invoice_delivery_pii and package_open_obligations: on the
--   UTC date a retention expiry or an employment end counts a little later,
--   which only ever holds on longer. tests/pg/stockholm-today.pg.test.ts names
--   them, so a new CURRENT_DATE has to say why.
--
-- pg-test: tests/pg/stockholm-today.pg.test.ts

CREATE OR REPLACE FUNCTION public.stockholm_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT (now() AT TIME ZONE 'Europe/Stockholm')::date
$function$;

REVOKE EXECUTE ON FUNCTION public.stockholm_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stockholm_today() TO authenticated, service_role;

COMMENT ON FUNCTION public.stockholm_today() IS
  'Today on the Swedish calendar, the SQL twin of todayIsoStockholm in lib/dates/iso.ts. Business dates compare against this, not CURRENT_DATE: the database runs in UTC, so CURRENT_DATE lags by one between midnight and 01:00/02:00 in Sweden.';

CREATE OR REPLACE FUNCTION public.update_overdue_supplier_invoices()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Flip. 0.005 mirrors the "fully paid" threshold used by the payment/match
  -- paths, and credit notes (kreditfakturor) are not payables.
  UPDATE supplier_invoices si
  SET status = 'overdue',
      updated_at = NOW()
  WHERE si.due_date < public.stockholm_today()
    AND si.status IN ('registered', 'approved')
    AND si.remaining_amount > 0.005
    AND COALESCE(si.is_credit_note, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM company_migration_resets r
      WHERE r.source_company_id = si.company_id
    );

  -- Un-flip: the exact inverse of the predicate above.
  UPDATE supplier_invoices si
  SET status = CASE WHEN si.approved_at IS NOT NULL THEN 'approved' ELSE 'registered' END,
      updated_at = NOW()
  WHERE si.status = 'overdue'
    AND si.due_date >= public.stockholm_today()
    AND si.remaining_amount > 0.005
    AND COALESCE(si.is_credit_note, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM company_migration_resets r
      WHERE r.source_company_id = si.company_id
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_migrated_invoice_deduction(p_company_id uuid, p_invoice_id uuid, p_expected jsonb, p_deduction jsonb DEFAULT NULL::jsonb, p_journal_entry_id uuid DEFAULT NULL::uuid, p_dry_run boolean DEFAULT false, p_trail jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_caller        uuid := auth.uid();
  v_invoice       public.invoices%ROWTYPE;
  v_paid          numeric;
  v_type          text;
  v_total_ded     numeric;
  v_item          jsonb;
  v_row           public.invoice_items%ROWTYPE;
  v_item_count    integer;
  v_payment_count integer;
  v_sum_items     numeric := 0;
  v_ids           uuid[] := ARRAY[]::uuid[];
  v_remaining     numeric;
  v_status        text;
  v_paid_on       date;
  v_paid_at       timestamptz;
  v_entry         public.journal_entries%ROWTYPE;
  v_debit_1513    numeric;
  v_credit_1510   numeric;
  v_other_lines   integer;
  v_actor         jsonb;
  v_provider      text;
  v_consent       uuid;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND (
    v_caller IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_id = p_company_id AND user_id = v_caller
        AND role IN ('owner', 'admin', 'member')
    )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVOICE_NOT_FOUND');
  END IF;

  v_paid := COALESCE(v_invoice.paid_amount, 0);

  -- Idempotency: a deduction already written by this voucher is done.
  IF p_deduction IS NOT NULL AND COALESCE(v_invoice.deduction_total, 0) > 0 THEN
    IF p_journal_entry_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.journal_entries
      WHERE id = p_journal_entry_id AND company_id = p_company_id
        AND source_type = 'rot_rut_reclassification'
        AND source_id = p_invoice_id AND status = 'posted'
    ) THEN
      RETURN jsonb_build_object('ok', true, 'applied', false,
        'status', v_invoice.status, 'remaining_amount', v_invoice.remaining_amount);
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_HAS_DEDUCTION');
  END IF;
  IF p_deduction IS NULL AND v_invoice.status = 'partially_paid' THEN
    RETURN jsonb_build_object('ok', true, 'applied', false,
      'status', v_invoice.status, 'remaining_amount', v_invoice.remaining_amount);
  END IF;

  IF v_invoice.document_type IS DISTINCT FROM 'invoice'
     OR v_invoice.credited_invoice_id IS NOT NULL
     OR COALESCE(v_invoice.total, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AN_OPEN_INVOICE');
  END IF;

  -- Drift: the plan holds only for the state the preview saw.
  SELECT count(*) INTO v_item_count FROM public.invoice_items WHERE invoice_id = p_invoice_id;
  SELECT count(*) INTO v_payment_count FROM public.invoice_payments WHERE invoice_id = p_invoice_id;
  IF p_expected IS NULL
     OR v_invoice.status IS DISTINCT FROM p_expected->>'status'
     OR v_invoice.total IS DISTINCT FROM (p_expected->>'total')::numeric
     OR v_paid IS DISTINCT FROM (p_expected->>'paid_amount')::numeric
     OR v_payment_count IS DISTINCT FROM (p_expected->>'payment_count')::integer
     OR v_item_count IS DISTINCT FROM (p_expected->>'item_count')::integer THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIFT');
  END IF;

  -- Status-only mode: a part-paid import the provider left at sent.
  IF p_deduction IS NULL THEN
    IF v_invoice.status NOT IN ('sent', 'overdue')
       OR NOT (v_paid > 0 AND v_paid < v_invoice.total) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'STATUS_NOT_REPAIRABLE');
    END IF;
    v_remaining := public.rot_rut_customer_outstanding(
      v_invoice.total, v_paid, v_invoice.deduction_total, v_invoice.deduction_reclaimed_total);
    IF p_dry_run THEN
      RETURN jsonb_build_object('ok', true, 'applied', false, 'dry_run', true,
        'status', 'partially_paid', 'remaining_amount', v_remaining);
    END IF;
    UPDATE public.invoices
    SET status = 'partially_paid', remaining_amount = v_remaining
    WHERE id = p_invoice_id AND company_id = p_company_id;
    v_status := 'partially_paid';
  ELSE
    IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NOT_AN_OPEN_INVOICE');
    END IF;
    IF upper(COALESCE(v_invoice.currency, 'SEK')) <> 'SEK' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CURRENCY');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.rot_rut_payout_request_items i
      JOIN public.rot_rut_payout_requests r ON r.id = i.request_id
      WHERE i.invoice_id = p_invoice_id AND r.company_id = p_company_id
        AND r.status NOT IN ('cancelled', 'rejected')
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'HELD_BY_REQUEST');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.invoice_items
      WHERE invoice_id = p_invoice_id AND deduction_type IS NOT NULL
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_HAS_DEDUCTION');
    END IF;

    v_type := p_deduction->>'deduction_type';
    v_total_ded := (p_deduction->>'deduction_total')::numeric;
    IF v_type NOT IN ('rot', 'rut', 'gron_teknik')
       OR v_total_ded IS NULL OR v_total_ded <= 0
       OR v_total_ded <> trunc(v_total_ded)
       OR jsonb_typeof(p_deduction->'items') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_deduction->'items') = 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'DEDUCTION_INVALID');
    END IF;
    IF COALESCE(p_deduction->>'personnummer_encrypted', '') = ''
       OR COALESCE(p_deduction->>'personnummer_last4', '') !~ '^[0-9]{4}$' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PERSONNUMMER_MISSING');
    END IF;

    -- Every work row must be this invoice's own, unchanged since the preview,
    -- and claim no more than its own price including moms.
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_deduction->'items') LOOP
      SELECT * INTO v_row FROM public.invoice_items
      WHERE id = (v_item->>'id')::uuid AND invoice_id = p_invoice_id;
      IF NOT FOUND
         OR (v_item->>'id')::uuid = ANY (v_ids)
         OR COALESCE(v_row.line_type, 'product') = 'text'
         OR v_row.line_total IS DISTINCT FROM (v_item->>'line_total')::numeric
         OR v_row.vat_amount IS DISTINCT FROM (v_item->>'vat_amount')::numeric THEN
        RETURN jsonb_build_object('ok', false, 'code', 'ITEMS_MISMATCH');
      END IF;
      IF (v_item->>'deduction_amount')::numeric IS NULL
         OR (v_item->>'deduction_amount')::numeric < 0
         OR (v_item->>'deduction_amount')::numeric > v_row.line_total + v_row.vat_amount
         OR COALESCE(v_item->>'work_type', '') = '' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'DEDUCTION_INVALID');
      END IF;
      v_ids := v_ids || (v_item->>'id')::uuid;
      v_sum_items := v_sum_items + (v_item->>'deduction_amount')::numeric;
    END LOOP;
    IF v_sum_items <> v_total_ded THEN
      RETURN jsonb_build_object('ok', false, 'code', 'DEDUCTION_INVALID');
    END IF;
    IF v_total_ded > v_invoice.total - v_paid THEN
      RETURN jsonb_build_object('ok', false, 'code', 'DEDUCTION_EXCEEDS_REMAINING');
    END IF;

    v_remaining := public.rot_rut_customer_outstanding(
      v_invoice.total, v_paid, v_total_ded, v_invoice.deduction_reclaimed_total);
    IF v_remaining > 0 THEN
      v_status := CASE WHEN v_paid > 0 THEN 'partially_paid' ELSE v_invoice.status END;
      v_paid_at := NULL;
    ELSE
      -- The buyer has paid their whole share: the invoice is paid, on the day
      -- that payment arrived, which the begäran reports to Skatteverket.
      v_paid_on := NULLIF(p_deduction->>'paid_on', '')::date;
      IF v_paid_on IS NULL OR v_paid_on > public.stockholm_today() THEN
        RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_DATE_MISSING');
      END IF;
      v_status := 'paid';
      v_paid_at := (v_paid_on::text || 'T12:00:00Z')::timestamptz;
    END IF;

    IF p_dry_run THEN
      RETURN jsonb_build_object('ok', true, 'applied', false, 'dry_run', true,
        'status', v_status, 'remaining_amount', v_remaining);
    END IF;

    -- The voucher must have moved exactly the deduction from 1510 to 1513.
    SELECT * INTO v_entry FROM public.journal_entries
    WHERE id = p_journal_entry_id AND company_id = p_company_id;
    IF NOT FOUND OR v_entry.status <> 'posted'
       OR v_entry.source_type <> 'rot_rut_reclassification'
       OR v_entry.source_id IS DISTINCT FROM p_invoice_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'VOUCHER_INVALID');
    END IF;
    SELECT
      COALESCE(sum(debit_amount) FILTER (WHERE account_number = '1513'), 0),
      COALESCE(sum(credit_amount) FILTER (WHERE account_number = '1510'), 0),
      count(*) FILTER (WHERE NOT (
        (account_number = '1513' AND COALESCE(credit_amount, 0) = 0)
        OR (account_number = '1510' AND COALESCE(debit_amount, 0) = 0)
      ))
    INTO v_debit_1513, v_credit_1510, v_other_lines
    FROM public.journal_entry_lines
    WHERE journal_entry_id = p_journal_entry_id;
    IF v_debit_1513 <> v_total_ded OR v_credit_1510 <> v_total_ded OR v_other_lines > 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'VOUCHER_INVALID');
    END IF;

    UPDATE public.invoice_items AS ii
    SET deduction_type = v_type,
        deduction_amount = (x->>'deduction_amount')::numeric,
        labor_hours = NULLIF(x->>'labor_hours', '')::numeric,
        work_type = x->>'work_type',
        housing_designation = NULLIF(x->>'housing_designation', ''),
        apartment_number = NULLIF(x->>'apartment_number', ''),
        brf_org_number = NULLIF(x->>'brf_org_number', '')
    FROM jsonb_array_elements(p_deduction->'items') AS x
    WHERE ii.id = (x->>'id')::uuid AND ii.invoice_id = p_invoice_id;

    UPDATE public.invoices
    SET deduction_total = v_total_ded,
        deduction_personnummer_encrypted = p_deduction->>'personnummer_encrypted',
        deduction_personnummer_last4 = p_deduction->>'personnummer_last4',
        remaining_amount = v_remaining,
        status = v_status,
        paid_at = COALESCE(v_paid_at, paid_at)
    WHERE id = p_invoice_id AND company_id = p_company_id;
  END IF;

  -- Session callers cannot name another actor.
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    v_actor := jsonb_build_object('type', 'user', 'id', v_caller);
  ELSE
    v_actor := jsonb_build_object('type', 'system', 'id', 'migrated-deduction');
  END IF;
  v_provider := p_trail->>'provider';
  IF v_provider IS NOT NULL AND v_provider NOT IN ('fortnox', 'visma', 'briox', 'bokio', 'bjornlunden', 'wint') THEN
    v_provider := NULL;
  END IF;
  SELECT id INTO v_consent FROM public.provider_consents
  WHERE id = NULLIF(p_trail->>'consent_id', '')::uuid AND company_id = p_company_id;

  INSERT INTO public.processing_history (
    company_id, correlation_id, aggregate_type, aggregate_id, event_type,
    payload, payload_schema_version, actor, occurred_at
  ) VALUES (
    p_company_id,
    COALESCE(NULLIF(p_trail->>'correlation_id', '')::uuid, gen_random_uuid()),
    'Invoice', p_invoice_id, 'InvoiceDeductionMigrated',
    jsonb_strip_nulls(jsonb_build_object(
      'action', CASE WHEN p_deduction IS NULL THEN 'status_repaired' ELSE 'applied' END,
      'provider', v_provider,
      'consent_id', v_consent,
      'journal_entry_id', CASE WHEN p_deduction IS NULL THEN NULL ELSE p_journal_entry_id END,
      'deduction_type', v_type,
      'deduction_total', v_total_ded,
      'status_before', v_invoice.status,
      'status_after', v_status,
      'remaining_before', v_invoice.remaining_amount,
      'remaining_after', v_remaining,
      'work_rows', CASE WHEN p_deduction IS NULL THEN NULL ELSE jsonb_array_length(p_deduction->'items') END
    )),
    1, v_actor, clock_timestamp()
  );

  RETURN jsonb_build_object('ok', true, 'applied', true,
    'status', v_status, 'remaining_amount', v_remaining);
END;
$function$;

CREATE OR REPLACE FUNCTION public.revert_migrated_invoice_deduction(p_company_id uuid, p_invoice_id uuid, p_journal_entry_id uuid, p_check_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
 SET lock_timeout TO '2s'
AS $function$
DECLARE
  v_caller    uuid := auth.uid();
  v_invoice   public.invoices%ROWTYPE;
  v_entry     public.journal_entries%ROWTYPE;
  v_entry_status text;
  v_moved     numeric;
  v_paid      numeric;
  v_remaining numeric;
  v_status    text;
  v_actor     jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND (
    v_caller IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.company_members
      WHERE company_id = p_company_id AND user_id = v_caller
        AND role IN ('owner', 'admin', 'member')
    )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  END IF;

  -- Before the storno the voucher is still posted; after it, reversed.
  v_entry_status := CASE WHEN p_check_only THEN 'posted' ELSE 'reversed' END;
  SELECT * INTO v_entry FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;
  IF NOT FOUND OR v_entry.source_type <> 'rot_rut_reclassification'
     OR v_entry.source_id IS DISTINCT FROM p_invoice_id
     OR v_entry.status <> v_entry_status THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VOUCHER_INVALID');
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVOICE_NOT_FOUND');
  END IF;
  IF COALESCE(v_invoice.deduction_total, 0) = 0 THEN
    -- Never applied, or already reverted.
    RETURN jsonb_build_object('ok', true, 'reverted', false);
  END IF;

  IF COALESCE(v_invoice.deduction_reclaimed_total, 0) > 0 OR EXISTS (
    SELECT 1 FROM public.rot_rut_payout_request_items i
    JOIN public.rot_rut_payout_requests r ON r.id = i.request_id
    WHERE i.invoice_id = p_invoice_id AND r.company_id = p_company_id
      AND r.status NOT IN ('cancelled', 'rejected')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'HELD_BY_REQUEST');
  END IF;

  SELECT COALESCE(sum(debit_amount) FILTER (WHERE account_number = '1513'), 0)
  INTO v_moved
  FROM public.journal_entry_lines
  WHERE journal_entry_id = p_journal_entry_id;
  IF v_moved <> v_invoice.deduction_total THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VOUCHER_INVALID');
  END IF;

  IF p_check_only THEN
    RETURN jsonb_build_object('ok', true, 'reverted', false, 'check_only', true);
  END IF;

  v_paid := COALESCE(v_invoice.paid_amount, 0);
  v_remaining := GREATEST(0, ROUND((v_invoice.total - v_paid)::numeric, 2));
  IF v_remaining <= 0 AND v_paid > 0 THEN
    v_status := 'paid';
  ELSIF v_paid > 0 THEN
    v_status := 'partially_paid';
  ELSIF v_invoice.due_date < public.stockholm_today() THEN
    v_status := 'overdue';
  ELSE
    v_status := 'sent';
  END IF;

  UPDATE public.invoice_items
  SET deduction_type = NULL, deduction_amount = 0, labor_hours = NULL, work_type = NULL,
      housing_designation = NULL, apartment_number = NULL, brf_org_number = NULL
  WHERE invoice_id = p_invoice_id AND deduction_type IS NOT NULL;

  UPDATE public.invoices
  SET deduction_total = 0,
      deduction_personnummer_encrypted = NULL,
      deduction_personnummer_last4 = NULL,
      remaining_amount = v_remaining,
      status = v_status,
      paid_at = CASE WHEN v_status = 'paid' THEN paid_at ELSE NULL END
  WHERE id = p_invoice_id AND company_id = p_company_id;

  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    v_actor := jsonb_build_object('type', 'user', 'id', v_caller);
  ELSE
    v_actor := jsonb_build_object('type', 'system', 'id', 'migrated-deduction');
  END IF;
  INSERT INTO public.processing_history (
    company_id, correlation_id, aggregate_type, aggregate_id, event_type,
    payload, payload_schema_version, actor, occurred_at
  ) VALUES (
    p_company_id, gen_random_uuid(), 'Invoice', p_invoice_id, 'InvoiceDeductionMigrated',
    jsonb_build_object(
      'action', 'reverted',
      'journal_entry_id', p_journal_entry_id,
      'deduction_total', v_invoice.deduction_total,
      'status_before', v_invoice.status,
      'status_after', v_status,
      'remaining_before', v_invoice.remaining_amount,
      'remaining_after', v_remaining
    ),
    1, v_actor, clock_timestamp()
  );

  RETURN jsonb_build_object('ok', true, 'reverted', true,
    'status', v_status, 'remaining_amount', v_remaining);
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_invoice_write_off(p_id uuid, p_company_id uuid, p_invoice_id uuid, p_kind text, p_entry_date date, p_amount numeric, p_net_amount numeric, p_vat_amount numeric, p_vat_by_rate jsonb, p_reserve_released numeric, p_journal_entry_id uuid, p_evidence_document_id uuid, p_reason text, p_case_id uuid, p_reverses_id uuid, p_decided_by uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_decided_by uuid;
  v_invoice record;
  v_entry record;
  v_reversed record;
  v_status text;
  v_amount numeric := p_amount;
  v_net numeric := p_net_amount;
  v_vat numeric := COALESCE(p_vat_amount, 0);
  v_shares jsonb := COALESCE(p_vat_by_rate, '[]'::jsonb);
  v_released numeric := COALESCE(p_reserve_released, 0);
  v_reserve_cr numeric;
  v_receivable_cr numeric;
BEGIN
  IF v_actor IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.company_members m
      WHERE m.company_id = p_company_id AND m.user_id = v_actor AND m.role <> 'viewer'
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_FORBIDDEN: not a writer in this company'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_decided_by := v_actor;
  ELSE
    v_decided_by := p_decided_by;
  END IF;

  SELECT i.id, i.status, i.currency, i.paid_amount, i.due_date, i.journal_entry_id
    INTO v_invoice
    FROM public.invoices i
    WHERE i.id = p_invoice_id AND i.company_id = p_company_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_INVOICE_NOT_FOUND: invoice % not found in company %', p_invoice_id, p_company_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF COALESCE(v_invoice.currency, 'SEK') <> 'SEK' THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_CURRENCY_UNSUPPORTED: only SEK invoices'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_journal_entry_id IS NOT NULL THEN
    SELECT je.id, je.status, je.source_type, je.source_id, je.reverses_id, je.entry_date
      INTO v_entry
      FROM public.journal_entries je
      WHERE je.id = p_journal_entry_id AND je.company_id = p_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: voucher % not found in company %', p_journal_entry_id, p_company_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_entry.entry_date <> p_entry_date THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: the row date must be the voucher date'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_evidence_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_attachments d
    WHERE d.id = p_evidence_document_id AND d.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_EVIDENCE_NOT_FOUND: document % not found in company %', p_evidence_document_id, p_company_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_case_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.collection_cases c
    WHERE c.id = p_case_id AND c.company_id = p_company_id AND c.invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_CASE_MISMATCH: case % is not this invoice''s', p_case_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_kind = 'annulled' THEN
    SELECT w.* INTO v_reversed
      FROM public.invoice_write_offs w
      WHERE w.id = p_reverses_id AND w.invoice_id = p_invoice_id AND w.company_id = p_company_id;
    IF NOT FOUND OR v_reversed.kind = 'annulled' OR v_reversed.journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_ANNUL_INVALID: nothing to annul'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.invoice_write_offs a WHERE a.reverses_id = v_reversed.id) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_ANNUL_INVALID: the decision is already annulled'
        USING ERRCODE = 'check_violation';
    END IF;
    IF p_journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: an annulment names the storno of the decision''s voucher'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_entry.source_type <> 'storno' OR v_entry.reverses_id IS DISTINCT FROM v_reversed.journal_entry_id THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: an annulment names the storno of the decision''s voucher'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The annulment undoes exactly what the decision recorded.
    v_amount := v_reversed.amount;
    v_net := v_reversed.net_amount;
    v_vat := v_reversed.vat_amount;
    v_shares := v_reversed.vat_by_rate;
    v_released := v_reversed.reserve_released;
  ELSIF p_journal_entry_id IS NOT NULL THEN
    IF v_entry.source_type <> 'customer_loss' OR v_entry.source_id IS DISTINCT FROM p_id
       OR v_entry.status <> 'posted' THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: the voucher is not this decision''s posted customer_loss voucher'
        USING ERRCODE = 'check_violation';
    END IF;

    -- The reserve and receivable lines carry the row's amounts.
    SELECT
      COALESCE(sum(l.credit_amount - l.debit_amount) FILTER (WHERE l.account_number = '1519'), 0),
      COALESCE(sum(l.credit_amount - l.debit_amount) FILTER (
        WHERE l.account_number ~ '^151[0-9]$' AND l.account_number NOT IN ('1513', '1519')), 0)
      INTO v_reserve_cr, v_receivable_cr
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = p_journal_entry_id;
    IF (p_kind = 'doubtful' AND (v_reserve_cr <> v_net OR v_receivable_cr <> 0))
       OR (p_kind = 'reversed_doubtful' AND (-v_reserve_cr <> v_net OR v_receivable_cr <> 0))
       OR (p_kind = 'confirmed' AND (v_receivable_cr <> v_amount OR -v_reserve_cr <> v_released))
       OR (p_kind = 'recovered' AND (v_receivable_cr <> 0 OR v_reserve_cr <> 0)) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: the voucher''s 1519 and 151x lines do not carry the decision''s amounts'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The output VAT a konstaterad or recovery row records is what the
  -- momsdeklaration reads: well-formed shares that sum to vat_amount, each
  -- base matching its VAT at its rate, and account by account what the
  -- voucher moved on 26xx (debit for konstaterad, credit for a recovery).
  IF jsonb_typeof(v_shares) <> 'array' THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_VAT_MISMATCH: vat_by_rate is not a list'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind IN ('confirmed', 'recovered') THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_shares) s
      WHERE jsonb_typeof(s) <> 'object'
         OR NOT (s ? 'account' AND s ? 'rate' AND s ? 'vat' AND s ? 'base')
         OR (s ->> 'account') !~ '^26[0-9]{2}$'
         OR (s ->> 'rate')::numeric NOT IN (25, 12, 6)
         OR (s ->> 'vat')::numeric <= 0
         OR abs((s ->> 'base')::numeric * (s ->> 'rate')::numeric / 100 - (s ->> 'vat')::numeric) > 0.01
    ) OR COALESCE((SELECT sum((s ->> 'vat')::numeric) FROM jsonb_array_elements(v_shares) s), 0) <> v_vat THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VAT_MISMATCH: vat_by_rate does not add up to vat_amount'
        USING ERRCODE = 'check_violation';
    END IF;

    IF p_journal_entry_id IS NULL THEN
      -- Only a claim that never reached the ledger as a fordran (kontantmetoden)
      -- is written off without a voucher, and it has no VAT to take back.
      IF v_vat <> 0 OR EXISTS (
        SELECT 1
          FROM public.journal_entries je
          JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
          WHERE je.id = v_invoice.journal_entry_id
            AND je.company_id = p_company_id
            AND je.status = 'posted'
            AND l.account_number ~ '^151[0-9]$'
            AND l.account_number NOT IN ('1513', '1519')
            AND l.debit_amount > 0
      ) THEN
        RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: a claim on the ledger is written off by a voucher'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF EXISTS (
      WITH booked AS (
        SELECT l.account_number AS account,
               sum(CASE WHEN p_kind = 'confirmed' THEN l.debit_amount - l.credit_amount
                        ELSE l.credit_amount - l.debit_amount END) AS vat
          FROM public.journal_entry_lines l
          WHERE l.journal_entry_id = p_journal_entry_id
            AND l.account_number ~ '^26[0-9]{2}$'
          GROUP BY l.account_number
      ), recorded AS (
        SELECT s ->> 'account' AS account, sum((s ->> 'vat')::numeric) AS vat
          FROM jsonb_array_elements(v_shares) s
          GROUP BY 1
      )
      SELECT 1
        FROM booked b
        FULL JOIN recorded r ON r.account = b.account
        WHERE COALESCE(b.vat, 0) <> COALESCE(r.vat, 0)
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VAT_MISMATCH: the voucher''s output VAT lines differ from vat_by_rate'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_status := v_invoice.status;

  IF p_kind = 'doubtful' THEN
    IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_INVOICE_NOT_OPEN: invoice status %', v_invoice.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_kind = 'confirmed' THEN
    IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_INVOICE_NOT_OPEN: invoice status %', v_invoice.status
        USING ERRCODE = 'check_violation';
    END IF;
    v_status := 'written_off';
  ELSIF p_kind = 'recovered' THEN
    IF v_invoice.status <> 'written_off' THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_NOT_WRITTEN_OFF: invoice status %', v_invoice.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_kind = 'reversed_doubtful' THEN
    IF v_invoice.status IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_INVOICE_NOT_OPEN: invoice status %', v_invoice.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_kind = 'annulled' THEN
    -- Undo in order: only the latest live decision on the invoice.
    IF EXISTS (
      SELECT 1 FROM public.invoice_write_offs w
      WHERE w.invoice_id = p_invoice_id
        AND w.kind <> 'annulled'
        AND w.id <> v_reversed.id
        AND w.decided_at > v_reversed.decided_at
        AND NOT EXISTS (SELECT 1 FROM public.invoice_write_offs a WHERE a.reverses_id = w.id)
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_ANNUL_NOT_LATEST: a later decision on the invoice must be reversed first'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_reversed.kind = 'confirmed' THEN
      IF v_invoice.status <> 'written_off' THEN
        RAISE EXCEPTION 'CUSTOMER_LOSS_NOT_WRITTEN_OFF: invoice status %', v_invoice.status
          USING ERRCODE = 'check_violation';
      END IF;
      v_status := CASE
        WHEN COALESCE(v_invoice.paid_amount, 0) > 0 THEN 'partially_paid'
        WHEN v_invoice.due_date < public.stockholm_today() THEN 'overdue'
        ELSE 'sent'
      END;
    END IF;
  ELSE
    RAISE EXCEPTION 'CUSTOMER_LOSS_KIND_INVALID: %', p_kind USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.invoice_write_offs (
    id, company_id, invoice_id, kind, entry_date, amount, net_amount, vat_amount,
    vat_by_rate, reserve_released, journal_entry_id, evidence_document_id, reason,
    case_id, reverses_id, decided_by
  ) VALUES (
    p_id, p_company_id, p_invoice_id, p_kind, p_entry_date, v_amount, v_net,
    v_vat, v_shares, v_released,
    p_journal_entry_id, p_evidence_document_id, p_reason, p_case_id, p_reverses_id, v_decided_by
  );

  IF v_status IS DISTINCT FROM v_invoice.status THEN
    PERFORM pg_catalog.set_config('gnubok.customer_loss_status', 'true', true);
    UPDATE public.invoices SET status = v_status WHERE id = p_invoice_id;
    PERFORM pg_catalog.set_config('gnubok.customer_loss_status', '', true);
  END IF;

  RETURN jsonb_build_object('id', p_id, 'invoice_status', v_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.revert_rot_rut_reclaim_invoice(p_item_id uuid, p_invoice_id uuid, p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item      public.rot_rut_payout_request_items%ROWTYPE;
  v_invoice   public.invoices%ROWTYPE;
  v_paid      numeric;
  v_reclaimed numeric;
  v_remaining numeric;
  v_status    text;
BEGIN
  SELECT * INTO v_item
  FROM public.rot_rut_payout_request_items
  WHERE id = p_item_id AND invoice_id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revert_rot_rut_reclaim_invoice: item % not found for invoice %', p_item_id, p_invoice_id;
  END IF;
  IF v_item.reclaimed_amount IS NULL THEN
    RETURN jsonb_build_object('reverted', false);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rot_rut_payout_requests
    WHERE id = v_item.request_id AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'revert_rot_rut_reclaim_invoice: request for item % not found in company %', p_item_id, p_company_id;
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revert_rot_rut_reclaim_invoice: invoice % not found in company %', p_invoice_id, p_company_id;
  END IF;

  v_reclaimed := GREATEST(0, COALESCE(v_invoice.deduction_reclaimed_total, 0) - v_item.reclaimed_amount);
  v_paid := COALESCE(v_invoice.paid_amount, 0);
  v_remaining := public.rot_rut_customer_outstanding(
    v_invoice.total, v_paid, v_invoice.deduction_total, v_reclaimed
  );
  v_status := v_invoice.status;
  IF v_invoice.status IN ('sent', 'overdue', 'partially_paid', 'paid') THEN
    IF v_remaining <= 0 AND v_paid > 0 THEN
      v_status := 'paid';
    ELSIF v_paid > 0 THEN
      v_status := 'partially_paid';
    ELSIF v_invoice.due_date IS NOT NULL AND v_invoice.due_date < public.stockholm_today() THEN
      v_status := 'overdue';
    ELSE
      v_status := 'sent';
    END IF;
  END IF;

  UPDATE public.rot_rut_payout_request_items
  SET reclaimed_amount = NULL
  WHERE id = p_item_id;

  UPDATE public.invoices
  SET deduction_reclaimed_total = v_reclaimed,
      remaining_amount = v_remaining,
      status = v_status
  WHERE id = p_invoice_id AND company_id = p_company_id;

  RETURN jsonb_build_object('reverted', true, 'remaining_amount', v_remaining, 'status', v_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_delivery_note_number(p_company_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_number INTEGER;
  v_year TEXT;
  v_trusted boolean;
BEGIN
  -- Same fail-closed rule as generate_invoice_number: only a service_role or
  -- a direct database connection with no auth.uid() is trusted without a
  -- membership in the company.
  v_trusted := auth.uid() IS NULL
    AND (
      COALESCE(auth.role(), '') = 'service_role'
      OR (auth.role() IS NULL AND session_user <> 'authenticator')
    );

  IF NOT v_trusted AND NOT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE user_id = auth.uid() AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.company_settings
  SET next_delivery_note_number = next_delivery_note_number + 1,
      updated_at = now()
  WHERE company_id = p_company_id
  RETURNING next_delivery_note_number - 1
  INTO v_number;

  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Company settings not found for company %', p_company_id;
  END IF;

  v_year := EXTRACT(YEAR FROM public.stockholm_today())::TEXT;
  -- At least three digits, never cut: LPAD truncates a longer string.
  RETURN 'FS-' || v_year || LPAD(v_number::TEXT, GREATEST(3, length(v_number::TEXT)), '0');
END;
$function$;
