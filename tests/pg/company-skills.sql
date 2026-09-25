-- Rollback-only fixture: may also run through the staging SQL tool.
BEGIN;
DO $test$
DECLARE
  owner_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  firm_owner uuid := gen_random_uuid();
  company_a uuid := gen_random_uuid();
  company_b uuid := gen_random_uuid();
  firm_id uuid := gen_random_uuid();
  own_id uuid;
  firm_skill uuid;
  affected integer;
BEGIN
  INSERT INTO auth.users(id, email, instance_id)
  SELECT id, 'skill-test-' || id || '@test.invalid', '00000000-0000-0000-0000-000000000000'::uuid
  FROM unnest(ARRAY[owner_id, other_id, viewer_id, firm_owner]) AS id;
  INSERT INTO public.teams(id, name, created_by) VALUES (firm_id, 'Skill test firm', firm_owner);
  INSERT INTO public.team_members(team_id, user_id, role) VALUES (firm_id, firm_owner, 'owner');
  INSERT INTO public.companies(id, name, entity_type, created_by, team_id) VALUES
    (company_a, 'Skill test A', 'aktiebolag', owner_id, firm_id),
    (company_b, 'Skill test B', 'aktiebolag', other_id, NULL);
  INSERT INTO public.company_members(company_id, user_id, role) VALUES
    (company_a, owner_id, 'owner'), (company_a, viewer_id, 'viewer'), (company_b, other_id, 'owner');
  INSERT INTO public.user_preferences(user_id, active_company_id) VALUES
    (owner_id, company_a), (viewer_id, company_a), (other_id, company_b)
    ON CONFLICT(user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id;

  -- Constraint tests bypass RLS to exercise the actual invariant.
  BEGIN
    INSERT INTO public.company_skills(created_by, name, description, body) VALUES (owner_id, 'None', 'Desc', 'Body');
    RAISE EXCEPTION 'Missing scope was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_skills(company_id, team_id, created_by, name, description, body) VALUES (company_a, firm_id, owner_id, 'Both', 'Desc', 'Body');
    RAISE EXCEPTION 'Two scopes were accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.company_skills(company_id, created_by, name, description, body) VALUES (company_a, owner_id, 'Big', 'Desc', repeat('å', 16385));
    RAISE EXCEPTION 'UTF-8 byte cap was not enforced';
  EXCEPTION WHEN check_violation THEN NULL; END;

  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.company_skills(company_id, created_by, name, description, body)
    VALUES(company_a, owner_id, 'Own', 'Private instruction', 'Review before booking.') RETURNING id INTO own_id;
  BEGIN
    INSERT INTO public.company_skills(company_id, created_by, name, description, body)
      VALUES(company_b, owner_id, 'Leak', 'Desc', 'Body');
    RAISE EXCEPTION 'Cross-company insert was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.company_skills SET company_id = company_b WHERE id = own_id;
    RAISE EXCEPTION 'Scope mutation was accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE public.company_skills SET share_status = 'submitted', author_handle = 'skill-test-author', share_confirmed_at = now() WHERE id = own_id;
  IF NOT EXISTS (SELECT 1 FROM public.company_skills WHERE id = own_id AND length(submission_body_hash) = 64) THEN
    RAISE EXCEPTION 'Submission did not capture a body hash';
  END IF;
  BEGIN
    UPDATE public.company_skills SET body = 'Changed after consent' WHERE id = own_id;
    RAISE EXCEPTION 'Submitted text changed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.company_skills SET share_status = 'published', reviewed_at = now() WHERE id = own_id;
    RAISE EXCEPTION 'Author forged review evidence';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  DELETE FROM public.company_skills WHERE id = own_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Submitted evidence was deleted'; END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', firm_owner::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', firm_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.company_skills(team_id, created_by, name, description, body)
    VALUES(firm_id, firm_owner, 'Firm', 'Shared instruction', 'Explain uncertain mappings.') RETURNING id INTO firm_skill;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  IF NOT EXISTS(SELECT 1 FROM public.company_skills WHERE id = firm_skill) THEN RAISE EXCEPTION 'Firm instruction not inherited'; END IF;
  UPDATE public.company_skills SET body = 'Unauthorized firm edit' WHERE id = firm_skill;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Company member edited firm instruction'; END IF;
  UPDATE public.company_skills SET share_status = 'withdrawn' WHERE id = own_id;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', viewer_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  IF (SELECT count(*) FROM public.company_skills WHERE id IN(own_id, firm_skill)) <> 2 THEN RAISE EXCEPTION 'Viewer cannot read scoped instructions'; END IF;
  BEGIN
    INSERT INTO public.company_skills(company_id, created_by, name, description, body) VALUES(company_a, viewer_id, 'Forbidden', 'Desc', 'Body');
    RAISE EXCEPTION 'Viewer inserted a skill';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', other_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  IF EXISTS(SELECT 1 FROM public.company_skills WHERE id IN(own_id, firm_skill)) THEN RAISE EXCEPTION 'Private instruction leaked across tenants'; END IF;
  RESET ROLE;
  IF NOT EXISTS(SELECT 1 FROM public.audit_log WHERE table_name = 'company_skills' AND record_id = own_id AND actor_id = owner_id) THEN
    RAISE EXCEPTION 'Missing skill audit evidence';
  END IF;
END;
$test$;
ROLLBACK;
