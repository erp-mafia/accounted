-- Ledger for Stripe payouts (the bank transfers that empty the Stripe balance).
--
-- Each payout.paid event lands here exactly once. When every balance
-- transaction in the payout is deterministic (charges/payments + the payout
-- itself, SEK, gross - fees = net), the sync books one journal entry:
--
--   Debit  1930 Företagskonto            [net]
--   Debit  6570 Bankkostnader            [fees]
--   Debit  4535 (+ Credit 4598)          [fees]        ruta 21 basis pair
--   Debit  2645 / Credit 2614            [25% of fees] fiktiv moms (RC)
--   Credit 1686 Fordringar för kontokort [gross]
--
-- Stripe Payments Europe Ltd is Irish: the fees are an EU services purchase
-- under omvänd skattskyldighet, so the booking reuses the same reverse-charge
-- generators as supplier invoices (rutor 21/30/48 populate identically).
-- Anything non-deterministic (refunds, disputes, FX, adjustments, non-SEK)
-- becomes needs_review: never guessed at. The 1930 line then surfaces in bank
-- reconciliation (get_unlinked_1930_lines) for linking against the incoming
-- bank feed transaction.

create table public.stripe_payouts (
  id                uuid primary key default uuid_generate_v4(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  connection_id     uuid not null references public.stripe_connections(id) on delete cascade,
  payout_id         text not null,
  stripe_event_id   text,
  -- Net amount actually paid out, in the payout currency.
  amount            numeric,
  gross             numeric,
  fees              numeric,
  currency          text,
  arrival_date      date,
  status            text not null default 'processing'
                      check (status in ('processing', 'booked', 'needs_review', 'ignored')),
  reason            text,
  journal_entry_id  uuid references public.journal_entries(id),
  event_created_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint stripe_payouts_payout_uniq unique (connection_id, payout_id)
);

create index idx_stripe_payouts_company_status
  on public.stripe_payouts (company_id, status);

alter table public.stripe_payouts enable row level security;

-- Members read; writes are service-role only (sync cron).
create policy "members read stripe_payouts"
  on public.stripe_payouts for select
  using (company_id in (select public.user_company_ids()));

create trigger set_updated_at_stripe_payouts
  before update on public.stripe_payouts
  for each row execute function public.update_updated_at_column();

comment on table public.stripe_payouts is
  'Idempotent ledger for Stripe payouts; deterministic payouts are booked (1930/6570+RC/1686), everything else needs_review.';

NOTIFY pgrst, 'reload schema';
