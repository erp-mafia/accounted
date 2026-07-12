-- Stripe Connect: per-company connected Stripe accounts (OAuth for Standard
-- accounts). Accounted's own Stripe account is the Connect platform; a company
-- connects its Stripe account and we store ONLY the acct_... id. There is no
-- per-company API key or token: every API call uses the platform secret key
-- plus the Stripe-Account header, and either side can revoke at any time.
-- This table is the user-facing Stripe integration (extensions/general/stripe),
-- fully separate from Accounted's own billing (company_subscriptions).

create table public.stripe_connections (
  id                    uuid primary key default uuid_generate_v4(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  user_id               uuid not null references auth.users(id) on delete cascade,
  -- acct_... id of the connected Stripe account. Not a secret: useless without
  -- the platform secret key. NULL while the OAuth round-trip is pending.
  stripe_account_id     text,
  -- Whether the connection was made in Stripe live mode (sk_live platform key)
  -- or test mode. Payment events are only ever applied to bookkeeping when the
  -- event's livemode matches the connection's.
  livemode              boolean not null default false,
  status                text not null default 'pending'
                          check (status in ('pending', 'active', 'revoked', 'error')),
  -- Single-use CSRF token for the OAuth round-trip; cleared in the callback.
  oauth_state           uuid,
  -- Stripe account display name (business_profile.name) for the settings panel.
  display_name          text,
  -- Event-polling cursor (payment/payout sync). The sync overlaps the cursor
  -- by a few minutes and relies on unique constraints for idempotency.
  last_event_created_at timestamptz,
  last_event_id         text,
  error_message         text,
  connected_at          timestamptz,
  disconnected_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- One active connection per company.
create unique index stripe_connections_one_active_per_company
  on public.stripe_connections (company_id) where (status = 'active');

-- A Stripe account may be actively connected to at most one company (per mode):
-- two companies importing the same payment stream would double-book it.
create unique index stripe_connections_account_active_uniq
  on public.stripe_connections (stripe_account_id, livemode) where (status = 'active');

create index idx_stripe_connections_company_id on public.stripe_connections (company_id);
create index idx_stripe_connections_oauth_state on public.stripe_connections (oauth_state)
  where (oauth_state is not null);

alter table public.stripe_connections enable row level security;

-- Members read their company's connection. Insert/update are member-scoped so
-- the connect/disconnect routes can run on the user's cookie session; the OAuth
-- callback and the sync cron use the service role (bypasses RLS). No DELETE
-- policy: connections are revoked (status flip), never deleted, for audit.
create policy "members read stripe_connections"
  on public.stripe_connections for select
  using (company_id in (select public.user_company_ids()));

create policy "members insert stripe_connections"
  on public.stripe_connections for insert
  with check (
    company_id in (select public.user_company_ids())
    and user_id = auth.uid()
  );

create policy "members update stripe_connections"
  on public.stripe_connections for update
  using (company_id in (select public.user_company_ids()))
  with check (company_id in (select public.user_company_ids()));

create trigger set_updated_at_stripe_connections
  before update on public.stripe_connections
  for each row execute function public.update_updated_at_column();

comment on table public.stripe_connections is
  'Stripe Connect (OAuth) connections per company. Stores only the connected acct_ id, never keys or tokens.';

NOTIFY pgrst, 'reload schema';
