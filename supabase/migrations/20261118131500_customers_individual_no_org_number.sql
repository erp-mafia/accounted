-- The database refuses an org number on a private person's customer card.
-- pg-test: tests/pg/customers-individual-no-org-number.pg.test.ts
--
-- A privatperson has no org number. Its identifier is the personnummer, held
-- AES-256-GCM encrypted in customers.personal_number and masked on every
-- read. org_number is plain text and shown in full, so a personnummer there
-- is personal data in the clear. The rule lived only in application code,
-- one copy per write path, and the paths that lacked a copy (the MCP create
-- tool before 2026-08-21, the CSV register import until 2026-10-05) wrote
-- the personnummer into org_number. The one-off repair
-- (/api/customers/personal-number-repair/cron) sealed 730 such cards in
-- production on 2026-10-29 and 2026-10-30 and has written nothing since; on
-- 2026-11-18 none of the 46,078 individual cards holds an org number.
--
-- The application rule stays, so a person still gets the Swedish message
-- before the write. This CHECK is what holds for every writer, present and
-- future: a new route, a script, an RPC, SQL typed by hand.
--
-- An org_number that is empty, or holds only spaces, tabs or line breaks,
-- counts as none: the write paths trim before they judge it, and a blank can
-- be stored as it came. Anything else on an individual is refused.
-- customer_type defaults to 'individual', so an INSERT that names an org
-- number and no type is refused too: a card with an org number says what
-- kind of business it is.
--
-- promote_parties is the one writer found that could still produce the
-- state. It typed the new customer card from the party's kind alone, and a
-- person party can hold an org number: it learns one when its card becomes
-- a business (a sole trader, whose org number is the owner's personnummer)
-- or when the user picks a company for it in the register lookup, and its
-- kind stays person. Promoting that party to a customer, once it has
-- no live card, made an individual card with the number in plain text. The
-- function now reads the number first: a party that holds one becomes a
-- business card. Everything else in it is the definition of 20260903183000.
--
-- NOT VALID: the constraint holds every INSERT and UPDATE from now on
-- without scanning the table, so adding it cannot fail on a database that
-- still holds such rows (a self-hosted one where the repair has not run, or
-- left a number that is not a personnummer for a person to decide). There a
-- violating row accepts only a write that also clears its org_number, which
-- is what the repair does. 20261118131600 validates the constraint where no
-- row violates it.

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

    -- Identities are stored as digits; the supplier form writes them the way
    -- they are printed (5317-0900, 12 34 56-7 style plusgiro as 123456-7).
    SELECT CASE WHEN length(i.value) IN (7, 8) THEN left(i.value, length(i.value) - 4) || '-' || right(i.value, 4) ELSE i.value END
      INTO v_bankgiro FROM public.party_identities i
    WHERE i.party_id = v_party.id AND i.scheme = 'bankgiro' ORDER BY i.seen_count DESC, i.last_seen DESC NULLS LAST LIMIT 1;
    SELECT CASE WHEN length(i.value) >= 2 THEN left(i.value, length(i.value) - 1) || '-' || right(i.value, 1) ELSE i.value END
      INTO v_plusgiro FROM public.party_identities i
    WHERE i.party_id = v_party.id AND i.scheme = 'plusgiro' ORDER BY i.seen_count DESC, i.last_seen DESC NULLS LAST LIMIT 1;

    -- Type from the numbers we hold: a Swedish org number means a Swedish
    -- business; an EU VAT number without one means an EU business; nothing
    -- means we do not know, and swedish_business is the form's own default.
    v_supplier_type := CASE
      WHEN v_party.org_number IS NOT NULL THEN 'swedish_business'
      WHEN v_party.vat_number IS NOT NULL AND v_party.vat_number !~* '^SE' THEN 'eu_business'
      ELSE 'swedish_business' END;
    -- A party that holds an org number is a business, whatever its kind says:
    -- a person party gets a number from a business card or a supplier
    -- (link_party_on_role_write) or from the register lookup, typically a
    -- sole trader, whose org number is the owner's personnummer. A private
    -- person's card holds none (customers_individual_no_org_number), so only
    -- a person party without a number becomes an individual.
    v_customer_type := CASE
      WHEN v_party.kind = 'person' AND v_party.org_number IS NULL THEN 'individual'
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

-- customers is read on every invoice page: fail the migration job instead of
-- queueing those reads behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.customers
  ADD CONSTRAINT customers_individual_no_org_number
  CHECK (customer_type <> 'individual' OR btrim(coalesce(org_number, ''), E' \t\n\r') = '')
  NOT VALID;

COMMENT ON CONSTRAINT customers_individual_no_org_number ON public.customers IS
  'A private person has no org number: the personnummer is held encrypted in personal_number. An org_number that is empty or only whitespace counts as none.';

NOTIFY pgrst, 'reload schema';
