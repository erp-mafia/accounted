-- Migrated invoices: the household deduction a provider invoice carried.
--
-- A Visma invoice issued under fakturamodellen (ROT, RUT, grön teknik)
-- reached Accounted without its deduction: the provider import has no slot
-- for it and Visma's SIE books the whole invoice on 1510. An open RUT invoice
-- therefore reads as owed in full by the buyer and can never be requested
-- from Skatteverket here (crm#1144).
--
-- The post-migration deduction step (lib/invoices/migrated-deduction-apply.ts)
-- repairs one invoice at a time:
--   1. a reclassification voucher through the engine, debit 1513 / credit
--      1510 for the deduction (source_type 'rot_rut_reclassification',
--      source_id = the invoice), the 1513 claim an invoice issued here books
--      on day one (swedish-invoice-compliance section 8, fakturamodellen);
--   2. apply_migrated_invoice_deduction, which writes the deduction onto the
--      invoice and its work rows exactly as buildInvoiceWriteData does for an
--      invoice issued here, so settle, reclaim, credit notes, the customer
--      share formula and the begäran need no second model.
-- 1510 and 1513 share SRU 7251: no balance sheet, INK2 or VAT figure moves.
--
-- This migration adds:
--   - 'rot_rut_reclassification' to journal_entries.source_type and one live
--     voucher per invoice (the voucher-series default follows in
--     20261015001100);
--   - the processing_history event InvoiceDeductionMigrated;
--   - apply_migrated_invoice_deduction and its mirror
--     revert_migrated_invoice_deduction (the voucher is reversed).
--
-- pg-test: tests/pg/migrated-invoice-deduction.pg.test.ts

-- 1. journal_entries.source_type: add 'rot_rut_reclassification' ----------
-- Rebuilt from 20261011203100_journal_source_type_pos_daily_sales.sql (the
-- latest definition): full list preserved, new value appended. TS
-- (JournalEntrySourceType) and Zod (JournalEntrySourceTypeSchema) gain the
-- value in the same change.

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'inbox_item',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation',
    'supplier_invoice_privately_paid',
    'reminder_fee',
    'accrual',
    'result_appropriation',
    'rot_rut_payout',
    'vat_settlement',
    'stripe_payout',
    'webshop_order',
    'expense_claim',
    'expense_payout',
    'rot_rut_reclaim',
    'pos_daily_sales',
    'rot_rut_reclassification'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

-- 2. One live reclassification voucher per invoice --------------------------
-- Same race guard as journal_entries_rot_rut_reclaim_live_unique
-- (20260907160000): two concurrent runs must not both move the deduction.
-- draft included so the loser fails at the draft insert, before it can
-- spend a voucher number; the apply service then reuses the winner's voucher.

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_rot_rut_reclassification_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'rot_rut_reclassification'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');

-- 3. Behandlingshistorik event ----------------------------------------------
-- One event per write: action 'applied' (deduction written), 'status_repaired'
-- (a part-paid import moved from sent to partially_paid) or 'reverted' (the
-- voucher was reversed). UUIDs, amounts and enum strings only: no
-- personnummer and no invoice number in the payload.

INSERT INTO public.processing_event_types (event_type)
VALUES ('InvoiceDeductionMigrated')
ON CONFLICT (event_type) DO NOTHING;

-- 4. apply_migrated_invoice_deduction ---------------------------------------
-- p_expected: what the preview saw: {status, total, paid_amount,
--   payment_count, item_count}. Any drift refuses: the plan was made for
--   that state and only for it.
-- p_deduction: NULL for the status-only mode (a part-paid import at sent or
--   overdue becomes partially_paid, nothing else changes); otherwise
--   {deduction_type, deduction_total, personnummer_encrypted,
--   personnummer_last4, paid_on, items: [{id, line_total, vat_amount,
--   deduction_amount, labor_hours, work_type, housing_designation,
--   apartment_number, brf_org_number}]}.
-- p_journal_entry_id: the posted reclassification voucher. Not read on a dry
--   run, which checks everything else and writes nothing.
-- p_trail: {provider, consent_id, correlation_id} for the event.
--
-- The database derives remaining_amount and status with the one outstanding
-- formula (rot_rut_customer_outstanding, 20260907160400); the caller names
-- only the deduction. Refusals answer {ok: false, code}, never raise, so a
-- run reports them per invoice and goes on.

CREATE OR REPLACE FUNCTION public.apply_migrated_invoice_deduction(
  p_company_id uuid,
  p_invoice_id uuid,
  p_expected jsonb,
  p_deduction jsonb DEFAULT NULL,
  p_journal_entry_id uuid DEFAULT NULL,
  p_dry_run boolean DEFAULT false,
  p_trail jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '8s'
SET lock_timeout = '2s'
AS $$
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
      IF v_paid_on IS NULL OR v_paid_on > CURRENT_DATE THEN
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
$$;

-- 5. revert_migrated_invoice_deduction --------------------------------------
-- The reclassification voucher was reversed: the storno put the deduction
-- back on 1510, so the invoice goes back to reading it as the buyer's.
-- p_check_only answers whether the reversal may go ahead and writes nothing:
-- reverseEntry asks it BEFORE booking the storno, because a begäran made in
-- Accounted that holds the invoice (or a reclaim that followed one) makes the
-- deduction Skatteverket's business, and a storno would leave 1513 and the
-- begäran disagreeing. The write mode asks the same question again under the
-- lock (a begäran made between the two calls).

CREATE OR REPLACE FUNCTION public.revert_migrated_invoice_deduction(
  p_company_id uuid,
  p_invoice_id uuid,
  p_journal_entry_id uuid,
  p_check_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '8s'
SET lock_timeout = '2s'
AS $$
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
  ELSIF v_invoice.due_date < CURRENT_DATE THEN
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
$$;

REVOKE ALL ON FUNCTION public.apply_migrated_invoice_deduction(uuid, uuid, jsonb, jsonb, uuid, boolean, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revert_migrated_invoice_deduction(uuid, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_migrated_invoice_deduction(uuid, uuid, jsonb, jsonb, uuid, boolean, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revert_migrated_invoice_deduction(uuid, uuid, uuid, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
