-- Ingestion ledger for Stripe payment events (checkout.session.completed from
-- auto-created invoice payment links).
--
-- Every polled event lands here exactly once with a terminal status:
--   * processing     claim row while the sync handles the event (crash-safe:
--                    stale claims are reclaimed after 1h)
--   * matched_booked the deterministic matcher settled the invoice (journal
--                    entry against 1686, invoice flipped to paid)
--   * needs_review   the event could not be applied deterministically
--                    (unknown invoice, amount/currency drift, already paid,
--                    locked period, non-SEK). Surfaced in the settings panel;
--                    NEVER guessed at.
--   * ignored        not applicable (test-mode event on live connection,
--                    unpaid async session)
--
-- Idempotency: the (connection_id, stripe_event_id) unique constraint is the
-- dedup key; the cursor on stripe_connections only narrows the polling window
-- and always overlaps, so a re-delivered event is a no-op here.

create table public.stripe_payment_events (
  id                  uuid primary key default uuid_generate_v4(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  connection_id       uuid not null references public.stripe_connections(id) on delete cascade,
  stripe_event_id     text not null,
  checkout_session_id text,
  payment_intent_id   text,
  payment_link_id     text,
  invoice_id          uuid references public.invoices(id) on delete set null,
  amount              numeric,
  currency            text,
  status              text not null default 'processing'
                        check (status in ('processing', 'matched_booked', 'needs_review', 'ignored')),
  reason              text,
  journal_entry_id    uuid references public.journal_entries(id),
  event_created_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint stripe_payment_events_event_uniq unique (connection_id, stripe_event_id)
);

create unique index stripe_payment_events_session_uniq
  on public.stripe_payment_events (connection_id, checkout_session_id)
  where (checkout_session_id is not null);

create index idx_stripe_payment_events_company_status
  on public.stripe_payment_events (company_id, status);
create index idx_stripe_payment_events_invoice
  on public.stripe_payment_events (invoice_id) where (invoice_id is not null);

alter table public.stripe_payment_events enable row level security;

-- Members read their company's rows (the settings panel's needs_review list).
-- Writes are service-role only: rows are produced by the sync cron, never by
-- users.
create policy "members read stripe_payment_events"
  on public.stripe_payment_events for select
  using (company_id in (select public.user_company_ids()));

create trigger set_updated_at_stripe_payment_events
  before update on public.stripe_payment_events
  for each row execute function public.update_updated_at_column();

comment on table public.stripe_payment_events is
  'Idempotent ingestion ledger for Stripe checkout events; deterministic matches settle invoices, everything else becomes needs_review.';

NOTIFY pgrst, 'reload schema';
