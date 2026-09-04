-- Parties, phase 1d: merge with survivor choice, and undo within 30 days.
--
-- A merge is soft: the merged party rows stay, with merged_into pointing at
-- the survivor and archived_at set. Facts, identities and role links keep
-- their party_id; readers resolve the canonical party through
-- canonical_party_id(). That is what makes undo a plain restore rather than
-- a reconstruction, which the July research found is where Attio, Pennylane
-- and Ramp lose data (merges irreversible, a paid undo market exists).
--
-- What the survivor gains at merge time: the union of alias keys (so the
-- suggestion pipeline attaches future keys to the survivor) and an org
-- number if it had none. Both are snapshotted in the decision and restored
-- on undo.

CREATE OR REPLACE FUNCTION public.canonical_party_id(p_party_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH RECURSIVE chain AS (
    SELECT p.id, p.merged_into, 1 AS depth
    FROM public.parties p WHERE p.id = p_party_id
    UNION ALL
    SELECT p.id, p.merged_into, c.depth + 1
    FROM chain c JOIN public.parties p ON p.id = c.merged_into
    WHERE c.merged_into IS NOT NULL AND c.depth < 16
  )
  SELECT id FROM chain ORDER BY depth DESC LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.canonical_party_id(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.canonical_party_id(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.canonical_party_id(uuid) IS
  'Follows merged_into to the surviving party (at most 16 hops). Returns the input id for a live party.';

-- ── Merge ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.merge_parties(
  p_company_id uuid,
  p_user_id uuid,
  p_survivor uuid,
  p_merged uuid[],
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_survivor public.parties%ROWTYPE;
  v_ids uuid[];
  v_before jsonb;
  v_alias text[];
  v_org text;
  v_decision uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'merge_parties: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_survivor FROM public.parties
  WHERE id = p_survivor AND company_id = p_company_id AND merged_into IS NULL
  FOR UPDATE;
  IF v_survivor.id IS NULL THEN
    RAISE EXCEPTION 'merge_parties: survivor is not a live party of this company' USING ERRCODE = '23503';
  END IF;

  -- Only live parties of this company, never the survivor, each once.
  SELECT coalesce(array_agg(p.id ORDER BY p.created_at, p.id), '{}') INTO v_ids
  FROM public.parties p
  WHERE p.company_id = p_company_id AND p.id = ANY(p_merged) AND p.id <> p_survivor AND p.merged_into IS NULL;
  IF coalesce(array_length(v_ids, 1), 0) <> (SELECT count(DISTINCT x) FROM unnest(p_merged) AS x WHERE x <> p_survivor) THEN
    RAISE EXCEPTION 'merge_parties: every merged id must be a live party of this company' USING ERRCODE = '23503';
  END IF;
  IF coalesce(array_length(v_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'merge_parties: nothing to merge' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.parties WHERE id = ANY(v_ids) FOR UPDATE;

  SELECT ARRAY(SELECT DISTINCT x FROM (
           SELECT unnest(v_survivor.alias_keys) AS x
           UNION ALL
           SELECT unnest(p.alias_keys) FROM public.parties p WHERE p.id = ANY(v_ids)
         ) a),
         coalesce(v_survivor.org_number, (
           SELECT p.org_number FROM public.parties p
           WHERE p.id = ANY(v_ids) AND p.org_number IS NOT NULL
           ORDER BY p.created_at, p.id LIMIT 1))
    INTO v_alias, v_org;

  v_before := jsonb_build_object(
    'survivor', jsonb_build_object('id', v_survivor.id, 'alias_keys', to_jsonb(v_survivor.alias_keys), 'org_number', v_survivor.org_number),
    'merged', (SELECT jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'status', p.status, 'archived_at', p.archived_at) ORDER BY p.created_at, p.id)
               FROM public.parties p WHERE p.id = ANY(v_ids))
  );

  UPDATE public.parties
  SET merged_into = p_survivor, archived_at = coalesce(archived_at, now())
  WHERE id = ANY(v_ids);

  UPDATE public.parties
  SET alias_keys = v_alias, org_number = v_org
  WHERE id = p_survivor;

  INSERT INTO public.party_decisions (party_id, company_id, user_id, kind, before, after, note)
  VALUES (p_survivor, p_company_id, p_user_id, 'merge', v_before,
          jsonb_build_object('survivor', jsonb_build_object('id', p_survivor, 'alias_keys', to_jsonb(v_alias), 'org_number', v_org), 'merged', to_jsonb(v_ids)),
          p_note)
  RETURNING id INTO v_decision;

  RETURN v_decision;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_parties(uuid, uuid, uuid, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_parties(uuid, uuid, uuid, uuid[], text) TO authenticated, service_role;
COMMENT ON FUNCTION public.merge_parties(uuid, uuid, uuid, uuid[], text) IS
  'Soft-merges live parties into a survivor (merged_into + archived_at), unions alias keys, copies an org number the survivor lacks. Returns the merge decision id for undo_party_merge.';

-- ── Undo ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.undo_party_merge(
  p_company_id uuid,
  p_user_id uuid,
  p_decision_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_d public.party_decisions%ROWTYPE;
  v_ids uuid[];
  v_restored integer;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'undo_party_merge: p_user_id must be the caller' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_d FROM public.party_decisions
  WHERE id = p_decision_id AND company_id = p_company_id AND kind = 'merge'
  FOR UPDATE;
  IF v_d.id IS NULL THEN
    RAISE EXCEPTION 'undo_party_merge: no merge decision % in this company', p_decision_id USING ERRCODE = '23503';
  END IF;
  IF v_d.created_at < now() - interval '30 days' THEN
    RAISE EXCEPTION 'undo_party_merge: the 30-day undo window has passed' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.party_decisions u
             WHERE u.company_id = p_company_id AND u.kind = 'split' AND u.before->>'decision_id' = p_decision_id::text) THEN
    RAISE EXCEPTION 'undo_party_merge: merge % is already undone', p_decision_id USING ERRCODE = '22023';
  END IF;

  v_ids := ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(v_d.after->'merged') AS x);

  -- Survivor first: it may carry an org number copied from a merged row, and
  -- that row cannot become live again while the survivor still holds it.
  UPDATE public.parties
  SET alias_keys = ARRAY(SELECT jsonb_array_elements_text(v_d.before->'survivor'->'alias_keys')),
      org_number = nullif(v_d.before->'survivor'->>'org_number', '')
  WHERE id = v_d.party_id AND company_id = p_company_id;

  -- Only rows still merged into this survivor come back; a party merged
  -- onward since then belongs to a later decision.
  WITH restored AS (
    UPDATE public.parties p
    SET merged_into = NULL,
        archived_at = (SELECT nullif(m->>'archived_at', '')::timestamptz
                       FROM jsonb_array_elements(v_d.before->'merged') m WHERE (m->>'id')::uuid = p.id)
    WHERE p.id = ANY(v_ids) AND p.company_id = p_company_id AND p.merged_into = v_d.party_id
    RETURNING p.id
  )
  SELECT count(*) INTO v_restored FROM restored;

  INSERT INTO public.party_decisions (party_id, company_id, user_id, kind, before, after, note)
  VALUES (v_d.party_id, p_company_id, p_user_id, 'split',
          jsonb_build_object('decision_id', p_decision_id, 'merged', to_jsonb(v_ids)),
          jsonb_build_object('restored', v_restored),
          'undo merge');

  RETURN v_restored;
END;
$$;

REVOKE ALL ON FUNCTION public.undo_party_merge(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_party_merge(uuid, uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.undo_party_merge(uuid, uuid, uuid) IS
  'Restores the parties merged by one merge decision within 30 days: clears merged_into, restores the survivor''s alias keys and org number, logs a split decision. Returns the number of restored parties.';

NOTIFY pgrst, 'reload schema';
