-- Whether nothing on a webshop order needs shipping (Shopify: every line's
-- requiresShipping is false, as for digital products and services). The
-- order row and its refund rows carry it. The country rules read it
-- (src/lib/webshop-orders/country-routing.ts): an order with nothing to ship
-- books a sale abroad on the services account where a rule names a goods
-- account (3305 ruta 40 for 3105 ruta 36, 3308 ruta 39 for 3108 ruta 35).
--
-- Not a financial field: the freeze trigger does not cover it. Existing rows
-- read false (goods, the booking they had) until the sync reads them again.

alter table public.webshop_orders
  add column ships_nothing boolean not null default false;

comment on column public.webshop_orders.ships_nothing is
  'Shopify: no line of the order needs shipping (digital products, services); refund rows take their order''s. False when a line ships, when unknown, and for other platforms.';

NOTIFY pgrst, 'reload schema';
