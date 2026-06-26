-- Enforce that an enskild firma cannot put its owner or board on payroll.
--
-- An enskild firma is not a separate legal person from its owner, so the owner
-- cannot be their own employee and cannot be paid lön — owner compensation is
-- egna uttag (BAS 2013), booked against equity, never a salary cost.
-- board_member (styrelse) is an aktiebolag concept and likewise doesn't exist
-- for an EF. Ordinary employees (employment_type 'employee') remain fully
-- allowed for an EF that hires staff and book identically to an aktiebolag.
--
-- This trigger is the all-paths backstop (UI route, /api/v1, MCP, direct SQL)
-- for the application-layer guard in lib/salary/employment-rules.ts. The two
-- must agree on the forbidden set: company_owner, board_member. See #782.

CREATE OR REPLACE FUNCTION public.enforce_ef_no_owner_employee()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_entity_type text;
BEGIN
  -- Only owner/board employment types are constrained; ordinary employees are
  -- allowed for every entity type, so leave those untouched.
  IF NEW.employment_type NOT IN ('company_owner', 'board_member') THEN
    RETURN NEW;
  END IF;

  -- Resolve the company's effective entity type: company_settings is the
  -- read-primary source the app uses, with companies as the canonical
  -- fallback (mirrors lib/company/context.getCompanyEntityType()).
  v_entity_type := COALESCE(
    (SELECT cs.entity_type FROM public.company_settings cs WHERE cs.company_id = NEW.company_id),
    (SELECT c.entity_type FROM public.companies c WHERE c.id = NEW.company_id)
  );

  IF v_entity_type = 'enskild_firma' THEN
    RAISE EXCEPTION 'En enskild firma kan inte ha sin ägare eller styrelse som anställd (employment_type=%). Ägaren tar ut pengar via eget uttag (konto 2013), inte lön.', NEW.employment_type
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- Fires on INSERT and on UPDATEs that touch employment_type only — so an
-- unrelated edit to a grandfathered row (created before this guard existed)
-- is never blocked, but setting/keeping an owner type on an EF is.
DROP TRIGGER IF EXISTS trg_enforce_ef_no_owner_employee ON public.employees;
CREATE TRIGGER trg_enforce_ef_no_owner_employee
  BEFORE INSERT OR UPDATE OF employment_type ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ef_no_owner_employee();

NOTIFY pgrst, 'reload schema';
