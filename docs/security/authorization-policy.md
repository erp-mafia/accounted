# Authorization Policy: Privileged RPCs

This document records the access-control model of database functions that run
with elevated privileges (SECURITY DEFINER) and can mutate or destroy tenant
data. It exists so the authorization contract of each function is reviewable
without reading migration SQL, and so changes to that contract are deliberate.

No machine-readable authorization matrix (authorization-matrix.csv or similar)
exists in this repository yet; this document is currently the authoritative
inventory. If such a matrix is introduced, every function listed here must get
a row in it.

## SIE bulk-delete pair: `replace_sie_import` and `undo_sie_import` (retired)

Both functions hard-deleted a completed SIE import's verifikationer under the
`gnubok.allow_delete` escape hatch, gated to an owner or admin actor.
`supabase/migrations/20260911140532_sie_import_replacement_handoff.sql`
revoked EXECUTE from PUBLIC, anon, authenticated and service_role when the
durable SIE job backbone went live, and
`supabase/migrations/20261012100200_drop_legacy_sie_import_rpcs.sql` dropped
them together with the one-shot writer `import_sie_journal_entries`.

Replace and undo now run as durable jobs (`replace_sie_import_job`,
`request_sie_import_undo`). The pg-real tests that pin this:

- `src/lib/import/__tests__/sie-import.replace.pg.test.ts` (the three
  functions are gone; a legacy import needs reviewed reconciliation)
- `src/lib/import/__tests__/undo-sie-import-actor.pg.test.ts` (the owner or
  admin gate on the undo request, the 42501 errcode, no impersonation from an
  authenticated session)

## Company migration reset: `get_company_migration_reset_eligibility` and `reset_company_for_migration`

Defined in:

- `supabase/migrations/20260818084050_company_migration_reset.sql`
- `supabase/migrations/20260818141018_harden_company_migration_reset_eligibility.sql`
- `supabase/migrations/20260818143004_close_migration_reset_archive_gaps.sql`
- `supabase/migrations/20260818224000_block_vat_state_migration_reset.sql`
- `supabase/migrations/20260818231500_block_external_filing_staging_state.sql`

These functions support the owner-only archive-and-replace recovery flow for a
failed migration. The execution function archives the source company and
creates a clean replacement. It does not delete or rewrite source accounting
records and never sets a retention-trigger bypass.

### Why SECURITY DEFINER

The operation must atomically create a company, copy memberships and settings,
move operational provider consent and subscription state, preserve the
original entitlement expiry, move inbound document routing, switch active
preferences and pending invitations, and insert immutable audit records.
Authenticated callers do not have direct write policies for all of those
tables. SECURITY DEFINER makes the single transaction possible while the
in-function gate below keeps it tenant-scoped.

The internal `company_migration_reset_snapshot` function is also SECURITY
DEFINER so both preview and execution use one fail-closed eligibility
implementation. It has no EXECUTE grant for authenticated callers and is only
reached through the two guarded entry points.

The source-mutation trigger functions are SECURITY DEFINER only so their audit
lookup cannot be hidden by RLS from an invitation acceptor or a delayed
request. They accept no caller-controlled identifiers, expose no rows, and can
only return the row unchanged or raise a generic exception.

### Actor and tenant gate

Neither entry point accepts an actor parameter. The actor is always
`auth.uid()`, so a cookie-session caller cannot assert another user's identity
and a service-role call with no user identity cannot pass the gate.

The actor must have a `company_members.role = 'owner'` row for the requested
company. A non-member receives `COMPANY_RESET_NOT_FOUND`; a member with any
other role receives `COMPANY_RESET_FORBIDDEN`. The HTTP route also requires the
URL company ID to equal the active company resolved by `withRouteContext`.

Execution locks the active source company row and repeats the exact-name,
reason, attestation, and eligibility checks inside the transaction. Any
failure returns a structured result before the first write. Unexpected
database failures roll the transaction back.

### Eligibility and retention contract

Self-service is restricted to active companies created within 30 days. It is
blocked by the company lock date, a closed or locked period, any journal entry
in any status or source, any voucher-sequence row, any customer or supplier
invoice, an incomplete import, a known authority submission, or persisted VAT
declaration workflow state. The VAT state closes the historical direct-lock
path where the signing lock was stored in `extension_data` without a matching
audit row. This prevents a replacement for the same legal
entity from restarting voucher numbering after a draft, migrated voucher, or
sequence state already exists. Live integrations, bank connections, recurring
invoice schedules, pending accrual installments, and non-terminal background
jobs also block because they can write after the interactive session moves.
The owner must attest that no filing was made outside Accounted and acknowledge
that the source remains retained. Accounted cannot independently observe every
filing made directly at an authority, so uncertainty must fail closed and be
escalated rather than inferred from an empty internal audit log.

The source company's imports, transactions, periods, documents, journal
entries, and voucher sequences are not mutated. The replacement starts with no
such rows. An append-only `company_migration_resets` row captures the reason,
confirmations, and source counts, and ordinary immutable `audit_log` rows link
the source and replacement company IDs. The active inbound email address and
custom inbound domain move to the replacement; already received documents do
not move. A database trigger also rejects new memberships on the archived
source, closing the race with an invitation acceptance that began before the
reset transaction. Database mutation guards make the retained source's
imports, transactions, periods, documents, journal rows, invoices, and voucher
sequences write-closed after the audit row is committed. Filing-adjacent payroll,
AGI, annual report, ROT/RUT, bank-connection, authority-audit, and newly arriving
VAT workflow rows receive the same archive guard. Team membership sync
selects active companies only, so an archived source cannot block a later team
member from reaching the replacement.

### Grants

The migration explicitly revokes EXECUTE from PUBLIC and anon, grants the two
entry points only to authenticated, and revokes authenticated access to the
internal snapshot. The audit table grants authenticated SELECT only through an
RLS policy based on active membership of the replacement company. It has no
user DML policy, and UPDATE, DELETE, and TRUNCATE are blocked by triggers even
for elevated callers. An owner-only archive endpoint follows that immutable
replacement-to-source link, rechecks current ownership of the active
replacement, requires the source archive marker with a service-role client,
and exports without activating or mutating the source. Authorization does not
depend on retained-source membership because normal team removal and account
anonymization can legitimately change those rows; the immutable reset link
keeps the statutory archive reachable to the legal entity's current owners.
Support inspection follows reset chains with the service-side read-only query
in the runbook.

### Verification

The contract is pinned by:

- `tests/pg/company-migration-reset.pg.test.ts`
- `src/app/api/company/[id]/migration-reset/__tests__/route.test.ts`

Any change to the owner gate, eligibility boundary, source-retention
invariant, grants, or audit immutability must update those tests and this
document in the same change.
