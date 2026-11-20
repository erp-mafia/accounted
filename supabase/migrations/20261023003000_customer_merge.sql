-- Customer merge (crm#1398, crm#1299): fold a duplicate customer card into
-- the card that stays, and undo it within 30 days.
--
-- Duplicates arise when a card made by hand meets the same customer from an
-- import (Visma, Fortnox, Bokio before crm#1294), or when someone enters a
-- customer twice. The invoice history then sits on two cards for one buyer,
-- and nothing could move it: a card on an issued invoice is never deleted
-- (lib/customers/delete-guard.ts), and no door re-pointed an invoice.
--
-- A merge moves every row that names the duplicate to the surviving card, in
-- one transaction: invoices (quotes and proformas are invoice rows), sales
-- orders, recurring invoice schedules, deadlines, and the import's source
-- map (migration_source_records), so a re-run of the import resolves the
-- source customer to the survivor instead of filling the duplicate again.
-- The duplicate is then archived, never deleted: an invoice row stores no
-- copy of its buyer, so the card is what the issued invoices named while
-- they pointed at it (ML 17 kap 24 §, BFL 7 kap 2 §). Nothing on the
-- surviving card changes.
--
-- Untouched on purpose: posted verifikationer and their lines (they name the
-- invoice, never the customer), business_events (append-only; a row keeps
-- the customer id it was posted with, and customer_merges says where that
-- card went), migration_job_chunks (a finished job's receipts) and the
-- parties a card links to (Motparter has its own merge).
--
-- customer_merges is the record of who merged what, when, and exactly which
-- rows moved: the behandlingshistorik (BFNAR 2013:2 p. 9.16) and what undo
-- reads. Undo moves back only the rows the merge moved that still point at
-- the survivor, and restores the duplicate's archived_at.
--
-- Two cards that state different org numbers or VAT numbers are two legal
-- persons and are refused here. A personnummer is encrypted with the
-- application's key, so lib/customers/merge-customers.ts compares those
-- before it calls.

-- =============================================================================
-- 1. customer_merges
-- =============================================================================

CREATE TABLE public.customer_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  -- NO ACTION: a card a merge names is kept, like a card on an invoice.
  survivor_id uuid NOT NULL REFERENCES public.customers(id),
  merged_id uuid NOT NULL REFERENCES public.customers(id),
  -- {"invoices": [ids], "sales_orders": [...], "recurring_invoice_schedules":
  -- [...], "deadlines": [...], "migration_source_records": [...]}
  moved jsonb NOT NULL,
  -- The duplicate's archived_at before the merge (NULL: it was live).
  merged_archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by uuid,
  CONSTRAINT customer_merges_distinct CHECK (survivor_id <> merged_id),
  CONSTRAINT customer_merges_undo_pair CHECK ((undone_at IS NULL) = (undone_by IS NULL))
);

CREATE INDEX customer_merges_company ON public.customer_merges (company_id, created_at DESC);
CREATE INDEX customer_merges_survivor ON public.customer_merges (survivor_id);
CREATE INDEX customer_merges_merged ON public.customer_merges (merged_id);

ALTER TABLE public.customer_merges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_merges_select" ON public.customer_merges
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- Read by members; written only by the two SECURITY DEFINER functions below.
GRANT SELECT ON TABLE public.customer_merges TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customer_merges TO service_role;
-- no-grant: anon on public.customer_merges (company data)

COMMENT ON TABLE public.customer_merges IS
  'One row per customer card merged into another (merge_customers): who, when, and the ids of every row moved to the survivor, for undo_customer_merge and the behandlingshistorik.';

-- =============================================================================
-- 2. customer_merge_preview and merge_customers
-- =============================================================================
-- Actor: p_user_id is honoured only for a service_role caller (the v1 and
-- MCP doors run on the cookieless service client); any other caller is
-- pinned to its own auth.uid(), and must be a member of the company who is
-- not a viewer (the pattern of book_counterparty_setoff).
--
-- Both answer {ok: false, code, details} for a refusal. The preview is the
-- dry run (STABLE, reads only: the staging of an agent's merge may call
-- nothing that writes) and the one rule set: merge_customers locks the cards
-- and asks it again before it moves anything.

CREATE OR REPLACE FUNCTION public.customer_merge_preview(
  p_company_id uuid,
  p_survivor_id uuid,
  p_merged_ids uuid[],
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_ids uuid[];
  v_found uuid[];
  v_survivor public.customers%ROWTYPE;
  v_card public.customers%ROWTYPE;
  v_survivor_org text;
  v_survivor_vat text;
  v_key text;
  v_merged jsonb := '[]'::jsonb;
  v_invoices int;
  v_orders int;
  v_schedules int;
  v_deadlines int;
  v_sources int;
  v_total_invoices int := 0;
  v_total_orders int := 0;
  v_total_schedules int := 0;
  v_total_deadlines int := 0;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role <> 'viewer'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_FORBIDDEN');
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_ids
    FROM unnest(COALESCE(p_merged_ids, '{}')) AS x WHERE x IS NOT NULL;
  IF p_survivor_id IS NULL OR cardinality(v_ids) = 0 OR cardinality(v_ids) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'details', jsonb_build_object('field', 'merged_customer_ids', 'reason', 'between_1_and_50'));
  END IF;
  IF p_survivor_id = ANY (v_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VALIDATION_ERROR',
      'details', jsonb_build_object('field', 'merged_customer_ids', 'reason', 'survivor_in_merged'));
  END IF;

  SELECT * INTO v_survivor FROM public.customers
    WHERE id = p_survivor_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_NOT_FOUND',
      'details', jsonb_build_object('customer_id', p_survivor_id));
  END IF;
  IF v_survivor.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_SURVIVOR_ARCHIVED',
      'details', jsonb_build_object('customer_id', p_survivor_id));
  END IF;

  SELECT COALESCE(array_agg(id), '{}') INTO v_found FROM public.customers
    WHERE company_id = p_company_id AND id = ANY (v_ids);
  IF cardinality(v_found) <> cardinality(v_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_NOT_FOUND',
      'details', jsonb_build_object('customer_ids',
        (SELECT to_jsonb(array_agg(x)) FROM unnest(v_ids) AS x WHERE NOT (x = ANY (v_found)))));
  END IF;

  -- An org number keys by its letters and digits, a 12-digit form by its
  -- last 10 (lib/invariants/org-number.ts orgNumberKey); a VAT number by its
  -- letters and digits, upper case.
  v_survivor_org := NULLIF(upper(regexp_replace(COALESCE(v_survivor.org_number, ''), '[^0-9A-Za-z]', '', 'g')), '');
  IF v_survivor_org ~ '^[0-9]{12}$' THEN v_survivor_org := right(v_survivor_org, 10); END IF;
  v_survivor_vat := NULLIF(upper(regexp_replace(COALESCE(v_survivor.vat_number, ''), '[^0-9A-Za-z]', '', 'g')), '');

  FOR v_card IN SELECT * FROM public.customers
      WHERE company_id = p_company_id AND id = ANY (v_ids) ORDER BY created_at, id LOOP
    v_key := NULLIF(upper(regexp_replace(COALESCE(v_card.org_number, ''), '[^0-9A-Za-z]', '', 'g')), '');
    IF v_key ~ '^[0-9]{12}$' THEN v_key := right(v_key, 10); END IF;
    IF v_survivor_org IS NOT NULL AND v_key IS NOT NULL AND v_key <> v_survivor_org THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_IDENTITY_CONFLICT',
        'details', jsonb_build_object('customer_id', v_card.id, 'field', 'org_number'));
    END IF;
    v_key := NULLIF(upper(regexp_replace(COALESCE(v_card.vat_number, ''), '[^0-9A-Za-z]', '', 'g')), '');
    IF v_survivor_vat IS NOT NULL AND v_key IS NOT NULL AND v_key <> v_survivor_vat THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_IDENTITY_CONFLICT',
        'details', jsonb_build_object('customer_id', v_card.id, 'field', 'vat_number'));
    END IF;

    SELECT count(*) INTO v_invoices FROM public.invoices WHERE company_id = p_company_id AND customer_id = v_card.id;
    SELECT count(*) INTO v_orders FROM public.sales_orders WHERE company_id = p_company_id AND customer_id = v_card.id;
    SELECT count(*) INTO v_schedules FROM public.recurring_invoice_schedules
      WHERE company_id = p_company_id AND customer_id = v_card.id;
    SELECT count(*) INTO v_deadlines FROM public.deadlines WHERE company_id = p_company_id AND customer_id = v_card.id;
    SELECT count(*) INTO v_sources FROM public.migration_source_records
      WHERE company_id = p_company_id AND resource = 'customers' AND target_id = v_card.id;

    v_merged := v_merged || jsonb_build_array(jsonb_build_object(
      'customer_id', v_card.id,
      'name', v_card.name,
      'customer_number', v_card.customer_number,
      'merge_id', NULL,
      'was_archived', v_card.archived_at IS NOT NULL,
      'invoices', v_invoices,
      'sales_orders', v_orders,
      'recurring_invoice_schedules', v_schedules,
      'deadlines', v_deadlines,
      'source_records', v_sources));
    v_total_invoices := v_total_invoices + v_invoices;
    v_total_orders := v_total_orders + v_orders;
    v_total_schedules := v_total_schedules + v_schedules;
    v_total_deadlines := v_total_deadlines + v_deadlines;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', true,
    'survivor', jsonb_build_object('customer_id', v_survivor.id, 'name', v_survivor.name,
      'customer_number', v_survivor.customer_number),
    'merged', v_merged,
    'totals', jsonb_build_object('invoices', v_total_invoices, 'sales_orders', v_total_orders,
      'recurring_invoice_schedules', v_total_schedules, 'deadlines', v_total_deadlines));
END;
$function$;

REVOKE ALL ON FUNCTION public.customer_merge_preview(uuid, uuid, uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_merge_preview(uuid, uuid, uuid[], uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.customer_merge_preview(uuid, uuid, uuid[], uuid) IS
  'The dry run of merge_customers: its refusals (caller, ids, archived survivor, different org or VAT numbers) and, per merged customer card, how many invoices, sales orders, recurring schedules, deadlines and import source mappings would move. Reads only.';

CREATE OR REPLACE FUNCTION public.merge_customers(
  p_company_id uuid,
  p_survivor_id uuid,
  p_merged_ids uuid[],
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_check jsonb;
  v_survivor public.customers%ROWTYPE;
  v_card public.customers%ROWTYPE;
  v_invoices uuid[];
  v_orders uuid[];
  v_schedules uuid[];
  v_deadlines uuid[];
  v_sources uuid[];
  v_merge_id uuid;
  v_merged jsonb := '[]'::jsonb;
  v_total_invoices int := 0;
  v_total_orders int := 0;
  v_total_schedules int := 0;
  v_total_deadlines int := 0;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role <> 'viewer'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_FORBIDDEN');
  END IF;

  -- Every card of the merge, locked in id order so two merges never wait on
  -- each other crosswise. FOR UPDATE also holds off an invoice, order or
  -- deadline written against a duplicate while it moves (an FK check takes
  -- FOR KEY SHARE on the card). Then the rules, on the locked rows.
  PERFORM 1 FROM public.customers
    WHERE company_id = p_company_id
      AND (id = p_survivor_id OR id = ANY (COALESCE(p_merged_ids, '{}')))
    ORDER BY id FOR UPDATE;
  v_check := public.customer_merge_preview(p_company_id, p_survivor_id, p_merged_ids, p_user_id);
  IF NOT (v_check->>'ok')::boolean THEN
    RETURN v_check;
  END IF;

  SELECT * INTO v_survivor FROM public.customers WHERE id = p_survivor_id AND company_id = p_company_id;

  FOR v_card IN SELECT c.* FROM public.customers c
      WHERE c.company_id = p_company_id
        AND c.id IN (SELECT (m->>'customer_id')::uuid FROM jsonb_array_elements(v_check->'merged') AS m)
      ORDER BY c.created_at, c.id LOOP
    WITH moved AS (
      UPDATE public.invoices SET customer_id = p_survivor_id
      WHERE company_id = p_company_id AND customer_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_invoices FROM moved;
    WITH moved AS (
      UPDATE public.sales_orders SET customer_id = p_survivor_id
      WHERE company_id = p_company_id AND customer_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_orders FROM moved;
    WITH moved AS (
      UPDATE public.recurring_invoice_schedules SET customer_id = p_survivor_id
      WHERE company_id = p_company_id AND customer_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_schedules FROM moved;
    WITH moved AS (
      UPDATE public.deadlines SET customer_id = p_survivor_id
      WHERE company_id = p_company_id AND customer_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_deadlines FROM moved;
    WITH moved AS (
      UPDATE public.migration_source_records SET target_id = p_survivor_id
      WHERE company_id = p_company_id AND resource = 'customers' AND target_id = v_card.id RETURNING id)
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_sources FROM moved;
    UPDATE public.customers SET archived_at = COALESCE(archived_at, now())
      WHERE id = v_card.id AND company_id = p_company_id;

    INSERT INTO public.customer_merges (company_id, user_id, survivor_id, merged_id, moved, merged_archived_at)
    VALUES (p_company_id, v_caller, p_survivor_id, v_card.id,
      jsonb_build_object(
        'invoices', to_jsonb(v_invoices),
        'sales_orders', to_jsonb(v_orders),
        'recurring_invoice_schedules', to_jsonb(v_schedules),
        'deadlines', to_jsonb(v_deadlines),
        'migration_source_records', to_jsonb(v_sources)),
      v_card.archived_at)
    RETURNING id INTO v_merge_id;

    v_merged := v_merged || jsonb_build_array(jsonb_build_object(
      'customer_id', v_card.id,
      'name', v_card.name,
      'customer_number', v_card.customer_number,
      'merge_id', v_merge_id,
      'was_archived', v_card.archived_at IS NOT NULL,
      'invoices', cardinality(v_invoices),
      'sales_orders', cardinality(v_orders),
      'recurring_invoice_schedules', cardinality(v_schedules),
      'deadlines', cardinality(v_deadlines),
      'source_records', cardinality(v_sources)));
    v_total_invoices := v_total_invoices + cardinality(v_invoices);
    v_total_orders := v_total_orders + cardinality(v_orders);
    v_total_schedules := v_total_schedules + cardinality(v_schedules);
    v_total_deadlines := v_total_deadlines + cardinality(v_deadlines);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'survivor', jsonb_build_object('customer_id', v_survivor.id, 'name', v_survivor.name,
      'customer_number', v_survivor.customer_number),
    'merged', v_merged,
    'totals', jsonb_build_object('invoices', v_total_invoices, 'sales_orders', v_total_orders,
      'recurring_invoice_schedules', v_total_schedules, 'deadlines', v_total_deadlines));
END;
$function$;

REVOKE ALL ON FUNCTION public.merge_customers(uuid, uuid, uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_customers(uuid, uuid, uuid[], uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.merge_customers(uuid, uuid, uuid[], uuid) IS
  'Moves every invoice, sales order, recurring schedule, deadline and import source mapping of the merged customer cards to the survivor, archives the merged cards and records each merge in customer_merges, after the rules of customer_merge_preview hold on the locked cards.';

-- =============================================================================
-- 3. undo_customer_merge
-- =============================================================================
-- Within 30 days, like undo_party_merge. Refused while the survivor has
-- itself been merged into another card since: undo that merge first.

CREATE OR REPLACE FUNCTION public.undo_customer_merge(
  p_company_id uuid,
  p_merge_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_m public.customer_merges%ROWTYPE;
  v_invoices int;
  v_orders int;
  v_schedules int;
  v_deadlines int;
  v_sources int;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role <> 'viewer'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_FORBIDDEN');
  END IF;

  SELECT * INTO v_m FROM public.customer_merges
    WHERE id = p_merge_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_NOT_FOUND',
      'details', jsonb_build_object('merge_id', p_merge_id));
  END IF;
  IF v_m.undone_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_ALREADY_UNDONE',
      'details', jsonb_build_object('merge_id', p_merge_id));
  END IF;
  IF v_m.created_at < now() - interval '30 days' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_UNDO_EXPIRED',
      'details', jsonb_build_object('merge_id', p_merge_id));
  END IF;

  PERFORM 1 FROM public.customers
    WHERE company_id = p_company_id AND id IN (v_m.survivor_id, v_m.merged_id)
    ORDER BY id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.customer_merges l
             WHERE l.company_id = p_company_id AND l.merged_id = v_m.survivor_id
               AND l.undone_at IS NULL AND l.created_at >= v_m.created_at) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CUSTOMER_MERGE_UNDO_BLOCKED',
      'details', jsonb_build_object('merge_id', p_merge_id, 'customer_id', v_m.survivor_id));
  END IF;

  -- Only the rows this merge moved, and only while they still name the
  -- survivor: a row moved on since stays where it was put.
  WITH r AS (
    UPDATE public.invoices SET customer_id = v_m.merged_id
    WHERE company_id = p_company_id AND customer_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'invoices') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_invoices FROM r;
  WITH r AS (
    UPDATE public.sales_orders SET customer_id = v_m.merged_id
    WHERE company_id = p_company_id AND customer_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'sales_orders') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_orders FROM r;
  WITH r AS (
    UPDATE public.recurring_invoice_schedules SET customer_id = v_m.merged_id
    WHERE company_id = p_company_id AND customer_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'recurring_invoice_schedules') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_schedules FROM r;
  WITH r AS (
    UPDATE public.deadlines SET customer_id = v_m.merged_id
    WHERE company_id = p_company_id AND customer_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'deadlines') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_deadlines FROM r;
  WITH r AS (
    UPDATE public.migration_source_records SET target_id = v_m.merged_id
    WHERE company_id = p_company_id AND resource = 'customers' AND target_id = v_m.survivor_id
      AND id IN (SELECT (x)::uuid FROM jsonb_array_elements_text(v_m.moved->'migration_source_records') AS x)
    RETURNING 1)
  SELECT count(*) INTO v_sources FROM r;

  UPDATE public.customers SET archived_at = v_m.merged_archived_at
    WHERE id = v_m.merged_id AND company_id = p_company_id;
  UPDATE public.customer_merges SET undone_at = now(), undone_by = v_caller WHERE id = v_m.id;

  RETURN jsonb_build_object(
    'ok', true,
    'merge_id', v_m.id,
    'survivor_customer_id', v_m.survivor_id,
    'restored_customer_id', v_m.merged_id,
    'restored', jsonb_build_object('invoices', v_invoices, 'sales_orders', v_orders,
      'recurring_invoice_schedules', v_schedules, 'deadlines', v_deadlines, 'source_records', v_sources));
END;
$function$;

REVOKE ALL ON FUNCTION public.undo_customer_merge(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_customer_merge(uuid, uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.undo_customer_merge(uuid, uuid, uuid) IS
  'Within 30 days of a merge_customers merge: moves the rows it moved back to the merged card where they still name the survivor, restores the card''s archived_at and marks the merge undone.';

-- =============================================================================
-- 4. pending_operations.operation_type: 'merge_customers'
-- =============================================================================
-- Expanded from the constraint's current definition, read from the catalog
-- (the pattern of 20261022130100), never re-stated from a copy, so no value
-- main added is dropped again. Keep it in step with the risk-tier table in
-- lib/pending-operations/risk-tiers.ts. Validated right away: one migration
-- version, and the table is small enough that the scan is brief.

DO $$
DECLARE
  v_types text[];
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_types
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.pending_operations'::regclass
     AND c.conname = 'pending_operations_operation_type_check';
  IF v_types IS NULL OR cardinality(v_types) < 150 THEN
    RAISE EXCEPTION 'pending_operations_operation_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  IF NOT ('merge_customers' = ANY (v_types)) THEN
    v_types := v_types || 'merge_customers'::text;
  END IF;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;

-- =============================================================================
-- cleanup_sandbox_user: the customer merge log
-- =============================================================================
-- Rebuilt from 20261021120700_invoice_write_offs.sql (the latest definition).
-- The only change: customer_merges rows go before the companies delete, since
-- their survivor_id / merged_id references to customers are NO ACTION.

CREATE OR REPLACE FUNCTION public.cleanup_sandbox_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
  v_companies uuid[];
  v_company uuid;
BEGIN
  -- Verify this is a sandbox user: at least one settings row, and EVERY
  -- settings row flagged sandbox.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings cs WHERE cs.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  SELECT array_agg(cs.company_id ORDER BY cs.company_id) INTO v_companies
    FROM public.company_settings cs WHERE cs.user_id = p_user_id AND cs.is_sandbox IS TRUE;

  -- The account delete at the end cascades into every company the user
  -- created and every row they authored through a user_id foreign key, with
  -- the delete bypass set. Refuse while anything of theirs lives outside the
  -- sandbox set: a membership, a created company, or authored vouchers or
  -- documents (the BFL-retained rows a former membership can leave behind).
  IF EXISTS (SELECT 1 FROM public.company_members cm
             WHERE cm.user_id = p_user_id AND cm.company_id <> ALL (v_companies))
     OR EXISTS (SELECT 1 FROM public.companies c
                WHERE c.created_by = p_user_id AND c.id <> ALL (v_companies))
     OR EXISTS (SELECT 1 FROM public.journal_entries je
                WHERE je.user_id = p_user_id AND je.company_id <> ALL (v_companies))
     OR EXISTS (SELECT 1 FROM public.document_attachments d
                WHERE d.user_id = p_user_id AND d.company_id <> ALL (v_companies)) THEN
    RAISE EXCEPTION 'User % has data in a company that is not a sandbox', p_user_id;
  END IF;

  -- Serialize teardown with every worker before changing holds or receipts.
  FOREACH v_company IN ARRAY v_companies LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || v_company::text, 0));
    -- Pin the classification until teardown finishes. company_id is unique,
    -- but fail closed even if future schema changes permit conflicting rows.
    PERFORM 1 FROM public.company_settings cs WHERE cs.company_id = v_company FOR SHARE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.company_settings cs
      WHERE cs.company_id = v_company AND cs.is_sandbox IS NOT TRUE) THEN
      RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
    END IF;
  END LOOP;

  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

  -- SIE work state: remove the SIE-only blockers while the classification
  -- remains available to each retention guard, then release holds and the
  -- IB review pointers so the ordinary deletes below can run.
  DELETE FROM public.sie_duplicate_repair_items WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_import_chunks WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_period_read_leases WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET import_hold = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET opening_balance_review_import_id = NULL,
    opening_balance_review_token = NULL, opening_balance_review_entry_id = NULL,
    opening_balance_review_reason = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.sie_imports SET opening_balance_entry_id = NULL WHERE company_id = ANY(v_companies);

  -- The user's API keys die with the account; api_keys.sod_acknowledged_by
  -- (NO ACTION to auth.users) would otherwise block the account delete.
  DELETE FROM public.api_keys WHERE user_id = p_user_id OR company_id = ANY(v_companies);

  -- WORM logs and registers whose delete guard re-verifies sandbox-ness
  -- through company_settings: purged first, while it still exists.
  DELETE FROM public.dimension_retag_log WHERE company_id = ANY(v_companies);
  -- Kundförlust decisions (20261021120700): RESTRICT references to documents,
  -- vouchers, cases and invoices.
  DELETE FROM public.invoice_write_offs WHERE company_id = ANY(v_companies);
  -- Match log: some rows carry no company_id (lib/invoices/match-log.ts), so
  -- the user's own rows go too; purged before supplier_invoices because
  -- payment_match_log_supplier_invoice_id_fkey is ON DELETE SET NULL and the
  -- guard refuses that UPDATE even during teardown.
  DELETE FROM public.payment_match_log
  WHERE user_id = p_user_id OR company_id = ANY(v_companies);
  DELETE FROM public.journal_entry_rattelse_log WHERE company_id = ANY(v_companies);
  DELETE FROM public.account_reconciliation_attachments WHERE company_id = ANY(v_companies);
  -- signed_by is RESTRICT into auth.users.
  DELETE FROM public.account_reconciliations WHERE company_id = ANY(v_companies);
  -- Before documents: source_document_id is ON DELETE SET NULL and the guard
  -- refuses that UPDATE.
  DELETE FROM public.company_facts WHERE company_id = ANY(v_companies);
  -- Before journal entries: journal_entry_id is ON DELETE SET NULL and a
  -- booked trip refuses that UPDATE.
  DELETE FROM public.mileage_trips WHERE company_id = ANY(v_companies);
  -- Before fiscal periods (RESTRICT) and while the period rows still exist.
  DELETE FROM public.fiscal_period_tax_adjustments WHERE company_id = ANY(v_companies);

  -- Annual report: signature requests and submissions hold RESTRICT
  -- references to the versions, validation runs to versions and periods,
  -- versions to periods and the company.
  DELETE FROM public.arsredovisning_signature_requests WHERE company_id = ANY(v_companies);
  DELETE FROM public.annual_report_validation_runs WHERE company_id = ANY(v_companies);

  -- Documents: unlink from vouchers (block_document_deletion refuses a
  -- document on a posted voucher), detach the bank rows
  -- (transactions_document_id_fkey is RESTRICT; the detach is allowed once
  -- the document no longer sits on a voucher), then the deliveries that
  -- point at the sent PDF (RESTRICT, and block_sent_invoice_document_deletion),
  -- then the documents. The bank rows themselves stay for the companies
  -- cascade, as before: deleting them this early would rewrite every
  -- invoice and supplier invoice payment that points at one.
  -- Collected payments and settlements (20261021120000) hold RESTRICT
  -- references to their vouchers, archived documents, invoices, cases and
  -- connection: they go before all of those (the lines go with their
  -- settlement).
  DELETE FROM public.collection_collected_payments WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_settlements WHERE company_id = ANY(v_companies);
  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE company_id = ANY(v_companies);
  UPDATE public.transactions SET document_id = NULL
  WHERE company_id = ANY(v_companies) AND document_id IS NOT NULL;
  DELETE FROM public.invoice_deliveries WHERE company_id = ANY(v_companies);
  DELETE FROM public.document_attachments WHERE company_id = ANY(v_companies);

  -- Salary payment file archive (20260919105035): WORM with a teardown
  -- bypass that re-verifies through company_settings, and RESTRICT on
  -- salary_runs.
  DELETE FROM public.salary_payment_files WHERE company_id = ANY(v_companies);

  -- Registers that point at vouchers with RESTRICT or NO ACTION.
  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE company_id = ANY(v_companies);
  -- fiscal_periods points at its IB and bokslut vouchers with NO ACTION FKs,
  -- and previous_period_id chains periods to each other the same way.
  UPDATE public.fiscal_periods
  SET opening_balance_entry_id = NULL,
      closing_entry_id = NULL,
      previous_period_id = NULL
  WHERE company_id = ANY(v_companies);
  -- Posted depreciation (RESTRICT; block_posted_depreciation_schedule_delete
  -- honours gnubok.allow_delete) and disposals (assets.disposal_journal_entry_id,
  -- RESTRICT). The schedules go first, then the register rows.
  DELETE FROM public.depreciation_schedules WHERE company_id = ANY(v_companies);
  DELETE FROM public.assets WHERE company_id = ANY(v_companies);
  DELETE FROM public.accrual_schedule_installments WHERE company_id = ANY(v_companies);
  DELETE FROM public.accrual_schedules WHERE company_id = ANY(v_companies);
  DELETE FROM public.vacation_year_closures WHERE company_id = ANY(v_companies);
  DELETE FROM public.agi_declarations WHERE company_id = ANY(v_companies);
  DELETE FROM public.stripe_payment_events WHERE company_id = ANY(v_companies);
  DELETE FROM public.stripe_payouts WHERE company_id = ANY(v_companies);
  DELETE FROM public.webshop_orders WHERE company_id = ANY(v_companies);

  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT je.id FROM public.journal_entries je WHERE je.company_id = ANY(v_companies)
  );
  DELETE FROM public.journal_entries WHERE company_id = ANY(v_companies);

  -- Betalfil batches: their items reference supplier_invoices with
  -- ON DELETE RESTRICT, so the batch headers go first (the items cascade).
  DELETE FROM public.supplier_payment_batches WHERE company_id = ANY(v_companies);
  -- Bokio supplier completion: entries hold NO ACTION references to the
  -- supplier invoices and to the work row, the work row to the company.
  DELETE FROM public.bokio_supplier_completion_entries WHERE company_id = ANY(v_companies);
  DELETE FROM public.bokio_supplier_completion_work WHERE company_id = ANY(v_companies);
  DELETE FROM public.supplier_invoices WHERE company_id = ANY(v_companies);

  -- Collections cases (20261012030200): the case trail is append-only and
  -- its teardown window re-verifies through company_settings, so it goes
  -- while those rows exist. The cases hold RESTRICT references to invoices
  -- and connections (deleted further down) and point at pending operations
  -- with SET NULL, so they go before all three.
  -- Payment forwards (20261012030400): a RESTRICT reference to their case,
  -- so they go first.
  DELETE FROM public.collection_payment_forwards WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_case_events WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_cases WHERE company_id = ANY(v_companies);

  DELETE FROM public.pending_operations WHERE company_id = ANY(v_companies);
  DELETE FROM public.dimensions WHERE company_id = ANY(v_companies);

  -- Journal references are gone. Delete import rows explicitly instead of
  -- relying on the cascade, whose settings-delete order is unknown.
  DELETE FROM public.sie_imports WHERE company_id = ANY(v_companies);
  -- Durable SIE jobs project terminal API operations: guarded, re-verified
  -- through company_settings.
  DELETE FROM public.operations WHERE company_id = ANY(v_companies);
  -- NO ACTION to companies, no cascade.
  DELETE FROM public.processing_history WHERE company_id = ANY(v_companies);
  -- Terminal webhook deliveries: guarded against DELETE.
  DELETE FROM public.webhook_deliveries WHERE company_id = ANY(v_companies);

  -- Rows that the companies cascade would otherwise reach in an order
  -- decided by trigger names: each holds a RESTRICT or NO ACTION reference
  -- to another row of the same company.
  DELETE FROM public.salary_line_items WHERE company_id = ANY(v_companies);
  DELETE FROM public.salary_payslip_deliveries WHERE company_id = ANY(v_companies);
  DELETE FROM public.salary_payslip_links WHERE company_id = ANY(v_companies);
  DELETE FROM public.salary_run_employees WHERE company_id = ANY(v_companies);
  DELETE FROM public.rot_rut_payout_request_items
  WHERE request_id IN (
    SELECT r.id FROM public.rot_rut_payout_requests r WHERE r.company_id = ANY(v_companies)
  );
  DELETE FROM public.recurring_invoice_schedules WHERE company_id = ANY(v_companies);
  -- Payment rows (20261012030300): a collected payment's delete guard
  -- re-verifies the sandbox through company_settings, so they go explicitly
  -- before the invoices cascade would take them.
  DELETE FROM public.invoice_payments WHERE company_id = ANY(v_companies);
  -- Customer merge log (20261023003000): NO ACTION references to both
  -- cards, so it goes before the companies cascade takes the customers.
  DELETE FROM public.customer_merges WHERE company_id = ANY(v_companies);
  DELETE FROM public.invoices WHERE company_id = ANY(v_companies);
  DELETE FROM public.deadlines WHERE company_id = ANY(v_companies);
  DELETE FROM public.tax_assessment_notices WHERE company_id = ANY(v_companies);
  DELETE FROM public.annual_report_versions WHERE company_id = ANY(v_companies);
  DELETE FROM public.migration_job_chunks WHERE company_id = ANY(v_companies);
  DELETE FROM public.migration_jobs WHERE company_id = ANY(v_companies);
  DELETE FROM public.migration_source_records WHERE company_id = ANY(v_companies);

  -- Collections connections (20261012030100): the event trail is append-only
  -- and its teardown window re-verifies through company_settings, so it goes
  -- while those rows exist; the connections follow it.
  DELETE FROM public.collection_connection_events WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_connections WHERE company_id = ANY(v_companies);

  DELETE FROM public.audit_log WHERE company_id = ANY(v_companies);

  -- The companies themselves, before the account: every company-scoped row
  -- that references auth.users is gone before the account delete checks it.
  DELETE FROM public.companies WHERE id = ANY(v_companies);

  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM set_config('gnubok.allow_delete', '', true);
  PERFORM set_config('gnubok.sandbox_cleanup', '', true);

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_sandbox_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
