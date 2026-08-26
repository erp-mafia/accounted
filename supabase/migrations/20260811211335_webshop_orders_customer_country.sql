-- Billing country on webshop order rows (ISO 3166-1 alpha-2, e.g. 'SE').
--
-- The booking dialog needs it for the export/EU advisory: a 0%-rate amount
-- on an order with a known non-SE billing country should not silently book
-- to 3004 (ruta 42, domestic momsfri); export/EU sales belong on 31xx/33xx
-- accounts. Advisory only: the user always confirms the lines.

alter table public.webshop_orders
  add column customer_country text;

comment on column public.webshop_orders.customer_country is
  'Billing country (ISO 3166-1 alpha-2) from the store; drives the export/EU booking hint.';

NOTIFY pgrst, 'reload schema';
