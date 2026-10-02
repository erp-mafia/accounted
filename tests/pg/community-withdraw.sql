-- Rollback-only fixture for 20260926172514_community_withdraw_to_private.
BEGIN;
DO $test$
DECLARE
  owner_id uuid := gen_random_uuid();
  company_a uuid := gen_random_uuid();
  published_id uuid;
  returned_id uuid;
  r record;
  a record;
BEGIN
  INSERT INTO auth.users(id, email, instance_id)
    VALUES (owner_id, 'withdraw-test-' || owner_id || '@test.invalid', '00000000-0000-0000-0000-000000000000'::uuid);
  INSERT INTO public.companies(id, name, entity_type, created_by) VALUES (company_a, 'Withdraw test A', 'aktiebolag', owner_id);
  INSERT INTO public.company_members(company_id, user_id, role) VALUES (company_a, owner_id, 'owner');
  INSERT INTO public.user_preferences(user_id, active_company_id) VALUES (owner_id, company_a)
    ON CONFLICT(user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id;

  -- The author shares two items.
  PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.company_skills(company_id, created_by, name, description, body)
    VALUES (company_a, owner_id, 'Publicerad', 'Desc', '# Publicerad') RETURNING id INTO published_id;
  INSERT INTO public.company_skills(company_id, created_by, name, description, body)
    VALUES (company_a, owner_id, 'Tillbakaskickad', 'Desc', '# Tillbakaskickad') RETURNING id INTO returned_id;
  UPDATE public.company_skills SET share_status = 'submitted', author_handle = 'withdraw-author', share_confirmed_at = now()
    WHERE id IN (published_id, returned_id);
  BEGIN
    INSERT INTO public.company_skills(company_id, created_by, name, description, body, published_notified_at)
      VALUES (company_a, owner_id, 'Forged', 'Desc', 'Body', now());
    RAISE EXCEPTION 'Author inserted a publish notification';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;

  -- Accounted approves and the sync publishes the first: an exposed atom, linked back.
  INSERT INTO public.agent_atom_registry(id, tier, title, description, body, body_path, trigger_signals, is_active, mcp_exposed)
    VALUES ('community/pg-test-withdraw', 'community', 'Publicerad', 'Desc', '# Publicerad', 'erp-mafia/accounted-skills/community/pg-test-withdraw/SKILL.md',
      jsonb_build_object('kind', 'workflow', 'submission', published_id::text, 'approved_sha', repeat('b', 64)), true, true);
  INSERT INTO public.agent_atom_registry(id, tier, title, description, body, body_path, trigger_signals, is_active, mcp_exposed)
    VALUES ('community/pg-test-bystander', 'community', 'Annan', 'Desc', '# Annan', 'erp-mafia/accounted-skills/community/pg-test-bystander/SKILL.md',
      jsonb_build_object('kind', 'workflow', 'approved_sha', repeat('c', 64)), true, true);
  UPDATE public.company_skills SET share_status = 'published', approved_body_sha = repeat('b', 64), published_atom_id = 'community/pg-test-withdraw',
    reviewed_at = now(), review_url = 'https://github.com/erp-mafia/accounted-skills/tree/main/community/pg-test-withdraw', published_notified_at = now()
    WHERE id = published_id;

  -- The author cannot fake or clear the notification, nor use the old dead-end state.
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.company_skills SET published_notified_at = NULL WHERE id = published_id;
    RAISE EXCEPTION 'Author cleared the publish notification';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.company_skills SET share_status = 'withdrawn' WHERE id = published_id;
    RAISE EXCEPTION 'Author reached the withdrawn state';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;

  -- "Dra tillbaka" on the published item: private again, review evidence gone.
  UPDATE public.company_skills SET share_status = 'private' WHERE id = published_id;
  RESET ROLE;
  SELECT * INTO r FROM public.company_skills WHERE id = published_id;
  IF r.share_status <> 'private' OR r.approved_body_sha IS NOT NULL OR r.published_atom_id IS NOT NULL OR r.reviewed_at IS NOT NULL
    OR r.review_url IS NOT NULL OR r.published_notified_at IS NOT NULL THEN
    RAISE EXCEPTION 'Withdrawn item kept review evidence: %', row_to_json(r);
  END IF;
  -- Its atom stops reaching AIs at once and is marked for removal; the bystander is untouched.
  SELECT * INTO a FROM public.agent_atom_registry WHERE id = 'community/pg-test-withdraw';
  IF a.mcp_exposed OR a.trigger_signals ? 'approved_sha' OR NOT a.trigger_signals ? 'withdrawn_at' OR a.trigger_signals->>'submission' IS DISTINCT FROM published_id::text THEN
    RAISE EXCEPTION 'Withdrawn atom still live: %', row_to_json(a);
  END IF;
  SELECT * INTO a FROM public.agent_atom_registry WHERE id = 'community/pg-test-bystander';
  IF NOT a.mcp_exposed OR a.trigger_signals ? 'withdrawn_at' THEN
    RAISE EXCEPTION 'Unrelated atom was hidden: %', row_to_json(a);
  END IF;
  -- A sync that read the atom before the withdrawal writes its stale copy back: it stays hidden and marked.
  INSERT INTO public.agent_atom_registry(id, tier, title, description, body, body_path, trigger_signals, is_active, mcp_exposed)
    VALUES ('community/pg-test-withdraw', 'community', 'Publicerad', 'Desc', '# Publicerad', 'erp-mafia/accounted-skills/community/pg-test-withdraw/SKILL.md',
      jsonb_build_object('kind', 'workflow', 'submission', published_id::text, 'approved_sha', repeat('b', 64)), true, true)
    ON CONFLICT (id) DO UPDATE SET trigger_signals = EXCLUDED.trigger_signals, mcp_exposed = EXCLUDED.mcp_exposed;
  SELECT * INTO a FROM public.agent_atom_registry WHERE id = 'community/pg-test-withdraw';
  IF a.mcp_exposed OR a.trigger_signals ? 'approved_sha' OR NOT a.trigger_signals ? 'withdrawn_at' THEN
    RAISE EXCEPTION 'A stale sync exposed a withdrawn text again: %', row_to_json(a);
  END IF;

  -- Private again, so the author can edit it, share it anew or delete it.
  SET LOCAL ROLE authenticated;
  UPDATE public.company_skills SET body = '# Publicerad, ny version' WHERE id = published_id;
  UPDATE public.company_skills SET share_status = 'submitted', share_confirmed_at = now() WHERE id = published_id;
  UPDATE public.company_skills SET share_status = 'private' WHERE id = published_id;
  DELETE FROM public.company_skills WHERE id = published_id;
  IF EXISTS (SELECT 1 FROM public.company_skills WHERE id = published_id) THEN
    RAISE EXCEPTION 'Author could not delete a withdrawn item';
  END IF;
  RESET ROLE;

  -- Accounted sends the second back: its note stays for the author, any approval goes.
  UPDATE public.company_skills SET approved_body_sha = repeat('d', 64) WHERE id = returned_id;
  UPDATE public.company_skills SET share_status = 'private', review_note = 'Ta bort kundnamnet' WHERE id = returned_id;
  SELECT * INTO r FROM public.company_skills WHERE id = returned_id;
  IF r.review_note IS DISTINCT FROM 'Ta bort kundnamnet' OR r.approved_body_sha IS NOT NULL THEN
    RAISE EXCEPTION 'Send-back lost its note or kept its approval: %', row_to_json(r);
  END IF;

  -- Shared again and then withdrawn by the author: the old note no longer applies.
  SET LOCAL ROLE authenticated;
  UPDATE public.company_skills SET share_status = 'submitted', share_confirmed_at = now() WHERE id = returned_id;
  UPDATE public.company_skills SET share_status = 'private' WHERE id = returned_id;
  RESET ROLE;
  SELECT * INTO r FROM public.company_skills WHERE id = returned_id;
  IF r.review_note IS NOT NULL THEN
    RAISE EXCEPTION 'Author withdrawal kept an old send-back note: %', row_to_json(r);
  END IF;
END;
$test$;
