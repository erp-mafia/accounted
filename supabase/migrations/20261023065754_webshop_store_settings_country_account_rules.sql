-- Per-store account rules by destination country for webshop orders: which
-- sales and VAT account an order's VAT bucket books to when a Shopify order
-- ships outside Sweden (OSS to other EU countries, export or VOEC outside the
-- EU). An array of rules shaped like WebshopCountryAccountRule
-- (lib/webshop-orders/country-routing.ts); the settings route validates each
-- rule against the company's chart before it is stored.
--
-- Prefill and sweep policy only, like payment_method_account_map beside it:
-- the single booking dialog shows the routed lines for review, and the bulk
-- sweep books an order shipped abroad only when a rule covers every VAT
-- bucket. Nothing auto-books. No RLS change: the row's member policies cover
-- the new column.

alter table public.webshop_store_settings
  add column country_account_rules jsonb not null default '[]'::jsonb;

alter table public.webshop_store_settings
  add constraint webshop_store_settings_country_account_rules_is_array
  check (jsonb_typeof(country_account_rules) = 'array');

comment on column public.webshop_store_settings.country_account_rules is
  'Sales and VAT account per destination country (and optionally VAT rate) for orders shipped outside Sweden. Prefill and bulk-sweep policy only; never auto-books.';

NOTIFY pgrst, 'reload schema';
