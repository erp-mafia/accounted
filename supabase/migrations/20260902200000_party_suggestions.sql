-- Parties, phase 1c: the suggestion pipeline.
--
-- A migrant's register is filled from what the ledger already knows: posted
-- vouchers keyed on ledger_key(description) (get_observed_parties), plus the
-- documents linked to those vouchers, whose OCR-read supplier block carries
-- the hard keys (org number, VAT number, bankgiro, plusgiro). Nothing here is
-- shown as a fact: every party this pipeline writes has status 'suggested'
-- and waits for a person to confirm or dismiss it. Text similarity never
-- merges anything; only an org number or an exact ledger key attaches a key
-- to an existing party (DECISIONS 2026-09-02, dedupe on org only).
--
-- Three functions, all SECURITY INVOKER so RLS on parties/party_* applies to
-- authenticated callers; the service role bypasses RLS as it does everywhere.
--   get_ledger_key_evidence(company)      read: hard keys per ledger key
--   apply_party_suggestions(company, user, items)  write: upsert suggestions
--   decide_parties(company, user, ids, kind, note) write: bulk confirm/dismiss

-- Why the queue can show a reason per row without a join.
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS suggested_reason jsonb;
COMMENT ON COLUMN public.parties.suggested_reason IS
  'Why the pipeline suggested this party (evidence summary). NULL once confirmed by a person.';

-- ── Evidence per ledger key ─────────────────────────────────────────────────
-- Same voucher population as get_observed_parties, joined to current-version
-- documents whose extracted supplier block is an object. Documents whose
-- supplier org number is the company's own are the company's sales invoices
-- uploaded as underlag (40% of org-bearing documents fleet-wide); they are
-- counted in self_docs and contribute nothing else.
CREATE OR REPLACE FUNCTION public.get_ledger_key_evidence(p_company_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH own AS (
    SELECT public.normalize_org_number(c.org_number) AS org
    FROM public.companies c WHERE c.id = p_company_id
  ),
  entries AS (
    SELECT je.id, je.entry_date, public.ledger_key(je.description) AS k
    FROM public.journal_entries je
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.source_type NOT IN ('storno', 'opening_balance', 'year_end', 'vat_settlement')
      AND je.description IS NOT NULL
      AND btrim(je.description) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.transactions t
        WHERE t.journal_entry_id = je.id
          AND t.merchant_name IS NOT NULL
          AND btrim(t.merchant_name) <> ''
      )
  ),
  docs AS (
    SELECT e.k, e.entry_date, d.id AS document_id,
           public.normalize_org_number(d.extracted_data->'supplier'->>'orgNumber') AS org,
           nullif(upper(regexp_replace(coalesce(d.extracted_data->'supplier'->>'vatNumber', ''), '[^0-9A-Za-z]', '', 'g')), '') AS vat,
           nullif(regexp_replace(coalesce(d.extracted_data->'supplier'->>'bankgiro', ''), '[^0-9]', '', 'g'), '') AS bankgiro,
           nullif(regexp_replace(coalesce(d.extracted_data->'supplier'->>'plusgiro', ''), '[^0-9]', '', 'g'), '') AS plusgiro,
           nullif(btrim(d.extracted_data->'supplier'->>'name'), '') AS name
    FROM entries e
    JOIN public.document_attachments d
      ON d.journal_entry_id = e.id
     AND d.company_id = p_company_id
     AND d.is_current_version
     AND jsonb_typeof(d.extracted_data->'supplier') = 'object'
    WHERE e.k <> ''
  ),
  classified AS (
    SELECT d.*, (d.org IS NOT NULL AND d.org = own.org) AS is_self
    FROM docs d CROSS JOIN own
  ),
  useful AS (SELECT * FROM classified WHERE NOT is_self),
  orgs AS (
    SELECT k, org, count(*) AS n FROM useful WHERE org IS NOT NULL GROUP BY k, org
  ),
  vats AS (
    SELECT k, vat, count(*) AS n FROM useful WHERE vat IS NOT NULL GROUP BY k, vat
  ),
  names AS (
    SELECT k, name, count(*) AS n FROM useful WHERE name IS NOT NULL GROUP BY k, name
  ),
  bg AS (
    SELECT k, bankgiro AS value, count(*) AS n, min(entry_date) AS first_seen, max(entry_date) AS last_seen
    FROM useful WHERE bankgiro IS NOT NULL AND length(bankgiro) BETWEEN 7 AND 8 GROUP BY k, bankgiro
  ),
  pg AS (
    SELECT k, plusgiro AS value, count(*) AS n, min(entry_date) AS first_seen, max(entry_date) AS last_seen
    FROM useful WHERE plusgiro IS NOT NULL AND length(plusgiro) BETWEEN 5 AND 8 GROUP BY k, plusgiro
  ),
  per_key AS (
    SELECT c.k,
           count(*) AS docs,
           count(*) FILTER (WHERE c.is_self) AS self_docs
    FROM classified c GROUP BY c.k
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key', p.k,
    'docs', p.docs,
    'self_docs', p.self_docs,
    'orgs', coalesce((SELECT jsonb_agg(jsonb_build_object('org', o.org, 'n', o.n) ORDER BY o.n DESC, o.org) FROM orgs o WHERE o.k = p.k), '[]'::jsonb),
    'vat_numbers', coalesce((SELECT jsonb_agg(jsonb_build_object('vat', v.vat, 'n', v.n) ORDER BY v.n DESC, v.vat) FROM vats v WHERE v.k = p.k), '[]'::jsonb),
    'names', coalesce((SELECT jsonb_agg(jsonb_build_object('name', x.name, 'n', x.n) ORDER BY x.n DESC, x.name) FROM names x WHERE x.k = p.k), '[]'::jsonb),
    'bankgiro', coalesce((SELECT jsonb_agg(jsonb_build_object('value', b.value, 'n', b.n, 'first_seen', b.first_seen, 'last_seen', b.last_seen) ORDER BY b.n DESC, b.value) FROM bg b WHERE b.k = p.k), '[]'::jsonb),
    'plusgiro', coalesce((SELECT jsonb_agg(jsonb_build_object('value', g.value, 'n', g.n, 'first_seen', g.first_seen, 'last_seen', g.last_seen) ORDER BY g.n DESC, g.value) FROM pg g WHERE g.k = p.k), '[]'::jsonb)
  ) ORDER BY p.docs DESC, p.k), '[]'::jsonb)
  FROM per_key p;
$$;

REVOKE ALL ON FUNCTION public.get_ledger_key_evidence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ledger_key_evidence(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_ledger_key_evidence(uuid) IS
  'Hard keys (org, VAT, bankgiro, plusgiro, printed name) per ledger_key from documents linked to posted vouchers. Self-extracted documents (supplier org = own org) count only in self_docs.';

-- ── Apply suggestions ───────────────────────────────────────────────────────
-- p_items: array of
--   { key, display_name, kind?, origin?, org_number?, vat_number?, alias_keys?,
--     party_id?, reason?, facts?: [{field, value, source, reference?}],
--     identities?: [{scheme, value, first_seen?, last_seen?, seen_count?}] }
-- Attach order: explicit party_id, then live party with the same org number,
-- then live party whose alias_keys already contains the key; otherwise insert
-- a suggested party. Never by name. Re-running is idempotent.
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
  v_aliases text[];
  v_created integer := 0;
  v_attached integer := 0;
  v_identities integer := 0;
  v_facts integer := 0;
  v_seen integer;
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
      UPDATE public.parties
      SET alias_keys = ARRAY(SELECT DISTINCT x FROM unnest(alias_keys || v_aliases) AS x),
          vat_number = coalesce(vat_number, nullif(btrim(v_item->>'vat_number'), '')),
          legal_name = coalesce(legal_name, nullif(btrim(v_item->>'legal_name'), '')),
          org_number = coalesce(org_number, v_org)
      WHERE id = v_party_id
        AND (NOT (alias_keys @> v_aliases)
             OR (vat_number IS NULL AND nullif(btrim(v_item->>'vat_number'), '') IS NOT NULL)
             OR (legal_name IS NULL AND nullif(btrim(v_item->>'legal_name'), '') IS NOT NULL)
             OR (org_number IS NULL AND v_org IS NOT NULL));
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

  RETURN jsonb_build_object('created', v_created, 'attached', v_attached, 'identities', v_identities, 'facts', v_facts);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_party_suggestions(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_party_suggestions(uuid, uuid, jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION public.apply_party_suggestions(uuid, uuid, jsonb) IS
  'Upserts pipeline suggestions: attaches by explicit party_id, org number or exact ledger key, otherwise inserts a suggested party. Never merges on name. Idempotent.';

-- ── Decide: bulk confirm or dismiss ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.decide_parties(
  p_company_id uuid,
  p_user_id uuid,
  p_party_ids uuid[],
  p_kind text,
  p_note text DEFAULT NULL
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
    RAISE EXCEPTION 'decide_parties: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('confirm', 'dismiss') THEN
    RAISE EXCEPTION 'decide_parties: kind must be confirm or dismiss, got %', p_kind USING ERRCODE = '22023';
  END IF;

  IF p_kind = 'confirm' THEN
    WITH changed AS (
      UPDATE public.parties p
      SET status = 'confirmed', suggested_reason = NULL, archived_at = NULL
      WHERE p.company_id = p_company_id AND p.id = ANY(p_party_ids) AND p.merged_into IS NULL
        AND (p.status <> 'confirmed' OR p.archived_at IS NOT NULL)
      RETURNING p.id, p.display_name
    ), logged AS (
      INSERT INTO public.party_decisions (party_id, company_id, user_id, kind, before, after, note)
      SELECT c.id, p_company_id, p_user_id, 'confirm',
             jsonb_build_object('status', 'suggested'), jsonb_build_object('status', 'confirmed'), p_note
      FROM changed c
      RETURNING 1
    )
    SELECT count(*) INTO v_count FROM logged;
  ELSE
    WITH changed AS (
      UPDATE public.parties p
      SET archived_at = now()
      WHERE p.company_id = p_company_id AND p.id = ANY(p_party_ids) AND p.merged_into IS NULL
        AND p.archived_at IS NULL
      RETURNING p.id, p.status
    ), logged AS (
      INSERT INTO public.party_decisions (party_id, company_id, user_id, kind, before, after, note)
      SELECT c.id, p_company_id, p_user_id, 'dismiss',
             jsonb_build_object('status', c.status, 'archived', false), jsonb_build_object('status', c.status, 'archived', true), p_note
      FROM changed c
      RETURNING 1
    )
    SELECT count(*) INTO v_count FROM logged;
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.decide_parties(uuid, uuid, uuid[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_parties(uuid, uuid, uuid[], text, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.decide_parties(uuid, uuid, uuid[], text, text) IS
  'Bulk confirm (suggested -> confirmed) or dismiss (archive) parties, one party_decisions row each. Merge and undo live in their own RPCs.';

NOTIFY pgrst, 'reload schema';
