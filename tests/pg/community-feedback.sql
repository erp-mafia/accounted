-- Rollback-only fixture: community upvotes (community_feedback), the frozen
-- kind of a submission and community_item_stats().
BEGIN;
DO $test$
DECLARE
  author_id uuid := gen_random_uuid();
  voter_id uuid := gen_random_uuid();
  viewer_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  company_a uuid := gen_random_uuid();
  company_b uuid := gen_random_uuid();
  firm_id uuid := gen_random_uuid();
  skill_id uuid;
  row_id uuid;
  seen integer;
  stats record;
BEGIN
  INSERT INTO auth.users(id, email, instance_id)
  SELECT id, 'community-feedback-' || id || '@test.invalid', '00000000-0000-0000-0000-000000000000'::uuid
  FROM unnest(ARRAY[author_id, voter_id, viewer_id, other_id]) AS id;
  INSERT INTO public.teams(id, name, created_by, kind) VALUES (firm_id, 'Feedback test firm', author_id, 'byra');
  INSERT INTO public.companies(id, name, entity_type, created_by, team_id) VALUES
    (company_a, 'Feedback test A', 'aktiebolag', author_id, firm_id),
    (company_b, 'Feedback test B', 'aktiebolag', other_id, NULL);
  INSERT INTO public.company_members(company_id, user_id, role) VALUES
    (company_a, author_id, 'owner'), (company_a, voter_id, 'member'), (company_a, viewer_id, 'viewer'), (company_b, other_id, 'owner');
  INSERT INTO public.user_preferences(user_id, active_company_id) VALUES
    (author_id, company_a), (voter_id, company_a), (viewer_id, company_a), (other_id, company_b)
    ON CONFLICT(user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
  INSERT INTO public.agent_atom_registry(id, tier, title, description, body_path, body, parent_atom_id, is_active, mcp_exposed) VALUES
    ('community/feedback-test-live', 'community', 'Live item', 'A live item.', 'x', 'body', NULL, true, true),
    ('community/feedback-test-off', 'community', 'Withdrawn item', 'Off.', 'x', 'body', NULL, false, false),
    ('vertical/feedback-test-pack', 'vertical', 'Not community', 'A pack.', 'x', 'body', NULL, true, true);

  -- The kind is validated and frozen once submitted.
  BEGIN
    INSERT INTO public.company_skills(company_id, created_by, name, description, body, kind)
      VALUES (company_a, author_id, 'Bad kind', 'Desc', 'Body', 'connection');
    RAISE EXCEPTION 'Unknown kind was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  PERFORM set_config('request.jwt.claim.sub', author_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', author_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.company_skills(company_id, created_by, name, description, body)
    VALUES (company_a, author_id, 'Shared', 'Shared instruction', 'Steps.') RETURNING id INTO skill_id;
  UPDATE public.company_skills SET share_status = 'submitted', author_handle = 'feedback-author', share_confirmed_at = now(),
    kind = 'analysis' WHERE id = skill_id;
  BEGIN
    UPDATE public.company_skills SET kind = 'rules' WHERE id = skill_id;
    RAISE EXCEPTION 'Submitted kind changed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
  -- The reviewer publishes it (service role in production).
  UPDATE public.company_skills SET share_status = 'published', published_atom_id = 'community/feedback-test-live', reviewed_at = now()
    WHERE id = skill_id;

  -- A member votes from their company, takes it back and votes again.
  PERFORM set_config('request.jwt.claim.sub', voter_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', voter_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.community_feedback(atom_id, company_id, user_id, vote)
    VALUES ('community/feedback-test-live', company_a, voter_id, true) RETURNING id INTO row_id;
  UPDATE public.community_feedback SET vote = false WHERE id = row_id;
  UPDATE public.community_feedback SET vote = true WHERE id = row_id;
  BEGIN
    INSERT INTO public.community_feedback(atom_id, company_id, user_id, vote)
      VALUES ('community/feedback-test-live', company_a, voter_id, true);
    RAISE EXCEPTION 'A second row for the same person and item was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.community_feedback(atom_id, company_id, user_id, vote)
      VALUES ('community/feedback-test-off', company_a, voter_id, true);
    RAISE EXCEPTION 'A withdrawn item was voted on';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.community_feedback(atom_id, company_id, user_id, vote)
      VALUES ('vertical/feedback-test-pack', company_a, voter_id, true);
    RAISE EXCEPTION 'A non-community item was voted on';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO public.community_feedback(atom_id, company_id, user_id, vote)
      VALUES ('community/feedback-test-live', company_a, author_id, true);
    RAISE EXCEPTION 'A vote was cast for someone else';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.community_feedback SET company_id = company_b WHERE id = row_id;
    RAISE EXCEPTION 'A vote was moved to a company the voter is not in';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.community_feedback SET atom_id = 'community/feedback-test-off' WHERE id = row_id;
    RAISE EXCEPTION 'A vote moved to another item';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- A viewer may vote too: voting is not a change to the company's books.
  -- A row without a vote does not count.
  PERFORM set_config('request.jwt.claim.sub', viewer_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', viewer_id, 'role', 'authenticated')::text, true);
  INSERT INTO public.community_feedback(atom_id, company_id, user_id, vote)
    VALUES ('community/feedback-test-live', company_a, viewer_id, false);
  SELECT count(*) INTO seen FROM public.community_feedback;
  IF seen <> 1 THEN RAISE EXCEPTION 'A person saw % feedback rows, expected only their own', seen; END IF;

  -- Another company's user votes from their own company, sees none of the
  -- others' rows, but reads the counts.
  PERFORM set_config('request.jwt.claim.sub', other_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', other_id, 'role', 'authenticated')::text, true);
  BEGIN
    INSERT INTO public.community_feedback(atom_id, company_id, user_id, vote)
      VALUES ('community/feedback-test-live', company_a, other_id, true);
    RAISE EXCEPTION 'A vote was given from a company the voter is not in';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  INSERT INTO public.community_feedback(atom_id, company_id, user_id, vote)
    VALUES ('community/feedback-test-live', company_b, other_id, true);
  SELECT count(*) INTO seen FROM public.community_feedback;
  IF seen <> 1 THEN RAISE EXCEPTION 'Another tenant saw % feedback rows', seen; END IF;
  SELECT * INTO stats FROM public.community_item_stats() s WHERE s.atom_id = 'community/feedback-test-live';
  IF stats IS NULL THEN RAISE EXCEPTION 'The live item has no stats'; END IF;
  IF stats.votes <> 2 THEN
    RAISE EXCEPTION 'Wrong count: % votes, expected 2', stats.votes;
  END IF;
  IF stats.kind <> 'analysis' THEN
    RAISE EXCEPTION 'The kind did not reach the stats';
  END IF;
  IF stats.author <> 'feedback-author' OR stats.author_shared <> 1 OR NOT stats.author_verified THEN
    RAISE EXCEPTION 'Wrong author data: %, %, %', stats.author, stats.author_shared, stats.author_verified;
  END IF;
  IF EXISTS (SELECT 1 FROM public.community_item_stats() s WHERE s.atom_id IN ('community/feedback-test-off', 'vertical/feedback-test-pack')) THEN
    RAISE EXCEPTION 'Stats listed an item that is not a live community item';
  END IF;
  RESET ROLE;

  IF NOT EXISTS (SELECT 1 FROM public.audit_log WHERE table_name = 'community_feedback' AND record_id = row_id) THEN
    RAISE EXCEPTION 'Missing feedback audit evidence';
  END IF;
  IF has_function_privilege('anon', 'public.community_item_stats()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon may read community stats';
  END IF;
END;
$test$;
ROLLBACK;
