-- Validate the activation CHECK added NOT VALID in 20260907143000: existing
-- rows were already conformed there, and VALIDATE takes only SHARE UPDATE
-- EXCLUSIVE, so writes keep flowing while it scans.
alter table public.woocommerce_connections
  validate constraint woocommerce_connections_active_requires_both_signals;

-- browser_confirmed_at is one of the two signals the activation CHECK
-- (20260907143000) requires. It is written by the wc-auth return leg and by
-- the manual key-entry route, both on the service role. Every other write
-- path is a company member's own PostgREST session, and the row-scoped RLS
-- policy would let any writer of the company set the timestamp on a
-- colleague's pending row and so flip it active without the initiator.
--
-- A trigger rather than column privileges: authenticated holds table-level
-- INSERT/UPDATE, and a column-level REVOKE is inert next to a table-level
-- grant (the alternative, revoke-all-then-regrant-per-column, breaks every
-- time a column is added). The trigger keys on the JWT role claim like
-- enforce_company_writer_role (20260902093000): service role, pg_cron and
-- migrations pass, end-user sessions cannot write the column.

CREATE OR REPLACE FUNCTION public.woocommerce_browser_confirmation_server_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT public.jwt_caller_is_end_user() OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.browser_confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'browser_confirmed_at is written by the server only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.browser_confirmed_at IS DISTINCT FROM OLD.browser_confirmed_at THEN
    RAISE EXCEPTION 'browser_confirmed_at is written by the server only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ab_browser_confirmation_server_only ON public.woocommerce_connections;
CREATE TRIGGER ab_browser_confirmation_server_only
  BEFORE INSERT OR UPDATE ON public.woocommerce_connections
  FOR EACH ROW EXECUTE FUNCTION public.woocommerce_browser_confirmation_server_only();

NOTIFY pgrst, 'reload schema';
