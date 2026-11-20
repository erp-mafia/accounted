-- The active-company resolution also reports the caller's role there.
-- pg-test: tests/pg/resolve-active-company-role.pg.test.ts
--
-- WHY
-- ---
-- Every write route (withRouteContext({ requireWrite: true })) paid two
-- sequential round trips before its handler ran: resolve_active_company()
-- (or its seat-gated twin) to learn WHICH company is active, then a
-- company_members select to learn the caller's ROLE there, to refuse
-- viewers. Both read the same company_members row: the resolution already
-- joins it to validate the preference and to pick the fallback. This
-- migration returns that row's role next to the company, so the write guard
-- needs no second query (lib/auth/require-write.ts takes a known role).
--
-- WHAT CHANGES
-- ------------
-- One column, role text, appended LAST to the RETURNS TABLE of both
--   public.resolve_active_company()                  (20260723161000)
--   public.resolve_active_company_gated(integer)     (20260901081417)
-- Each body is copied VERBATIM from that file with exactly two edits: the
-- validated and fallback CTEs also select cm.role, and the final SELECT adds
-- COALESCE(validated role, fallback role) AS role. company_members.role is
-- NOT NULL and (company_id, user_id) is UNIQUE, so the role always belongs
-- to the same membership row as the returned company_id, and it is NULL
-- exactly when company_id is NULL. company_id, locale, used_fallback and
-- has_locked_membership are untouched, so the invariants in the headers of
-- those two files still hold (in particular: company_id stays semantically
-- identical to current_active_company_id(), which RLS reads).
--
-- ROLLING DEPLOY
-- --------------
-- CREATE OR REPLACE cannot change a RETURNS TABLE, so each function is
-- dropped and re-created under the SAME name and argument list (precedent:
-- 20260928112724, validate_and_increment_api_key). This is safe in both
-- orders the merge can land in:
--   * new database, old code: the old code reads company_id, locale and
--     used_fallback by name and ignores the extra column. supabase db push
--     runs the file as one implicit transaction, so no caller ever sees the
--     function missing between the DROP and the CREATE.
--   * new code, old database (Vercel live before CI applies this, or a
--     self-hosted instance not migrated yet): the row has no role key, the
--     app treats the role as unknown and reads it from company_members as
--     it does today. Same behavior and cost as before, never a failure.
-- A new function name was the alternative and is worse: during the window
-- the new code would get PGRST202, which getActiveCompanyId answers with the
-- UNGATED query path (fail open on the seat gate, and slower than today),
-- and a second resolver would have to be kept identical to
-- current_active_company_id() until the old one is dropped in a follow-up.
--
-- GRANTS
-- ------
-- A dropped function takes its ACL with it. Each CREATE runs under the same
-- default privileges its original did (functions were left out of
-- 20260929220000_own_default_privileges), and the REVOKE/GRANT lines below
-- are the ones those files ran, so the resulting ACL is today's: EXECUTE for
-- authenticated (and service_role through the platform default), none for
-- PUBLIC or anon. SECURITY DEFINER, STABLE and the pinned search_path are
-- unchanged.

-- =============================================================================
-- 1. resolve_active_company()
-- =============================================================================
DROP FUNCTION IF EXISTS public.resolve_active_company();

CREATE FUNCTION public.resolve_active_company()
  RETURNS TABLE(company_id uuid, locale text, used_fallback boolean, role text)
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  WITH pref AS (
    SELECT up.active_company_id, up.locale
    FROM public.user_preferences up
    WHERE up.user_id = auth.uid()
  ),
  validated AS (
    SELECT cm.company_id, cm.role
    FROM pref p
    JOIN public.company_members cm
      ON cm.user_id = auth.uid() AND cm.company_id = p.active_company_id
    JOIN public.companies c
      ON c.id = cm.company_id AND c.archived_at IS NULL
    LIMIT 1
  ),
  fallback AS (
    SELECT cm.company_id, cm.role
    FROM public.company_members cm
    JOIN public.companies c
      ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = auth.uid()
    ORDER BY cm.created_at ASC
    LIMIT 1
  )
  SELECT
    COALESCE((SELECT v.company_id FROM validated v), (SELECT f.company_id FROM fallback f)) AS company_id,
    (SELECT p.locale FROM pref p) AS locale,
    ((SELECT v.company_id FROM validated v) IS NULL) AS used_fallback,
    COALESCE((SELECT v.role FROM validated v), (SELECT f.role FROM fallback f)) AS role
  WHERE auth.uid() IS NOT NULL;
$function$;

REVOKE ALL ON FUNCTION public.resolve_active_company() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_active_company() TO authenticated;

-- =============================================================================
-- 2. resolve_active_company_gated(grace_days)
-- =============================================================================
DROP FUNCTION IF EXISTS public.resolve_active_company_gated(integer);

CREATE FUNCTION public.resolve_active_company_gated(p_grace_days integer)
  RETURNS TABLE(company_id uuid, locale text, used_fallback boolean, has_locked_membership boolean, role text)
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  WITH pref AS (
    SELECT up.active_company_id, up.locale
    FROM public.user_preferences up
    WHERE up.user_id = auth.uid()
  ),
  validated AS (
    SELECT cm.company_id, cm.role
    FROM pref p
    JOIN public.company_members cm
      ON cm.user_id = auth.uid() AND cm.company_id = p.active_company_id
    JOIN public.companies c
      ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.role = 'owner' OR public.company_multi_user_ok(cm.company_id, p_grace_days)
    LIMIT 1
  ),
  fallback AS (
    SELECT cm.company_id, cm.role
    FROM public.company_members cm
    JOIN public.companies c
      ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = auth.uid()
      AND (cm.role = 'owner' OR public.company_multi_user_ok(cm.company_id, p_grace_days))
    ORDER BY cm.created_at ASC
    LIMIT 1
  ),
  resolved AS (
    SELECT COALESCE(
      (SELECT v.company_id FROM validated v),
      (SELECT f.company_id FROM fallback f)
    ) AS company_id
  )
  SELECT
    (SELECT r.company_id FROM resolved r) AS company_id,
    (SELECT p.locale FROM pref p) AS locale,
    ((SELECT v.company_id FROM validated v) IS NULL) AS used_fallback,
    CASE
      WHEN (SELECT r.company_id FROM resolved r) IS NOT NULL THEN false
      ELSE EXISTS (
        SELECT 1
        FROM public.company_members cm
        JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
        WHERE cm.user_id = auth.uid()
          AND cm.role <> 'owner'
          AND NOT public.company_multi_user_ok(cm.company_id, p_grace_days)
      )
    END AS has_locked_membership,
    COALESCE((SELECT v.role FROM validated v), (SELECT f.role FROM fallback f)) AS role
  WHERE auth.uid() IS NOT NULL;
$function$;

REVOKE ALL ON FUNCTION public.resolve_active_company_gated(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_active_company_gated(integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
