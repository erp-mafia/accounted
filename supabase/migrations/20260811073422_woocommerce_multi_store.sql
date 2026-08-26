-- Multi-store WooCommerce: a company may connect several stores.
--
-- The Orders page is built around users running multiple webshops, so the
-- one-active-connection-per-company limit falls. The other uniqueness stays:
-- a store may still be actively connected to at most ONE company (two
-- companies importing the same order stream would double-book it), and the
-- (company_id, external_id) unique index on webshop_orders / transactions
-- keeps per-company dedup intact regardless of connection count.

drop index if exists public.woocommerce_connections_one_active_per_company;
