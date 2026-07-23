# Authorization Policy

Status: **Approved Documented Security Decision**
Owner: Emil Mattsson (emil.mattsson@arcim.io)
Last reviewed: 2026-07-23

This document records authorization decisions for Accounted that go beyond the
default "the resource creator is the only person who can act on it" model.
It is the canonical reference for compliance reviewers (OWASP ASVS V8, ISO
27001:2022 A.5.1 / A.8.3 / A.8.5, SOC 2 CC6.1) when they encounter an
authorization check that uses `company_id` rather than `user_id`.

---

## Multi-tenant model

Accounted is a multi-tenant SaaS where the unit of business ownership is the
**company** (a row in `public.companies`). Users access companies through
the `company_members` table, which links a user to one or more companies
with a role (`owner` / `admin` / `member` / `viewer`).

The active company is resolved on every request by
`lib/supabase/middleware.ts`. Application code reads it via
`ctx.companyId` (extensions) or `companyId` resolved from the cookie. Row
Level Security policies on every business table use the `user_company_ids()`
DB helper to enforce membership.

The user is **never** the authoritative tenant identifier on its own. Any
business data ownership check that compares `user_id` to the actor's
`user.id` instead of the resource's `company_id` is a bug.

---

## Shared-resource model (default)

Business records inside a company are **shared resources**: any member of
the company can read and write them, subject to their role. This includes:

- Customer invoices and supplier invoices
- Journal entries and bank transactions
- Customers and suppliers
- Receipts and documents
- **Bank connections (Enable Banking PSD2)**
- Invoice delivery metadata and archived sent PDFs
- Mapping rules, booking templates, counterparty templates
- Salary runs and AGI declarations
- Company settings

The role of the actor (owner, admin, member, viewer) restricts what
operations they can perform via `lib/auth/require-write.ts`, but does not
restrict *which records* they can act on. A viewer cannot post any journal
entry; a member can post any journal entry their company owns, regardless
of who originally drafted it.

Invoice delivery list responses are data-minimized even for authorized
company members. They expose masked recipient domains and operational status,
but not BCC recipients, message bodies, subjects, reply-to addresses, provider
message IDs, attachment filenames, or attachment checksums. Archived PDFs are
served only when their document row belongs to the request's active company.
The underlying exact delivery payload is selectable only by the user who sent
the message. Other members receive the minimized list through the dedicated
database function, so direct PostgREST access cannot bypass route minimization.
The complete statutory archive is an owner/admin-only server operation and may
include exact company delivery evidence. Deferred booking uses a separate
`SECURITY DEFINER` function that verifies active-company membership and exposes
only the latest archived document ID. The archive route verifies owner/admin
twice: first through the authenticated RLS client and then through a stateless
service-role client with explicit `company_id` and `user_id` predicates. Every
archive query is scoped by that `company_id` or by parent IDs selected for it.

### Why this is intentional

Accounted's users are small businesses and the bookkeepers / consultants they
share access with. Compliance scenarios that drive this model:

1. **Bookkeeper handover.** A consultant who connected a bank during
   onboarding might not be the same person who later configures account
   selection. Forcing `user_id` ownership would lock the second person
   out of fixing the first person's setup.
2. **Vacation cover.** A second admin must be able to disconnect a bank,
   approve a supplier invoice, or send a customer invoice when the
   primary user is unreachable.
3. **Audit trail under BFL 7 kap.** Swedish bookkeeping law requires a
   continuous audit trail per *company*, not per user. Locking entries
   to a single user would interrupt that trail at every personnel
   change.
4. **Role-based, not identity-based, separation of duties.** Where SoD
   matters (e.g. AGI submission, year-end close, salary approval) we
   enforce it through the `role` column on `company_members`, not by
   recording which specific user created the underlying record.

### Compensating controls

Although authorization is by `company_id`, the audit trail is by `user_id`:

- `journal_entries.user_id`, `transactions.user_id`, etc. record who
  *created* a record. These columns are never used for authorization,
  but they are preserved for the audit log and the immutable
  `audit_log` table.
- `event_log` rows include `user_id` so every privileged action
  (consent grants, invoice sends, period locks, document uploads) is
  attributable to a specific user even when authorization is shared.
- The `audit_log` table is immutable (DB trigger `audit_log_immutable`)
  and retained for 7 years per BFL.

---

## Specific decisions

### Invoice CC and BCC configuration: owner or admin only

**Decision.** Changing fixed invoice recipients or adding an arbitrary CC or
BCC recipient to an individual invoice send requires the actor to have the
`owner` or `admin` role in `company_members`. The dashboard hides those change
controls for other roles. The settings route protects fixed-recipient changes;
the dashboard and v1 send routes protect per-send additions before rendering,
number allocation, or email delivery. The database also rejects direct member
changes to fixed recipient fields. Once an owner or admin approves a fixed
recipient, it applies to every send by a writable company member without a new
role check. A fixed recipient that matches the customer address is de-duplicated
with To precedence because it does not introduce a new external disclosure. The
legacy company-email or authenticated sender-email fallback is also fixed
routing: it cannot be supplied by the request, and the sender already has access
to the invoice being sent.

**Why.** Both fixed and per-send recipients can disclose customer invoice data
to a new external address. This is a distinct disclosure decision and needs a
narrower authorization boundary than ordinary invoice sending. Explicit
recipients that collide with To, fixed CC, fixed BCC, or another per-send
recipient are rejected instead of silently changing recipient classification.

**Compensating audit.** Successful invoice sends retain the exact immutable
recipient payload in `invoice_deliveries`, including the actor and company.
Routine delivery-list and send responses remain minimized and never expose BCC.

**Service write boundary.** Delivery persistence uses a stateless service-role
client because authenticated PostgREST writes are intentionally revoked. The
service-only RPCs do not trust that client alone: they verify the supplied actor
is a writable member of the supplied company and bind every invoice and
delivery row to that company. Dashboard routes enter through `withRouteContext`,
v1 and MCP routes enter through `withApiV1` or the approved pending-operation
path, and recurring sends derive actor, company, invoice, and schedule from the
same company-scoped job before calling the RPC.

**Cross-references.**
- OWASP ASVS V2.3: business logic integrity
- OWASP ASVS V8.2.1: operation-level authorization
- GDPR Articles 5(1)(c) and 25(2): minimization and privacy by default
- SOC 2 CC6.1: logical access

### Invoice payment instructions: owner or admin only

**Decision.** Changing the currency-keyed `invoice_payment_accounts` or any
legacy SEK mirror field requires the `owner` or `admin` role. The legacy fields
are `bank_name`, `clearing_number`, `account_number`, `bankgiro`, `plusgiro`,
`swish`, `iban`, and `bic`. The settings route enforces this before persistence,
matching the existing `company_settings` RLS policy.

**Why.** Payment instructions determine where a customer sends company funds.
They need the same administrative boundary as other company financial settings.
All payable invoices, including SEK invoices, must resolve a usable account
before PDF rendering or invoice-number allocation. Credit notes, proformas, and
delivery notes remain exempt because they do not request payment.
Resends are not exempt: the current implementation renders a new PDF from
current company settings instead of reusing an earlier delivery snapshot, so it
must not send a payable document with blank or obsolete remittance details.

**Cross-references.**
- OWASP ASVS V2.3: business logic integrity
- OWASP ASVS V8.2.1: operation-level authorization
- SOC 2 CC6.1: logical access

### bank_connections: managed at company scope

**Decision.** Any active `company_members` row for a company can manage
any `bank_connection` belonging to that company. This covers `POST /connect`,
`PATCH /accounts`, `POST /sync`, and `DELETE /disconnect` in the
`enable-banking` extension.

**Why.** A bank connection is a company-level resource (it represents the
company's relationship to its bank under PSD2 consent obtained on behalf of
the company, not a personal banking relationship). Restricting management
to the user who initiated the OAuth flow would create a lockout failure
mode that exceeds the cross-tenant access risk of the broader model.

**Compensating audit.** Every state transition on a bank connection emits
a structured event persisted to `event_log` with both `user_id` and
`company_id`:

- `bank_connection.consent_granted`: PSD2 callback completed, account
  metadata stored, status `pending_selection`. Emitted from
  `app/api/extensions/enable-banking/callback/route.ts`.
- `bank_connection.account_selection_changed`: user chose which accounts
  to sync; status may transition `pending_selection → active`. Emitted
  from `PATCH /accounts` in `extensions/general/enable-banking/index.ts`.
- `bank_connection.revoked`: user disconnected the bank; PSD2 session is
  revoked at Enable Banking; status set to `revoked`. Emitted from
  `DELETE /disconnect`.

The `event_log` row carries: `connectionId`, `bankName`, `previousStatus`,
`newStatus`, `accountCount` / `enabledCount` / `totalCount`, `userId`,
`companyId`, `consentExpiresAt`. This is sufficient to attribute every
PSD2 consent decision to a specific user under that company.

**Cross-references.**
- ASVS V8.2.1: authorization checks at trust boundary
- ASVS V16: audit logging of security-relevant events
- ISO 27001:2022 A.5.1, A.8.3, A.8.5: access control and information
  access restriction
- SOC 2 CC6.1, CC7.2: logical access controls and detection of
  unauthorized changes
- GDPR Art.30: records of processing activities (PSD2 consent
  decisions)
- BFL 7 kap.: 7-year retention of audit trail

---

## Reviewers' checklist

When reviewing a PR that touches authorization:

1. The check filters by **`company_id`** resolved from the verified
   request context (`ctx.companyId` in extensions; `companyId` in API
   routes). Never `user.id` as a substitute.
2. If `companyId` is absent, the handler returns `400`. Never falls
   back to a different identifier.
3. The actor's company membership is enforced by either RLS
   (`user_company_ids()` policy) or an explicit application-side check
   against `company_members`. Both is best.
4. Any state change is emitted as a structured event with `userId` and
   `companyId` so the audit trail remains attributable.
5. Where role-level restrictions apply, `requireWrite()` /
   `requireRole()` from `lib/auth/require-write.ts` enforces them.

Deviations from the shared-resource model (e.g. resources that *should*
be locked to a single user) must be added to this document with the same
"Decision / Why / Compensating audit" structure before merging.
