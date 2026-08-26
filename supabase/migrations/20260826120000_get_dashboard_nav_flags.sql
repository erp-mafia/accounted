-- get_dashboard_nav_flags(p_company_id): the two booleans the dashboard
-- layout needs to decide whether to render the Webshop and Körjournal nav
-- rows, in ONE round trip instead of four limit-1 selects on the critical
-- path of every hard load (woocommerce_connections, shopify_connections,
-- webshop_orders, mileage_trips).
--
-- SECURITY INVOKER: RLS on the four tables applies as usual, so a caller who
-- is not a member of p_company_id sees (false, false), never another
-- company's flags. STABLE: pure reads. EXECUTE only for authenticated.
--
-- Responsiveness plan 2026-08-26, track B4 (dashboard layout diet).

CREATE OR REPLACE FUNCTION public.get_dashboard_nav_flags(p_company_id uuid)
RETURNS TABLE(has_webshop boolean, has_mileage_trips boolean)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT
    (
      EXISTS (
        SELECT 1 FROM public.woocommerce_connections w
        WHERE w.company_id = p_company_id AND w.status = 'active'
      )
      OR EXISTS (
        SELECT 1 FROM public.shopify_connections s
        WHERE s.company_id = p_company_id AND s.status = 'active'
      )
      OR EXISTS (
        SELECT 1 FROM public.webshop_orders o
        WHERE o.company_id = p_company_id
      )
    ) AS has_webshop,
    EXISTS (
      SELECT 1 FROM public.mileage_trips m
      WHERE m.company_id = p_company_id
    ) AS has_mileage_trips;
$$;

REVOKE ALL ON FUNCTION public.get_dashboard_nav_flags(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dashboard_nav_flags(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_nav_flags(uuid) TO authenticated;

COMMENT ON FUNCTION public.get_dashboard_nav_flags(uuid) IS
  'Dashboard nav visibility flags (webshop, mileage) for one company in one round trip. SECURITY INVOKER: RLS applies.';

NOTIFY pgrst, 'reload schema';
