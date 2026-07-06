-- NULL-safe tenant guards across all SECURITY DEFINER company-scoped
-- functions (mcp_optimization_plan P2-3 follow-up from PR #872 review).
--
-- The house guard pattern `p_company_id NOT IN (SELECT public.user_company_ids())`
-- evaluates to UNKNOWN — and the deny branch silently does not fire — when
-- either side yields NULL. Not exploitable today (company_members.company_id
-- is NOT NULL so the set never contains NULLs), but a NULL p_company_id
-- skips the guard, and the shape breaks silently if the membership helper
-- ever changes. 9 live functions carried the pattern at authoring time.
--
-- Fix in two parts:
--   1. caller_is_company_member(uuid) — the NULL-safe membership predicate
--      (NULL company → false, always).
--   2. A mechanical rewrite: every public function whose source contains the
--      raw pattern is re-created via pg_get_functiondef with the guard line
--      swapped to the helper. Mechanical-over-hand-copied is deliberate —
--      reproducing 9 function bodies by hand is the same stale-copy hazard
--      that caused the 2026-07-03 constraint clobber. The rewrite is
--      validated three ways: the pg-real ratchet test asserts no function
--      retains the raw pattern after full migration replay, the existing
--      tenant-guard suites re-assert deny semantics on these exact
--      functions, and prod is verified 9 → 0 after apply.
--
-- pg-test: tests/pg/null-safe-tenant-guards.pg.test.ts

CREATE OR REPLACE FUNCTION public.caller_is_company_member(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT p_company_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_company_ids() AS c(id) WHERE c.id = p_company_id
  )
$$;

REVOKE ALL ON FUNCTION public.caller_is_company_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_is_company_member(uuid) TO authenticated, service_role;

DO $$
DECLARE
  fn record;
  def text;
  new_def text;
  rewritten integer := 0;
BEGIN
  FOR fn IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosrc LIKE '%NOT IN (SELECT public.user_company_ids())%'
  LOOP
    def := pg_get_functiondef(fn.oid);
    new_def := regexp_replace(
      def,
      '([a-zA-Z_][a-zA-Z0-9_.]*)\s+NOT IN \(SELECT public\.user_company_ids\(\)\)',
      'NOT public.caller_is_company_member(\1)',
      'g'
    );
    IF new_def <> def THEN
      EXECUTE new_def;
      rewritten := rewritten + 1;
      RAISE NOTICE 'null_safe_tenant_guards: rewrote %', fn.proname;
    END IF;
  END LOOP;
  RAISE NOTICE 'null_safe_tenant_guards: rewrote % function(s) total', rewritten;
END;
$$;

NOTIFY pgrst, 'reload schema';
