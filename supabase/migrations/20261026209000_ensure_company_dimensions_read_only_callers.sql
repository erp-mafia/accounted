-- ensure_company_dimensions: a read stays a read.
--
-- GET /api/dimensions (and every page that loads the registry through the
-- reference-data hook, the voucher page among them) calls
-- ensure_company_dimensions before it reads. For a viewer that call failed
-- with 42501 "row-level security: no write access to company ... for INSERT
-- on dimensions", so the read-only role could not list dimensions at all.
--
-- The system dimensions were NOT missing. Every company that hit the error
-- already had dims 1 and 6, seeded days before. The function always
-- proposed both rows and relied on ON CONFLICT DO NOTHING to skip the
-- existing ones, but row-level BEFORE INSERT triggers run before the
-- conflict check. aa_enforce_company_writer_role (20260902093000) is such a
-- trigger, keyed on the JWT role so it also fires inside SECURITY DEFINER
-- bodies, and it refuses a viewer for a row that would never have been
-- inserted.
--
-- The function now:
--   1. returns at once when both system dimensions exist: no row is
--      proposed, so no trigger runs and nothing is written;
--   2. returns without seeding when the caller is an end user who may not
--      write the company (the exact predicate the writer-role trigger uses):
--      the caller reads whatever registry exists, and the next writer who
--      opens a dimension-aware page seeds it as before;
--   3. otherwise inserts only the rows that are missing. ON CONFLICT stays
--      for two writers racing on the first seed.
--
-- Membership guard, grants, owner and SECURITY DEFINER are unchanged
-- (CREATE OR REPLACE keeps owner, ACL and comment). Write paths that call
-- the function before their own insert (createDimension, the staged
-- create_dimension_value, importing existing codes) still refuse a viewer:
-- at their real write, through the same trigger.
--
-- No backfill and no seeding at company creation: the lazy seed is the
-- substrate's design (core stays zero-config), the system dims are
-- undeletable (enforce_dimension_registry_guards) so a creation-time seed
-- would block the rollback delete in createCompanyCore, and none of the
-- failures was a missing row.
--
-- pg-test: covered-by tests/pg/dimensions-substrate.pg.test.ts

CREATE OR REPLACE FUNCTION public.ensure_company_dimensions(p_company_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Tenant guard: authenticated callers must be members of the company.
  -- Service-role callers (auth.uid() IS NULL) are trusted: server code scopes
  -- by company_id (defense-in-depth pattern used across the codebase).
  IF auth.uid() IS NOT NULL
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'not a member of company %', p_company_id;
  END IF;

  -- Both present: nothing to seed and nothing proposed. ON CONFLICT DO
  -- NOTHING alone is not enough, since BEFORE INSERT row triggers (the
  -- writer-role gate) run before the conflict check.
  IF (SELECT count(*) FROM public.dimensions
      WHERE company_id = p_company_id AND sie_dim_no IN (1, 6)) = 2 THEN
    RETURN;
  END IF;

  -- A read-only member cannot seed: same predicate as
  -- enforce_company_writer_role. The caller reads what exists.
  IF public.jwt_caller_is_end_user()
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RETURN;
  END IF;

  INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, sort_order)
  SELECT p_company_id, v.sie_dim_no, v.name, v.resets_annually, true, v.sort_order
  FROM (VALUES
    (1, 'Kostnadsställe', true,  10),
    (6, 'Projekt',        false, 20)
  ) AS v(sie_dim_no, name, resets_annually, sort_order)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.dimensions d
    WHERE d.company_id = p_company_id AND d.sie_dim_no = v.sie_dim_no
  )
  ON CONFLICT (company_id, sie_dim_no) DO NOTHING;
END;
$function$;
