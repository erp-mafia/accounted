-- Sandbox cleanup: every failed teardown comes back with its reason.
-- pg-test: tests/pg/sandbox-cleanup-failure-reasons.pg.test.ts
--
-- The nightly cron (cron.sandbox_cleanup) logs "sandbox cleanup completed
-- with failures" every night, with the same two users failing, and nobody can
-- say why: cleanup_expired_sandbox_users catches each failed
-- cleanup_sandbox_user call, counts it and writes the error text only as a
-- Postgres WARNING. The cron sees a number; the reason stays in a log nobody
-- reads. That is how the teardown sat broken for weeks twice before
-- (20260807130000, 20260927220000).
--
-- Mechanism, not symptom: a refusal that is correct by design (a sandbox user
-- who also owns a real company, a sandbox holding a record of an exchange
-- with Skatteverket, Bolagsverket or the Peppol network) and a teardown gap (a
-- new RESTRICT foreign key or WORM guard) look the same from outside. Only the
-- error tells them apart, so the error travels with the result.
--
-- The one change: each failure (sandbox teardown or orphan sweep) is appended
-- to a `failures` array in the returned summary, with the user id, the
-- SQLSTATE, the message, the table and constraint when Postgres names them
-- (foreign key and check violations do), and the error context, which names
-- the guard function and the teardown statement that hit it. The row detail
-- (PG_EXCEPTION_DETAIL) is left out on purpose: for a check or unique
-- violation it carries the failing row's values. The WARNING stays.
--
-- Everything else is copied from 20260927220000 (the latest definition):
-- same signature and return type, so CREATE OR REPLACE keeps the callers.
-- The function-local statement_timeout is restated: CREATE OR REPLACE
-- resets proconfig. The cron route reads `failures` only when present, so
-- either deploy order keeps working.

CREATE OR REPLACE FUNCTION public.cleanup_expired_sandbox_users(
  p_max_age_hours int DEFAULT 24,
  p_limit int DEFAULT NULL,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '290s'
AS $$
DECLARE
  v_user_id uuid;
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_attempted integer := 0;
  v_cleaned integer := 0;
  v_sandbox_failed integer := 0;
  v_failed integer := 0;
  v_orphans integer := 0;
  v_failures jsonb := '[]'::jsonb;
  v_sqlstate text;
  v_message text;
  v_schema text;
  v_table text;
  v_constraint text;
  v_context text;
BEGIN
  FOR v_user_id IN
    SELECT cs.user_id
    FROM public.company_settings cs
    WHERE cs.is_sandbox = true
    GROUP BY cs.user_id
    HAVING min(cs.created_at) < now() - interval '1 hour' * p_max_age_hours
    ORDER BY min(cs.created_at), cs.user_id
    OFFSET v_offset
    LIMIT p_limit
  LOOP
    v_attempted := v_attempted + 1;
    BEGIN
      PERFORM public.cleanup_sandbox_user(v_user_id);
      v_cleaned := v_cleaned + 1;
    EXCEPTION WHEN OTHERS THEN
      v_sandbox_failed := v_sandbox_failed + 1;
      GET STACKED DIAGNOSTICS
        v_sqlstate = RETURNED_SQLSTATE,
        v_message = MESSAGE_TEXT,
        v_schema = SCHEMA_NAME,
        v_table = TABLE_NAME,
        v_constraint = CONSTRAINT_NAME,
        v_context = PG_EXCEPTION_CONTEXT;
      v_failures := v_failures || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'user_id', v_user_id,
        'kind', 'sandbox',
        'sqlstate', v_sqlstate,
        'message', left(v_message, 500),
        'table', CASE WHEN NULLIF(v_table, '') IS NOT NULL
                      THEN concat_ws('.', NULLIF(v_schema, ''), v_table) END,
        'constraint', NULLIF(v_constraint, ''),
        'context', left(NULLIF(v_context, ''), 1000)
      )));
      RAISE WARNING 'Failed to clean up sandbox user %: %', v_user_id, SQLERRM;
    END;
  END LOOP;
  v_failed := v_sandbox_failed;

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
        GET STACKED DIAGNOSTICS
          v_sqlstate = RETURNED_SQLSTATE,
          v_message = MESSAGE_TEXT,
          v_schema = SCHEMA_NAME,
          v_table = TABLE_NAME,
          v_constraint = CONSTRAINT_NAME,
          v_context = PG_EXCEPTION_CONTEXT;
        v_failures := v_failures || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'user_id', v_user_id,
          'kind', 'orphan',
          'sqlstate', v_sqlstate,
          'message', left(v_message, 500),
          'table', CASE WHEN NULLIF(v_table, '') IS NOT NULL
                        THEN concat_ws('.', NULLIF(v_schema, ''), v_table) END,
          'constraint', NULLIF(v_constraint, ''),
          'context', left(NULLIF(v_context, ''), 1000)
        )));
        RAISE WARNING 'Failed to clean up orphaned anonymous user %: %', v_user_id, SQLERRM;
      END;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'cleaned', v_cleaned,
    'failed', v_failed,
    'orphans_removed', v_orphans,
    'attempted', v_attempted,
    'next_offset', v_offset + v_sandbox_failed,
    'failures', v_failures
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_sandbox_users(int, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_sandbox_users(int, int, int) TO service_role;

NOTIFY pgrst, 'reload schema';
