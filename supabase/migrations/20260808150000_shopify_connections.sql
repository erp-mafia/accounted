-- Shopify store connections: per-company Shopify custom-app credentials for
-- the order/refund transaction feed (extensions/general/shopify).
--
-- Shopify discontinued admin-created custom apps with revealable shpat_
-- tokens on 2026-01-01. The merchant instead creates a custom app in their
-- own Dev Dashboard and pastes its client id/secret; the server exchanges
-- those for a ~24h access token per run (client credentials grant), so only
-- the client id/secret are stored, AES-256-GCM encrypted with a dedicated
-- server-side key (SHOPIFY_CREDENTIALS_ENCRYPTION_KEY), never in plaintext.
-- The encrypted blobs are useless without that env key, mirroring the
-- WooCommerce credential store (20260806170000).
--
-- Modeled on woocommerce_connections: same status lifecycle, same
-- member-scoped RLS, no DELETE policy (connections are revoked, never
-- deleted, for audit). Like the sibling tables there is no write_audit_log
-- trigger: this is connection state, not accounting data, and audit-logging
-- rows that carry encrypted credentials would copy secret ciphertext into
-- audit_log. The 'pending' status is unused by the current paste-credentials
-- flow but kept for lifecycle parity (a future OAuth-app flow needs it).

create table public.shopify_connections (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  user_id                  uuid not null references auth.users(id) on delete cascade,
  -- Normalized myshopify.com domain, lowercased, no scheme/path. The Admin
  -- API only lives on *.myshopify.com, so this doubles as the SSRF guard.
  shop_domain              text not null,
  -- Shop display name for the settings panel.
  shop_name                text,
  -- AES-256-GCM encrypted Dev Dashboard custom-app client id/secret.
  client_id_encrypted      text,
  client_secret_encrypted  text,
  status                   text not null default 'pending'
                             check (status in ('pending', 'active', 'revoked', 'error')),
  -- ISO 4217 shop currency read at connect time; drives the feed's cash account.
  currency                 text,
  -- Opt-in for the nightly order feed cron (the manual sync button ignores it).
  transaction_sync_enabled boolean not null default false,
  -- Order-polling cursor: max updatedAt processed. Re-polled with a 24h
  -- overlap; (company_id, external_id) dedup makes overlaps no-ops.
  last_order_synced_at     timestamptz,
  error_message            text,
  connected_at             timestamptz,
  disconnected_at          timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- One active connection per company.
create unique index shopify_connections_one_active_per_company
  on public.shopify_connections (company_id) where (status = 'active');

-- A store may be actively connected to at most one company: two companies
-- importing the same order stream would double-book it.
create unique index shopify_connections_shop_active_uniq
  on public.shopify_connections (shop_domain) where (status = 'active');

create index idx_shopify_connections_company_id
  on public.shopify_connections (company_id);

alter table public.shopify_connections enable row level security;

-- Members read their company's connection. Insert/update are member-scoped so
-- the connect/disconnect routes can run on the user's cookie session; the
-- sync cron uses the service role (bypasses RLS).
-- No DELETE policy: connections are revoked (status flip), never deleted.
create policy "members read shopify_connections"
  on public.shopify_connections for select
  using (company_id in (select public.user_company_ids()));

create policy "members insert shopify_connections"
  on public.shopify_connections for insert
  with check (
    company_id in (select public.user_company_ids())
    and user_id = auth.uid()
  );

create policy "members update shopify_connections"
  on public.shopify_connections for update
  using (company_id in (select public.user_company_ids()))
  with check (company_id in (select public.user_company_ids()));

create trigger set_updated_at_shopify_connections
  before update on public.shopify_connections
  for each row execute function public.update_updated_at_column();

comment on table public.shopify_connections is
  'Shopify store connections per company. Custom-app client id/secret stored AES-256-GCM encrypted; decryption requires the server-side SHOPIFY_CREDENTIALS_ENCRYPTION_KEY.';

NOTIFY pgrst, 'reload schema';
