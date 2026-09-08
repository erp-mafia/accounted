-- Zettle merchant connections: per-company OAuth refresh tokens for the
-- paid-purchase feed (extensions/general/zettle).
--
-- Partner-hosted authorization code grant: the deployment holds
-- ZETTLE_CLIENT_ID / ZETTLE_CLIENT_SECRET; each merchant authorises READ:PURCHASE
-- + READ:USERINFO. Only the rotating refresh token is stored, AES-256-GCM
-- encrypted with ZETTLE_CREDENTIALS_ENCRYPTION_KEY (same layout as Shopify /
-- WooCommerce credential stores). Access tokens are ephemeral (~2h) and
-- never persisted. organization_uuid from users/self is the store identity
-- frozen into webshop_orders.external_id.
--
-- Modeled on shopify_connections: same status lifecycle, same member-scoped
-- RLS, no DELETE policy (connections are revoked, never deleted). No
-- write_audit_log trigger: connection state carrying encrypted credentials
-- must not flood audit_log.

create table public.zettle_connections (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  user_id                  uuid not null references auth.users(id) on delete cascade,
  -- Merchant organization UUID; null while pending OAuth.
  organization_uuid        text,
  organization_name        text,
  -- AES-256-GCM encrypted OAuth refresh token.
  refresh_token_encrypted  text,
  oauth_state              text,
  -- Validated origin the connect flow started on (app origin or a brand
  -- domain from the brands table); the callback returns the browser there.
  return_origin            text,
  -- Sync claim: set by the run that holds the connection (cron or manual
  -- sync), so two runs never refresh the rotating token concurrently (a
  -- reused refresh token comes back 400 and would flip the row to revoked).
  sync_lock_until          timestamptz not null default 'epoch',
  status                   text not null default 'pending'
                             check (status in ('pending', 'active', 'revoked', 'error')),
  currency                 text,
  transaction_sync_enabled boolean not null default false,
  last_order_synced_at     timestamptz,
  error_message            text,
  connected_at             timestamptz,
  disconnected_at          timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create unique index zettle_connections_one_active_per_company
  on public.zettle_connections (company_id) where (status = 'active');

create unique index zettle_connections_org_active_uniq
  on public.zettle_connections (organization_uuid) where (status = 'active');

create index idx_zettle_connections_company_id
  on public.zettle_connections (company_id);

alter table public.zettle_connections enable row level security;

create policy "members read zettle_connections"
  on public.zettle_connections for select
  using (company_id in (select public.user_company_ids()));

create policy "members insert zettle_connections"
  on public.zettle_connections for insert
  with check (
    company_id in (select public.user_company_ids())
    and user_id = auth.uid()
  );

create policy "members update zettle_connections"
  on public.zettle_connections for update
  using (company_id in (select public.user_company_ids()))
  with check (company_id in (select public.user_company_ids()));

create trigger set_updated_at_zettle_connections
  before update on public.zettle_connections
  for each row execute function public.update_updated_at_column();

comment on table public.zettle_connections is
  'Zettle merchant connections per company. Refresh token stored AES-256-GCM encrypted; decryption requires ZETTLE_CREDENTIALS_ENCRYPTION_KEY.';

NOTIFY pgrst, 'reload schema';
