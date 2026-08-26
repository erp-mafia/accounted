-- Webshop orders: platform-agnostic order/refund rows from connected webshops
-- (WooCommerce first; Shopify plugs into the same table via platform).
--
-- Replaces the WooCommerce transactions-inbox feed as the landing surface for
-- store orders: the sync upserts rich order rows here (customer, payment
-- method, VAT breakdown, line items) instead of anonymous feed rows in
-- public.transactions. Each row is one bookable money event: row_type 'order'
-- carries the gross sale, each refund is its own 'refund' row with a negative
-- total and a parent_order_id self-reference, so refunds arriving in later
-- periods book independently.
--
-- Unlike the append-only transactions feed, rows are UPSERTED on
-- (company_id, external_id): order status changes, date_paid arriving later,
-- growing refund totals and billing corrections all land on re-sync. The
-- boundary is the financial-freeze trigger below: once a row is booked
-- (journal_entry_id) or invoiced (invoice_id) its financial fields are
-- immutable; corrections go through the sanctioned storno/rattelse paths.
-- The sync service respects the freeze application-side and flags divergence
-- via remote_changed_after_freeze instead of failing.
--
-- external_id reuses the FROZEN feed scheme (woo_{storeScope}_order_{id} /
-- woo_{storeScope}_refund_{id}), which makes the overlap with rows already
-- imported into public.transactions a pure string join: such rows carry
-- legacy_transaction_id and the booking route refuses to double-book them.
--
-- No write_audit_log trigger: rows are a nightly-refreshed mirror of store
-- data and auditing every upsert would flood audit_log. The accounting-
-- relevant events (booking, invoicing) are audited on journal_entries /
-- invoices themselves.

create table public.webshop_orders (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  platform             text not null check (platform in ('woocommerce', 'shopify')),
  -- Normalized store host(+path), same value frozen into external_id by
  -- wooStoreScope(); the store identity that survives disconnect/reconnect.
  store_scope          text not null,
  -- Display snapshot (store title), refreshed on sync.
  store_label          text,
  -- Soft pointer to the platform's *_connections row. Deliberately no FK:
  -- order rows are accounting underlag and must survive disconnect/reconnect.
  connection_id        uuid,
  row_type             text not null default 'order' check (row_type in ('order', 'refund')),
  parent_order_id      uuid references public.webshop_orders(id) on delete cascade,
  -- FROZEN feed scheme: woo_{scope}_order_{id} / woo_{scope}_refund_{id}.
  external_id          text not null,
  -- Raw remote order/refund id.
  platform_order_id    text not null,
  -- Display number (refund rows carry the parent order's number).
  order_number         text not null,
  -- Raw platform status (pending/processing/completed/refunded/cancelled/...).
  status               text not null,
  is_paid              boolean not null default false,
  -- Order rows: date_created; refund rows: refund date_created.
  order_date           date not null,
  paid_date            date,
  currency             text not null,
  -- Gross incl. tax and shipping; NEGATIVE on refund rows.
  total                numeric(14,2) not null,
  total_tax            numeric(14,2) not null default 0,
  -- Null until the Riksbanken rate resolves; booking is blocked while null.
  total_sek            numeric(14,2),
  exchange_rate        numeric(12,6),
  -- [{"rate": 25, "net": 400.00, "tax": 100.00}] in order currency.
  vat_breakdown        jsonb not null default '[]'::jsonb,
  -- [{"name", "quantity", "total", "total_tax", "vat_rate"}]
  line_items           jsonb not null default '[]'::jsonb,
  customer_name        text,
  customer_company     text,
  customer_email       text,
  -- Best effort (billing.company pattern + meta_data scan); must be user-
  -- confirmed before use in invoice legal fields.
  customer_orgnr       text,
  -- Gateway id ('swish', 'klarna_payments', 'stripe', 'bacs', ...).
  payment_method       text,
  payment_method_title text,
  -- order.transaction_id; join key for gateway-side reconciliation.
  gateway_reference    text,
  -- Order rows: informational sum of refunds seen so far.
  refunded_total       numeric(14,2) not null default 0,
  journal_entry_id     uuid references public.journal_entries(id),
  invoice_id           uuid references public.invoices(id),
  -- Same money event already imported by the legacy transactions feed.
  legacy_transaction_id uuid references public.transactions(id),
  -- A financial delta arrived from the store after booking/invoicing froze
  -- this row; surfaced in the UI, resolved via storno, never silently applied.
  remote_changed_after_freeze boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index webshop_orders_company_external_uniq
  on public.webshop_orders (company_id, external_id);
create index idx_webshop_orders_company_date
  on public.webshop_orders (company_id, order_date desc);
create index idx_webshop_orders_company_store
  on public.webshop_orders (company_id, platform, store_scope);
create index idx_webshop_orders_parent
  on public.webshop_orders (parent_order_id) where (parent_order_id is not null);
create index idx_webshop_orders_journal_entry
  on public.webshop_orders (journal_entry_id) where (journal_entry_id is not null);
create index idx_webshop_orders_invoice
  on public.webshop_orders (invoice_id) where (invoice_id is not null);

alter table public.webshop_orders enable row level security;

-- Members read and update (the book/create-invoice routes run on the cookie
-- session and write back journal_entry_id / invoice_id). INSERT is service-
-- role only (the sync cron); no member INSERT policy on purpose. No DELETE
-- policy: order rows are accounting underlag; booked rows fall under BFL
-- 7-year retention via their journal entries.
create policy "members read webshop_orders"
  on public.webshop_orders for select
  using (company_id in (select public.user_company_ids()));

create policy "members update webshop_orders"
  on public.webshop_orders for update
  using (company_id in (select public.user_company_ids()))
  with check (company_id in (select public.user_company_ids()));

create trigger set_updated_at_webshop_orders
  before update on public.webshop_orders
  for each row execute function public.update_updated_at_column();

-- Financial freeze: once a row is booked or invoiced, the fields that fed the
-- verifikat/invoice are immutable. Status, refund summary, labels, links and
-- the divergence flag stay mutable so sync keeps working. Mirrors the spirit
-- of enforce_journal_entry_immutability one layer up: the underlag a posted
-- entry was built from must not drift underneath it.
create or replace function public.enforce_webshop_order_financial_freeze()
returns trigger
language plpgsql
as $$
begin
  if old.journal_entry_id is not null or old.invoice_id is not null then
    if new.total is distinct from old.total
      or new.total_tax is distinct from old.total_tax
      or new.total_sek is distinct from old.total_sek
      or new.exchange_rate is distinct from old.exchange_rate
      or new.currency is distinct from old.currency
      or new.vat_breakdown is distinct from old.vat_breakdown
      or new.line_items is distinct from old.line_items
      or new.order_date is distinct from old.order_date
      or new.paid_date is distinct from old.paid_date
      or new.is_paid is distinct from old.is_paid
      or new.payment_method is distinct from old.payment_method
      or new.external_id is distinct from old.external_id
      or new.platform_order_id is distinct from old.platform_order_id
    then
      raise exception 'webshop_orders row % is booked/invoiced; financial fields are frozen (use storno)', old.id
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger enforce_webshop_order_financial_freeze
  before update on public.webshop_orders
  for each row execute function public.enforce_webshop_order_financial_freeze();

comment on table public.webshop_orders is
  'Order/refund rows synced from connected webshops (WooCommerce, Shopify). One row per bookable money event; upserted on (company_id, external_id); financial fields freeze once booked or invoiced.';

NOTIFY pgrst, 'reload schema';
