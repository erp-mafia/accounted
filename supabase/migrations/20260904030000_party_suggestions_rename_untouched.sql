-- Parties: a later suggestion run may rename an untouched suggestion.
--
-- apply_party_suggestions only ever added aliases, hard keys and facts to an
-- existing party, never a name, so a suggestion made before the legal-form
-- anchoring (feat/parties-name-extract) kept its sentence-long or bank-memo
-- name for good: on 2026-09-04 that was 4 rows in one company and 510 in
-- another. Now an item whose display name is anchored on a legal form read
-- out of the voucher text (name_anchored) renames a party that is still a
-- suggestion nobody has touched: no decision, no user or registry fact.
-- Confirmed parties, decided ones and names a person or a register gave are
-- never renamed. The summary gains 'renamed'.

CREATE OR REPLACE FUNCTION public.apply_party_suggestions(
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
  v_fact jsonb;
  v_ident jsonb;
  v_party_id uuid;
  v_key text;
  v_org text;
  v_vat text;
  v_aliases text[];
  v_created integer := 0;
  v_attached integer := 0;
  v_identities integer := 0;
  v_facts integer := 0;
  v_seen integer;
  v_rename boolean;
  v_renamed integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'apply_party_suggestions: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'apply_party_suggestions: p_items must be a JSON array' USING ERRCODE = '22023';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_key := nullif(btrim(coalesce(v_item->>'key', '')), '');
    IF v_key IS NULL THEN
      RAISE EXCEPTION 'apply_party_suggestions: every item needs a key' USING ERRCODE = '22023';
    END IF;
    v_org := public.normalize_org_number(v_item->>'org_number');
    v_vat := nullif(upper(regexp_replace(coalesce(v_item->>'vat_number', ''), '[^0-9A-Za-z]', '', 'g')), '');
    v_aliases := ARRAY(SELECT DISTINCT x FROM (
      SELECT v_key AS x UNION ALL SELECT jsonb_array_elements_text(coalesce(v_item->'alias_keys', '[]'::jsonb))
    ) a WHERE x IS NOT NULL AND btrim(x) <> '');

    v_party_id := NULL;
    IF v_item->>'party_id' IS NOT NULL THEN
      SELECT id INTO v_party_id FROM public.parties
      WHERE id = (v_item->>'party_id')::uuid AND company_id = p_company_id AND merged_into IS NULL;
      IF v_party_id IS NULL THEN
        RAISE EXCEPTION 'apply_party_suggestions: party % is not a live party of this company', v_item->>'party_id'
          USING ERRCODE = '23503';
      END IF;
    END IF;
    IF v_party_id IS NULL AND v_org IS NOT NULL THEN
      SELECT id INTO v_party_id FROM public.parties
      WHERE company_id = p_company_id AND org_number = v_org AND merged_into IS NULL;
    END IF;
    -- A VAT number is a hard key too: foreign suppliers (Framer B.V.,
    -- Anthropic Ireland) never carry a Swedish org number, and three keys for
    -- one Dutch company made three suggestions on 2026-09-03.
    IF v_party_id IS NULL AND v_vat IS NOT NULL THEN
      SELECT id INTO v_party_id FROM public.parties
      WHERE company_id = p_company_id AND merged_into IS NULL
        AND upper(regexp_replace(coalesce(vat_number, ''), '[^0-9A-Za-z]', '', 'g')) = v_vat
      ORDER BY (status = 'confirmed') DESC, created_at
      LIMIT 1;
    END IF;
    IF v_party_id IS NULL THEN
      SELECT id INTO v_party_id FROM public.parties
      WHERE company_id = p_company_id AND merged_into IS NULL AND alias_keys @> ARRAY[v_key]
      ORDER BY (status = 'confirmed') DESC, created_at
      LIMIT 1;
    END IF;

    IF v_party_id IS NULL THEN
      INSERT INTO public.parties (company_id, user_id, display_name, legal_name, kind, status, org_number, vat_number, alias_keys, origin, suggested_reason)
      VALUES (
        p_company_id, p_user_id,
        coalesce(nullif(btrim(v_item->>'display_name'), ''), v_key),
        nullif(btrim(v_item->>'legal_name'), ''),
        coalesce(v_item->>'kind', 'company'),
        'suggested',
        v_org,
        nullif(btrim(v_item->>'vat_number'), ''),
        v_aliases,
        coalesce(v_item->>'origin', 'ledger'),
        v_item->'reason'
      )
      ON CONFLICT DO NOTHING
      RETURNING id INTO v_party_id;
      IF v_party_id IS NULL THEN
        -- Lost a race on (company_id, org_number): attach to the winner.
        SELECT id INTO v_party_id FROM public.parties
        WHERE company_id = p_company_id AND org_number = v_org AND merged_into IS NULL;
        v_attached := v_attached + 1;
      ELSE
        v_created := v_created + 1;
      END IF;
    ELSE
      v_attached := v_attached + 1;
      -- An untouched suggestion (no decision, no user or registry fact) takes
      -- a better name from a later run when that name is anchored on a legal
      -- form read out of the voucher text; a cleaned bank memo never
      -- replaces anything. Names a person or a register gave stay.
      v_rename := coalesce((v_item->>'name_anchored')::boolean, false)
        AND nullif(btrim(v_item->>'display_name'), '') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.parties p
          WHERE p.id = v_party_id AND p.status = 'suggested'
            AND p.display_name IS DISTINCT FROM btrim(v_item->>'display_name')
            AND NOT EXISTS (SELECT 1 FROM public.party_decisions d WHERE d.party_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM public.party_facts f WHERE f.party_id = p.id AND f.source IN ('user', 'registry_scb', 'registry_tic', 'vies', 'peppol'))
        );
      UPDATE public.parties
      SET alias_keys = ARRAY(SELECT DISTINCT x FROM unnest(alias_keys || v_aliases) AS x),
          vat_number = coalesce(vat_number, nullif(btrim(v_item->>'vat_number'), '')),
          legal_name = coalesce(legal_name, nullif(btrim(v_item->>'legal_name'), '')),
          org_number = coalesce(org_number, v_org),
          display_name = CASE WHEN v_rename THEN btrim(v_item->>'display_name') ELSE display_name END
      WHERE id = v_party_id
        AND (NOT (alias_keys @> v_aliases)
             OR v_rename
             OR (vat_number IS NULL AND nullif(btrim(v_item->>'vat_number'), '') IS NOT NULL)
             OR (legal_name IS NULL AND nullif(btrim(v_item->>'legal_name'), '') IS NOT NULL)
             OR (org_number IS NULL AND v_org IS NOT NULL));
      IF v_rename THEN v_renamed := v_renamed + 1; END IF;
    END IF;

    FOR v_ident IN SELECT * FROM jsonb_array_elements(coalesce(v_item->'identities', '[]'::jsonb)) LOOP
      v_seen := greatest(coalesce((v_ident->>'seen_count')::integer, 1), 1);
      INSERT INTO public.party_identities (party_id, company_id, user_id, scheme, value, status, source, first_seen, last_seen, seen_count)
      VALUES (
        v_party_id, p_company_id, p_user_id,
        v_ident->>'scheme', v_ident->>'value',
        CASE WHEN v_seen >= 2 THEN 'known' ELSE 'unverified' END,
        coalesce(v_ident->>'source', 'document'),
        (v_ident->>'first_seen')::date, (v_ident->>'last_seen')::date, v_seen
      )
      ON CONFLICT (party_id, scheme, value) DO UPDATE
        SET seen_count = greatest(party_identities.seen_count, EXCLUDED.seen_count),
            first_seen = least(party_identities.first_seen, EXCLUDED.first_seen),
            last_seen = greatest(party_identities.last_seen, EXCLUDED.last_seen),
            status = CASE WHEN greatest(party_identities.seen_count, EXCLUDED.seen_count) >= 2 THEN 'known' ELSE party_identities.status END
        WHERE party_identities.seen_count < EXCLUDED.seen_count
           OR party_identities.last_seen IS DISTINCT FROM greatest(party_identities.last_seen, EXCLUDED.last_seen)
           OR party_identities.first_seen IS DISTINCT FROM least(party_identities.first_seen, EXCLUDED.first_seen);
      v_identities := v_identities + 1;
    END LOOP;

    FOR v_fact IN SELECT * FROM jsonb_array_elements(coalesce(v_item->'facts', '[]'::jsonb)) LOOP
      INSERT INTO public.party_facts (party_id, company_id, user_id, field, value, source, reference)
      SELECT v_party_id, p_company_id, p_user_id, v_fact->>'field', v_fact->'value', v_fact->>'source', v_fact->'reference'
      WHERE NOT EXISTS (
        SELECT 1 FROM public.party_facts f
        WHERE f.party_id = v_party_id AND f.field = v_fact->>'field' AND f.source = v_fact->>'source'
          AND f.value = v_fact->'value' AND f.superseded_at IS NULL
      );
      IF FOUND THEN v_facts := v_facts + 1; END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('created', v_created, 'attached', v_attached, 'identities', v_identities, 'facts', v_facts, 'renamed', v_renamed);
END;
$$;

NOTIFY pgrst, 'reload schema';
