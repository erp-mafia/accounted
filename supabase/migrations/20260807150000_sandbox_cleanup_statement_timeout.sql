-- The nightly sandbox cleanup cannot finish inside PostgREST's session cap.
--
-- All PostgREST sessions log in as authenticator, which carries
-- statement_timeout = 8s at the role level, and profiling the repaired
-- teardown (migration 20260807130000) on prod puts one sandbox user at
-- ~3s: the auth.users delete fans out over ~250 FK triggers. FK indexes do
-- not help (verified by replaying with them inside an aborted transaction);
-- the cost is the trigger fan-out itself. One nightly RPC call therefore
-- cleans at most two users before the whole batch times out and ROLLS BACK,
-- which is a second silent-failure mode for the cron this migration chain
-- exists to fix.
--
-- Fix mirrors undo_sie_import (20260702154500, pinned by
-- sie-import.replace.pg.test.ts): a function-local statement_timeout raises
-- the cap for this statement only. CREATE OR REPLACE resets proconfig, so
-- the timeout must be restated if this function is ever replaced again.
-- The cron route passes p_limit sized so a run finishes inside both this
-- 290s cap and the route's maxDuration.

DROP FUNCTION IF EXISTS public.cleanup_expired_sandbox_users(int, int);

CREATE FUNCTION public.cleanup_expired_sandbox_users(
  p_max_age_hours int DEFAULT 24,
  p_limit int DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '290s'
AS $$
DECLARE
  v_user_id uuid;
  v_cleaned integer := 0;
  v_failed integer := 0;
  v_orphans integer := 0;
BEGIN
  FOR v_user_id IN
    SELECT cs.user_id
    FROM public.company_settings cs
    WHERE cs.is_sandbox = true
      AND cs.created_at < now() - interval '1 hour' * p_max_age_hours
    ORDER BY cs.created_at
    LIMIT p_limit
  LOOP
    BEGIN
      PERFORM public.cleanup_sandbox_user(v_user_id);
      v_cleaned := v_cleaned + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      RAISE WARNING 'Failed to clean up sandbox user %: %', v_user_id, SQLERRM;
    END;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users'
      AND column_name = 'is_anonymous'
  ) THEN
    FOR v_user_id IN
      SELECT u.id
      FROM auth.users u
      WHERE u.is_anonymous = true
        AND u.created_at < now() - interval '1 hour' * p_max_age_hours
        AND NOT EXISTS (
          SELECT 1 FROM public.company_settings cs WHERE cs.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companies c WHERE c.created_by = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.company_members cm WHERE cm.user_id = u.id
        )
      ORDER BY u.created_at
      LIMIT p_limit
    LOOP
      BEGIN
        DELETE FROM auth.users WHERE id = v_user_id;
        v_orphans := v_orphans + 1;
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed + 1;
        RAISE WARNING 'Failed to clean up orphaned anonymous user %: %', v_user_id, SQLERRM;
      END;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'cleaned', v_cleaned,
    'failed', v_failed,
    'orphans_removed', v_orphans
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_sandbox_users(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_sandbox_users(int, int) TO service_role;
