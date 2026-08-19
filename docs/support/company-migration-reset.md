# Company migration reset support runbook

This runbook covers the owner-only self-service flow for redoing a failed
company migration. The operation is deliberately an archive-and-replace reset.
It is not a deletion or an in-place rewrite.

## Legal and product boundary

Swedish Bookkeeping Act (1999:1078) 1 kap. 2 § defines räkenskapsinformation
broadly. It includes journal and ledger information, vouchers, supporting
systems information, important agreements, and other information needed to
understand the postings. Chapter 7 requires electronic accounting information
to remain durable, accessible, and preserved through the seventh year after
the relevant calendar year. BFNAR 2013:2 also requires treatment history to
show added postings and system changes that affect how accounting information
is processed.

Authoritative references:

- [Bokföringslag (1999:1078), especially 1 kap. 2 § and 7 kap. 1-2 §§](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/)
- [BFNAR 2013:2 Bokföring, especially points 2.17 and 9.16](https://www.bfn.se/wp-content/uploads/2020/06/bfnar13-2-grund.pdf)

Accounted cannot reliably prove that every provider-imported customer,
invoice, transaction, or document is disposable test data. Some provider
imports do not carry row-level provenance, and Accounted cannot observe every
filing made directly at Skatteverket or Bolagsverket. Therefore this feature
never deletes or rewrites source data.

The self-service boundary is intentionally narrow:

- The company must be active and no more than 30 days old.
- Sandbox companies are excluded because they have a separate disposable-data
  cleanup lifecycle and must not become retained legal archives.
- The caller must be an owner, not merely an admin or member.
- No company lock date may exist, and no fiscal period may be locked, closed,
  or marked closed in the previous bookkeeping system.
- No journal entry may exist in any status or source. Drafts, imported entries,
  opening balances, postings, reversals, and corrections all block the reset.
- No voucher-sequence row may exist, including a zero-valued sequence. This
  prevents the same legal entity from receiving two independently restarted
  voucher-number namespaces.
- No customer or supplier invoice may exist, even without a journal entry.
  Issued invoices, credit-note references, and received supplier invoices are
  retained accounting documents and cannot be stranded in a hidden source.
- No bank connection may be pending or active. This prevents the service-role
  sync job from writing new transactions into the retained source after reset.
- No SIE, bank-file, or tax-account-file import may be pending or processing.
- No commerce, Stripe, or Skatteverket connection, recurring invoice schedule,
  or pending accrual installment may still be able to write in the background.
- No import, OCR, API operation, invoice delivery, payment sync, or messaging
  worker may still be queued or processing for the company.
- No AGI upload, VAT declaration draft, lock or submission, ROT/RUT request,
  or production annual report submission may exist. Persisted VAT and AGI
  workflow state blocks even when an older direct action has no audit row.
  Every generated ROT/RUT payout file blocks because upload and signing happen
  outside Accounted before the local request can be marked submitted.
- The owner must separately attest that nothing was filed outside Accounted.
  Accounted cannot verify that external fact. If the owner is unsure, support
  must stop the reset and escalate instead of interpreting silence as consent.
- The owner must acknowledge that the source copy is retained, provide an
  audit reason, and type the exact displayed company name.

If any condition fails, self-service returns `COMPANY_RESET_INELIGIBLE` and
makes no change. Support must not override the result with deletion SQL.

## What the reset does

`reset_company_for_migration` executes in one database transaction:

1. It proves the caller is an owner before taking tenant-wide locks, then locks
   the source and repeats authorization, confirmation, and eligibility checks.
2. It archives the source company by setting `archived_at` and `archived_by`.
3. It creates a replacement company with the same legal identity, team, owner
   and member roles, company settings, and invoice-number counters. Setup state
   and the company bookkeeping lock date are cleared on the replacement.
4. It seeds a fresh chart of accounts and primary `1930` cash account.
5. It transfers provider migration consents, subscription state, and existing
   capability grants. The automatically created fresh trial is removed before
   the original grants move, so resetting cannot extend a trial.
6. It transfers the active inbound email address and any custom inbound domain
   to the replacement, so future documents are routed to the active company.
7. It transfers unexpired pending member invitations. Accepted, revoked, and
   expired invitation history stays on the source.
8. It switches active-company preferences to the replacement.
9. It writes an immutable `company_migration_resets` audit record and two
   append-only `audit_log` records.
10. Database guards make the retained source's accounting and import rows
    write-closed, including bank connections, payroll and AGI records, annual
    report submissions, ROT/RUT requests, authority audit rows, and VAT or AGI
    workflow rows from requests that were already waiting on external signing.

The transaction does not disable a trigger. It does not delete, detach,
renumber, recalculate, copy, or mutate any source bookkeeping record.

The following stay on the archived source company unchanged:

- SIE, bank-file, and tax-account-file import records
- bank transactions and expired or revoked bank connections
- fiscal periods and their lock or close state
- documents, hashes, version chains, and voucher links
- customers and suppliers
- authority and general audit logs
- extension runtime state, including any non-blocking provider history

Eligibility requires journal-entry, voucher-sequence, customer-invoice, and
supplier-invoice counts to be zero.
Those tables remain covered by the immutable-source guards and audit counts as
defense in depth. The replacement company intentionally has no fiscal period,
journal entry, transaction, document, import record, or voucher sequence. The
new migration creates the applicable periods and its first sequence state.
Provider migration consent is transferred so the owner can start again from
the import workspace. Bank connections are not transferred. Pending or active
connections block the reset and must be disconnected first. Reconnect
deliberately after the replacement migration is verified. The active inbound
email address and custom inbound domain move to the replacement; already
received documents do not move.

## Support checks

Start with the request ID from the API response or browser network panel. The
routes log operations `company.migration-reset.preview`,
`company.migration-reset.execute`, and `company.migration-reset.archive`.

Use read-only checks only. Do not run a reset RPC on behalf of a customer, do
not run `scripts/clear-user-data.sql`, and do not disable retention or journal
enforcement triggers.

The retained source is hidden from normal company selection. A current owner
of the active replacement can use **Settings > Company > Previous migration >
Download archive**. That owner-only route verifies the immutable reset link,
current replacement ownership, and the source archive marker before using the
read-only archive exporter. It deliberately does not rely on retained-source
membership, which can change through team removal or account anonymization. It
never makes the source active. If documents push
the direct ZIP over the response limit, the owner can download the structured
data without documents and support must provide the complete document package
through an approved read-only export path. Never unarchive the source merely to
reuse ordinary write-capable screens.

The replacement represents the same legal entity, not a newly formed business.
Its `next_invoice_number` and `next_arrival_number` therefore continue from the
source settings even when eligibility confirms that no invoice rows exist.
Those counters can reflect an imported or previously allocated series, and
resetting them to 1 could reuse a number or conceal a gap. Do not manually reset
either counter as part of migration recovery. Escalate a suspected numbering
error for a separate, documented compliance review.

After deployment, the audit chain can be inspected read-only with:

```sql
select
  id,
  source_company_id,
  replacement_company_id,
  actor_id,
  reason,
  confirmation_snapshot,
  source_counts,
  created_at
from public.company_migration_resets
where source_company_id = '<source-company-id>'
   or replacement_company_id = '<replacement-company-id>';
```

Confirm the source was retained and the replacement is active:

```sql
select id, name, org_number, archived_at, archived_by, created_at
from public.companies
where id in ('<source-company-id>', '<replacement-company-id>');
```

Compare source record counts without selecting personal or accounting content:

```sql
select
  (select count(*) from public.journal_entries where company_id = '<source-company-id>') as journal_entries,
  (select count(*)
   from public.journal_entry_lines line
   join public.journal_entries entry on entry.id = line.journal_entry_id
   where entry.company_id = '<source-company-id>') as journal_entry_lines,
  (select count(*) from public.transactions where company_id = '<source-company-id>') as transactions,
  (select count(*) from public.document_attachments where company_id = '<source-company-id>') as documents,
  (select count(*) from public.fiscal_periods where company_id = '<source-company-id>') as fiscal_periods,
  (select count(*) from public.voucher_sequences where company_id = '<source-company-id>') as voucher_sequences;
```

The counts should match `company_migration_resets.source_counts`. A mismatch is
an incident requiring investigation. Do not repair it by editing the source.

## Common blocker interpretation

- `migration_window_expired`: the company is older than the self-service
  recovery window. Escalate for a case-specific legal and accounting review.
- `sandbox_company`: use the existing sandbox cleanup lifecycle. Do not convert
  disposable sandbox data into a retained migration archive.
- `locked_or_closed_periods`: a company lock date or finalized period exists.
  Do not clear or unlock it to enable reset.
- `journal_entries_exist`: at least one draft or committed journal entry exists,
  regardless of whether it came from an import. Do not delete, reverse, or edit
  the entry to enable reset. Continue in the existing company or escalate for
  case-specific review.
- `voucher_sequence_state_exists`: at least one voucher sequence has been
  created. Do not renumber or remove it to enable reset.
- `invoice_records_exist`: at least one customer or supplier invoice exists.
  Do not delete, cancel, credit, or detach it to enable reset. Continue in the
  existing company or escalate for case-specific review.
- `authority_submission_detected`: Accounted has evidence of an authority
  interaction, including a persisted VAT draft, an AGI upload awaiting BankID
  signing, or any generated ROT/RUT payout file. Do not reset even if the owner
  believes it was a test without first establishing the authority environment
  and legal status. Remove only a local VAT draft that never left Accounted,
  and only through the product flow; never clear extension data, payout
  requests, or audit rows manually. An AGI upload, generated payout file,
  locked declaration, or possibly signed declaration requires legal escalation,
  not cleanup.
- `live_bank_connections`: disconnect every pending or active bank connection
  first. Do not bypass the blocker because the sync cron can import without an
  interactive company session.
- `imports_in_progress`: wait until every import completes or fails. Never
  change an import status manually to bypass this concurrency guard.
- `active_integrations_or_schedules`: disable the reported integrations and
  automatic schedules first. Team-level grants and service credentials can
  otherwise keep background writers active after the session switches company.
- `background_work_in_progress`: wait for every queued or processing import,
  OCR, API, delivery, payment, or messaging job to reach a terminal state.
- `COMPANY_RESET_CONFIRMATION_MISMATCH`: confirm the user typed the displayed
  name from `company_settings.company_name`, not a stale internal name.

## Deployment and rollback

The migration files are
`supabase/migrations/20260818084050_company_migration_reset.sql` and
`supabase/migrations/20260818141018_harden_company_migration_reset_eligibility.sql`
and
`supabase/migrations/20260818143004_close_migration_reset_archive_gaps.sql` and
`supabase/migrations/20260818224000_block_vat_state_migration_reset.sql` and
`supabase/migrations/20260818231500_block_external_filing_staging_state.sql`.
Apply them only to the permitted `erpbase` staging branch through the normal
migration workflow, then deploy application code. Never deploy the UI/API
before all listed migrations exist.

Before production rollout:

1. Run the pg-real suite against an approved disposable test database.
2. Reconcile every remote migration version with the repository.
3. Verify anon has no execute privilege and authenticated has execute only on
   the preview and execution RPCs. The archive route uses the audit table's
   replacement-membership RLS policy and repeats owner checks with its
   service-role export client.
4. Exercise the flow with synthetic data in an approved non-production
   environment, including every blocker and a forced transaction failure.
5. Confirm monitoring captures the request ID and structured error code without
   logging the typed company name or reason.

Application rollback can hide the UI and route, but it must not drop the audit
table or delete reset history. Database rollback is additive only: revoke new
RPC execution if necessary and ship a new migration. Never modify or remove the
applied migration file.

## Escalation boundary

Escalate to Emil and an accounting/legal reviewer when the owner cannot make
the external-filing attestation, the company is outside the 30-day window, a
period is closed or locked, any journal entry or voucher sequence exists, or a
customer or supplier invoice exists, or a known authority submission exists. A
live bank connection is operational, not a legal override case: disconnect it
before retrying. The safe fallback is to
retain the source company and perform no reset.
