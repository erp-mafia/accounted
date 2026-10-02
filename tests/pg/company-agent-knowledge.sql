-- Rollback-only fixture: what a company's agents know (company_agent_knowledge).
BEGIN;
DO $test$
DECLARE
  owner_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  company_a uuid := gen_random_uuid();
  company_b uuid := gen_random_uuid();
  choice_id uuid;
  seen integer;
BEGIN
  INSERT INTO auth.users(id, email, instance_id)
  SELECT id, 'agent-knowledge-' || id || '@test.invalid', '00000000-0000-0000-0000-000000000000'::uuid
  FROM unnest(ARRAY[owner_id, viewer_id, other_id]) AS id;
  INSERT INTO public.companies(id, name, entity_type, created_by) VALUES
    (company_a, 'Knowledge test A', 'aktiebolag', owner_id),
    (company_b, 'Knowledge test B', 'aktiebolag', other_id);
  INSERT INTO public.company_members(company_id, user_id, role) VALUES
    (company_a, owner_id, 'owner'), (company_a, viewer_id, 'viewer'), (company_b, other_id, 'owner');
  INSERT INTO public.user_preferences(user_id, active_company_id) VALUES
    (owner_id, company_a), (viewer_id, company_a), (other_id, company_b)
    ON CONFLICT(user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
  INSERT INTO public.agent_atom_registry(id, tier, title, description, body_path, body, parent_atom_id, is_active, mcp_exposed) VALUES
    ('horizontal/knowledge-test-live', 'horizontal', 'Live pack', 'A live pack.', 'x', 'body', NULL, true, true),
    ('horizontal/knowledge-test-live/ref', 'horizontal', 'Reference', 'A reference.', 'x', 'body', 'horizontal/knowledge-test-live', true, true),
    ('horizontal/knowledge-test-off', 'horizontal', 'Withdrawn pack', 'Off.', 'x', 'body', NULL, false, true);

  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  INSERT INTO public.company_agent_knowledge(company_id, agent_id, atom_id, included)
    VALUES (company_a, 'quarterly-vat-review', 'horizontal/knowledge-test-live', true) RETURNING id INTO choice_id;
  -- taking a default away needs no live pack
  INSERT INTO public.company_agent_knowledge(company_id, agent_id, atom_id, included)
    VALUES (company_a, 'quarterly-vat-review', 'horizontal/knowledge-test-off', false);
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, atom_id, included)
      VALUES (company_a, 'bookkeep', 'horizontal/knowledge-test-off', true);
    RAISE EXCEPTION 'A withdrawn pack was added';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, atom_id, included)
      VALUES (company_a, 'bookkeep', 'horizontal/knowledge-test-live/ref', true);
    RAISE EXCEPTION 'A reference file was added as a pack';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, atom_id, included)
      VALUES (company_a, 'Bad Agent!', 'horizontal/knowledge-test-live', true);
    RAISE EXCEPTION 'A malformed agent id was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, atom_id, included)
      VALUES (company_b, 'bookkeep', 'horizontal/knowledge-test-live', true);
    RAISE EXCEPTION 'Cross-company insert was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.company_agent_knowledge SET agent_id = 'bookkeep' WHERE id = choice_id;
    RAISE EXCEPTION 'A choice moved to another agent';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE public.company_agent_knowledge SET included = false WHERE id = choice_id;

  -- a viewer reads the choices but cannot change them
  PERFORM set_config('request.jwt.claim.sub', viewer_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO seen FROM public.company_agent_knowledge WHERE company_id = company_a;
  IF seen <> 2 THEN RAISE EXCEPTION 'Viewer saw % choices, expected 2', seen; END IF;
  BEGIN
    INSERT INTO public.company_agent_knowledge(company_id, agent_id, atom_id, included)
      VALUES (company_a, 'bookkeep', 'horizontal/knowledge-test-live', true);
    RAISE EXCEPTION 'A viewer changed what an agent knows';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  DELETE FROM public.company_agent_knowledge WHERE id = choice_id;
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.company_agent_knowledge WHERE id = choice_id) THEN
    RAISE EXCEPTION 'A viewer deleted a choice';
  END IF;

  -- another company sees none of it
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', other_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO seen FROM public.company_agent_knowledge;
  IF seen <> 0 THEN RAISE EXCEPTION 'Another company saw % choices', seen; END IF;
  RESET ROLE;
END;
$test$;
