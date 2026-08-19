# Authorization Policy: Privileged RPCs

This document records the access-control model of database functions that run
with elevated privileges (SECURITY DEFINER) and can mutate or destroy tenant
data. It exists so the authorization contract of each function is reviewable
without reading migration SQL, and so changes to that contract are deliberate.

No machine-readable authorization matrix (authorization-matrix.csv or similar)
exists in this repository yet; this document is currently the authoritative
inventory. If such a matrix is introduced, every function listed here must get
a row in it.

## SIE bulk-delete pair: `replace_sie_import` and `undo_sie_import`

Defined in:

- `supabase/migrations/20260727120000_replace_sie_import_authorize_actor.sql`
- `supabase/migrations/20260727121000_undo_sie_import_caller_guard.sql`

Both functions hard-delete a completed SIE import's verifikationer so a fiscal
period can be re-imported (replace) or restored to its pre-import state (undo).
To do that they call `set_config('gnubok.allow_delete', 'true', true)`, which
disarms the BFL immutability and 7-year retention triggers for the transaction.
That makes them the two most dangerous entry points in the schema, and their
authorization model is correspondingly strict.

### Why SECURITY DEFINER

The functions must bypass RLS and the enforcement triggers to perform the
sanctioned bulk delete atomically. Running as the function owner is what allows
the `gnubok.allow_delete` escape hatch to work; the compensating control is the
in-function authorization gate described below, which runs before any mutation.

### Actor resolution

Each function takes `p_user_id uuid DEFAULT NULL` and resolves the acting user
as follows:

- If `auth.role() = 'service_role'`: the actor is
  `COALESCE(p_user_id, auth.uid())`. The service-role client is the cookieless
  server client (`rpcClientForBulkDelete` in `lib/import/sie-import.ts`), used
  to escape the authenticator role's 8s statement timeout. Inside it
  `auth.uid()` is NULL, so the application passes the human user it already
  authenticated as `p_user_id`.
- Every other caller is pinned to its own `auth.uid()`, regardless of what it
  passes as `p_user_id`. This closes the impersonation hole where an
  authenticated PostgREST caller could pass an owner's UUID and walk through
  the gate (the pre-fix behavior of `undo_sie_import`).

This is the same shape as `list_invoice_delivery_summaries_for_service`
(migration `20260727100000`); treat it as the house pattern for any
SECURITY DEFINER function that must accept a caller-asserted actor.

### Authorization gate

The resolved actor must hold the `owner` or `admin` role in
`company_members` for `p_company_id`. The gate fails closed:

- An anon or unauthenticated caller has no membership row, `v_caller_role`
  resolves NULL, and the function raises before any mutation and before
  `gnubok.allow_delete` is ever set.
- The raise uses `ERRCODE 42501` (insufficient_privilege) so application
  routes can map it to a 403.

### Grants

Supabase's default privileges grant EXECUTE on every new public function to
PUBLIC and to anon/authenticated/service_role, and CREATE OR REPLACE
re-introduces those grants. Both migrations therefore end with an explicit:

- `REVOKE EXECUTE ... FROM PUBLIC, anon` (revoking anon alone is not enough;
  anon is a member of PUBLIC and would stay callable through the PUBLIC grant)
- `GRANT EXECUTE ... TO authenticated, service_role`

`authenticated` retains EXECUTE on purpose: on self-hosted installs without a
`SUPABASE_SERVICE_ROLE_KEY`, the application falls back to running these RPCs
on the caller's own session client. The in-function owner/admin gate scopes
such callers to companies they actually administer, so this is tenant-scoped
access, not a privilege escalation.

### Tenant isolation contract

Every mutation inside both functions filters on `p_company_id`, and the gate
guarantees the actor administers that company. A caller can therefore never
reach another tenant's data: the pre-fix `replace_sie_import` (no gate,
EXECUTE held by anon) was a cross-tenant data-destruction primitive, and the
gate plus the REVOKEs are what closed it.

### Verification

The contract is pinned by pg-real tests (run with `npm run test:pg`):

- `lib/import/__tests__/sie-import.replace.pg.test.ts`
- `lib/import/__tests__/undo-sie-import-actor.pg.test.ts` (spoofed
  `p_user_id` rejection, the 42501 errcode, and the tightened grants)

Any change to either function's signature, gate, or grants must update these
tests and this document in the same change.

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
- `app/api/company/[id]/migration-reset/__tests__/route.test.ts`

Any change to the owner gate, eligibility boundary, source-retention
invariant, grants, or audit immutability must update those tests and this
document in the same change.
