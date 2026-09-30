-- Rollback-only fixture: a company's own knowledge given to a flow
-- (company_agent_knowledge.own_skill_id).
BEGIN;
DO $test$
DECLARE
  owner_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  company_a uuid := gen_random_uuid();
  company_b uuid := gen_random_uuid();
  flow_id uuid;
  rules_id uuid;
  draft_rules_id uuid;
  workflow_item_id uuid;
  other_rules_id uuid;
  seen integer;
BEGIN
  INSERT INTO auth.users(id, email, instance_id)
  SELECT id, 'own-knowledge-' || id || '@test.invalid', '00000000-0000-0000-0000-000000000000'::uuid
  FROM unnest(ARRAY[owner_id, other_id]) AS id;
  INSERT INTO public.companies(id, name, entity_type, created_by) VALUES
    (company_a, 'Own knowledge test A', 'aktiebolag', owner_id),
    (company_b, 'Own knowledge test B', 'aktiebolag', other_id);
  INSERT INTO public.company_members(company_id, user_id, role) VALUES
    (company_a, owner_id, 'owner'), (company_b, other_id, 'owner');
  INSERT INTO public.user_preferences(user_id, active_company_id) VALUES
    (owner_id, company_a), (other_id, company_b)
    ON CONFLICT(user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
  INSERT INTO public.agent_atom_registry(id, tier, title, description, body_path, body, parent_atom_id, is_active, mcp_exposed) VALUES
    ('horizontal/own-knowledge-test-live', 'horizontal', 'Live pack', 'A live pack.', 'x', 'body', NULL, true, true);
  INSERT INTO public.company_skills(company_id, created_by, name, description, body, kind)
    VALUES (company_a, owner_id, 'Flow', 'A flow.', '# Flow', 'workflow') RETURNING id INTO flow_id;
  INSERT INTO public.company_skills(company_id, created_by, name, description, body, kind)
    VALUES (company_a, owner_id, 'Rules', 'Our rules.', '# Rules', 'rules') RETURNING id INTO rules_id;
  INSERT INTO public.company_skills(company_id, created_by, name, description, body, kind, draft)
    VALUES (company_a, owner_id, 'Draft rules', 'Not added.', '# Draft', 'rules', true) RETURNING id INTO draft_rules_id;
  INSERT INTO public.company_skills(company_id, created_by, name, description, body, kind)
    VALUES (company_a, owner_id, 'Another flow', 'A flow, not knowledge.', '# Flow 2', 'workflow') RETURNING id INTO workflow_item_id;
  INSERT INTO public.company_skills(company_id, created_by, name, description, body, kind)
    VALUES (company_b, other_id, 'Their rules', 'Company B.', '# B', 'rules') RETURNING id INTO other_rules_id;

  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- the company's own knowledge goes to its own flow, next to a pack
  INSERT INTO public.company_agent_knowledge(company_id, agent_id, own_skill_id, included)
    VALUES (company_a, 'own/' || flow_id, rules_id, true);
  INSERT INTO public.company_agent_knowledge(company_id, agent_id, atom_id, included)
    VALUES (company_a, 'own/' || flow_id, 'horizontal/own-knowledge-test-live', true);
  -- and to a curated flow
  INSERT INTO public.company_agent_knowledge(company_id, agent_id, own_skill_id, included)
    VALUES (company_a, 'bookkeep', rules_id, true);
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, own_skill_id, included)
      VALUES (company_a, 'own/' || flow_id, rules_id, true);
    RAISE EXCEPTION 'The same own knowledge was added twice';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, own_skill_id, included)
      VALUES (company_a, 'bookkeep', draft_rules_id, true);
    RAISE EXCEPTION 'A draft was given to a flow';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, own_skill_id, included)
      VALUES (company_a, 'bookkeep', workflow_item_id, true);
    RAISE EXCEPTION 'A flow was given to a flow as knowledge';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, own_skill_id, included)
      VALUES (company_a, 'bookkeep', other_rules_id, true);
    RAISE EXCEPTION 'Another company''s knowledge was given to a flow';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, own_skill_id, included)
      VALUES (company_a, 'month-end-close', rules_id, false);
    RAISE EXCEPTION 'Own knowledge was taken away as if it were a default';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, atom_id, own_skill_id, included)
      VALUES (company_a, 'month-end-close', 'horizontal/own-knowledge-test-live', rules_id, true);
    RAISE EXCEPTION 'A choice pointed at a pack and own knowledge at once';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, included)
      VALUES (company_a, 'month-end-close', true);
    RAISE EXCEPTION 'A choice pointed at nothing';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.company_agent_knowledge SET own_skill_id = draft_rules_id WHERE agent_id = 'bookkeep';
    RAISE EXCEPTION 'A choice was moved to other knowledge';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
  RESET ROLE;

  -- deleting the knowledge item takes it off every flow
  DELETE FROM public.company_skills WHERE id = rules_id;
  SELECT count(*) INTO seen FROM public.company_agent_knowledge WHERE company_id = company_a AND own_skill_id IS NOT NULL;
  IF seen <> 0 THEN RAISE EXCEPTION '% choices outlived their knowledge', seen; END IF;
  SELECT count(*) INTO seen FROM public.company_agent_knowledge WHERE company_id = company_a;
  IF seen <> 1 THEN RAISE EXCEPTION 'Expected the pack choice to remain, found % rows', seen; END IF;
END;
$test$;
