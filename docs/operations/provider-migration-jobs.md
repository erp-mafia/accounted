# Resumable provider registers (#2690)

The wizard now submits customers, suppliers, sales invoices and supplier invoices
as one persisted job. It restores unfinished jobs when reopened and offers the
latest completed result. The existing company-information, asset, SIE and document
flows retain their own paths. Direct integrations using the legacy `/migrate`
register flags must adopt the job API to obtain resumable execution.

## Why this change

Large registers exceeded a single HTTP invocation. Repeating the request also
repeated discovery and earlier writes. Increasing the request ceiling or merely
splitting the four register requests cannot bound a large individual register.

The worker uses the existing Supabase database and scheduler. Encrypted provider
snapshots, persisted page cursors, short batches, worker leases with attempt
fencing, and transactional source-ID receipts make a restart safe without adding
a queue dependency. Invoice headers and their rows commit together. Payment
candidates are persisted for the whole job before settlement, so conflicting
candidates in different batches cannot each consume the same voucher.

## Execution and limits

- `POST /api/extensions/ext/arcim-migration/migration-jobs` accepts `consentId`
  and a `resources` array. Company, actor and imported fiscal years come from the
  authenticated context and database. It responds `202` with `data.jobId`.
- `GET` on that path, optionally with `?jobId=...`, returns persisted progress.
  Without an ID it returns the latest job for the active company.
- `POST .../run` nudges a job. `POST .../retry` resumes records needing attention.
  Both take `jobId`. Retry can also take a renewed `consentId`; the source account
  must match. These routes use the extension dispatcher’s normal authorization.
- The authenticated worker cron runs every minute in the hosted and generated
  self-hosted schedules. Each invocation stops at a 210-second budget. Its
  five-minute lease is reclaimed after a crash. Each record write is fenced by
  the current worker and attempt inside the transaction.
- Visma discovery requests 1,000 records per page. Other providers keep their
  native page contracts. Discovery persists segments of at most 250 records and
  750 kB. Import and follow-up work uses at most 10 records per batch. Individual
  invoices over 2,000 lines or the payload bound are reported for review.
- One active job per company. Retry preserves successful records. Source identity
  includes company, provider, provider account, resource and provider record ID;
  display invoice numbers do not serve as retry keys.
- Party matching uses provider IDs or an organization identity, never a display
  name alone. When neither is available, the placeholder is scoped to its source
  invoice rather than silently merging different people with the same name.
- Transient provider failures back off. Exhausted detail failures and malformed
  records get explicit attention outcomes while healthy records continue.
  Authorization failures pause the job and expose reconnect in the wizard.
- Snapshot encryption uses `PERSONNUMMER_ENCRYPTION_KEY`. All workers sharing the
  staging database must use the same configured key. Every runtime refuses to
  work without it; test harnesses explicitly supply their own fixture key.
  Job state is operational; source-ID mappings are included in the
  company archive alongside the imported registers.

## Accounting and retention boundaries

The provider worker imports registers and links existing posted vouchers; it
does not create journal entries. VAT and FX warnings are stored in receipts and
shown in the result. The unlinked-credit count is derived from the invoice rows
instead (`provider_migration_counts`, migration 20260920190600): a credit note
counts as unlinked when its provider sent no reference, or when its link phase
has run and `credited_invoice_id` is still NULL because the invoice it names is
not among the imported ones. These warnings do not by themselves put
every record into `needs_attention` and must be reviewed before later accounting
actions. The existing mapper is reused without changing its VAT rules.

A supplier credit note (#2838) is stored the way Kreditera writes one: the
magnitudes of the invoice it reverses beside `is_credit_note`, status `credited`,
nothing paid and nothing remaining, whatever sign the provider states. It is
paired through `supplier_invoices.credited_invoice_id` only when the provider
names the credited invoice (Fortnox `CreditReference`) and that invoice is an
ordinary invoice of the same supplier, in the same currency, not smaller than
the credit; never by amount. The registration link corroborates a credit note
against the NEGATED total, because its verifikat debits 2440. A supplier credit
note the company already holds in the shape written before #2838 (the provider's
negative total on an unflagged row) is skipped with reason
`creditNoteInOldShape` instead of being inserted a second time; rewriting those
rows is a separate, founder-approved repair.

There is no snapshot purge or TTL job. A pending or failed snapshot remains
available for retry. The archive includes customers, suppliers, invoices, their
items and payments, and source-ID mappings; operational jobs and encrypted
replay payloads are excluded. Source documents keep their separate import and
retention flow.

Historical invoice numbers are preserved. This worker does not change the
company's invoice prefix or next number and does not create a separate number
namespace. Before issuing new invoices after a migration, check those settings
against the imported numbers. The existing company-wide unique index refuses
collisions instead of issuing a duplicate number.

## Local session with staging

Use a checkout containing the provider migration worker, with Node 22 and environment configuration
pointing to `erp-base` **staging**, never the production database. No local
Supabase or Docker is needed. Do not copy the main checkout’s `.env.local`.

Start the app through its usual `npm run dev` command after configuring staging.
The open progress screen nudges the worker, so a local cron process is optional.
Without a local scheduler, a closed browser resumes on reopening once the current
worker invocation ends. Hosted background continuation relies on the cron route.

Check a sandbox-provider import whose SIE data is already present:

1. Import the four registers and inspect saved counts while work continues.
2. Reload or close/reopen the page; the same job and receipts should return.
3. Stop/restart the local server during import. Wait for the expired lease, then
   reopen the job; successful documents and lines must not duplicate.
4. Test an expired connection, reconnect, and resume.
5. Review any failed records, then repeat the import and compare source mappings,
   invoice counts, invoice-line counts and payment links.

## Verification and rollout

The SQL assertions in `tests/pg/sql/provider-migration-jobs.sql` run as one
rollback-only transaction. They exercise the service-role RPCs and authenticated
RLS on the staging database, including worker fencing, response-loss retries,
number-less draft invoices, supplier credit notes sharing display numbers,
atomic row completion and payment contention across batches. The matching
`provider-migration-jobs.pg.test.ts` runs the same assertions in pg-real CI.

The six migrations for provider jobs have been applied to staging and verified
byte-for-byte against its migration history. The application and scheduler are
not deployed by this worktree. Browser testing with a real provider account is
still the joint local verification step. Production rollout requires merging and
deploying the application and explicitly approving the production migrations.
The affected production company’s repair is separate and has not been executed.
