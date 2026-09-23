-- Activation is server-only. Two things an end-user session (JWT role anon or
-- authenticated) must never do on woocommerce_connections:
--
--   1. write browser_confirmed_at, one of the two signals the activation
--      CHECK (20260907143000) requires: the row-scoped RLS policy would let
--      any writer of the company supply the initiator's signal on a
--      colleague's pending row;
--   2. move a row INTO status 'active' at all: the CHECK only proves both
--      signals are present, while the 15-minute handshake TTL lives in the
--      server's conditional activation update (activateIfComplete), so a
--      direct UPDATE ... SET status = 'active' from PostgREST would flip a
--      fully staged but expired row.
--
-- Both server paths (the wc-auth return leg and manual key entry) run on the
-- service role, as do the cron and migrations. Leaving 'active' (disconnect,
-- supersede, the sync marking a revoked key) stays member-writable.
--
-- A trigger rather than column privileges: authenticated holds table-level
-- INSERT/UPDATE, and a column-level REVOKE is inert next to a table-level
-- grant (the alternative, revoke-all-then-regrant-per-column, breaks every
-- time a column is added). It keys on the JWT role claim exactly like
-- enforce_company_writer_role (20260902093000). Installed BEFORE the CHECK
-- below is validated, so at no point is the gate enforced with the signal
-- still member-writable.

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

  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
    RAISE EXCEPTION 'woocommerce_connections are activated by the server only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ab_browser_confirmation_server_only ON public.woocommerce_connections;
CREATE TRIGGER ab_browser_confirmation_server_only
  BEFORE INSERT OR UPDATE ON public.woocommerce_connections
  FOR EACH ROW EXECUTE FUNCTION public.woocommerce_browser_confirmation_server_only();

-- Only now, with the signal and the transition server-only, validate the
-- activation CHECK added NOT VALID in 20260907143000. Existing rows were
-- already conformed there; VALIDATE takes SHARE UPDATE EXCLUSIVE, so writes
-- keep flowing while it scans.
alter table public.woocommerce_connections
  validate constraint woocommerce_connections_active_requires_both_signals;

NOTIFY pgrst, 'reload schema';
