-- Parties, phase 3 start: one way to write facts from a registry.
--
-- record_party_facts(company, user, party, source, facts, fetched_at)
--   facts: [{field, value, reference?, valid_from?, valid_to?}]
--
-- Facts are statements with provenance and time (plan section 05). A new
-- statement for the same field from the same source supersedes the old one
-- only when the value changed: an unchanged value just refreshes fetched_at,
-- so "SCB · 2026-09-03" on the dossier means "checked then", not "changed
-- then". Facts from other sources (document, user) are never touched: the
-- dossier shows every source side by side and the survivorship chain
-- (user > registry > document > bank > ledger > model) decides what leads.

CREATE OR REPLACE FUNCTION public.record_party_facts(
  p_company_id uuid,
  p_user_id uuid,
  p_party_id uuid,
  p_source text,
  p_facts jsonb,
  p_fetched_at timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_fact jsonb;
  v_field text;
  v_existing_id uuid;
  v_existing_value jsonb;
  v_inserted integer := 0;
  v_superseded integer := 0;
  v_refreshed integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'record_party_facts: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;
  IF p_source NOT IN ('user', 'registry_scb', 'registry_tic', 'vies', 'peppol', 'document', 'bank', 'ledger', 'model') THEN
    RAISE EXCEPTION 'record_party_facts: unknown source %', p_source USING ERRCODE = '22023';
  END IF;
  IF p_facts IS NULL OR jsonb_typeof(p_facts) <> 'array' THEN
    RAISE EXCEPTION 'record_party_facts: p_facts must be a JSON array' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.parties p WHERE p.id = p_party_id AND p.company_id = p_company_id AND p.merged_into IS NULL) THEN
    RAISE EXCEPTION 'record_party_facts: party % is not a live party of this company', p_party_id USING ERRCODE = '23503';
  END IF;

  FOR v_fact IN SELECT * FROM jsonb_array_elements(p_facts) LOOP
    v_field := nullif(btrim(coalesce(v_fact->>'field', '')), '');
    IF v_field IS NULL OR length(v_field) > 64 THEN
      RAISE EXCEPTION 'record_party_facts: every fact needs a field of at most 64 characters' USING ERRCODE = '22023';
    END IF;

    SELECT f.id, f.value INTO v_existing_id, v_existing_value
    FROM public.party_facts f
    WHERE f.party_id = p_party_id AND f.company_id = p_company_id AND f.field = v_field AND f.source = p_source AND f.superseded_at IS NULL
    ORDER BY f.recorded_at DESC LIMIT 1;

    IF v_existing_id IS NOT NULL AND v_existing_value = v_fact->'value' THEN
      UPDATE public.party_facts SET fetched_at = p_fetched_at, reference = coalesce(v_fact->'reference', reference)
      WHERE id = v_existing_id;
      v_refreshed := v_refreshed + 1;
      CONTINUE;
    END IF;

    IF v_existing_id IS NOT NULL THEN
      UPDATE public.party_facts SET superseded_at = p_fetched_at WHERE id = v_existing_id;
      v_superseded := v_superseded + 1;
    END IF;

    INSERT INTO public.party_facts (party_id, company_id, user_id, field, value, source, reference, fetched_at, valid_from, valid_to, recorded_at)
    VALUES (
      p_party_id, p_company_id, p_user_id, v_field, v_fact->'value', p_source, v_fact->'reference', p_fetched_at,
      (v_fact->>'valid_from')::date, (v_fact->>'valid_to')::date, p_fetched_at
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('inserted', v_inserted, 'superseded', v_superseded, 'refreshed', v_refreshed);
END;
$$;

REVOKE ALL ON FUNCTION public.record_party_facts(uuid, uuid, uuid, text, jsonb, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_party_facts(uuid, uuid, uuid, text, jsonb, timestamptz) TO authenticated, service_role;
COMMENT ON FUNCTION public.record_party_facts(uuid, uuid, uuid, text, jsonb, timestamptz) IS
  'Records facts from one source for one party: unchanged values refresh fetched_at, changed values supersede the previous statement and insert a new one. Other sources are never touched.';

NOTIFY pgrst, 'reload schema';
