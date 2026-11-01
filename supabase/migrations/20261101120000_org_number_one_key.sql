-- One key for a Swedish org or personal number, in SQL as in TypeScript.
--
-- lib/invariants/org-number.ts holds the rule: any written form reduces to one
-- 10-digit key, a 12-digit form only from a 16, 18, 19 or 20 century, because
-- the last 10 digits of any other 12-digit value are somebody else's number
-- (556012579001 is a VAT number, its tail is not a company). The SQL side had
-- three other readings of that rule. normalize_org_number cut any 12 digits, so
-- 83 + a real number wrote that real number onto parties.org_number. The
-- provider migration compared letters and digits, so one customer written in
-- 10 and in 12 digits came in as two cards. The card merge cut any 12 digits,
-- though its comment cited orgNumberKey.
--
-- Applies from now on. Nothing stored changes: no row here is rewritten.

-- orgNumberKey in lib/invariants/org-number.ts. tests/pg/org-number-key.pg.test.ts
-- runs one table of written forms through both. One expression and no SET, so
-- the planner inlines it: the migration compares it against every card of a
-- company, for every party it brings in.
CREATE OR REPLACE FUNCTION public.org_number_key(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT substring(
    regexp_replace(regexp_replace(raw, '[[:space:]-]', '', 'g'), '^([0-9]{6})\+([0-9]{4})$', '\1\2')
    FROM '^(?:16|18|19|20)?([0-9]{10})$'
  )
$$;

-- partyOrgKey in lib/invariants/org-number.ts: what decides that two register
-- cards are one party. A foreign number keeps its country: BE0123456789 and
-- FR0123456789 are two parties.
CREATE OR REPLACE FUNCTION public.party_org_key(raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(public.org_number_key(raw), NULLIF(upper(regexp_replace(raw, '[^0-9A-Za-z]', '', 'g')), ''))
$$;

GRANT EXECUTE ON FUNCTION public.org_number_key(text), public.party_org_key(text) TO authenticated, service_role;

-- normalize_org_number: orgNumberKey plus the Luhn check digit, as
-- normalizeOrgNumber in TypeScript. Every caller (link_party_on_role_write, the
-- party suggestions) keeps its signature.
CREATE OR REPLACE FUNCTION public.normalize_org_number(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  cleaned text := public.org_number_key(raw);
  total int := 0;
  dg int;
  i int;
BEGIN
  IF cleaned IS NULL THEN RETURN NULL; END IF;
  -- Luhn over the 10 digits, rightmost digit weight 1, then alternating 2/1.
  FOR i IN 1..10 LOOP
    dg := substr(reverse(cleaned), i, 1)::int;
    IF i % 2 = 0 THEN
      dg := dg * 2;
      IF dg > 9 THEN dg := dg - 9; END IF;
    END IF;
    total := total + dg;
  END LOOP;
  IF total % 10 <> 0 THEN RETURN NULL; END IF;
  RETURN cleaned;
END;
$$;

-- resolve_provider_migration_party: copied from
-- 20260919154319_provider_migration_party_identity.sql, one edit: the verified
-- organization identity compares by party_org_key, so 10 and 12 digits of one
-- number adopt the same card.
CREATE OR REPLACE FUNCTION public.resolve_provider_migration_party(p_job_id uuid,p_resource text,p_source_id text,p_row jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; target uuid; candidates uuid[]; tbl text; row_data jsonb;
BEGIN
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id;
  IF p_resource NOT IN ('customers','suppliers') OR NULLIF(p_source_id,'') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_PARTY_ID_MISSING'; END IF;
  tbl:=p_resource;
  SELECT target_id INTO target FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
    AND account_key=j.account_key AND resource=p_resource AND source_id=p_source_id;
  IF target IS NOT NULL THEN
    EXECUTE format('SELECT array_agg(id) FROM public.%I WHERE id=$1 AND company_id=$2',tbl)
      INTO candidates USING target,j.company_id;
    IF candidates IS NULL THEN RAISE EXCEPTION 'MIGRATION_PARTY_CHANGED'; END IF;
    RETURN target;
  END IF;
  -- Adopt a legacy/native party only with a verified organization identity.
  -- A display name alone is not identity, even when it matches only one row.
  -- Exact provider IDs remain authoritative on every subsequent retry.
  EXECUTE format('SELECT array_agg(id) FROM (SELECT id FROM public.%I p WHERE company_id=$1
    AND public.party_org_key(org_number)=public.party_org_key($2->>''org_number'')
    AND ($6 OR NOT EXISTS(SELECT 1 FROM migration_source_records m WHERE m.company_id=$1 AND m.resource=$3
      AND m.provider=$4 AND m.account_key=$5 AND m.target_id=p.id AND m.source_id NOT LIKE ''invoice-party:%%''))
    LIMIT 2) candidates',tbl)
    INTO candidates USING j.company_id,p_row,p_resource,j.provider,j.account_key,p_source_id LIKE 'invoice-party:%';
  IF cardinality(candidates)>1 THEN RAISE EXCEPTION 'MIGRATION_PARTY_AMBIGUOUS'; END IF;
  target:=candidates[1];
  IF target IS NULL THEN
    row_data:=p_row||jsonb_build_object('company_id',j.company_id,'user_id',j.user_id);
    target:=insert_provider_migration_row(tbl,row_data);
  END IF;
  INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
    VALUES(j.company_id,j.user_id,j.provider,j.account_key,p_resource,p_source_id,target);
  RETURN target;
END $$;

-- customer_merge_preview: copied from 20261027130000_invoicer_company_role.sql,
-- one edit: the org number keys by party_org_key. 83 + a number and that number
-- are two identities, and the merge says so.
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
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role NOT IN ('viewer', 'invoicer')
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

  -- An org number keys by public.party_org_key (lib/invariants/org-number.ts
  -- partyOrgKey); a VAT number by its letters and digits, upper case.
  v_survivor_org := public.party_org_key(v_survivor.org_number);
  v_survivor_vat := NULLIF(upper(regexp_replace(COALESCE(v_survivor.vat_number, ''), '[^0-9A-Za-z]', '', 'g')), '');

  FOR v_card IN SELECT * FROM public.customers
      WHERE company_id = p_company_id AND id = ANY (v_ids) ORDER BY created_at, id LOOP
    v_key := public.party_org_key(v_card.org_number);
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

NOTIFY pgrst, 'reload schema';
