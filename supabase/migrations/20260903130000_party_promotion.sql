-- Parties, phase 1g: a suggestion is confirmed INTO a role.
--
-- Founder decision 2026-09-03: users know two words, kund and leverantör,
-- and a "kontakt" with no role is a state nobody has seen in Fortnox or
-- Bokio. Confirming a suggestion therefore creates the supplier and/or
-- customer row straight away, filled from what the documents said (org
-- number, VAT number, bankgiro, plusgiro). The party model stays underneath
-- unchanged: the role rows link to the party through party_id and the
-- role-link trigger; the register the user sees is Leverantörer and Kunder.
--
--   promote_parties(company, user, items)   items: [{party_id, roles: [...]}]
--   undo_party_promotions(company, user, party_ids)   within 30 days
--
-- Undo archives the role rows the promotion created (archived_at, and
-- is_active = false on suppliers, the same state the v1 API's archive
-- leaves) and puts the party back in the queue. Rows the promotion did not
-- create are left alone.

CREATE OR REPLACE FUNCTION public.promote_parties(
  p_company_id uuid,
  p_user_id uuid,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_item jsonb;
  v_party public.parties%ROWTYPE;
  v_roles text[];
  v_supplier_id uuid;
  v_customer_id uuid;
  v_created text[];
  v_bankgiro text;
  v_plusgiro text;
  v_suppliers integer := 0;
  v_customers integer := 0;
  v_parties integer := 0;
  v_supplier_type text;
  v_customer_type text;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'promote_parties: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'promote_parties: p_items must be a JSON array' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_roles := ARRAY(SELECT DISTINCT r FROM jsonb_array_elements_text(coalesce(v_item->'roles', '[]'::jsonb)) AS r WHERE r IN ('supplier', 'customer'));
    IF coalesce(array_length(v_roles, 1), 0) = 0 THEN
      RAISE EXCEPTION 'promote_parties: every item needs at least one of supplier, customer' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_party FROM public.parties
    WHERE id = (v_item->>'party_id')::uuid AND company_id = p_company_id AND merged_into IS NULL AND archived_at IS NULL
    FOR UPDATE;
    IF v_party.id IS NULL THEN
      RAISE EXCEPTION 'promote_parties: party % is not a live party of this company', v_item->>'party_id' USING ERRCODE = '23503';
    END IF;

    v_created := '{}';
    SELECT s.id INTO v_supplier_id FROM public.suppliers s
    WHERE s.company_id = p_company_id AND s.party_id = v_party.id AND s.archived_at IS NULL
    ORDER BY s.created_at LIMIT 1;
    SELECT c.id INTO v_customer_id FROM public.customers c
    WHERE c.company_id = p_company_id AND c.party_id = v_party.id AND c.archived_at IS NULL
    ORDER BY c.created_at LIMIT 1;

    SELECT i.value INTO v_bankgiro FROM public.party_identities i
    WHERE i.party_id = v_party.id AND i.scheme = 'bankgiro' ORDER BY i.seen_count DESC, i.last_seen DESC NULLS LAST LIMIT 1;
    SELECT i.value INTO v_plusgiro FROM public.party_identities i
    WHERE i.party_id = v_party.id AND i.scheme = 'plusgiro' ORDER BY i.seen_count DESC, i.last_seen DESC NULLS LAST LIMIT 1;

    -- Type from the numbers we hold: a Swedish org number means a Swedish
    -- business; an EU VAT number without one means an EU business; nothing
    -- means we do not know, and swedish_business is the form's own default.
    v_supplier_type := CASE
      WHEN v_party.org_number IS NOT NULL THEN 'swedish_business'
      WHEN v_party.vat_number IS NOT NULL AND v_party.vat_number !~* '^SE' THEN 'eu_business'
      ELSE 'swedish_business' END;
    v_customer_type := CASE
      WHEN v_party.kind = 'person' THEN 'individual'
      ELSE v_supplier_type END;

    IF 'supplier' = ANY(v_roles) AND v_supplier_id IS NULL THEN
      INSERT INTO public.suppliers (company_id, user_id, name, supplier_type, org_number, vat_number, bankgiro, plusgiro, party_id)
      VALUES (p_company_id, p_user_id, v_party.display_name, v_supplier_type, v_party.org_number, v_party.vat_number, v_bankgiro, v_plusgiro, v_party.id)
      RETURNING id INTO v_supplier_id;
      v_created := array_append(v_created, 'supplier');
      v_suppliers := v_suppliers + 1;
    END IF;
    IF 'customer' = ANY(v_roles) AND v_customer_id IS NULL THEN
      INSERT INTO public.customers (company_id, user_id, name, customer_type, org_number, vat_number, party_id)
      VALUES (p_company_id, p_user_id, v_party.display_name, v_customer_type, v_party.org_number, v_party.vat_number, v_party.id)
      RETURNING id INTO v_customer_id;
      v_created := array_append(v_created, 'customer');
      v_customers := v_customers + 1;
    END IF;

    UPDATE public.parties SET status = 'confirmed', suggested_reason = NULL WHERE id = v_party.id;
    v_parties := v_parties + 1;

    INSERT INTO public.party_decisions (party_id, company_id, user_id, kind, before, after, note)
    VALUES (v_party.id, p_company_id, p_user_id, 'role',
            jsonb_build_object('status', v_party.status, 'suggested_reason', v_party.suggested_reason),
            jsonb_build_object('status', 'confirmed', 'roles', to_jsonb(v_roles), 'created', to_jsonb(v_created),
                               'supplier_id', v_supplier_id, 'customer_id', v_customer_id),
            NULL);
  END LOOP;

  RETURN jsonb_build_object('parties', v_parties, 'suppliers', v_suppliers, 'customers', v_customers);
END;
$$;

REVOKE ALL ON FUNCTION public.promote_parties(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promote_parties(uuid, uuid, jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION public.promote_parties(uuid, uuid, jsonb) IS
  'Confirms suggested parties into roles: creates the supplier and/or customer row from the party''s facts (no duplicate when a live role row already points at the party), sets status confirmed, logs a role decision. Undo through undo_party_promotions within 30 days.';

CREATE OR REPLACE FUNCTION public.undo_party_promotions(
  p_company_id uuid,
  p_user_id uuid,
  p_party_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'undo_party_promotions: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;

  WITH latest AS (
    SELECT DISTINCT ON (d.party_id) d.id, d.party_id, d.kind, d.before, d.after, d.created_at
    FROM public.party_decisions d
    WHERE d.company_id = p_company_id AND d.party_id = ANY(p_party_ids)
    ORDER BY d.party_id, d.created_at DESC, d.id DESC
  ),
  eligible AS (
    SELECT l.* FROM latest l WHERE l.kind = 'role' AND l.created_at >= now() - interval '30 days'
  ),
  archived_suppliers AS (
    UPDATE public.suppliers s
    SET archived_at = now(), is_active = false
    FROM eligible e
    WHERE s.company_id = p_company_id AND s.id = (e.after->>'supplier_id')::uuid
      AND e.after->'created' ? 'supplier' AND s.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.supplier_invoices si WHERE si.supplier_id = s.id)
    RETURNING s.id
  ),
  archived_customers AS (
    UPDATE public.customers c
    SET archived_at = now()
    FROM eligible e
    WHERE c.company_id = p_company_id AND c.id = (e.after->>'customer_id')::uuid
      AND e.after->'created' ? 'customer' AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.customer_id = c.id)
    RETURNING c.id
  ),
  reverted AS (
    UPDATE public.parties p
    SET status = 'suggested', suggested_reason = e.before->'suggested_reason'
    FROM eligible e
    WHERE p.id = e.party_id AND p.company_id = p_company_id AND p.merged_into IS NULL
    RETURNING p.id, e.id AS decision_id
  ),
  logged AS (
    INSERT INTO public.party_decisions (party_id, company_id, user_id, kind, before, after, note)
    SELECT r.id, p_company_id, p_user_id, 'undo',
           jsonb_build_object('decision_id', r.decision_id, 'kind', 'role'),
           jsonb_build_object('status', 'suggested',
                              'archived_suppliers', (SELECT count(*) FROM archived_suppliers),
                              'archived_customers', (SELECT count(*) FROM archived_customers)),
           'undo role'
    FROM reverted r
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM logged;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.undo_party_promotions(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_party_promotions(uuid, uuid, uuid[]) TO authenticated, service_role;
COMMENT ON FUNCTION public.undo_party_promotions(uuid, uuid, uuid[]) IS
  'Reverses the latest promotion per party within 30 days: archives the supplier/customer rows that promotion created (unless invoices already point at them), returns the party to the queue with its reason, logs an undo decision.';

NOTIFY pgrst, 'reload schema';
