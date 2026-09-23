-- Shared by pg-real and the staging MCP verification. All fixtures roll back.
BEGIN;
DO $$
DECLARE
  u uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  a jsonb;
  b jsonb;
  old_company uuid;
  attempt uuid;
BEGIN
  INSERT INTO auth.users(id, email, instance_id, is_anonymous)
    VALUES (u, u::text || '@test.invalid', '00000000-0000-0000-0000-000000000000', true),
           (other_user, other_user::text || '@test.invalid', '00000000-0000-0000-0000-000000000000', false);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  SET LOCAL ROLE authenticated;
  a := public.claim_sandbox_seed();
  ASSERT a->>'status' = 'running', 'first request must claim';
  old_company := (a->>'company_id')::uuid;
  attempt := (a->>'attempt_id')::uuid;
  ASSERT (SELECT active_company_id = old_company FROM public.user_preferences WHERE user_id = u);
  ASSERT (SELECT is_sandbox FROM public.company_settings WHERE company_id = old_company);
  ASSERT (public.claim_sandbox_seed()->>'status') = 'busy', 'second request must not seed';
  ASSERT NOT public.finish_sandbox_seed(gen_random_uuid(), true), 'wrong token must not finish';
  ASSERT public.finish_sandbox_seed(attempt, false), 'failed attempt must release';
  b := public.claim_sandbox_seed();
  ASSERT b->>'status' = 'running';
  ASSERT b->>'company_id' <> a->>'company_id', 'retry must use a fresh company';
  -- Active-company RLS intentionally hides the previous archived company.
  RESET ROLE;
  ASSERT EXISTS (SELECT 1 FROM public.companies WHERE id = old_company AND archived_at IS NOT NULL);
  ASSERT EXISTS (SELECT 1 FROM public.company_settings WHERE company_id = old_company), 'preserve partial data';
  SET LOCAL ROLE authenticated;
  ASSERT NOT public.finish_sandbox_seed(attempt, true), 'old worker cannot finish new attempt';
  ASSERT public.finish_sandbox_seed((b->>'attempt_id')::uuid, true);
  ASSERT NOT public.finish_sandbox_seed((b->>'attempt_id')::uuid, false), 'late error cannot downgrade success';
  ASSERT public.claim_sandbox_seed()->>'status' = 'complete';
  ASSERT public.claim_sandbox_seed()->>'company_id' = b->>'company_id';
  BEGIN
    UPDATE public.sandbox_seed_attempts SET status = 'complete' WHERE user_id = u;
    RAISE EXCEPTION 'direct state writes must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', other_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', other_user, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  ASSERT NOT EXISTS (SELECT 1 FROM public.sandbox_seed_attempts WHERE user_id = u), 'state must be isolated';
  BEGIN
    PERFORM public.claim_sandbox_seed();
    RAISE EXCEPTION 'registered user must be denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.finish_sandbox_seed((b->>'attempt_id')::uuid, true);
    RAISE EXCEPTION 'registered user must not finish';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  -- Expired workers are replaced, retaining their partial data.
  UPDATE public.sandbox_seed_attempts SET status = 'running', started_at = now() - interval '16 minutes' WHERE user_id = u;
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  SET LOCAL ROLE authenticated;
  a := public.claim_sandbox_seed();
  ASSERT a->>'status' = 'running';
  ASSERT a->>'company_id' <> b->>'company_id';
  RESET ROLE;
END $$;
ROLLBACK;
