-- A payment provider's payout, read from the provider (Kustom's settlement
-- report first, Shopify Payments next), so its bank row can be proposed as
-- one verifikat: the bank net, the provider's fees, and the clearing account
-- the orders were booked against, gross.
--
-- The sales and their VAT are booked from the orders (webshop_orders), never
-- from the payout. A payout row only says what the provider paid out and how:
-- `lines` holds each part of the payout signed toward it (sale +, return -,
-- fee -, fee VAT -, holdback -, release +, adjustment either way), and their
-- sum is `amount`, what reached the bank. The voucher is proposed on the
-- bank row by the payout's clearing proposer and booked through the bank
-- row's own booking (transactions categorize); `transaction_id` is the row
-- that claimed it and `journal_entry_id` the verifikat that booked it.
--
-- Writes: inserted by the upload route with the service role (as
-- webshop_orders), claimed and settled by the booking. Members read their
-- company's payouts; no member write policy, no delete policy.

create table public.webshop_payouts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  platform text not null check (platform in ('kustom', 'shopify')),
  store_scope text not null,
  -- The provider's identity of the payout: the key a second upload of the
  -- same report, or a second sync, finds the row by.
  external_id text not null,
  -- The payout reference the provider prints, which the bank text often carries.
  reference text,
  payout_date date not null,
  currency text not null,
  amount numeric(14,2) not null check (amount > 0),
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  transaction_id uuid references public.transactions(id) on delete set null,
  journal_entry_id uuid references public.journal_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webshop_payouts_company_external_key unique (company_id, external_id)
);

comment on table public.webshop_payouts is
  'A payment provider''s payout (Kustom, Shopify Payments): what reached the bank and how it nets, proposed on its bank row as one verifikat (bank net, fees, clearing account gross).';
comment on column public.webshop_payouts.lines is
  'The payout''s parts, each {kind, amount} signed toward the payout: sale +, return -, reversal -, fee -, fee_vat -, holdback -, release +, adjustment either way. They sum to amount.';
comment on column public.webshop_payouts.transaction_id is
  'The bank row whose booking claimed the payout; released when that booking fails.';
comment on column public.webshop_payouts.journal_entry_id is
  'The verifikat that booked the payout from its bank row.';

-- The proposer reads a company's open payouts by date.
create index idx_webshop_payouts_open
  on public.webshop_payouts (company_id, payout_date)
  where journal_entry_id is null;

alter table public.webshop_payouts enable row level security;

create policy "members read webshop_payouts"
  on public.webshop_payouts for select
  using (company_id in (select public.user_company_ids()));

grant select on table public.webshop_payouts to authenticated;
grant select, insert, update, delete on table public.webshop_payouts to service_role;

create trigger set_updated_at_webshop_payouts
  before update on public.webshop_payouts
  for each row execute function public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
