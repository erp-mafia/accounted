-- Kustom settlement file import (GitHub #2588): the sales and
-- returns of a Kustom settlement report land on the Orders page as rows of
-- their own platform, 'kustom'. Both platform CHECK constraints enumerate the
-- platforms (20260909100400), so without this every insert is refused at the
-- database. Kustom has no connection table: the rows come from a file the
-- user uploads, so nothing else that enumerates the integrations changes.

ALTER TABLE public.webshop_orders
  DROP CONSTRAINT IF EXISTS webshop_orders_platform_check;
ALTER TABLE public.webshop_orders
  ADD CONSTRAINT webshop_orders_platform_check
    CHECK (platform IN ('woocommerce', 'shopify', 'zettle', 'kustom'));

ALTER TABLE public.webshop_store_settings
  DROP CONSTRAINT IF EXISTS webshop_store_settings_platform_check;
ALTER TABLE public.webshop_store_settings
  ADD CONSTRAINT webshop_store_settings_platform_check
    CHECK (platform IN ('woocommerce', 'shopify', 'zettle', 'kustom'));

NOTIFY pgrst, 'reload schema';
