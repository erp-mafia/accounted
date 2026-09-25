-- Rollback-only fixture for 20260925164645_community_publishing.
BEGIN;
DO $test$
DECLARE
  owner_id uuid := gen_random_uuid();
  company_a uuid := gen_random_uuid();
  own_id uuid;
  stats record;
BEGIN
  INSERT INTO auth.users(id, email, instance_id)
    VALUES (owner_id, 'community-test-' || owner_id || '@test.invalid', '00000000-0000-0000-0000-000000000000'::uuid);
  INSERT INTO public.companies(id, name, entity_type, created_by) VALUES (company_a, 'Community test A', 'aktiebolag', owner_id);
  INSERT INTO public.company_members(company_id, user_id, role) VALUES (company_a, owner_id, 'owner');
  INSERT INTO public.user_preferences(user_id, active_company_id) VALUES (owner_id, company_a)
    ON CONFLICT(user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id;

  -- The author shares an own item.
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.company_skills(company_id, created_by, name, description, body, kind)
    VALUES (company_a, owner_id, 'Kassalikviditet', 'Likviditet varje månad', '# Kassalikviditet', 'analysis') RETURNING id INTO own_id;
  BEGIN
    INSERT INTO public.company_skills(company_id, created_by, name, description, body, review_note)
      VALUES (company_a, owner_id, 'Forged', 'Desc', 'Body', 'Approved by me');
    RAISE EXCEPTION 'Author inserted a review note';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE public.company_skills SET share_status = 'submitted', author_handle = 'community-author', share_confirmed_at = now() WHERE id = own_id;
  BEGIN
    UPDATE public.company_skills SET review_note = 'Looks fine' WHERE id = own_id;
    RAISE EXCEPTION 'Author wrote a review note';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;

  -- Accounted sends it back: private again, with the reason.
  UPDATE public.company_skills SET share_status = 'private', review_note = 'Ta bort kundnamnet' WHERE id = own_id;

  -- The author can edit and share again; the note stays review evidence.
  SET LOCAL ROLE authenticated;
  UPDATE public.company_skills SET body = '# Kassalikviditet utan kundnamn' WHERE id = own_id;
  BEGIN
    UPDATE public.company_skills SET review_note = NULL WHERE id = own_id;
    RAISE EXCEPTION 'Author cleared the review note';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE public.company_skills SET share_status = 'submitted', share_confirmed_at = now() WHERE id = own_id;
  RESET ROLE;

  -- A contribution straight from GitHub: no submission, its facts on the atom.
  INSERT INTO public.agent_atom_registry(id, tier, title, description, body, body_path, trigger_signals, is_active, mcp_exposed)
    VALUES ('community/pg-test-github', 'community', 'Från GitHub', 'Desc', '# Body', 'erp-mafia/accounted-skills/community/pg-test-github/SKILL.md',
      '{"kind":"rules","author":"repo-author","industries":["e-handel"]}'::jsonb, true, true);
  SELECT * INTO stats FROM public.community_item_stats() WHERE atom_id = 'community/pg-test-github';
  IF stats.kind IS DISTINCT FROM 'rules' OR stats.author IS DISTINCT FROM 'repo-author' OR stats.industries IS DISTINCT FROM ARRAY['e-handel'] OR stats.author_shared <> 1 THEN
    RAISE EXCEPTION 'GitHub-only item stats wrong: %', row_to_json(stats);
  END IF;

  -- A published submission: its own kind and author win over the atom's.
  INSERT INTO public.agent_atom_registry(id, tier, title, description, body, body_path, trigger_signals, is_active, mcp_exposed)
    VALUES ('community/pg-test-shared', 'community', 'Kassalikviditet', 'Desc', '# Body', 'erp-mafia/accounted-skills/community/pg-test-shared/SKILL.md',
      '{"kind":"workflow","author":"someone-else","industries":[]}'::jsonb, true, true);
  UPDATE public.company_skills SET share_status = 'published', published_atom_id = 'community/pg-test-shared', reviewed_at = now() WHERE id = own_id;
  SELECT * INTO stats FROM public.community_item_stats() WHERE atom_id = 'community/pg-test-shared';
  IF stats.kind IS DISTINCT FROM 'analysis' OR stats.author IS DISTINCT FROM 'community-author' OR stats.industries IS DISTINCT FROM ARRAY[]::text[] THEN
    RAISE EXCEPTION 'Published submission stats wrong: %', row_to_json(stats);
  END IF;
END;
$test$;
