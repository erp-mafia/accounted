-- Per-store webshop booking settings: payment-method -> account mapping that
-- prefills the order booking dialog (prefill only; the user always confirms,
-- and per-booking overrides persist only via the explicit "remember" opt-in).
--
-- Keyed by (company_id, platform, store_scope) rather than hung off
-- woocommerce_connections: the core booking route must read it without
-- touching extension-owned connection state, the mapping must survive
-- disconnect/reconnect (connections are revoked, never deleted, and can be
-- re-created), and Shopify reuses it with zero schema change.

create table public.webshop_store_settings (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  platform    text not null check (platform in ('woocommerce', 'shopify')),
  store_scope text not null,
  -- { "<payment_method>": {"mode": "book", "account": "1930"}
  --   | {"mode": "invoice"} }
  -- Account numbers are strings (identifiers, not quantities).
  payment_method_account_map jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, platform, store_scope)
);

create index idx_webshop_store_settings_company_id
  on public.webshop_store_settings (company_id);

alter table public.webshop_store_settings enable row level security;

-- Member-scoped config with upsert semantics; no DELETE policy needed (a
-- cleared mapping is an empty map, not a deleted row).
create policy "members read webshop_store_settings"
  on public.webshop_store_settings for select
  using (company_id in (select public.user_company_ids()));

create policy "members insert webshop_store_settings"
  on public.webshop_store_settings for insert
  with check (
    company_id in (select public.user_company_ids())
    and user_id = auth.uid()
  );

create policy "members update webshop_store_settings"
  on public.webshop_store_settings for update
  using (company_id in (select public.user_company_ids()))
  with check (company_id in (select public.user_company_ids()));

create trigger set_updated_at_webshop_store_settings
  before update on public.webshop_store_settings
  for each row execute function public.update_updated_at_column();

create trigger audit_webshop_store_settings
  after insert or update or delete on public.webshop_store_settings
  for each row execute function public.write_audit_log();

comment on table public.webshop_store_settings is
  'Per-store payment-method -> BAS account mapping for webshop order booking. Prefill only; never auto-books.';

NOTIFY pgrst, 'reload schema';
