---
name: accounted-api
description: >-
  Consume the Accounted REST API (Swedish double-entry bookkeeping SaaS,
  https://app.gnubok.se/api/v1). Use when building an integration, app, backend
  job, or agent tool layer against Accounted: invoices, customers,
  suppliers, supplier invoices, journal entries (bokföring), bank
  transactions and reconciliation, payroll (lön), VAT/moms and financial
  reports, SIE import/export, documents, webhooks. Covers auth with
  gnubok_sk_ API keys, conventions (dry-run, idempotency, cursor
  pagination, scopes), and all 284 endpoints.
---

<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Accounted API integration

Accounted is Swedish double-entry bookkeeping (bokföring) as a service: BAS
chart of accounts, verifikationer with legally immutable audit trails, VAT
(moms), payroll (lön), invoicing, bank reconciliation, and statutory reports,
exposed as a REST API designed for agents and integrations first.

**This skill is for building software against the REST API** (an app, a
backend job, an agent tool layer). If the goal is to *operate* a ledger
conversationally (book receipts, run month close), use the Accounted MCP
connector and its workflow skills instead: install the `accounted` plugin or
see https://app.gnubok.se/docs/api/connect-claude.

If you have used Stripe's API the shape will feel familiar: bearer keys, dated
versions, idempotency keys, webhook signatures, cursor pagination. The domain
rules are Swedish accounting law; the Gotchas section below stops the classic
violations before you ship them.

## Auth and base URL

Every request sends a bearer key:

```bash
curl https://app.gnubok.se/api/v1/companies \
  -H "Authorization: Bearer gnubok_sk_live_..."
```

- Base URL: `https://app.gnubok.se/api/v1` (legacy machine host, permanent).
  `https://app.accounted.se/api/v1` serves the identical API.
- Keys are created in the Accounted dashboard under **Settings -> API**
  (`/settings/api`). Two prefixes:
  - `gnubok_sk_live_*` commits real writes.
  - `gnubok_sk_test_*` reads real company data but forces every write into
    dry-run (responses carry `X-Gnubok-Mode: test`). Develop and run evals
    with a test key; switch to live last.
- Each key carries **scopes** (`invoices:read`, `invoices:write`,
  `payroll:write`, `webhooks:manage`, ...). Every endpoint in the index below
  is annotated with its required scope; a missing scope returns `403`.
- Rate limit: 100 requests/minute per key. On `429`, honor `Retry-After`.
- URLs carry the company id explicitly
  (`/api/v1/companies/{companyId}/invoices`). A key can act on any company its
  user is a member of; start every session with `GET /api/v1/companies` to
  discover ids. There is no implicit "current company".

First calls, in order: `GET /api/v1/health` (no auth, connectivity), then
`GET /api/v1/companies` (auth works, discover `companyId`).

## Conventions

These rules hold across the whole surface; endpoint entries below do not
repeat them.

**Response envelope.** Success: `{ "data": ..., "meta": { "request_id",
"api_version", "next_cursor"?, "audit"?, "partial_expansions"? } }`. Errors
replace `data` with `error` (no `meta`; `request_id` moves inside `error`).

**Errors.** Stable machine codes with agent-oriented remediation:

```json
{ "error": { "code": "PERIOD_LOCKED", "message": "Svenska", "message_en": "English",
  "details": {}, "recovery_hint": "next step", "docs_url": "...",
  "valid_alternatives": {}, "request_id": "req_..." } }
```

React to `code`, read `message_en` and `recovery_hint`, follow
`valid_alternatives` when present (e.g. `next_open_period`). Standard codes on
every endpoint: `400` validation, `401` bad key, `403` missing scope, `404`,
`429` rate limited (honor `Retry-After`), `500`. Full catalogue:
https://app.gnubok.se/docs/api/errors. Only endpoint-specific codes are
mentioned per endpoint below.

**Cursor pagination.** List endpoints take `?cursor=` and return
`meta.next_cursor`; loop until it is absent/null. A stale or tampered cursor
is NOT an error: the first page is returned again, so terminate on
`next_cursor`, never on "page looks familiar".

**Dry-run on every write that supports it** (`dry-run` badge in the index).
Send `?dry_run=true` (or `X-Dry-Run: true`): the response is always `200` with
`data.dry_run: true` plus a preview (would-be record, journal lines, voucher
number) and the `X-Dry-Run: true` response header; nothing is committed.
Commit by re-issuing without the flag and with the SAME `Idempotency-Key`
(the dry run is not cached against the key). Preview first on any financial
write; it is free.

**Idempotency-Key.** Send a fresh UUID header on every POST/PATCH/DELETE;
several endpoints reject writes without one (`400`). Replaying the same
key+body returns the original response with the `Idempotent-Replayed: true`
header; the same key with a different body returns `409 IDEMPOTENCY_KEY_REUSE`
(24h window). Safe retry loop: keep the key, keep the body.

**Test keys are simulation-only.** With a `gnubok_sk_test_*` key, reads
return real company data (responses carry `X-Gnubok-Mode: test`) and every
write is forced into dry-run; writes that cannot be simulated return
`403 TEST_KEY_WRITE_BLOCKED`. Nothing a test key does ever persists: it is
`?dry_run=true` baked into the credential. Full end-to-end write tests
therefore need a live key against a company you own.

**Atomic writes.** A mutation either commits fully or errors with no side
effects. There is no partial state to clean up after an error response
(`bulk-create` endpoints that do partial success say so explicitly).

**Audit inline.** Successful financial writes include `meta.audit` (voucher
number, audit-trail URL, immutability timestamp). No follow-up read needed to
confirm what was booked.

**Expansion.** Some list/detail endpoints take `?expand=a,b` (documented per
endpoint). If an expansion fails the response still succeeds and names the
failed parts in `meta.partial_expansions`; check it before trusting expanded
fields.

**Async operations.** Long-running actions (fiscal-period lock/close/year-end,
imports) return `202` with an operation id; poll `GET /api/v1/operations/{id}`
until `status` is `succeeded`/`failed`. The response shape is identical
whether the work ran inline or queued.

**Versioning.** Dated versions (current: see `meta.api_version`). Responses
carry the `Gnubok-Version` header; request pinning via a `Gnubok-Version`
request header is reserved for a future breaking change and is not read
today. Additive changes ship without a version bump; see
https://app.gnubok.se/docs/api/versioning.

**Index badges.** Every operation line below carries machine-readable
annotations from the spec: `scope:` (required key scope), `risk:` (low/medium/
high; confirm with a human before unprompted high-risk calls), `idempotent`
(safe to retry), `dry-run` (previewable), `reversible` (a single follow-up
call can undo it, e.g. invoice credit).

## Endpoint index

API version `2026-05-12`, 284 operations. Paths are shown without
their `/api/v1` prefix (full base URL: `https://app.gnubok.se/api/v1`).

### Core (11)

Full detail: [references/core.md](references/core.md)

```text
GET /companies : List companies the API key can access [scope:companies:read risk:low idempotent]
POST /companies : Create a company and set it up for bookkeeping [scope:companies:write risk:medium dry-run]
POST /companies/{companyId}/peppol/access-request : Ask the operators to switch on Peppol for the company (sending, optionally receiving) [scope:companies:write risk:medium idempotent dry-run]
GET /companies/{companyId}/peppol/registration : Read the company's Peppol receiving status: access grant, eligibility and registration [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/peppol/registration : Register the company as a Peppol participant so it can receive e-invoices [scope:companies:write risk:high idempotent dry-run]
GET /companies/{companyId}/settings : Read the company settings [scope:companies:read risk:low idempotent]
PATCH /companies/{companyId}/settings : Partially update company settings (contact, invoicing, reminders, voucher series, toggles) [scope:companies:write risk:medium idempotent dry-run reversible]
PATCH /companies/{companyId}/settings/bookkeeping-lock : Set, move or remove the company-wide bookkeeping lock date [scope:companies:write risk:high idempotent dry-run reversible]
PATCH /companies/{companyId}/settings/tax-profile : Change the tax and legal profile: VAT, F-skatt, employer registration, fiscal year, accounting method [scope:companies:write risk:high idempotent dry-run reversible]
GET /health : Health check [risk:low idempotent]
GET /operations/{id} : Poll a long-running operation by id [scope:operations:read risk:low idempotent]
```

### Journal entries (18)

Full detail: [references/journal-entries.md](references/journal-entries.md)

```text
GET /companies/{companyId}/journal-entries : List journal entries (verifikationer) [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/journal-entries : Create a draft journal entry (verifikation) [scope:bookkeeping:write risk:high idempotent dry-run reversible]
GET /companies/{companyId}/journal-entries/{id} : Retrieve a single verifikation by id [scope:reports:read risk:low idempotent]
PATCH /companies/{companyId}/journal-entries/{id} : Replace the header and lines of a DRAFT journal entry [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
DELETE /companies/{companyId}/journal-entries/{id} : Cancel an uncommitted draft verifikation [scope:bookkeeping:write risk:low idempotent dry-run]
POST /companies/{companyId}/journal-entries/{id}/commit : Commit a draft journal entry [scope:bookkeeping:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/journal-entries/{id}/correct : Correct a posted journal entry (BFL 5:5 storno-then-replace) [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/journal-entries/{id}/correct-metadata : Correct the description and/or date of a posted verifikat inside the same verifikat (inline rättelse) [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/journal-entries/{id}/no-document-required : Mark a verifikat as "Inget underlag krävs" (no supporting document required) [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
DELETE /companies/{companyId}/journal-entries/{id}/no-document-required : Remove the "Inget underlag krävs" mark from a verifikat [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/journal-entries/{id}/notes : Set, replace or clear the internal note (anteckning) on a verifikat [scope:bookkeeping:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/journal-entries/{id}/rattelse-log : Read the inline rättelse history of a verifikat, newest first [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/journal-entries/{id}/redate : Move a posted verifikat to another date, and thereby another period, by storno and re-post [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/journal-entries/{id}/reverse : Storno a posted journal entry [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/journal-entries/{id}/strike-lines : Strike lines of a posted verifikat and add replacement lines inside the same verifikat (inline rättelse) [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/journal-entries/batch-create : Create up to 50 draft journal entries (partial-success) [scope:bookkeeping:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/journal-entries/no-document-required : Mark many posted verifikat as "Inget underlag krävs" in one call [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/voucher-gap-explanations : Document a gap in the verifikationsserie (BFL 5 kap 6-7 §§) [scope:bookkeeping:write risk:low idempotent dry-run]
```

### Periods and registers (41)

Full detail: [references/periods.md](references/periods.md)

```text
GET /companies/{companyId}/accounts : List chart-of-accounts entries (BAS chart) [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/accounts : Add an account to the chart of accounts (kontoplan) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/accounts/{number} : Edit or deactivate an account in the chart of accounts [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/accounts/{number} : Delete an account nothing has been booked on [scope:bookkeeping:write risk:medium idempotent dry-run]
POST /companies/{companyId}/accounts/activate : Activate BAS accounts in bulk [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/accounts/deactivate : Deactivate accounts in bulk [scope:bookkeeping:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/compliance/check : Run a structured compliance pre-flight check [scope:compliance:read risk:low idempotent]
GET /companies/{companyId}/dimensions : List dimensions (kostnadsställe/projekt) with their values [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/dimensions : Create a custom dimension (e.g. Avdelning, Kund, Fordon) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/dimensions/{id} : Rename, archive or reorder a dimension [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/dimensions/{id} : Delete a custom dimension nobody has booked on [scope:bookkeeping:write risk:medium idempotent dry-run]
POST /companies/{companyId}/dimensions/{id}/values : Create a dimension value (kostnadsställe/projekt code) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/dimensions/{id}/values/{valueId} : Update a dimension value (rename, archive, set start/end date) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/dimensions/{id}/values/{valueId} : Delete an unreferenced dimension value [scope:bookkeeping:write risk:medium idempotent]
GET /companies/{companyId}/fiscal-periods : List fiscal periods (räkenskapsår) [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/fiscal-periods : Create a fiscal year (räkenskapsår) [scope:bookkeeping:write risk:medium idempotent dry-run]
PATCH /companies/{companyId}/fiscal-periods/{id} : Rename or re-date an open fiscal year [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
PATCH /companies/{companyId}/fiscal-periods/{id}/arsredovisning/compliance : Answer the årsredovisning compliance questions and record the confirmations [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/fiscal-periods/{id}/arsredovisning/ixbrl : The K2 årsredovisning as an inline XBRL (XHTML) document [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/fiscal-periods/{id}/arsredovisning/ixbrl/validate : Pre-flight the generated iXBRL årsredovisning against Bolagsverket's kontrollera rules [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/fiscal-periods/{id}/arsredovisning/narrative : Edit the årsredovisning texts: förvaltningsberättelse, resultatdisposition, disclosure notes and K3 note texts [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/fiscal-periods/{id}/arsredovisning/pdf : The årsredovisning as PDF: the live draft or a frozen version [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/fiscal-periods/{id}/arsredovisning/signatures : The årsredovisning signer roster and its signatures [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/fiscal-periods/{id}/arsredovisning/signatures : Add a board member or the VD to the årsredovisning signer roster [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
PATCH /companies/{companyId}/fiscal-periods/{id}/arsredovisning/signatures/{signatureId} : Record that a signer signed the frozen årsredovisning version, or declined [scope:bookkeeping:write risk:medium idempotent dry-run]
DELETE /companies/{companyId}/fiscal-periods/{id}/arsredovisning/signatures/{signatureId} : Remove a signer from the årsredovisning roster before a version binds it [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/fiscal-periods/{id}/arsredovisning/versions : Freeze an immutable årsredovisning version: a draft snapshot, or the version that gets signed [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/fiscal-periods/{id}/close : Close a fiscal period (IRREVERSIBLE per BFL 5 kap 8 §) [scope:bookkeeping:write risk:high idempotent]
POST /companies/{companyId}/fiscal-periods/{id}/close-external : Mark a migrated fiscal year as closed in the previous system (klarmarkera) [scope:bookkeeping:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/fiscal-periods/{id}/currency-revaluation : Run FX revaluation for the fiscal period [scope:bookkeeping:write risk:high idempotent reversible]
POST /companies/{companyId}/fiscal-periods/{id}/lock : Lock a fiscal period (no new entries can be posted into it) [scope:bookkeeping:write risk:high idempotent reversible]
POST /companies/{companyId}/fiscal-periods/{id}/opening-balances : Generate opening-balance verifikation for the next fiscal period [scope:bookkeeping:write risk:high idempotent reversible]
POST /companies/{companyId}/fiscal-periods/{id}/opening-balances/correct : Correct a year's ingående balanser by storno: the full corrected IB replaces the old one [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/fiscal-periods/{id}/opening-balances/manual : Book a fiscal year's ingående balanser (IB) from explicit lines, for a company new to Accounted [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/fiscal-periods/{id}/reopen-external : Undo klarmarkera: reopen a year marked closed in the previous system [scope:bookkeeping:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/fiscal-periods/{id}/unlock : Unlock a locked (not closed) fiscal year [scope:bookkeeping:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/fiscal-periods/{id}/year-end : Execute year-end closing (currency revaluation + closing entry) [scope:bookkeeping:write risk:high idempotent]
POST /companies/{companyId}/skattekonto/sync : Fetch the skattekonto from Skatteverket now instead of waiting for the hourly sync [scope:transactions:write risk:low idempotent dry-run]
POST /companies/{companyId}/skatteverket/agi/validate-huvuduppgift : Pre-validate an AGI huvuduppgift at Skatteverket without filing anything [scope:compliance:read risk:low idempotent]
POST /companies/{companyId}/skatteverket/agi/validate-individuppgift : Pre-validate one AGI individuppgift at Skatteverket without filing anything [scope:compliance:read risk:low idempotent]
GET /companies/{companyId}/skatteverket/vat-declarations : Read a filed momsdeklaration (submitted and/or decided) from Skatteverket [scope:compliance:read risk:low idempotent]
```

### Invoices (AR) (17)

Full detail: [references/invoices.md](references/invoices.md)

```text
GET /companies/{companyId}/invoices : List invoices for a company [scope:invoices:read risk:low idempotent]
POST /companies/{companyId}/invoices : Create a draft invoice, proforma, or delivery note [scope:invoices:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/invoices/{id} : Retrieve a single invoice by id [scope:invoices:read risk:low idempotent]
PATCH /companies/{companyId}/invoices/{id} : Update a draft invoice (metadata fields, optionally replacing line items) [scope:invoices:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/invoices/{id} : Delete a draft invoice (hard delete if unnumbered, makulering if numbered) [scope:invoices:write risk:high dry-run]
POST /companies/{companyId}/invoices/{id}/book : Book a sent customer invoice that was issued without a verifikat (the deferred Bokför step) [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/credit : Issue a credit note (kreditfaktura) against an invoice [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/mark-paid : Record a payment against an invoice [scope:invoices:write risk:medium idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/mark-sent : Transition a draft invoice to sent (without emailing) [scope:invoices:write risk:medium idempotent dry-run]
GET /companies/{companyId}/invoices/{id}/pdf : Download the rendered invoice PDF [scope:invoices:read risk:low idempotent]
GET /companies/{companyId}/invoices/{id}/peppol : Check whether a customer invoice can be sent over Peppol, to which participant, and what is missing [scope:invoices:read risk:low idempotent]
GET /companies/{companyId}/invoices/{id}/peppol/deliveries : List an invoice's Peppol deliveries and their network status [scope:invoices:read risk:low idempotent]
POST /companies/{companyId}/invoices/{id}/quote-status : Record the customer decision on a quote (offert) [scope:invoices:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/invoices/{id}/send : Send a draft invoice to the customer by email [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/send-peppol : Send a customer invoice as a Peppol e-invoice (BIS Billing 3) through the access point [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/bulk-book : Book many customer invoices in one call, each with its own outcome [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/bulk-create : Create up to 50 draft invoices in one call (partial-success) [scope:invoices:write risk:medium idempotent dry-run reversible]
```

### Customers and articles (7)

Full detail: [references/customers.md](references/customers.md)

```text
GET /companies/{companyId}/articles : List the article register (artikelregister) [scope:invoices:read risk:low idempotent]
GET /companies/{companyId}/customers : List customers for a company [scope:customers:read risk:low idempotent]
POST /companies/{companyId}/customers : Create a customer [scope:customers:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/customers/{id} : Retrieve a single customer by id [scope:customers:read risk:low idempotent]
PATCH /companies/{companyId}/customers/{id} : Partially update a customer [scope:customers:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/customers/{id} : Archive a customer (soft-delete) [scope:customers:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/customers/bulk-create : Create up to 50 customers in one call (partial-success) [scope:customers:write risk:low idempotent dry-run reversible]
```

### Suppliers (AP) (29)

Full detail: [references/suppliers.md](references/suppliers.md)

```text
GET /companies/{companyId}/expense-claims : List expense claims (utlägg): what the company owes owners and employees for private purchases [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/expense-claims : Register an expense claim (utlägg) and post its verifikat [scope:suppliers:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/expense-claims/{id} : Read one expense claim (utlägg) [scope:suppliers:read risk:low idempotent]
DELETE /companies/{companyId}/expense-claims/{id} : Delete a registered expense claim; its verifikat is reversed by storno, never deleted [scope:suppliers:write risk:medium idempotent dry-run]
POST /companies/{companyId}/expense-claims/payouts : Record that the company paid a person back for their expense claims [scope:suppliers:write risk:medium idempotent dry-run]
GET /companies/{companyId}/supplier-invoices : List supplier invoices for a company [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/supplier-invoices : Register a new supplier invoice [scope:suppliers:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/supplier-invoices/{id} : Retrieve a single supplier invoice by id [scope:suppliers:read risk:low idempotent]
PATCH /companies/{companyId}/supplier-invoices/{id} : Update a registered supplier invoice [scope:suppliers:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/supplier-invoices/{id} : Delete an unbooked, unpaid supplier invoice (no verifikat, no payment) [scope:suppliers:write risk:medium idempotent dry-run]
POST /companies/{companyId}/supplier-invoices/{id}/approve : Approve a registered or overdue supplier invoice [scope:suppliers:write risk:low idempotent dry-run]
POST /companies/{companyId}/supplier-invoices/{id}/bank-entered : Mark a supplier invoice as entered in the internet bank ("inlagd i banken"), or clear the mark [scope:suppliers:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/supplier-invoices/{id}/book : Book a registered supplier invoice that was registered without a verifikat (the deferred Bokför step) [scope:suppliers:write risk:high idempotent dry-run]
POST /companies/{companyId}/supplier-invoices/{id}/credit : Issue a credit note for a supplier invoice [scope:suppliers:write risk:high idempotent dry-run]
PATCH /companies/{companyId}/supplier-invoices/{id}/items/{itemId} : Move one supplier-invoice line to another account, correcting the registration verifikat inline [scope:suppliers:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/supplier-invoices/{id}/mark-paid : Record a payment against a supplier invoice [scope:suppliers:write risk:medium idempotent dry-run]
POST /companies/{companyId}/supplier-invoices/{id}/uncredit : Undo the credit of a supplier invoice ("Ångra kreditering"): storno the credit note's verifikat and restore the invoice [scope:suppliers:write risk:high idempotent dry-run]
GET /companies/{companyId}/supplier-payment-batches : List supplier payment batches (betalfiler), newest first, with settlement progress [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/supplier-payment-batches : Create a supplier payment file (betalfil, pain.001) for one or more supplier invoices [scope:suppliers:write risk:high idempotent dry-run]
GET /companies/{companyId}/supplier-payment-batches/{id} : Read one supplier payment batch (betalfil) with its lines and live settlement [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/supplier-payment-batches/{id}/cancel : Cancel (makulera) a supplier payment batch [scope:suppliers:write risk:medium idempotent dry-run]
GET /companies/{companyId}/supplier-payment-batches/{id}/file : Download the pain.001 payment file of a supplier payment batch [scope:suppliers:write risk:low idempotent]
POST /companies/{companyId}/supplier-payment-batches/preview : Check which supplier invoices can go into a payment file (betalfil), with amounts, payees and warnings [scope:suppliers:read risk:low idempotent]
GET /companies/{companyId}/suppliers : List suppliers for a company [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/suppliers : Create a supplier [scope:suppliers:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/suppliers/{id} : Retrieve a single supplier by id [scope:suppliers:read risk:low idempotent]
PATCH /companies/{companyId}/suppliers/{id} : Partially update a supplier [scope:suppliers:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/suppliers/{id} : Archive a supplier (soft-delete) [scope:suppliers:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/suppliers/bulk-create : Create up to 50 suppliers in one call (partial-success) [scope:suppliers:write risk:low idempotent dry-run reversible]
```

### Documents (15)

Full detail: [references/documents.md](references/documents.md)

```text
GET /companies/{companyId}/documents : List documents in the archive, linked or not, newest upload first [scope:documents:read risk:low idempotent]
POST /companies/{companyId}/documents : Upload a document to the WORM archive [scope:documents:write risk:medium idempotent]
GET /companies/{companyId}/documents/{id} : Read one document's metadata and what holds it [scope:documents:read risk:low idempotent]
DELETE /companies/{companyId}/documents/{id} : Delete a document that is not linked to any verifikat [scope:documents:write risk:medium idempotent dry-run]
GET /companies/{companyId}/documents/{id}/download : Get a time-limited signed download URL for a document [scope:documents:read risk:low idempotent]
POST /companies/{companyId}/documents/{id}/link : Link a document to a journal entry [scope:documents:write risk:medium idempotent dry-run]
GET /companies/{companyId}/inbox-items : List invoice-inbox items (Underlag) with a summary of what was read from each [scope:documents:read risk:low idempotent]
GET /companies/{companyId}/inbox-items/{id} : Read one inbox item with its full reading and e-mail text [scope:documents:read risk:low idempotent]
PATCH /companies/{companyId}/inbox-items/{id} : Correct fields of an inbox item's reading (supplier, invoice, totals) [scope:documents:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/inbox-items/{id} : Discard an inbox item that was never converted or booked [scope:documents:write risk:medium idempotent dry-run]
POST /companies/{companyId}/inbox-items/{id}/convert : Register a supplier invoice from an inbox item, with its document as underlag [scope:suppliers:write risk:medium idempotent dry-run]
POST /companies/{companyId}/inbox-items/{id}/match-supplier : Set which supplier an inbox item comes from [scope:documents:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/inbox-items/{id}/match-transaction : Pair an inbox item with the bank transaction it documents [scope:documents:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/inbox-items/{id}/stamp : Mark an inbox item as consumed by a journal entry [scope:documents:write risk:low idempotent]
POST /companies/{companyId}/inbox-items/{id}/unmatch-transaction : Release an inbox item's bank transaction match [scope:documents:write risk:low idempotent dry-run reversible]
```

### Banking (45)

Full detail: [references/banking.md](references/banking.md)

```text
GET /companies/{companyId}/bank-connections : List PSD2 bank connections with sync freshness and consent expiry [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/bank-connections/{connectionId}/sync : Sync one bank connection now instead of waiting for the nightly run [scope:transactions:write risk:low]
GET /companies/{companyId}/cash-accounts : List bank/cash accounts with the bank-reported balance [scope:transactions:read risk:low idempotent]
POST /companies/{companyId}/cash-accounts : Create a bank account by hand (no bank connection), with the payee details invoices print [scope:companies:write risk:low idempotent dry-run]
PATCH /companies/{companyId}/cash-accounts/{id} : Edit a bank account: verifikationsserie, payee details, name, or turn it on/off [scope:companies:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/cash-accounts/{id}/set-primary : Make a bank account the company's primary [scope:companies:write risk:medium idempotent dry-run reversible]
PUT /companies/{companyId}/cash-accounts/payee-defaults : Choose which bank account invoices in a currency tell the customer to pay to [scope:companies:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/imports/bank : Import a bank-file (CSV / XML / CAMT053) [scope:transactions:write risk:medium idempotent]
POST /companies/{companyId}/imports/bank/{id}/undo : Undo a bank file import: delete the rows it created that are still unbooked [scope:transactions:write risk:high idempotent dry-run]
POST /companies/{companyId}/imports/sie : Import a SIE4 file [scope:bookkeeping:write risk:high idempotent reversible]
POST /companies/{companyId}/imports/sie/{id}/resume : Resume an interrupted SIE import from where it stopped [scope:bookkeeping:write risk:medium idempotent dry-run]
POST /companies/{companyId}/imports/sie/{id}/undo : Undo an SIE import by batch storno: every entry it posted is reversed, nothing is deleted [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/imports/sie/upload : Reserve a direct SIE upload [scope:bookkeeping:write risk:low reversible]
POST /companies/{companyId}/imports/skattekonto-file : Import a skattekontoutdrag file (Skatteverket tax account statement) into the skattekonto rows [scope:transactions:write risk:medium idempotent dry-run]
GET /companies/{companyId}/reconciliation/accounts : List the accounts that can be reconciled, with status per account [scope:reconciliation:read risk:low idempotent]
GET /companies/{companyId}/reconciliation/accounts/{accountKey} : The reconciliation bridge for one account [scope:reconciliation:read risk:low idempotent]
GET /companies/{companyId}/reconciliation/accounts/{accountKey}/items : List the rows behind one account's bridge, bucketed [scope:reconciliation:read risk:low idempotent]
POST /companies/{companyId}/reconciliation/accounts/{accountKey}/items/{itemId}/ignore : Ignore or restore one outside row [scope:reconciliation:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/reconciliation/accounts/{accountKey}/links : Link outside rows to existing verifikat (pairs or proposals) [scope:reconciliation:write risk:medium dry-run reversible]
DELETE /companies/{companyId}/reconciliation/accounts/{accountKey}/links/{linkId} : Remove a link between an outside row and a verifikat [scope:reconciliation:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/reconciliation/accounts/{accountKey}/residual : Book the remainder of a bank selection as a fee/interest/rounding verifikat and link the selection [scope:transactions:write risk:medium dry-run]
GET /companies/{companyId}/reconciliation/accounts/{accountKey}/signoff : Sign-off history for one reconcilable account [scope:reconciliation:read risk:low idempotent reversible]
POST /companies/{companyId}/reconciliation/accounts/{accountKey}/signoff : Mark an account reconciled through a date (sign-off) [scope:reconciliation:signoff risk:medium dry-run reversible]
POST /companies/{companyId}/reconciliation/accounts/{accountKey}/signoff/{signoffId}/reopen : Reopen (undo) a reconciliation sign-off [scope:reconciliation:signoff risk:low idempotent dry-run reversible]
POST /companies/{companyId}/reconciliation/bank/run : Run the bank-reconciliation matcher [scope:transactions:write risk:medium idempotent dry-run]
GET /companies/{companyId}/reconciliation/bank/status : Bank-reconciliation health snapshot [scope:transactions:read risk:low idempotent]
GET /companies/{companyId}/transactions : List transactions for a company [scope:transactions:read risk:low idempotent]
GET /companies/{companyId}/transactions/{id} : Retrieve a single transaction by id [scope:transactions:read risk:low idempotent]
PATCH /companies/{companyId}/transactions/{id} : Edit an unbooked transaction: its working title, or which bank account it belongs to [scope:transactions:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/transactions/{id} : Delete an unbooked transaction that was added by hand (e.g. a duplicate you created) [scope:transactions:write risk:medium idempotent dry-run]
POST /companies/{companyId}/transactions/{id}/attach-document : Pin a document (receipt, invoice) to a bank transaction as its underlag [scope:transactions:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/transactions/{id}/categorize : Categorize a transaction and create the journal entry [scope:transactions:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/transactions/{id}/detach-document : Take the pinned document off a bank transaction that is not booked against it [scope:transactions:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/transactions/{id}/ignore : Ignore a bank transaction (no verifikat, allowed in locked periods) [scope:transactions:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/transactions/{id}/ignore : Restore an ignored bank transaction to the "to book" list [scope:transactions:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/transactions/{id}/link-journal-entry : Link a bank transaction to a verifikat that already books it (no new bookkeeping) [scope:transactions:write risk:medium idempotent dry-run]
POST /companies/{companyId}/transactions/{id}/match-batch : Book one bank payment against several customer invoices, or several supplier invoices, in one verifikat [scope:transactions:write risk:medium idempotent dry-run]
POST /companies/{companyId}/transactions/{id}/match-expense-payout : Book an outgoing bank transaction as the repayment of one person's expense claims [scope:transactions:write risk:medium idempotent dry-run]
POST /companies/{companyId}/transactions/{id}/match-invoice : Match a positive bank transaction to a customer invoice [scope:transactions:write risk:high idempotent]
POST /companies/{companyId}/transactions/{id}/match-supplier-invoice : Match a negative bank transaction to a supplier invoice [scope:transactions:write risk:high idempotent]
POST /companies/{companyId}/transactions/{id}/refresh-exchange-rate : Fill in the Riksbanken rate and SEK amount of an unbooked foreign-currency transaction [scope:transactions:write risk:low idempotent dry-run]
POST /companies/{companyId}/transactions/{id}/uncategorize : Reverse the categorization of a transaction (storno + reset) [scope:transactions:write risk:medium idempotent dry-run]
POST /companies/{companyId}/transactions/batch-categorize : Categorize up to 100 transactions in one call (partial-success) [scope:transactions:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/transactions/bulk-book : Book several same-day SEK bank transactions as one samlingsverifikat [scope:transactions:write risk:high idempotent dry-run]
POST /companies/{companyId}/transactions/ingest : Bulk-ingest transactions (up to 500 per call) [scope:transactions:write risk:medium idempotent dry-run]
```

### Employees (26)

Full detail: [references/employees.md](references/employees.md)

```text
GET /companies/{companyId}/employees : List employees for a company [scope:payroll:read risk:low idempotent]
POST /companies/{companyId}/employees : Create an employee [scope:payroll:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/employees/{id} : Get a single employee [scope:payroll:read risk:low idempotent]
PATCH /companies/{companyId}/employees/{id} : Update an employee [scope:payroll:write risk:low idempotent dry-run]
DELETE /companies/{companyId}/employees/{id} : Soft-delete an employee [scope:payroll:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/employees/{id}/absence : List absence days for an employee in a date range [scope:payroll:read risk:low idempotent]
PUT /companies/{companyId}/employees/{id}/absence : Register absence for an employee over a date range [scope:payroll:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/employees/{id}/absence : Delete absence days for an employee in a date range [scope:payroll:write risk:low idempotent dry-run]
GET /companies/{companyId}/employees/{id}/benefits : List the benefits (förmåner) registered on an employee [scope:payroll:read risk:low idempotent]
POST /companies/{companyId}/employees/{id}/benefits : Register a benefit (förmån) on an employee [scope:payroll:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/employees/{id}/benefits/{benefitId} : Partially update a benefit (förmån) on an employee [scope:payroll:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/employees/{id}/benefits/{benefitId} : Remove a benefit (förmån) from an employee [scope:payroll:write risk:medium idempotent dry-run]
GET /companies/{companyId}/employees/{id}/opening-balances : Get an employee's payroll cutover opening balances [scope:payroll:read risk:low idempotent]
PUT /companies/{companyId}/employees/{id}/opening-balances : Set an employee's payroll cutover opening balances [scope:payroll:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/employees/{id}/recurring-lines : List recurring payslip lines for an employee [scope:payroll:read risk:low idempotent]
POST /companies/{companyId}/employees/{id}/recurring-lines : Create a recurring payslip line for an employee [scope:payroll:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/employees/{id}/recurring-lines/{lineId} : Update a recurring payslip line [scope:payroll:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/employees/{id}/recurring-lines/{lineId} : Delete a recurring payslip line, or deactivate it if a run already used it [scope:payroll:write risk:low idempotent dry-run]
GET /companies/{companyId}/employees/{id}/vacation-balance : Get an employee's current vacation balance [scope:payroll:read risk:low idempotent]
GET /companies/{companyId}/employees/{id}/worked-days : List worked days (hours per date) for an employee in a date range [scope:payroll:read risk:low idempotent]
PUT /companies/{companyId}/employees/{id}/worked-days : Register worked hours per day for an employee (bulk upsert) [scope:payroll:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/employees/{id}/worked-days : Delete worked days for an employee in a date range [scope:payroll:write risk:low idempotent dry-run]
PUT /companies/{companyId}/employees/opening-balances : Bulk-set payroll cutover opening balances (atomic) [scope:payroll:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/salary/settings : Get the company payroll settings [scope:payroll:read risk:low idempotent]
PATCH /companies/{companyId}/salary/settings : Partially update the company payroll settings [scope:payroll:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/salary/vacation-year-close : Close a vacation year (semesterberedning + arsavslut) [scope:payroll:write risk:high idempotent dry-run]
```

### Salary runs (26)

Full detail: [references/salary-runs.md](references/salary-runs.md)

```text
GET /companies/{companyId}/salary-runs : List salary runs [scope:payroll:read risk:low idempotent]
POST /companies/{companyId}/salary-runs : Create a salary run [scope:payroll:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/salary-runs/{id} : Get a salary run [scope:payroll:read risk:low idempotent]
PATCH /companies/{companyId}/salary-runs/{id} : Update a draft salary run [scope:payroll:write risk:low idempotent dry-run]
DELETE /companies/{companyId}/salary-runs/{id} : Delete a draft salary run [scope:payroll:write risk:low idempotent dry-run]
POST /companies/{companyId}/salary-runs/{id}/approve : Approve a reviewed salary run [scope:payroll:write risk:low idempotent dry-run]
POST /companies/{companyId}/salary-runs/{id}/book : Post the verifikationer for a paid salary run [scope:payroll:write risk:high idempotent dry-run]
POST /companies/{companyId}/salary-runs/{id}/calculate : Calculate a draft salary run and advance it to review [scope:payroll:write risk:medium idempotent dry-run]
POST /companies/{companyId}/salary-runs/{id}/correct : Correct a booked salary run (rättelsekörning): storno its verifikat and open a new draft for the same period [scope:payroll:write risk:high idempotent dry-run]
GET /companies/{companyId}/salary-runs/{id}/employees : List per-employee results of a salary run [scope:payroll:read risk:low idempotent]
POST /companies/{companyId}/salary-runs/{id}/employees : Add an employee to a draft salary run [scope:payroll:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/salary-runs/{id}/employees/{employeeId} : Get one employee's payslip in a salary run [scope:payroll:read risk:low idempotent]
PATCH /companies/{companyId}/salary-runs/{id}/employees/{employeeId} : Set this run's base salary for one employee [scope:payroll:write risk:medium idempotent dry-run reversible]
DELETE /companies/{companyId}/salary-runs/{id}/employees/{employeeId} : Remove an employee from a draft salary run [scope:payroll:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/salary-runs/{id}/employees/{employeeId}/expense-claims : Repay an employee's open expense claims (utlägg) with this salary run [scope:payroll:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/salary-runs/{id}/employees/{employeeId}/lines : Add a payslip line to an employee in a draft salary run [scope:payroll:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/salary-runs/{id}/generate-agi : Generate the Skatteverket AGI XML for a salary run [scope:payroll:write risk:medium idempotent]
PATCH /companies/{companyId}/salary-runs/{id}/lines/{lineId} : Update a payslip line in a draft salary run [scope:payroll:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/salary-runs/{id}/lines/{lineId} : Delete a payslip line from a draft salary run [scope:payroll:write risk:low idempotent dry-run]
POST /companies/{companyId}/salary-runs/{id}/mark-paid : Mark an approved salary run as paid [scope:payroll:write risk:low idempotent dry-run]
POST /companies/{companyId}/salary-runs/{id}/payment-file : Generate the bank payment file (pain.001 or Bankgirot LB) for a salary run [scope:payroll:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/salary-runs/{id}/payment-files : List the archived bank payment files of a salary run [scope:payroll:read risk:low idempotent]
GET /companies/{companyId}/salary-runs/{id}/payslips/{employeeId}/pdf : Download one employee's payslip as PDF [scope:payroll:read risk:low idempotent]
POST /companies/{companyId}/salary-runs/{id}/revert : Send a salary run in review back to draft so it can be edited [scope:payroll:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/salary-runs/{id}/send-payslips : Email every employee on an approved salary run a secure link to their payslip [scope:payroll:write risk:medium idempotent dry-run]
POST /companies/{companyId}/salary-runs/{id}/unapprove : Recall the approval of a salary run (approved back to review) [scope:payroll:write risk:medium idempotent dry-run reversible]
```

### Reports (34)

Full detail: [references/reports.md](references/reports.md)

```text
GET /companies/{companyId}/audit-trail : The audit log: every trigger-recorded change to the books and their settings, newest first [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ar-ledger : AR ledger: unpaid customer invoices with aging [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/avgifter-basis : Annual arbetsgivaravgifter basis per employee [scope:payroll:read risk:low idempotent]
GET /companies/{companyId}/reports/balance-sheet : Balance sheet (balansräkning) for a fiscal period or as of a custom date [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/balance-sheet/pdf : Balance sheet (balansräkning) as a PDF [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/behandlingshistorik : Behandlingshistorik (BFL 5 kap. 11 §): who changed what in the books, and when, for a räkenskapsår [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/bokslutsbilagor : Bokslutsbilagor: every balance account at the balansdag with its specification, sign-off and underlag [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/continuity-check : IB/UB continuity check: opening balances match prior closing [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/dimension-pnl : Resultat per projekt or kostnadsställe: the income statement with one column per dimension value [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/general-ledger : General ledger (huvudbok) for a fiscal period [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/income-statement : Income statement (resultatrapport) for a fiscal period or a custom date range [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/income-statement/pdf : Income statement (resultaträkning) as a PDF [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ink2 : INK2 inkomstdeklaration (aktiebolag): INK2, INK2R and INK2S fields for a räkenskapsår [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ink2/sru : INK2 SRU files (INFO.SRU + BLANKETTER.SRU) as a zip, for upload at skatteverket.se [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/journal-register : Journal register (verifikationsregister) for a fiscal period [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/kassaflodesanalys : Kassaflödesanalys (cash flow statement, indirect method) for a räkenskapsår [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/kpi : Business KPIs (nyckeltal) for a fiscal period, as the dashboard shows them [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/monthly-breakdown : Income statement broken down by month for a fiscal period [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ne-bilaga : NE-bilaga (enskild firma): rutor R1-R11 for a räkenskapsår [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ne-bilaga/sru : NE-bilaga SRU files (INFO.SRU + BLANKETTER.SRU) as a zip, for upload at skatteverket.se [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/periodisk-sammanstallning : Periodisk sammanställning (EU sales list): per-customer EU sales of goods, services and triangulation [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/periodisk-sammanstallning/csv : Periodisk sammanställning as the SKV 574008 CSV file, for upload at skatteverket.se [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/salary-journal : Salary journal (lönejournal) for a year and optional month range [scope:payroll:read risk:low idempotent]
GET /companies/{companyId}/reports/sie-export : SIE4 export (.se file) for a fiscal period [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/supplier-ledger : Supplier ledger: unpaid supplier invoices with aging [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/trial-balance : Trial balance (huvudboksrapport) for a fiscal period [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/vacation-liability : Vacation liability (semesterlöneskuld) per employee at year-end [scope:payroll:read risk:low idempotent]
GET /companies/{companyId}/reports/vat-declaration : Swedish VAT declaration (momsdeklaration) for a period [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/vat-declaration/eskd : Momsdeklaration as an eSKD XML file, for "Deklarera via fil" at skatteverket.se [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/vat-declaration/filings : List the calendar VAT periods the company has recorded as filed [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/reports/vat-declaration/filings : Record that a VAT period was filed outside the Skatteverket connection [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/reports/vat-declaration/filings : Undo a manual "filed" mark on a VAT period [scope:bookkeeping:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/reports/vat-declaration/settlement-proposal : The proposed momsredovisning verifikat for a VAT period: clear 26xx to 2650 or 1650 [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/vat/settlement : Book the momsredovisning verifikat for a VAT period, exactly as the proposal gives it [scope:bookkeeping:write risk:high idempotent dry-run]
```

### Fixed assets (6)

Full detail: [references/assets.md](references/assets.md)

```text
GET /companies/{companyId}/assets : List the fixed-asset register (anläggningsregister) [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/assets : Register a fixed asset (no voucher is posted) [scope:bookkeeping:write risk:low idempotent dry-run]
GET /companies/{companyId}/assets/{id} : Get one fixed asset [scope:reports:read risk:low idempotent]
PATCH /companies/{companyId}/assets/{id} : Partially update a fixed asset [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/assets/{id} : Delete an asset that never reached the books [scope:bookkeeping:write risk:medium dry-run]
POST /companies/{companyId}/assets/{id}/dispose : Dispose a fixed asset and post the avyttring voucher [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
```

### Webhooks (9)

Full detail: [references/webhooks.md](references/webhooks.md)

```text
GET /companies/{companyId}/webhooks : List webhook subscriptions for a company [scope:webhooks:manage risk:low idempotent]
POST /companies/{companyId}/webhooks : Register a webhook subscription [scope:webhooks:manage risk:low idempotent dry-run reversible]
GET /companies/{companyId}/webhooks/{id} : Get a webhook subscription by id [scope:webhooks:manage risk:low idempotent]
PATCH /companies/{companyId}/webhooks/{id} : Update a webhook subscription [scope:webhooks:manage risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/webhooks/{id} : Delete a webhook subscription [scope:webhooks:manage risk:medium idempotent]
GET /companies/{companyId}/webhooks/{id}/deliveries : List deliveries for a webhook subscription [scope:webhooks:manage risk:low idempotent]
POST /companies/{companyId}/webhooks/{id}/rotate-secret : Rotate the HMAC signing secret on a webhook [scope:webhooks:manage risk:medium]
POST /companies/{companyId}/webhooks/{id}/test : Send a synthetic test event to a webhook [scope:webhooks:manage risk:low]
POST /webhook-deliveries/{id}/retry : Retry a webhook delivery [scope:webhooks:manage risk:medium]
```

## Gotchas (Swedish accounting domain)

Rules a generic REST integration will violate unless told:

- **Account numbers are strings, not numbers.** BAS accounts (`"1930"`,
  `"3001"`) are identifiers; send them as JSON strings. Arithmetic on them,
  zero-stripping, or number coercion corrupts postings.
- **Posted journal entries are immutable by law** (Bokföringslagen). There is
  no PATCH or DELETE on a committed entry, ever. Undo with
  `POST .../journal-entries/{id}/reverse` (storno), fix with
  `POST .../journal-entries/{id}/correct`. Design flows around
  reverse-and-repost, not edit-in-place.
- **Voucher numbers are gapless and server-assigned.** Never assume or
  pre-allocate one; read it from `meta.audit.voucher_number` after commit. A
  legally required gap explanation goes through
  `POST .../voucher-gap-explanations`.
- **Every entry balances.** `sum(debit) === sum(credit)` to the öre, amounts
  are decimal SEK numbers (max 2 decimals). Do rounding with
  round-half-away-from-zero on öre; never float-accumulate line totals
  client-side and "fix" the difference on a random line.
- **Period locks are a feature, not an error to retry.** Writes into a
  locked/closed period return `PERIOD_LOCKED` (with `valid_alternatives`
  pointing at open periods). Retrying the same request cannot succeed; either
  target an open period or surface the lock to the user.
- **Drafts vs posted.** Invoices are created as drafts with
  `invoice_number: null`; the F-series number is assigned atomically on send.
  Journal entries follow draft -> commit. Nothing financial exists in the
  ledger until the commit/send action.
- **Two invoice worlds.** `invoices` = accounts receivable (you bill
  customers); `supplier-invoices` = accounts payable (you receive bills).
  They are different resources with different lifecycles.
- **Swedish user-facing text.** `error.message` is Swedish by design; show it
  to Swedish end users, and use `message_en` for your own logs/logic. Domain
  terms in responses (moms, verifikat, kostnadsställe) are not translatable
  labels but legal concepts.
- **Compliance pre-flight.** Before building your own validation for Swedish
  rules, call `GET .../compliance/check`: it runs the server's own rule set
  (VAT plausibility, sequence integrity, period status) and returns findings.

## Verification

This skill is generated (`npm run apiskill:generate` in the Accounted repo)
from the same endpoint registry that serves the live API, its OpenAPI spec
(`https://app.gnubok.se/api/v1/openapi.json`), and its runtime request
validators, so schema drift between this text and the server cannot occur for
a matching `api_version`. CI regenerates and diffs it on every change.

Before first use in a new environment, smoke-test:

```bash
curl -s https://app.gnubok.se/api/v1/health
curl -s https://app.gnubok.se/api/v1/companies -H "Authorization: Bearer $ACCOUNTED_API_KEY"
```

If `meta.api_version` in responses is newer than the version in this skill's
index header, refetch the skill (or read the changelog at
https://app.gnubok.se/docs/api/changelog) before relying on endpoint details.
