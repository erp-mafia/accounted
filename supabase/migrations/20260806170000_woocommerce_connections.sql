-- WooCommerce store connections: per-company WooCommerce REST API credentials
-- for the order/refund transaction feed (extensions/general/woocommerce).
--
-- Unlike Stripe Connect there is no platform account: WooCommerce hands each
-- connected app a per-store consumer key/secret (via the /wc-auth/v1/authorize
-- handshake or manual key entry). Both are secrets, so they are stored
-- AES-256-GCM encrypted with a dedicated server-side key
-- (WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY), never in plaintext. The encrypted
-- blobs are useless without that env key, mirroring the Skatteverket token
-- store.
--
-- Modeled on stripe_connections (20260712100000): same status lifecycle, same
-- member-scoped RLS, no DELETE policy (connections are revoked, never deleted,
-- for audit). Like stripe_connections there is no write_audit_log trigger:
-- this is connection state, not accounting data, and audit-logging rows that
-- carry encrypted credentials would copy secret ciphertext into audit_log.

create table public.woocommerce_connections (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies(id) on delete cascade,
  user_id                   uuid not null references auth.users(id) on delete cascade,
  -- Normalized https origin (optionally with a subdirectory path for
  -- WordPress installs under a path), no trailing slash. Set at connect
  -- start; the wc-auth callback and every API call use this stored URL, so a
  -- forged callback cannot redirect the integration to another store.
  store_url                 text not null,
  -- Store display name (WordPress site title) for the settings panel.
  store_name                text,
  -- AES-256-GCM encrypted consumer key/secret (ck_... / cs_...).
  -- NULL while the wc-auth round-trip is pending.
  consumer_key_encrypted    text,
  consumer_secret_encrypted text,
  -- Permission level WooCommerce granted the key ('read' expected).
  key_permissions           text,
  status                    text not null default 'pending'
                              check (status in ('pending', 'active', 'revoked', 'error')),
  -- Single-use CSRF token for the wc-auth round-trip; passed as the handshake
  -- user_id correlation parameter and cleared on activation.
  oauth_state               uuid,
  -- Store settings read at connect time; drive the feed's cash account.
  currency                  text,
  prices_include_tax        boolean,
  wc_version                text,
  -- Opt-in for the nightly order feed cron (the manual sync button ignores it).
  transaction_sync_enabled  boolean not null default false,
  -- Order-polling cursor: max date_modified_gmt processed. Re-polled with a
  -- 24h overlap; (company_id, external_id) dedup makes overlaps no-ops.
  last_order_synced_at      timestamptz,
  error_message             text,
  connected_at              timestamptz,
  disconnected_at           timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- One active connection per company.
create unique index woocommerce_connections_one_active_per_company
  on public.woocommerce_connections (company_id) where (status = 'active');

-- A store may be actively connected to at most one company: two companies
-- importing the same order stream would double-book it.
create unique index woocommerce_connections_store_active_uniq
  on public.woocommerce_connections (store_url) where (status = 'active');

create index idx_woocommerce_connections_company_id
  on public.woocommerce_connections (company_id);
create index idx_woocommerce_connections_oauth_state
  on public.woocommerce_connections (oauth_state) where (oauth_state is not null);

alter table public.woocommerce_connections enable row level security;

-- Members read their company's connection. Insert/update are member-scoped so
-- the connect/disconnect routes can run on the user's cookie session; the
-- wc-auth callback and the sync cron use the service role (bypasses RLS).
-- No DELETE policy: connections are revoked (status flip), never deleted.
create policy "members read woocommerce_connections"
  on public.woocommerce_connections for select
  using (company_id in (select public.user_company_ids()));

create policy "members insert woocommerce_connections"
  on public.woocommerce_connections for insert
  with check (
    company_id in (select public.user_company_ids())
    and user_id = auth.uid()
  );

create policy "members update woocommerce_connections"
  on public.woocommerce_connections for update
  using (company_id in (select public.user_company_ids()))
  with check (company_id in (select public.user_company_ids()));

create trigger set_updated_at_woocommerce_connections
  before update on public.woocommerce_connections
  for each row execute function public.update_updated_at_column();

comment on table public.woocommerce_connections is
  'WooCommerce store connections per company. Consumer key/secret stored AES-256-GCM encrypted; decryption requires the server-side WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY.';

NOTIFY pgrst, 'reload schema';
