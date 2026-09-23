-- Include active zettle_connections in get_dashboard_nav_flags.has_webshop
-- so the Orders nav row appears after a Zettle connect (parity with
-- WooCommerce / Shopify probes in 20260826120000).

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
        SELECT 1 FROM public.zettle_connections z
        WHERE z.company_id = p_company_id AND z.status = 'active'
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

COMMENT ON FUNCTION public.get_dashboard_nav_flags(uuid) IS
  'Dashboard nav visibility flags (webshop, mileage) for one company in one round trip. SECURITY INVOKER: RLS applies.';

NOTIFY pgrst, 'reload schema';
