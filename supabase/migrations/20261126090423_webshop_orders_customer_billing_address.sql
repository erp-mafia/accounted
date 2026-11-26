-- Billing address on webshop order rows: the street lines, postal code and
-- city the store sent with the order (WooCommerce billing.address_1,
-- address_2, postcode and city). A customer that Skapa faktura creates from
-- the order gets it on its card, so the draft invoice carries the buyer's
-- address instead of the user typing it in. A matched or chosen customer
-- keeps the address its card already has.
--
-- WooCommerce order rows only. Shopify rows carry no contact details on
-- purpose (the invoice dialog fetches them from the store), and Zettle,
-- Kustom and refund rows never become an invoice. Existing rows read null
-- until the sync reads their order again.
--
-- Not financial fields: the freeze trigger does not cover them. The sync
-- refreshes them like the other customer fields, never on a booked,
-- invoiced or manually marked row.

alter table public.webshop_orders
  add column customer_address_line1 text,
  add column customer_address_line2 text,
  add column customer_postal_code text,
  add column customer_city text;

comment on column public.webshop_orders.customer_address_line1 is
  'Billing address, first street line, from the store (WooCommerce billing.address_1); prefills a customer created from the order.';
comment on column public.webshop_orders.customer_address_line2 is
  'Billing address, second street line, from the store (WooCommerce billing.address_2).';
comment on column public.webshop_orders.customer_postal_code is
  'Billing postal code from the store (WooCommerce billing.postcode).';
comment on column public.webshop_orders.customer_city is
  'Billing city from the store (WooCommerce billing.city).';

NOTIFY pgrst, 'reload schema';
