-- READ ONLY. When each background path last did real work for each company:
-- rows that arrived, deliveries a receiver acknowledged, jobs that finished.
-- Not when its cron last ran: a run that fetched nothing, failed quietly or
-- only bumped a stamp does not count. Run it twice a week apart and compare
-- the 'summary' rows; the 'flag' rows name the companies behind them.
--
-- Verdicts
--   ok           real work inside the expected cadence
--   quiet        ran, nothing arrived, and history does not expect anything
--   STALLED      ran within a day, nothing arrived for 7 days, history says >= 3 a week
--   NEVER        connected over 2 days ago and never produced a row (verify: a
--                truly quiet account looks the same)
--   NOT_RUNNING  entitled and active, but the job has not touched it for over a day
--   STUCK        items in a transient state past their threshold
--   FAILING      work that died: dead jobs or deliveries, failing calls
--   NEEDS_USER   waiting on a person (a migration in review)
--   PARTIAL      finished, with records left for review
--   DROPPED      an event a verified webhook should have received has no delivery
--   skipped      not entitled to the capability: skipped by design
--
-- expected_7d is rows per 7 days over days 8-67 back by business date
-- (booking or order date), so a fresh connection's history import is not read
-- as cadence. Bank feeds are grouped per company and bank, so a reconnect whose
-- fetches deduplicate against the old connection's rows is not called NEVER.
with
ent as (
  select c.id company_id, g.capability_key
  from companies c
  join capability_grants g
    on (g.company_id = c.id or (c.team_id is not null and g.team_id = c.team_id))
   and (g.expires_at is null or g.expires_at > now())
  where not exists (
    select 1 from company_capability_config cc
    where cc.company_id = c.id and cc.capability_key = g.capability_key and cc.enabled = false)
  group by 1, 2
),

-- Bank feeds (Enable Banking hourly, Open Payments every 10 min). last_synced_at
-- moves on every applied result, an empty one included, so it means "the bank
-- answered", never "rows arrived".
bank_conn as (
  select company_id, aggregator, provider,
         min(last_synced_at) last_ran, min(created_at) first_created
  from bank_connections
  where status = 'active' and superseded_by is null
  group by 1, 2, 3
),
bank_tx as (
  select bc.company_id, bc.aggregator, bc.provider,
         max(t.created_at) last_work,
         count(*) filter (where t.created_at > now() - interval '7 days') work_7d,
         round(count(*) filter (where t.date between current_date - 67 and current_date - 8) * 7.0 / 60, 1) expected_7d
  from bank_conn bc
  join bank_connections b on b.company_id = bc.company_id and b.aggregator = bc.aggregator and b.provider = bc.provider
  join transactions t on t.bank_connection_id = b.id
  group by 1, 2, 3
),
bank as (
  select bc.company_id, 'bank:' || bc.aggregator path, bc.provider ref,
         bc.last_ran, t.last_work, coalesce(t.work_7d, 0) work_7d, t.expected_7d,
         null::bigint open_items, null::timestamptz oldest_open,
         case
           when e.company_id is null then 'skipped'
           when bc.last_ran is null or bc.last_ran < now() - interval '26 hours' then 'NOT_RUNNING'
           when t.last_work is null and bc.first_created < now() - interval '2 days' then 'NEVER'
           when coalesce(t.work_7d, 0) = 0 and t.expected_7d >= 3 then 'STALLED'
           when coalesce(t.work_7d, 0) = 0 then 'quiet'
           else 'ok' end verdict
  from bank_conn bc
  left join bank_tx t using (company_id, aggregator, provider)
  left join ent e on e.company_id = bc.company_id and e.capability_key = 'bank_sync'
),

-- Stripe balance feed (nightly), rows in transactions with import_source 'stripe'.
-- A quiet first run never moves the cursor, so a connection with no rows ever is
-- NEVER rather than NOT_RUNNING.
stripe_tx as (
  select company_id, max(created_at) last_work,
         count(*) filter (where created_at > now() - interval '7 days') work_7d,
         round(count(*) filter (where date between current_date - 67 and current_date - 8) * 7.0 / 60, 1) expected_7d
  from transactions where import_source = 'stripe' group by 1
),
stripe as (
  select s.company_id, 'stripe', s.stripe_account_id,
         s.last_balance_txn_synced_at, t.last_work, coalesce(t.work_7d, 0), t.expected_7d,
         null::bigint, null::timestamptz,
         case
           when e.company_id is null then 'skipped'
           when t.last_work is null and s.connected_at < now() - interval '2 days' then 'NEVER'
           when s.last_balance_txn_synced_at is null or s.last_balance_txn_synced_at < now() - interval '26 hours' then 'NOT_RUNNING'
           when coalesce(t.work_7d, 0) = 0 and t.expected_7d >= 3 then 'STALLED'
           when coalesce(t.work_7d, 0) = 0 then 'quiet'
           else 'ok' end
  from stripe_connections s
  left join stripe_tx t on t.company_id = s.company_id
  left join ent e on e.company_id = s.company_id and e.capability_key = 'stripe_payments'
  where s.status = 'active' and s.transaction_sync_enabled
),

-- Webshop and POS order feeds (nightly), rows in webshop_orders.
shop_conn as (
  select 'woocommerce' platform, company_id, id, status, transaction_sync_enabled tse, last_order_synced_at last_ran, connected_at from woocommerce_connections
  union all select 'shopify', company_id, id, status, transaction_sync_enabled, last_order_synced_at, connected_at from shopify_connections
  union all select 'zettle', company_id, id, status, transaction_sync_enabled, last_order_synced_at, connected_at from zettle_connections
),
shop_rows as (
  select platform, company_id, max(created_at) last_work,
         count(*) filter (where created_at > now() - interval '7 days') work_7d,
         round(count(*) filter (where order_date between current_date - 67 and current_date - 8) * 7.0 / 60, 1) expected_7d
  from webshop_orders group by 1, 2
),
shop as (
  select c.company_id, 'shop:' || c.platform, c.id::text,
         c.last_ran, r.last_work, coalesce(r.work_7d, 0), r.expected_7d,
         null::bigint, null::timestamptz,
         case
           when c.last_ran is null or c.last_ran < now() - interval '26 hours' then 'NOT_RUNNING'
           when r.last_work is null and c.connected_at < now() - interval '2 days' then 'NEVER'
           when coalesce(r.work_7d, 0) = 0 and r.expected_7d >= 3 then 'STALLED'
           when coalesce(r.work_7d, 0) = 0 then 'quiet'
           else 'ok' end
  from shop_conn c
  left join shop_rows r on r.platform = c.platform and r.company_id = c.company_id
  where c.status = 'active' and c.tse
),

-- Skattekonto (hourly). A run is a transaktioner call in the audit log; work is a new row.
skv_calls as (
  select company_id, max(created_at) last_ran, max(created_at) filter (where outcome = 'ok') last_ok
  from skatteverket_api_audit_log
  where endpoint = 'skattekonto/transaktioner' and created_at > now() - interval '30 days'
  group by 1
),
skv_rows as (
  select company_id, max(imported_at) last_work,
         count(*) filter (where imported_at > now() - interval '7 days') work_7d
  from skattekonto_transactions where source is distinct from 'file' group by 1
),
skv as (
  select t.company_id, 'skatteverket:skattekonto', null::text,
         c.last_ran, r.last_work, coalesce(r.work_7d, 0), null::numeric,
         null::bigint, null::timestamptz,
         case
           when e.company_id is null then 'skipped'
           when c.last_ran is null or c.last_ran < now() - interval '3 hours' then 'NOT_RUNNING'
           when c.last_ok is null or c.last_ok < now() - interval '1 day' then 'FAILING'
           when r.last_work is null and t.created_at < now() - interval '2 days' then 'NEVER'
           when coalesce(r.work_7d, 0) = 0 then 'quiet'
           else 'ok' end
  from skatteverket_tokens t
  left join skv_calls c on c.company_id = t.company_id
  left join skv_rows r on r.company_id = t.company_id
  left join ent e on e.company_id = t.company_id and e.capability_key = 'skatteverket'
  where t.status = 'active'
),

-- Peppol outbound: accepted by the access point but never confirmed delivered,
-- or staged and never submitted.
peppol_out as (
  select d.company_id, 'peppol:outbound', null::text,
         max(d.updated_at), max(d.status_at) filter (where d.status in ('transport_succeeded', 'delivered')),
         count(*) filter (where d.created_at > now() - interval '7 days'), null::numeric,
         count(*) filter (where (d.status in ('submitting', 'submission_accepted', 'retryable_failure') and d.updated_at < now() - interval '1 hour')
                             or (d.status in ('staged', 'recipient_verified') and d.updated_at < now() - interval '1 day')),
         min(d.created_at) filter (where d.status in ('staged', 'recipient_verified', 'submitting', 'submission_accepted', 'retryable_failure')),
         case
           when count(*) filter (where (d.status in ('submitting', 'submission_accepted', 'retryable_failure') and d.updated_at < now() - interval '1 hour')
                                    or (d.status in ('staged', 'recipient_verified') and d.updated_at < now() - interval '1 day')) > 0 then 'STUCK'
           else 'ok' end
  from peppol_deliveries d
  group by d.company_id
),

-- Peppol inbound: registered to receive; work is an archived inbound document.
peppol_in as (
  select r.company_id, 'peppol:inbound', r.participant_identifier,
         null::timestamptz, max(i.created_at), count(i.id) filter (where i.created_at > now() - interval '7 days'), null::numeric,
         count(i.id) filter (where i.status in ('received', 'routed', 'unrouted', 'failed') and i.created_at < now() - interval '1 hour'),
         min(i.created_at) filter (where i.status in ('received', 'routed', 'unrouted', 'failed')),
         case
           when count(i.id) filter (where i.status in ('received', 'routed', 'unrouted', 'failed') and i.created_at < now() - interval '1 hour') > 0 then 'STUCK'
           when max(i.created_at) is null then 'quiet'
           else 'ok' end
  from peppol_registrations r
  left join peppol_inbound_documents i on i.company_id = r.company_id
  where r.status = 'registered'
  group by r.company_id, r.participant_identifier
),

-- Document jobs (read, classify, extract). 'failed' below max_attempts is a
-- retry waiting on run_after; dead is failed at max_attempts.
doc as (
  select company_id, 'documents:jobs', null::text,
         max(updated_at), max(updated_at) filter (where status = 'done' and coalesce(result, '') not like 'skipped%'),
         count(*) filter (where status = 'done' and coalesce(result, '') not like 'skipped%' and updated_at > now() - interval '7 days'), null::numeric,
         count(*) filter (where (status in ('queued', 'failed') and attempts < max_attempts and run_after < now() - interval '1 hour')
                             or (status = 'running' and locked_at < now() - interval '15 minutes')),
         min(run_after) filter (where status in ('queued', 'failed') and attempts < max_attempts),
         case
           when count(*) filter (where (status in ('queued', 'failed') and attempts < max_attempts and run_after < now() - interval '1 hour')
                                    or (status = 'running' and locked_at < now() - interval '15 minutes')) > 0 then 'STUCK'
           when count(*) filter (where status = 'failed' and attempts >= max_attempts and updated_at > now() - interval '7 days') > 0 then 'FAILING'
           else 'ok' end
  from document_jobs
  where status <> 'done' or updated_at > now() - interval '7 days'
  group by company_id
),

-- Provider migrations (Fortnox, Visma, Bokio). updated_at and attempt move on
-- every claim; progress is a chunk changing state.
mig as (
  select j.company_id, 'migration:' || j.provider, j.id::text,
         j.updated_at, max(c.updated_at) filter (where c.state = 'done'),
         count(c.id) filter (where c.state = 'done' and c.updated_at > now() - interval '7 days'), null::numeric,
         count(c.id) filter (where c.state in ('needs_attention', 'pending', 'imported', 'linked', 'planned')),
         min(c.created_at) filter (where c.state in ('needs_attention', 'pending', 'imported', 'linked', 'planned')),
         case
           when j.state in ('queued', 'running', 'retry_wait') and coalesce(max(c.updated_at), j.created_at) < now() - interval '1 hour' then 'STUCK'
           when j.state = 'needs_attention' then 'NEEDS_USER'
           when count(c.id) filter (where c.state = 'needs_attention') > 0 then 'PARTIAL'
           else 'ok' end
  from migration_jobs j
  left join migration_job_chunks c on c.job_id = j.id
  where j.state <> 'completed' or j.updated_at > now() - interval '30 days'
  group by j.company_id, j.provider, j.id, j.state, j.updated_at, j.created_at
),

-- SIE import jobs that never finished (a paused one holds the period: it cannot
-- be closed or locked), and post-import bank sweeps that never finished.
sie as (
  select s.company_id, 'sie_import', s.id::text,
         s.updated_at, (select max(c.completed_at) from sie_import_chunks c where c.import_id = s.id), null::bigint, null::numeric,
         s.consecutive_failures::bigint, s.created_at,
         'STUCK'
  from sie_imports s
  where (s.job_state in ('queued', 'preparing', 'running', 'reconciling', 'finalizing', 'undoing', 'paused') and s.updated_at < now() - interval '1 hour')
     or (s.bank_sweep->>'state' = 'running' and (s.bank_sweep->>'started_at')::timestamptz < now() - interval '1 hour')
),

-- Customer webhooks: an event a deliverable endpoint should have received with no
-- delivery row, deliveries that died, and deliveries left in flight. Events that
-- reached a pending (unverified, out of grace) endpoint are dropped by design.
hooks as (
  select w.id, w.company_id, w.verified_at, w.verification_grace_ends_at,
         coalesce(nullif(w.event_types, '{}'), array[w.event_type]) types
  from webhooks w where w.active and w.disabled_at is null
),
hook_missing as (
  select h.id, count(o.id) missing
  from hooks h
  join event_outbox o
    on o.company_id = h.company_id and o.event_type = any(h.types)
   and o.created_at < now() - interval '10 minutes'
   and ((h.verified_at is not null and o.created_at >= h.verified_at)
        or (h.verified_at is null and h.verification_grace_ends_at > o.created_at))
  where not exists (select 1 from webhook_deliveries x where x.webhook_id = h.id and x.outbox_id = o.id)
  group by h.id
),
hook as (
  select h.company_id, 'webhooks', h.id::text,
         max(d.updated_at), max(d.delivered_at),
         count(d.id) filter (where d.status = 'delivered' and d.created_at > now() - interval '7 days'), null::numeric,
         coalesce(max(m.missing), 0)::bigint,
         min(d.created_at) filter (where d.status not in ('delivered', 'dead')),
         case
           when coalesce(max(m.missing), 0) > 0 then 'DROPPED'
           when count(d.id) filter (where d.status = 'dead' and d.created_at > now() - interval '7 days') > 0 then 'FAILING'
           when count(d.id) filter (where d.status not in ('delivered', 'dead') and d.created_at < now() - interval '1 hour') > 0 then 'STUCK'
           else 'ok' end
  from hooks h
  left join webhook_deliveries d on d.webhook_id = h.id
  left join hook_missing m on m.id = h.id
  group by h.company_id, h.id
),

-- Recurring invoices past their run date, and accrual months that keep failing.
recurring as (
  select company_id, 'invoices:recurring', id::text,
         last_run_at, last_run_at, null::bigint, null::numeric,
         1::bigint, next_run_date::timestamptz,
         'STUCK'
  from recurring_invoice_schedules
  where status = 'active' and next_run_date < current_date
),
accrual as (
  select company_id, 'bookkeeping:accruals', schedule_id::text,
         max(updated_at), max(posted_at), null::bigint, null::numeric,
         count(*), min(period_month)::timestamptz,
         'FAILING'
  from accrual_schedule_installments
  where status = 'pending' and last_error is not null
  group by company_id, schedule_id
),

-- Bank payments: past their execution date without executing, an unknown
-- outcome, or executed without being settled against the supplier invoice.
-- 'accepted' with a future execution date is a scheduled payment, not stuck.
payments as (
  select company_id, 'payments:orders', null::text,
         max(provider_status_at), max(executed_at), null::bigint, null::numeric,
         count(*), min(requested_execution_date)::timestamptz,
         'STUCK'
  from payment_orders
  where (status in ('submitted', 'accepted') and requested_execution_date < current_date - 2)
     or outcome_unknown_at is not null
     or (status = 'executed' and supplier_invoice_id is not null and supplier_invoice_payment_id is null
         and executed_at < now() - interval '3 days')
  group by company_id
),

-- Collections (inkasso) connections.
coll as (
  select company_id, 'collections', id::text,
         greatest(last_success_at, last_error_at), last_success_at, null::bigint, null::numeric,
         failures_in_row::bigint, last_error_at,
         case
           when last_success_at is null or last_success_at < now() - interval '1 day' then 'NOT_RUNNING'
           when failures_in_row > 0 then 'FAILING'
           else 'ok' end
  from collection_connections where state = 'active'
),

-- Event outbox, all companies: deliveries the dispatcher never finished. In
-- shadow mode every row but a deferred one is marked done without running, so
-- only deferred rows and dead ones say anything.
outbox as (
  select null::uuid company_id, 'events:outbox:' || d.consumer_id, null::text,
         max(d.done_at), max(d.done_at) filter (where d.inline_result = 'deferred'),
         count(*) filter (where d.inline_result = 'deferred' and d.status = 'done' and d.done_at > now() - interval '7 days'), null::numeric,
         count(*) filter (where (d.status <> 'done' and d.created_at < now() - interval '10 minutes') or d.status = 'dead'),
         min(d.created_at) filter (where d.status <> 'done'),
         case
           when count(*) filter (where d.status = 'dead') > 0 then 'FAILING'
           when count(*) filter (where d.status <> 'done' and d.created_at < now() - interval '10 minutes') > 0 then 'STUCK'
           else 'ok' end
  from event_deliveries d
  group by d.consumer_id
),

rows_ as (
  select * from bank
  union all select * from stripe
  union all select * from shop
  union all select * from skv
  union all select * from peppol_out
  union all select * from peppol_in
  union all select * from doc
  union all select * from mig
  union all select * from sie
  union all select * from hook
  union all select * from recurring
  union all select * from accrual
  union all select * from payments
  union all select * from coll
  union all select * from outbox
)
select 'summary' section, r.path, r.verdict, null::text company, null::text ref,
       null::timestamptz last_ran, null::timestamptz last_work, null::bigint work_7d, null::numeric expected_7d,
       sum(r.open_items)::bigint open_items, null::timestamptz oldest_open,
       count(*) n, count(distinct r.company_id) companies
from rows_ r
group by r.path, r.verdict
union all
select 'flag', r.path, r.verdict, coalesce(c.name, '(all companies)'), r.ref,
       r.last_ran, r.last_work, r.work_7d, r.expected_7d,
       r.open_items, r.oldest_open,
       1, 1
from rows_ r
left join companies c on c.id = r.company_id
where r.verdict not in ('ok', 'quiet', 'skipped')
order by section desc, path, verdict, company;
