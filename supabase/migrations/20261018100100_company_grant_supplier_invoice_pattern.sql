-- Grants, slice 2: the booking pattern of a staged supplier invoice from the
-- inbox, what may never be granted, and creating a supplier-invoice grant.
--
-- 1. grant_item_account_allowed(account): the accounts a supplier-invoice
--    grant may book an invoice line on: the cost accounts of classes 4-7 and
--    the öresavrundning account 3740. Never representation, external or
--    personnel (6070-6079, 7630-7639: the deductible VAT is capped per person
--    and occasion, a person's judgement each time), never a balance account
--    (an asset, a prepaid or an accrued cost books more than the invoice: an
--    anläggningsregister entry or later periodiseringar), never class 8. The
--    one statement of the rule: the TypeScript schema leaves it to the
--    database.
--
-- 2. supplier_invoice_operation_unfit(params, preview): what a staged
--    create_supplier_invoice_from_inbox asks for beyond a plain registration
--    of a Swedish supplier's invoice, the first reason found, or NULL:
--      register_booked      registers an invoice whose verifikat already
--                           exists (gnubok_register_booked_supplier_invoice)
--      unsupported_params   a parameter (or a line field) this gate does not
--                           know: whatever a later tool version adds waits
--                           for a person until a grant is taught it
--      foreign_currency     not SEK, or an exchange rate
--      dimensions           dimension tags on the invoice or a line
--      special_payroll_tax  a line flagged for särskild löneskatt
--      credit_note          a total of zero or below, a negative subtotal
--      negative_line        a line below zero (a rabatt, or an avdrag such as
--                           a ROT/RUT skattereduktion, which a company never
--                           books as its own)
--      payment_details      the invoice states bank details the supplier card
--                           lacks or does not have: confirming would write
--                           them to the card or route a payment to them
--      preview_warning      the staging warned the approver (a recomputed
--                           payable, lines read as incl. VAT, foreign VAT in
--                           the cost, a missing exchange rate)
--      underlag_missing     no document: the invoice is the verifikat's
--                           underlag (BFL 5 kap. 6-7 §§)
--
-- 3. supplier_invoice_operation_pattern(params, preview, supplier_type): the
--    booking pattern, read off what the commit runs (the params) and what the
--    approver was shown (the preview's total): the supplier, the invoice
--    date, the VAT treatment, under reverse charge the kind the supplier's
--    type books, every line's '<account>:<VAT %>' sorted and distinct, and
--    the total (what 2440 is credited, SEK). NULL when it cannot be read
--    exactly: then no grant can match.
--
-- 4. create_company_grant: a new overload with two more parameters,
--    p_supplier_id and p_item_lines, holds the whole rule for both types; the
--    slice 1 signature is restated as the same call with both NULL, so a
--    bank-line grant is created exactly as before (and by callers that never
--    learnt the new parameters). For a supplier-invoice grant it checks, on
--    top of the owner-or-admin and person-in-the-app checks every grant has:
--    the supplier belongs to the company; the VAT treatment is a known one
--    and a reverse-charge kind is named exactly when it is reverse charge;
--    every line is '<account>:<0|6|12|25>' on an account
--    grant_item_account_allowed accepts and active in the chart; the
--    verifikat accounts hold every line account and 2440. No category and no
--    business account: the lines say where the cost goes.
--
-- pg-test: tests/pg/company-grants-supplier-invoices.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. grant_item_account_allowed
-- =============================================================================

CREATE FUNCTION public.grant_item_account_allowed(p_account text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT coalesce(p_account, '') ~ '^[0-9]{4}$'
     AND (p_account = '3740'
          OR (p_account BETWEEN '4000' AND '7999'
              AND p_account NOT BETWEEN '6070' AND '6079'
              AND p_account NOT BETWEEN '7630' AND '7639'));
$$;

GRANT EXECUTE ON FUNCTION public.grant_item_account_allowed(text) TO authenticated, service_role;

-- =============================================================================
-- 2. supplier_invoice_operation_unfit
-- =============================================================================

CREATE FUNCTION public.supplier_invoice_operation_unfit(p_params jsonb, p_preview jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_items jsonb;
  v_item jsonb;
  -- What gnubok_create_supplier_invoice_from_inbox stages today.
  known_params constant text[] := ARRAY[
    'inbox_item_id', 'supplier_id', 'document_id', 'supplier_invoice_number', 'invoice_date', 'due_date', 'currency',
    'exchange_rate', 'vat_treatment', 'payment_reference', 'subtotal', 'vat_amount', 'total', 'notes', 'items',
    'default_dimensions', 'mode'
  ];
  known_item_fields constant text[] := ARRAY[
    'line_number', 'description', 'quantity', 'unit', 'unit_price', 'line_total', 'account_number', 'vat_rate',
    'vat_amount', 'apply_slp', 'dimensions'
  ];
BEGIN
  IF p_params IS NULL OR jsonb_typeof(p_params) IS DISTINCT FROM 'object' THEN
    RETURN 'pattern_unreadable';
  END IF;
  IF p_params->>'mode' = 'register_booked' THEN
    RETURN 'register_booked';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_params) AS k WHERE NOT (k = ANY (known_params))) THEN
    RETURN 'unsupported_params';
  END IF;
  v_items := CASE WHEN jsonb_typeof(p_params->'items') = 'array' THEN p_params->'items' ELSE '[]'::jsonb END;
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RETURN 'pattern_unreadable';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) AS k WHERE NOT (k = ANY (known_item_fields))) THEN
      RETURN 'unsupported_params';
    END IF;
  END LOOP;

  IF coalesce(p_params->>'currency', 'SEK') <> 'SEK'
     OR coalesce(jsonb_typeof(p_params->'exchange_rate'), 'null') <> 'null' THEN
    RETURN 'foreign_currency';
  END IF;
  IF (coalesce(jsonb_typeof(p_params->'default_dimensions'), 'null') <> 'null' AND p_params->'default_dimensions' <> '{}'::jsonb)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) AS i
                 WHERE coalesce(jsonb_typeof(i->'dimensions'), 'null') <> 'null' AND i->'dimensions' <> '{}'::jsonb) THEN
    RETURN 'dimensions';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) AS i WHERE i->'apply_slp' = 'true'::jsonb) THEN
    RETURN 'special_payroll_tax';
  END IF;
  IF (jsonb_typeof(p_params->'total') = 'number' AND (p_params->>'total')::numeric <= 0)
     OR (jsonb_typeof(p_params->'subtotal') = 'number' AND (p_params->>'subtotal')::numeric < 0) THEN
    RETURN 'credit_note';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) AS i
              WHERE jsonb_typeof(i->'line_total') = 'number' AND (i->>'line_total')::numeric < 0) THEN
    RETURN 'negative_line';
  END IF;
  IF coalesce(p_preview ?| ARRAY['invoice_account', 'supplier_payment_details_fill', 'compliance_warning'], false) THEN
    RETURN 'payment_details';
  END IF;
  IF coalesce(p_preview ?| ARRAY['warning', 'payable_recomputed', 'line_amounts_interpreted_as', 'foreign_vat_in_cost', 'exchange_rate_hint'], false) THEN
    RETURN 'preview_warning';
  END IF;
  IF coalesce(p_params->>'document_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN 'underlag_missing';
  END IF;
  RETURN NULL;
END;
$$;

-- =============================================================================
-- 3. supplier_invoice_operation_pattern
-- =============================================================================

CREATE FUNCTION public.supplier_invoice_operation_pattern(p_params jsonb, p_preview jsonb, p_supplier_type text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_rate numeric;
  v_lines text[] := ARRAY[]::text[];
  v_total numeric;
  v_vat text;
  v_rc text;
  v_date date;
BEGIN
  IF p_params IS NULL OR p_preview IS NULL
     OR jsonb_typeof(p_params->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_params->'items') = 0 THEN
    RETURN NULL;
  END IF;
  IF coalesce(p_params->>'supplier_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  -- The total the approver was shown is the total the commit writes.
  IF jsonb_typeof(p_params->'total') IS DISTINCT FROM 'number' OR jsonb_typeof(p_preview->'total') IS DISTINCT FROM 'number' THEN
    RETURN NULL;
  END IF;
  v_total := (p_params->>'total')::numeric;
  IF v_total <= 0 OR (p_preview->>'total')::numeric <> v_total THEN
    RETURN NULL;
  END IF;
  IF coalesce(p_params->>'invoice_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_date := (p_params->>'invoice_date')::date;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  v_vat := nullif(p_params->>'vat_treatment', '');
  IF v_vat IS NULL OR v_vat NOT IN ('standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt') THEN
    RETURN NULL;
  END IF;
  -- The kind reverseChargeKindForSupplierType (src/lib/bookkeeping/vat-entries.ts)
  -- books for the supplier's type; a type without one never books reverse charge.
  IF v_vat = 'reverse_charge' THEN
    v_rc := CASE p_supplier_type
              WHEN 'eu_business' THEN 'eu_services'
              WHEN 'non_eu_business' THEN 'non_eu_services'
              WHEN 'swedish_business' THEN 'domestic_services'
            END;
    IF v_rc IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_params->'items') LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR coalesce(v_item->>'account_number', '') !~ '^[0-9]{4}$'
       OR jsonb_typeof(v_item->'line_total') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_item->'vat_rate') IS DISTINCT FROM 'number' THEN
      RETURN NULL;
    END IF;
    v_rate := (v_item->>'vat_rate')::numeric;
    IF v_rate NOT IN (0, 0.06, 0.12, 0.25) THEN
      RETURN NULL;
    END IF;
    v_lines := v_lines || ((v_item->>'account_number') || ':' || round(v_rate * 100)::int::text);
  END LOOP;
  SELECT array_agg(DISTINCT l ORDER BY l) INTO v_lines FROM unnest(v_lines) AS l;

  RETURN jsonb_build_object(
    'supplier_id', lower(p_params->>'supplier_id'),
    'invoice_date', v_date,
    'vat_treatment', v_vat,
    'reverse_charge_kind', v_rc,
    'item_lines', to_jsonb(v_lines),
    'amount_sek', round(v_total, 2)
  );
END;
$$;

-- =============================================================================
-- 4. create_company_grant: one rule for both types
-- =============================================================================

CREATE FUNCTION public.create_company_grant(
  p_company_id uuid,
  p_decided_by uuid,
  p_actor_type text,
  p_actor_label text,
  p_pending_operation_id uuid,
  p_operation_type text,
  p_counterparty_key text,
  p_counterparty_label text,
  p_direction text,
  p_category text,
  p_vat_treatment text,
  p_reverse_charge_kind text,
  p_account_number text,
  p_line_accounts text[],
  p_amount_limit_sek numeric,
  p_monthly_limit_sek numeric,
  p_credential_scope text,
  p_credential_id uuid,
  p_evidence jsonb,
  p_supplier_id uuid,
  p_item_lines text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old public.company_grants;
  v_new public.company_grants;
  v_version integer;
  v_actor_type text;
  v_lines text[];
  v_items text[];
  v_item_accounts text[];
  v_key text;
  v_label text;
  v_direction text;
  v_supplier public.suppliers;
  v_inactive text;
BEGIN
  IF p_decided_by IS NULL OR NOT public.service_account_actor_is_admin(p_company_id, p_decided_by) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_ADMIN_REQUIRED');
  END IF;
  -- Accepting a grant is a person's decision in the app: an agent never
  -- accepts its own authority, whichever credential relays it (api_key,
  -- mcp_oauth, agent_chat, service_account) and a missing actor alike.
  IF p_actor_type IS DISTINCT FROM 'user' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_NEEDS_PERSON');
  END IF;
  IF p_operation_type IS NULL OR p_operation_type NOT IN ('categorize_transaction', 'create_supplier_invoice_from_inbox') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'operation_type');
  END IF;

  SELECT array_agg(DISTINCT a ORDER BY a) INTO v_lines FROM unnest(coalesce(p_line_accounts, ARRAY[]::text[])) AS a;

  IF p_operation_type = 'categorize_transaction' THEN
    IF p_supplier_id IS NOT NULL OR p_item_lines IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'supplier_id');
    END IF;
    -- The key must be one grant_counterparty_key can produce: a bank text that
    -- names someone, not only a payment rail.
    IF p_counterparty_key IS NULL OR public.grant_counterparty_key(p_counterparty_key, NULL, NULL) IS DISTINCT FROM p_counterparty_key THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_UNKNOWN_COUNTERPARTY');
    END IF;
    IF p_account_number IS NULL OR p_account_number !~ '^[0-9]{4}$' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'account_number');
    END IF;
    IF v_lines IS NULL OR EXISTS (SELECT 1 FROM unnest(v_lines) AS a WHERE a !~ '^[0-9]{4}$')
       OR NOT (p_account_number = ANY (v_lines)) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'line_accounts');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.chart_of_accounts
                    WHERE company_id = p_company_id AND account_number = p_account_number AND is_active) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_ACCOUNT_INACTIVE', 'account_number', p_account_number);
    END IF;
    v_key := p_counterparty_key;
    v_label := left(coalesce(nullif(btrim(p_counterparty_label), ''), p_counterparty_key), 200);
    v_direction := p_direction;
  ELSE
    -- A known supplier, by id: never a name or a bank text.
    IF p_supplier_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_UNKNOWN_SUPPLIER');
    END IF;
    SELECT * INTO v_supplier FROM public.suppliers WHERE id = p_supplier_id AND company_id = p_company_id;
    IF v_supplier.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_UNKNOWN_SUPPLIER');
    END IF;
    IF p_counterparty_key IS NOT NULL AND p_counterparty_key IS DISTINCT FROM 'supplier:' || p_supplier_id::text THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'counterparty_key');
    END IF;
    IF p_category IS NOT NULL OR p_account_number IS NOT NULL OR coalesce(p_direction, 'out') <> 'out' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'pattern');
    END IF;
    IF p_vat_treatment IS NULL OR p_vat_treatment NOT IN ('standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt')
       OR (p_reverse_charge_kind IS NOT NULL) <> (p_vat_treatment = 'reverse_charge')
       OR (p_reverse_charge_kind IS NOT NULL AND p_reverse_charge_kind NOT IN ('eu_services', 'non_eu_services', 'domestic_services')) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'vat_treatment');
    END IF;
    SELECT array_agg(DISTINCT l ORDER BY l) INTO v_items FROM unnest(coalesce(p_item_lines, ARRAY[]::text[])) AS l;
    IF v_items IS NULL OR cardinality(v_items) > 12
       OR EXISTS (SELECT 1 FROM unnest(v_items) AS l
                   WHERE l !~ '^[0-9]{4}:(0|6|12|25)$' OR NOT public.grant_item_account_allowed(split_part(l, ':', 1))) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'item_lines');
    END IF;
    SELECT array_agg(DISTINCT split_part(l, ':', 1) ORDER BY split_part(l, ':', 1)) INTO v_item_accounts FROM unnest(v_items) AS l;
    -- The verifikat: every line account, 2440, and what VAT adds; nothing else.
    IF v_lines IS NULL OR cardinality(v_lines) NOT BETWEEN 2 AND 16
       OR EXISTS (SELECT 1 FROM unnest(v_lines) AS a WHERE a !~ '^[0-9]{4}$')
       OR NOT ('2440' = ANY (v_lines)) OR NOT (v_item_accounts <@ v_lines) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'line_accounts');
    END IF;
    SELECT a INTO v_inactive
      FROM unnest(v_item_accounts) AS a
     WHERE NOT EXISTS (SELECT 1 FROM public.chart_of_accounts c
                        WHERE c.company_id = p_company_id AND c.account_number = a AND c.is_active)
     ORDER BY a
     LIMIT 1;
    IF v_inactive IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_ACCOUNT_INACTIVE', 'account_number', v_inactive);
    END IF;
    v_key := 'supplier:' || p_supplier_id::text;
    v_label := left(coalesce(nullif(btrim(p_counterparty_label), ''), v_supplier.name), 200);
    v_direction := 'out';
  END IF;

  IF p_credential_scope = 'api_key' THEN
    IF p_credential_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.api_keys k
       WHERE k.id = p_credential_id AND k.revoked_at IS NULL
         AND (k.company_id = p_company_id
              OR (k.service_account_id IS NULL AND EXISTS (
                    SELECT 1 FROM public.company_members cm
                     WHERE cm.company_id = p_company_id AND cm.user_id = k.user_id)))) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_CREDENTIAL_UNKNOWN');
    END IF;
  ELSIF p_credential_scope = 'service_account' THEN
    IF p_credential_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.service_accounts s
       WHERE s.id = p_credential_id AND s.company_id = p_company_id AND s.revoked_at IS NULL) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'GRANT_CREDENTIAL_UNKNOWN');
    END IF;
  ELSIF p_credential_scope IS DISTINCT FROM 'any' OR p_credential_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'GRANT_INVALID', 'field', 'credential');
  END IF;

  v_actor_type := CASE
    WHEN p_actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat', 'service_account') THEN p_actor_type
    ELSE 'user'
  END;

  -- One decision per rule at a time: the supersede read and the insert see the same state.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'company-grant:' || p_company_id::text || ':' || p_operation_type || ':' || v_key, 0));

  SELECT * INTO v_old
    FROM public.company_grants
   WHERE company_id = p_company_id AND operation_type = p_operation_type
     AND counterparty_key = v_key AND revoked_at IS NULL
   FOR UPDATE;

  SELECT coalesce(max(version), 0) + 1 INTO v_version
    FROM public.company_grants
   WHERE company_id = p_company_id AND operation_type = p_operation_type AND counterparty_key = v_key;

  IF v_old.id IS NOT NULL THEN
    UPDATE public.company_grants
       SET revoked_at = now(), revoked_by = p_decided_by, revoked_reason = 'superseded',
           revoked_pending_operation_id = p_pending_operation_id
     WHERE id = v_old.id;
    INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                  description, actor_type, actor_label)
    SELECT p_decided_by, p_company_id, 'UPDATE', 'company_grants', g.id, p_decided_by, to_jsonb(v_old), to_jsonb(g),
           'Grant superseded by version ' || v_version || ': ' || g.counterparty_label,
           v_actor_type, nullif(left(p_actor_label, 200), '')
      FROM public.company_grants g WHERE g.id = v_old.id;
  END IF;

  INSERT INTO public.company_grants (
    company_id, operation_type, counterparty_key, counterparty_label, version, direction, category, vat_treatment,
    reverse_charge_kind, account_number, line_accounts, amount_limit_sek, monthly_limit_sek, credential_scope,
    credential_id, accepted_by, accepted_actor_type, accepted_actor_label, pending_operation_id, evidence,
    supplier_id, item_lines
  )
  VALUES (
    p_company_id, p_operation_type, v_key, v_label,
    v_version, v_direction, p_category, p_vat_treatment, p_reverse_charge_kind, p_account_number, v_lines,
    round(p_amount_limit_sek, 2), round(p_monthly_limit_sek, 2), coalesce(p_credential_scope, 'any'), p_credential_id,
    p_decided_by, v_actor_type, nullif(left(p_actor_label, 200), ''), p_pending_operation_id, coalesce(p_evidence, '{}'::jsonb),
    CASE WHEN p_operation_type = 'create_supplier_invoice_from_inbox' THEN p_supplier_id END,
    v_items
  )
  RETURNING * INTO v_new;

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state,
                                description, actor_type, actor_label)
  VALUES (
    p_decided_by, p_company_id, 'INSERT', 'company_grants', v_new.id, p_decided_by, NULL, to_jsonb(v_new),
    'Grant created: ' || v_new.counterparty_label || ', up to ' || v_new.amount_limit_sek || ' SEK',
    v_actor_type, nullif(left(p_actor_label, 200), '')
  );

  RETURN jsonb_build_object(
    'ok', true,
    'grant_id', v_new.id,
    'version', v_new.version,
    'superseded_grant_id', v_old.id,
    'valid_from', v_new.valid_from,
    'accepted_at', v_new.accepted_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_company_grant(uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text, text[], numeric, numeric, text, uuid, jsonb, uuid, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_company_grant(uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text, text[], numeric, numeric, text, uuid, jsonb, uuid, text[])
  TO service_role;

-- The slice 1 signature, restated from 20261017100300 as the same call with
-- no supplier and no lines: a bank-line grant is created exactly as before.
CREATE OR REPLACE FUNCTION public.create_company_grant(
  p_company_id uuid,
  p_decided_by uuid,
  p_actor_type text,
  p_actor_label text,
  p_pending_operation_id uuid,
  p_operation_type text,
  p_counterparty_key text,
  p_counterparty_label text,
  p_direction text,
  p_category text,
  p_vat_treatment text,
  p_reverse_charge_kind text,
  p_account_number text,
  p_line_accounts text[],
  p_amount_limit_sek numeric,
  p_monthly_limit_sek numeric DEFAULT NULL,
  p_credential_scope text DEFAULT 'any',
  p_credential_id uuid DEFAULT NULL,
  p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.create_company_grant(
    p_company_id, p_decided_by, p_actor_type, p_actor_label, p_pending_operation_id, p_operation_type, p_counterparty_key,
    p_counterparty_label, p_direction, p_category, p_vat_treatment, p_reverse_charge_kind, p_account_number, p_line_accounts,
    p_amount_limit_sek, p_monthly_limit_sek, p_credential_scope, p_credential_id, p_evidence, NULL::uuid, NULL::text[]
  );
$$;

REVOKE ALL ON FUNCTION public.create_company_grant(uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text, text[], numeric, numeric, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_company_grant(uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text, text[], numeric, numeric, text, uuid, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
