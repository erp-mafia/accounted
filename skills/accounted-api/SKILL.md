---
name: accounted-api
description: >-
  Consume the Accounted REST API (Swedish double-entry bookkeeping SaaS,
  https://app.accounted.se/api/v1). Use when building an integration, app, backend
  job, or agent tool layer against Accounted: invoices, customers,
  suppliers, supplier invoices, journal entries (bokföring), bank
  transactions and reconciliation, payroll (lön), VAT/moms and financial
  reports, SIE import/export, documents, webhooks. Covers auth with
  gnubok_sk_ API keys, conventions (dry-run, idempotency, cursor
  pagination, scopes), and all 478 endpoints.
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
see https://app.accounted.se/docs/api/connect-claude.

If you have used Stripe's API the shape will feel familiar: bearer keys, dated
versions, idempotency keys, webhook signatures, cursor pagination. The domain
rules are Swedish accounting law; the Gotchas section below stops the classic
violations before you ship them.

## Auth and base URL

Every request sends a bearer key:

```bash
curl https://app.accounted.se/api/v1/companies \
  -H "Authorization: Bearer gnubok_sk_..."
```

- Base URL: `https://app.accounted.se/api/v1`. Integrations set up against
  the earlier host `app.gnubok.se` keep working there; new integrations use
  `app.accounted.se`.
- Keys are created in the Accounted dashboard under **Settings -> API**
  (`/settings/api`). Two prefixes:
  - `gnubok_sk_<random>` (live: no infix after `gnubok_sk_`) commits real writes.
  - `gnubok_sk_test_*` reads real company data but forces every write into
    dry-run (responses carry `X-Gnubok-Mode: test`). Develop and run evals
    with a test key; switch to live last.
- Each key carries **scopes** (`invoices:read`, `invoices:write`,
  `payroll:write`, `webhooks:manage`, ...). Every endpoint in the index below
  is annotated with its required scope; a missing scope returns `403`.
  `GET /api/v1/api-key` (any valid key, no scope needed) returns the key's
  mode, scopes and per-company write access: check it when a key is
  connected instead of waiting for the first `403`.
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
  "details": {}, "recovery_hint": "next step",
  "docs_url": "https://docs.accounted.se/errors#period_locked",
  "valid_alternatives": {}, "request_id": "req_..." } }
```

React to `code`, read `message_en` and `recovery_hint`, follow
`valid_alternatives` when present (e.g. `next_open_period`). Standard codes on
every endpoint: `400` validation, `401` bad key, `403` missing scope, `404`,
`429` rate limited (honor `Retry-After`), `500`. Full catalogue, one entry
per code (`docs_url` links it): https://docs.accounted.se/errors. Only
endpoint-specific codes are mentioned per endpoint below.

**Typed handles.** Responses add `handle` next to the id of the resources
they return (the endpoint schemas show where):
`<prefix>_<the UUID as 32 lowercase hex, no dashes>`, so journal entry
`0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b` is `je_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b`.
It is the same id spelled with its type: store the handle and you always know
what an id names. Every path id and every body or query field named for a
resource (`journal_entry_id`, `credited_invoice_id`, `invoice_ids`,
`period_id`, ...) accepts the handle or the plain UUID; the plain UUID keeps
working everywhere. A handle of the wrong type (an `inv_` invoice handle where
a journal entry id belongs) is refused with `400 HANDLE_TYPE_MISMATCH` before
anything is read: `error.details.issues[]` names the `field`, the
`expected_prefix` it takes (null: plain UUID only) and the `received_prefix`.
Id fields keep their names and values (`journal_entry_id` still holds the
UUID); only `handle` is added. Prefixes are permanent: `cmp` company, `je`
journal entry, `inv` customer invoice (quotes and credit notes too), `sinv`
supplier invoice, `cus` customer, `sup` supplier, `txn` bank transaction,
`doc` document, `pop` pending operation, `fp` fiscal period, `emp` employee,
`srun` salary run, `art` article, `ast` fixed asset, `dim` dimension, `dimv`
dimension value, `inbx` inbox item, `exp` expense claim, `cash` cash account,
`pmt` payment order, `spb` supplier payment batch, `wh` webhook, `whd`
webhook delivery, `op` async operation, `svc` service account, `key` API key,
`aud` audit log entry, `rso` reconciliation sign-off, `vgap` voucher gap
explanation, `team` team (byrå or personal), `bev` business event (reserved:
no endpoint returns one yet). Sub-resources without a prefix (salary lines,
benefits) take the plain UUID only.
MCP tools accept handles in their id arguments too and still answer plain
UUIDs.

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

**Pin the preview you showed** (`x-preview-token-supported` in the spec).
The dry run of these writes also answers `data.preview_token`. The flow for
an agent: dry run, show the person `data.preview`, and once they confirm,
commit the same request with the header `Preview-Token: <preview_token>`
(and the same `Idempotency-Key`). The commit then books exactly what was
shown, or answers `409 PREVIEW_STALE` and writes nothing when something moved
in between (a period locked, an account deactivated, a rate changed, another
write landed): `error.details.preview` is what the write would do now and
`error.details.preview_token` its token, so show that, ask again and resend
with the new token. A token binds the operation, the company and the exact
input, so it never passes anywhere else. It works with `?stage=true` too.
The header on an endpoint without the flag, or a malformed value, is `400`;
without the header nothing changes. Over MCP the generated write tools take
the same token as a `preview_token` argument when staging.

**Stage for approval** (`stage` query parameter in the endpoint entry,
`x-stage-supported` in the spec). A write that agents stage over MCP can be
staged over REST too: send it with `?stage=true` and nothing is committed;
the answer is `202` with a pending operation (`pending_operation_id`,
`status: "pending"`, `task_state: "working"`, the `preview` an approver sees).
It commits only when approved: `POST /pending-operations/{id}/approve` (scope
`pending_operations:approve`, `{"confirmed": true}` for `risk_level` high),
or a person in the app; `POST /pending-operations/{id}/reject` discards it.
Poll `GET /pending-operations/{id}` until `task_state` is terminal:
`completed` (committed, `result` holds the outcome), `failed` (the approved
commit did not go through) or `cancelled` (rejected, expired or superseded).
Say why you propose it: a `reason` field in the staged body (one or two
sentences, the evidence and the pattern you followed) is never passed to the
write; the approver sees it, the pending operation answers it as
`agent_reason`, and the decision receipt keeps it. Longer than 500 characters
is cut at a word boundary, never refused.
`stage=true` on any other endpoint is `400 STAGE_NOT_SUPPORTED`; values other
than `true`/`false` are `400`. A write only a person may approve in the app
(handing an invoice to collection, an escalating collection case action) is
never committed from a key: without `?stage=true` it answers
`400 STAGE_REQUIRED` and does nothing. With `dry_run=true` (or a test key) the staging
is previewed and nothing is stored. Approving twice never commits twice: the
second approval answers `409 PENDING_OPERATION_NOT_PENDING` with the
operation as it stands.

**Idempotency-Key.** Send a fresh UUID header on every POST/PATCH/DELETE;
several endpoints reject writes without one (`400`). Replaying the same
key+body returns the original response with the `Idempotent-Replayed: true`
header; the same key with a different body returns `409 IDEMPOTENCY_KEY_REUSE`
(24h window). A repeat sent while the first request with that key is still
running returns `409 IDEMPOTENCY_KEY_IN_PROGRESS` with `Retry-After` and runs
nothing: wait, then resend the identical request to get the first answer.
Safe retry loop: keep the key, keep the body.

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

**Report query parameters.** A report read never answers an unfiltered report
to a dimension filter it cannot apply: `dim_no`, `dim_code`, `dimensions`,
`project` or `cost_center` on a report that does not document them is
`400 VALIDATION_ERROR`. Any other query parameter a report does not document
is not applied, and the response names it in the `X-Ignored-Query-Params`
header: check that header when a filter seems to have had no effect.

**Async operations.** Long-running actions (fiscal-period lock/close/year-end,
imports) return `202` with an operation id; poll `GET /api/v1/operations/{id}`
until `status` is `succeeded`/`failed`. The response shape is identical
whether the work ran inline or queued.

**Versioning.** Dated versions (current: see `meta.api_version`). Responses
carry the `Gnubok-Version` header; request pinning via a `Gnubok-Version`
request header is reserved for a future breaking change and is not read
today. Additive changes ship without a version bump; see
https://app.accounted.se/docs/api/versioning.

**Index badges.** Every operation line below carries machine-readable
annotations from the spec: `scope:` (required key scope), `risk:` (low/medium/
high; confirm with a human before unprompted high-risk calls), `idempotent`
(safe to retry), `dry-run` (previewable), `reversible` (a single follow-up
call can undo it, e.g. invoice credit).

## Endpoint index

API version `2026-05-12`, 478 operations. Paths are shown without
their `/api/v1` prefix (full base URL: `https://app.accounted.se/api/v1`).

### Core (24)

Full detail: [references/core.md](references/core.md)

```text
GET /api-key : Show what the calling API key may do: mode, scopes and company access [risk:low idempotent]
GET /companies : List companies the API key can access [scope:companies:read risk:low idempotent]
POST /companies : Create a company and set it up for bookkeeping [scope:companies:write risk:medium dry-run]
GET /companies/{companyId}/capabilities : Which building blocks this company can use, and why not [scope:companies:read risk:low idempotent]
GET /companies/{companyId}/packages : List the company packages with their status and what keeps a switched-off one winding down [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/packages/{packageId}/disable : Stage switching a package off, for an owner or admin to approve [scope:companies:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/packages/{packageId}/enable : Stage switching a package on, for an owner or admin to approve [scope:companies:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/peppol/access-request : Switch on Peppol for the company (sending, and receiving when chosen); needs a paid plan [scope:companies:write risk:medium idempotent dry-run]
GET /companies/{companyId}/peppol/registration : Read the company's Peppol receiving status: access grant, eligibility and registration [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/peppol/registration : Register the company as a Peppol participant so it can receive e-invoices [scope:companies:write risk:high idempotent dry-run]
GET /companies/{companyId}/service-accounts : List the company's service accounts [scope:service_accounts:manage risk:low idempotent]
POST /companies/{companyId}/service-accounts : Create a service account with a human sponsor [scope:service_accounts:manage risk:medium idempotent reversible]
GET /companies/{companyId}/service-accounts/{id} : Show one service account with its keys [scope:service_accounts:manage risk:low idempotent]
POST /companies/{companyId}/service-accounts/{id}/keys : Mint an API key for a service account; the secret is shown once [scope:service_accounts:manage risk:high reversible]
POST /companies/{companyId}/service-accounts/{id}/keys/{keyId}/revoke : Revoke one key of a service account [scope:service_accounts:manage risk:medium idempotent]
POST /companies/{companyId}/service-accounts/{id}/revoke : Revoke a service account and all its keys [scope:service_accounts:manage risk:high idempotent]
GET /companies/{companyId}/settings : Read the company settings [scope:companies:read risk:low idempotent]
PATCH /companies/{companyId}/settings : Partially update company settings (contact, invoicing, reminders, voucher series, toggles) [scope:companies:write risk:medium idempotent dry-run reversible]
PATCH /companies/{companyId}/settings/bookkeeping-lock : Set, move or remove the company-wide bookkeeping lock date [scope:companies:write risk:high idempotent dry-run reversible]
GET /companies/{companyId}/settings/skattekonto-account : Read which ledger account the skattekonto runs on (1630, or 2012 for an enskild firma) [scope:companies:read risk:low idempotent]
PATCH /companies/{companyId}/settings/skattekonto-account : Choose the ledger account the skattekonto runs on: 1630, or 2012 in equity for an enskild firma [scope:companies:write risk:high idempotent dry-run reversible]
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

### Periods and registers (78)

Full detail: [references/periods.md](references/periods.md)

```text
PATCH /companies/{companyId}/accounting-policies : Choose the K3 model for internally generated intangible assets: expense or capitalise (punkt 18.7) [scope:companies:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/accounts : List chart-of-accounts entries (BAS chart) [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/accounts : Add an account to the chart of accounts (kontoplan) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/accounts/{number} : Edit or deactivate an account in the chart of accounts [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/accounts/{number} : Delete an account nothing has been booked on [scope:bookkeeping:write risk:medium idempotent dry-run]
POST /companies/{companyId}/accounts/activate : Activate BAS accounts in bulk [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/accounts/deactivate : Deactivate accounts in bulk [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/accounts/oss-countries : Say which EU country each OSS account is for (unionsordningen) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/accrual-schedules : Create a periodisering by hand for an amount on 17xx/29xx that no invoice line in Accounted carries, with monthly catch-up [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/accrual-schedules/{id}/cancel : Undo a periodisering set up by hand: cancel its months not yet posted and storno the months it posted [scope:bookkeeping:write risk:medium idempotent dry-run]
POST /companies/{companyId}/accrual-schedules/{id}/replan : Re-plan the months of a periodisering that are not yet posted: a new period end and/or the day each month books on [scope:bookkeeping:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/agreement-obligations : List the payments the agreements say fall due, oldest first, with whether each arrived in the bank [scope:companies:read risk:low idempotent]
GET /companies/{companyId}/agreements : List the company's agreements (rent, leases, loans, subscriptions, insurance, permits, IP, domains, guarantees and more) with the next payment and the notice and end dates [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/agreements : Register an agreement by hand: what it is, the counterparty, the dates, notice and what it costs [scope:companies:write risk:low idempotent dry-run]
PATCH /companies/{companyId}/agreements/{id} : Change a manual agreement; its expected payments and its dates follow [scope:companies:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/agreements/{id}/end : End a manual agreement: no more expected payments after the day it ended, its dates leave Viktiga datum [scope:companies:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/compliance/check : Run a structured compliance pre-flight check [scope:compliance:read risk:low idempotent]
GET /companies/{companyId}/deadlines : List the company's deadlines, the open ones by default [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/deadlines/{id}/complete : Tick a deadline off, or put it back on the list [scope:bookkeeping:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/dimensions : List dimensions (kostnadsställe/projekt) with their values [scope:dimensions:read risk:low idempotent]
POST /companies/{companyId}/dimensions : Create a custom dimension (e.g. Avdelning, Kund, Fordon) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/dimensions/{id} : Rename, archive or reorder a dimension [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/dimensions/{id} : Delete a custom dimension nobody has booked on [scope:bookkeeping:write risk:medium idempotent dry-run]
POST /companies/{companyId}/dimensions/{id}/values : Create a dimension value (kostnadsställe/projekt code) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/dimensions/{id}/values/{valueId} : Update a dimension value (rename, archive, set start/end date) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/dimensions/{id}/values/{valueId} : Delete an unreferenced dimension value [scope:bookkeeping:write risk:medium idempotent]
POST /companies/{companyId}/dimensions/retag : Change or remove the dimension tags (kostnadsställe, projekt) on posted journal lines [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/dimensions/retag-log : Read the history of dimension tag changes on posted lines, newest first [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/dimensions/rules : List the account dimension rules (required, default or fixed dimension per account) [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/dimensions/rules : Require, pre-fill or pin a dimension value on an account [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/dimensions/rules/{id} : Change, pause or resume an account dimension rule [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/dimensions/rules/{id} : Delete an account dimension rule [scope:bookkeeping:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/fiscal-periods : List fiscal periods (räkenskapsår) [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/fiscal-periods : Create a fiscal year (räkenskapsår) [scope:bookkeeping:write risk:medium idempotent dry-run]
PATCH /companies/{companyId}/fiscal-periods/{id} : Rename or re-date an open fiscal year [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
DELETE /companies/{companyId}/fiscal-periods/{id} : Remove an empty first fiscal year [scope:bookkeeping:write risk:high idempotent dry-run]
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
POST /companies/{companyId}/fiscal-periods/{id}/arsredovisning/versions/{versionId}/signing-request : Send a locked årsredovisning version to the board for BankID signing: one link per signer slot [scope:bookkeeping:write risk:medium idempotent dry-run]
POST /companies/{companyId}/fiscal-periods/{id}/close : Close a fiscal period (IRREVERSIBLE per BFL 5 kap 8 §) [scope:bookkeeping:write risk:high idempotent]
POST /companies/{companyId}/fiscal-periods/{id}/close-external : Mark a migrated fiscal year as closed in the previous system (klarmarkera) [scope:bookkeeping:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/fiscal-periods/{id}/currency-revaluation : Run FX revaluation for the fiscal period [scope:bookkeeping:write risk:high idempotent reversible]
PUT /companies/{companyId}/fiscal-periods/{id}/deferred-tax : Save the uppskjuten skatt inputs of a K3 year: whether the tax loss carried forward is recognised and why, and differences entered by hand [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/fiscal-periods/{id}/lock : Lock a fiscal period (no new entries can be posted into it) [scope:bookkeeping:write risk:high idempotent reversible]
POST /companies/{companyId}/fiscal-periods/{id}/opening-balances : Generate opening-balance verifikation for the next fiscal period [scope:bookkeeping:write risk:high idempotent reversible]
POST /companies/{companyId}/fiscal-periods/{id}/opening-balances/correct : Correct a year's ingående balanser by storno: the full corrected IB replaces the old one [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/fiscal-periods/{id}/opening-balances/manual : Book a fiscal year's ingående balanser (IB) from explicit lines, for a company new to Accounted [scope:bookkeeping:write risk:high idempotent dry-run]
GET /companies/{companyId}/fiscal-periods/{id}/opening-balances/split-per-project : Preview splitting a year's ingående balanser per project from the previous year's tagged closing balances [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/fiscal-periods/{id}/opening-balances/split-per-project : Split a year's ingående balanser per project, inside the same IB verifikat (inline rättelse) [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/fiscal-periods/{id}/reopen-external : Undo klarmarkera: reopen a year marked closed in the previous system [scope:bookkeeping:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/fiscal-periods/{id}/unlock : Unlock a locked (not closed) fiscal year [scope:bookkeeping:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/fiscal-periods/{id}/year-end : Execute year-end closing (currency revaluation + closing entry) [scope:bookkeeping:write risk:high idempotent]
GET /companies/{companyId}/group-links : List the company's group structure: its parent, subsidiaries and associates with ownership and votes over time [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/group-links : Register a parent, subsidiary or associate of the company [scope:companies:write risk:low idempotent dry-run]
PATCH /companies/{companyId}/group-links/{id} : Change a group link, or end it with valid_to [scope:companies:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/k3-transition : Read the company's transition to K3 (kap. 35): the first K3 year, the relief chosen, the note facts, and the assets the 35.18 split concerns [scope:reports:read risk:low idempotent reversible]
POST /companies/{companyId}/k3-transition : Start the transition to K3 on the first K3 fiscal year (an open year reported under K3) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/k3-transition : Set the transition's 35.27 relief and the facts its notes state: the relief rules applied (35.31) and the principles changed (35.33) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/k3-transition : Drop a transition to K3 that is not committed and has no component splits left [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/k3-transition/commit : Post the transition to K3: the opening deferred tax and the stated adjustments against equity on the first day of the first K3 year [scope:bookkeeping:write risk:high idempotent dry-run reversible]
GET /companies/{companyId}/securities : List ställda säkerheter and eventualförpliktelser, with the årsredovisning note texts they give on a balance date [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/securities : Register a ställd säkerhet or an eventualförpliktelse [scope:companies:write risk:low idempotent dry-run]
PATCH /companies/{companyId}/securities/{id} : Change a ställd säkerhet or an eventualförpliktelse, or release it with valid_to [scope:companies:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/skattekonto/sync : Fetch the skattekonto from Skatteverket now instead of waiting for the hourly sync [scope:transactions:write risk:low idempotent dry-run]
POST /companies/{companyId}/skatteverket/agi/validate-huvuduppgift : Pre-validate an AGI huvuduppgift at Skatteverket without filing anything [scope:compliance:read risk:low idempotent]
POST /companies/{companyId}/skatteverket/agi/validate-individuppgift : Pre-validate one AGI individuppgift at Skatteverket without filing anything [scope:compliance:read risk:low idempotent]
GET /companies/{companyId}/skatteverket/vat-declarations : Read a filed momsdeklaration (submitted and/or decided) from Skatteverket [scope:compliance:read risk:low idempotent]
GET /companies/{companyId}/tax-loss-carryforwards : The underskottsregister: prior years' tax losses per fiscal year (IL 40 kap.), oldest first [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/tax-loss-carryforwards : Save one fiscal year of the underskottsregister: the deficit brought forward, an ownership change and the year's result [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/tax-loss-carryforwards/{id} : One fiscal year of the underskottsregister, checked against the year before it [scope:reports:read risk:low idempotent]
```

### Invoices (AR) (32)

Full detail: [references/invoices.md](references/invoices.md)

```text
GET /companies/{companyId}/collections/candidates : List the overdue customer invoices that could be handed over to the company's collections provider [scope:invoices:read risk:low idempotent]
POST /companies/{companyId}/collections/payments/{paymentId}/book : Book a payment a debtor made to the collections provider as a payment of the invoice [scope:invoices:write risk:high idempotent dry-run]
GET /companies/{companyId}/collections/settlements : List the payments debtors made to the collections provider and the provider's payouts, with how far each is booked [scope:invoices:read risk:low idempotent reversible]
POST /companies/{companyId}/collections/settlements/{settlementId}/book : Book a payout from the collections provider as one voucher, with the settlement PDF as its underlag [scope:bookkeeping:write risk:high idempotent dry-run]
GET /companies/{companyId}/invoices : List invoices for a company [scope:invoices:read risk:low idempotent]
POST /companies/{companyId}/invoices : Create a draft invoice, proforma, or delivery note [scope:invoices:draft risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/invoices/{id} : Retrieve a single invoice by id [scope:invoices:read risk:low idempotent]
PATCH /companies/{companyId}/invoices/{id} : Update a draft invoice (metadata fields, optionally replacing line items) [scope:invoices:draft risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/invoices/{id} : Delete a draft invoice (hard delete if unnumbered, makulering if numbered) [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/book : Book a sent customer invoice that was issued without a verifikat (the deferred Bokför step) [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/cancel : Cancel (makulera) a quote or a proforma invoice [scope:invoices:write risk:low idempotent dry-run]
GET /companies/{companyId}/invoices/{id}/collection : Read an invoice's collection case: stage, what the provider waits for, the actions it offers, amounts and timeline [scope:invoices:read risk:low idempotent]
POST /companies/{companyId}/invoices/{id}/collection : Hand an overdue customer invoice over to the company's collections provider [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/collection/actions : Act on an invoice's open collection case: pause, resume, withdraw, mark disputed, or answer what the provider waits for [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/credit : Issue a credit note (kreditfaktura) against an invoice [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/link-credit-note : Link an existing credit note to the existing invoice it credits [scope:invoices:write risk:medium idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/mark-paid : Record a payment against an invoice [scope:invoices:write risk:medium idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/mark-sent : Transition a draft invoice to sent (without emailing) [scope:invoices:write risk:medium idempotent dry-run]
GET /companies/{companyId}/invoices/{id}/pdf : Download the rendered invoice PDF [scope:invoices:read risk:low idempotent]
GET /companies/{companyId}/invoices/{id}/peppol : Check whether a customer invoice can be sent over Peppol, to which participant, and what is missing [scope:invoices:read risk:low idempotent]
GET /companies/{companyId}/invoices/{id}/peppol/deliveries : List an invoice's Peppol deliveries and their network status [scope:invoices:read risk:low idempotent]
POST /companies/{companyId}/invoices/{id}/quote-status : Record the customer decision on a quote (offert) [scope:invoices:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/invoices/{id}/send : Send a draft invoice to the customer by email [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/{id}/send-peppol : Send a customer invoice as a Peppol e-invoice (BIS Billing 3) through the access point [scope:invoices:write risk:high idempotent dry-run]
GET /companies/{companyId}/invoices/{id}/underlag : List the archived documents a customer invoice rests on (its underlag), oldest link first [scope:invoices:read risk:low idempotent]
POST /companies/{companyId}/invoices/{id}/underlag : Link archived documents to a customer invoice as its underlag [scope:invoices:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/invoices/{id}/underlag/{documentId} : Remove one document from a customer invoice's underlag [scope:invoices:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/invoices/bulk-book : Book many customer invoices in one call, each with its own outcome [scope:invoices:write risk:high idempotent dry-run]
POST /companies/{companyId}/invoices/bulk-create : Create up to 50 draft invoices in one call (partial-success) [scope:invoices:draft risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/invoices/late-payment-interest : Dröjsmålsränta per customer invoice: interest earned by invoices paid late, and interest accrued on overdue unpaid ones [scope:invoices:read risk:low idempotent]
POST /companies/{companyId}/setoffs : Set off (kvitta) an open customer invoice against an open supplier invoice of the same counterparty: one verifikat, both invoices lowered, the net left to pay or receive [scope:invoices:write risk:high idempotent dry-run reversible]
GET /companies/{companyId}/setoffs/counterparty : A counterparty that is both customer and supplier, as one relation: its open customer and supplier invoices, the net per currency and its set-offs [scope:reports:read risk:low idempotent]
```

### Customers and articles (9)

Full detail: [references/customers.md](references/customers.md)

```text
GET /companies/{companyId}/articles : List the article register (artikelregister) [scope:invoices:read risk:low idempotent]
GET /companies/{companyId}/customers : List customers for a company [scope:customers:read risk:low idempotent]
POST /companies/{companyId}/customers : Create a customer [scope:customers:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/customers/{id} : Retrieve a single customer by id [scope:customers:read risk:low idempotent]
PATCH /companies/{companyId}/customers/{id} : Partially update a customer [scope:customers:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/customers/{id} : Archive a customer (soft-delete) [scope:customers:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/customers/bulk-create : Create up to 50 customers in one call (partial-success) [scope:customers:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/customers/merge : Merge duplicate customers into one [scope:customers:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/customers/merges/{mergeId}/undo : Undo a customer merge [scope:customers:write risk:medium idempotent dry-run reversible]
```

### Suppliers (AP) (51)

Full detail: [references/suppliers.md](references/suppliers.md)

```text
GET /companies/{companyId}/expense-claims : List expense claims (utlägg): what the company owes owners and employees for private purchases [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/expense-claims : Register an expense claim (utlägg) and post its verifikat [scope:suppliers:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/expense-claims/{id} : Read one expense claim (utlägg) [scope:suppliers:read risk:low idempotent]
DELETE /companies/{companyId}/expense-claims/{id} : Delete a registered expense claim; its verifikat is reversed by storno, never deleted [scope:suppliers:write risk:medium idempotent dry-run]
POST /companies/{companyId}/expense-claims/payouts : Record that the company paid a person back for their expense claims [scope:suppliers:write risk:medium idempotent dry-run]
GET /companies/{companyId}/payment-orders : List bank payment orders (betalningar via banken), newest first [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/payment-orders : Prepare draft bank payments (betalningar via banken) for supplier invoices, or one payment in to the skattekonto [scope:suppliers:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/payment-orders/{id} : Read one bank payment order [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/payment-orders/{id}/cancel : Cancel a bank payment order [scope:suppliers:write risk:medium idempotent dry-run]
POST /companies/{companyId}/payment-orders/approve : Approve (attest) draft bank payments so they can be signed [scope:suppliers:write risk:high idempotent dry-run reversible]
GET /companies/{companyId}/payment-orders/availability : Whether the company can pay through its bank from Accounted, and from which accounts [scope:suppliers:read risk:low idempotent]
GET /companies/{companyId}/payment-orders/signing-link : The Betalningar page link where a person approves and signs bank payments, with what is waiting there [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/payment-orders/unapprove : Take approved bank payments back to draft [scope:suppliers:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/payment-orders/usage : Bank payments sent and accounts used in a month, against the monthly cap [scope:suppliers:read risk:low idempotent]
GET /companies/{companyId}/payment-orders/verification : The company's verification (know your customer) at the payment provider, and where it stands [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/payment-orders/verification/start : Start or renew the company's verification at the payment provider and get the form link [scope:suppliers:write risk:low dry-run reversible]
GET /companies/{companyId}/payments/creditor-lookup : The name Bankgirot has registered for a bankgiro or plusgiro number, and whether an OCR passes its check [scope:suppliers:read risk:low idempotent]
GET /companies/{companyId}/payments/giro-numbers : The bankgiro and plusgiro numbers Bankgirot has registered to the company's own organisationsnummer [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/payments/signing-links : Ask someone without an Accounted login to sign approved bank payments with BankID: a signing link [scope:suppliers:write risk:medium idempotent dry-run]
GET /companies/{companyId}/supplier-invoices : List supplier invoices for a company [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/supplier-invoices : Register a new supplier invoice [scope:suppliers:register risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/supplier-invoices/{id} : Retrieve a single supplier invoice by id [scope:suppliers:read risk:low idempotent]
PATCH /companies/{companyId}/supplier-invoices/{id} : Update a registered supplier invoice [scope:suppliers:register risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/supplier-invoices/{id} : Delete an unbooked, unpaid supplier invoice (no verifikat, no payment) [scope:suppliers:write risk:medium idempotent dry-run]
POST /companies/{companyId}/supplier-invoices/{id}/approve : Approve a registered or overdue supplier invoice [scope:suppliers:write risk:low idempotent dry-run]
GET /companies/{companyId}/supplier-invoices/{id}/attestations : Where the attest of one supplier invoice stands: who attested, who is left, every decision [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/supplier-invoices/{id}/bank-entered : Mark a supplier invoice as entered in the internet bank ("inlagd i banken"), or clear the mark [scope:suppliers:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/supplier-invoices/{id}/book : Book a registered supplier invoice that was registered without a verifikat (the deferred Bokför step) [scope:suppliers:write risk:high idempotent dry-run]
POST /companies/{companyId}/supplier-invoices/{id}/change-supplier : Move an unpaid, unattested supplier invoice to another supplier, correcting the registration verifikat's text inline [scope:suppliers:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/supplier-invoices/{id}/credit : Issue a credit note for a supplier invoice [scope:suppliers:write risk:high idempotent dry-run]
PATCH /companies/{companyId}/supplier-invoices/{id}/items/{itemId} : Move one supplier-invoice line to another account, correcting the registration verifikat inline [scope:suppliers:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/supplier-invoices/{id}/mark-paid : Record a payment against a supplier invoice [scope:suppliers:write risk:medium idempotent dry-run]
POST /companies/{companyId}/supplier-invoices/{id}/reject : Reject (neka) the attest of a supplier invoice that waits for it, with an optional comment [scope:suppliers:write risk:low idempotent dry-run]
GET /companies/{companyId}/supplier-invoices/{id}/self-billing-pdf : Download the self-billing invoice (självfaktura) PDF [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/supplier-invoices/{id}/uncredit : Undo the credit of a supplier invoice ("Ångra kreditering"): storno the credit note's verifikat and restore the invoice [scope:suppliers:write risk:high idempotent dry-run]
GET /companies/{companyId}/supplier-invoices/attest-policy : Read the company's attest policy for supplier invoices [scope:suppliers:read risk:low idempotent]
PUT /companies/{companyId}/supplier-invoices/attest-policy : Save the company's attest policy for supplier invoices [scope:suppliers:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/supplier-invoices/attest-substitutes : Name a substitute for a supplier invoice attester for a period [scope:suppliers:write risk:high idempotent dry-run reversible]
DELETE /companies/{companyId}/supplier-invoices/attest-substitutes/{id} : Remove a substitute for a supplier invoice attester [scope:suppliers:write risk:low idempotent dry-run]
GET /companies/{companyId}/supplier-payment-batches : List supplier payment batches (betalfiler), newest first, with settlement progress [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/supplier-payment-batches : Create a supplier payment file (betalfil: pain.001, or an LB file for Svea Bank) for one or more supplier invoices [scope:suppliers:write risk:high idempotent dry-run]
GET /companies/{companyId}/supplier-payment-batches/{id} : Read one supplier payment batch (betalfil) with its lines and live settlement [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/supplier-payment-batches/{id}/cancel : Cancel (makulera) a supplier payment batch [scope:suppliers:write risk:medium idempotent dry-run]
GET /companies/{companyId}/supplier-payment-batches/{id}/file : Download the payment file (pain.001, or the LB file for Svea Bank) of a supplier payment batch [scope:suppliers:write risk:low idempotent]
POST /companies/{companyId}/supplier-payment-batches/preview : Check which supplier invoices can go into a payment file (betalfil), with amounts, payees and warnings [scope:suppliers:read risk:low idempotent]
GET /companies/{companyId}/suppliers : List suppliers for a company [scope:suppliers:read risk:low idempotent]
POST /companies/{companyId}/suppliers : Create a supplier [scope:suppliers:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/suppliers/{id} : Retrieve a single supplier by id [scope:suppliers:read risk:low idempotent]
PATCH /companies/{companyId}/suppliers/{id} : Partially update a supplier [scope:suppliers:write risk:medium idempotent dry-run reversible]
DELETE /companies/{companyId}/suppliers/{id} : Archive a supplier (soft-delete) [scope:suppliers:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/suppliers/bulk-create : Create up to 50 suppliers in one call (partial-success) [scope:suppliers:write risk:low idempotent dry-run reversible]
```

### Documents (25)

Full detail: [references/documents.md](references/documents.md)

```text
GET /companies/{companyId}/documents : List documents in the archive, linked or not, newest upload first [scope:documents:read risk:low idempotent]
POST /companies/{companyId}/documents : Upload a document to the WORM archive [scope:documents:write risk:medium idempotent]
GET /companies/{companyId}/documents/{id} : Read one document's metadata and what holds it, and on request its text, reading, links and arrivals [scope:documents:read risk:low idempotent]
DELETE /companies/{companyId}/documents/{id} : Delete a document that no verifikat or registered record holds [scope:documents:write risk:medium idempotent dry-run]
GET /companies/{companyId}/documents/{id}/download : Get a time-limited signed download URL for a document [scope:documents:read risk:low idempotent]
POST /companies/{companyId}/documents/{id}/link : Link a document to a journal entry [scope:documents:write risk:medium idempotent dry-run]
PUT /companies/{companyId}/documents/{id}/type : Set what an archived document is (its type in Dokument) [scope:documents:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/inbox-items : List invoice-inbox items (Underlag) with a summary of what was read from each [scope:documents:read risk:low idempotent]
POST /companies/{companyId}/inbox-items : Deliver a supplier invoice or receipt into the Inkorg for a person to book [scope:documents:write risk:low idempotent]
GET /companies/{companyId}/inbox-items/{id} : Read one inbox item with its full reading and e-mail text [scope:documents:read risk:low idempotent]
PATCH /companies/{companyId}/inbox-items/{id} : Correct fields of an inbox item's reading (supplier, invoice, totals) [scope:documents:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/inbox-items/{id} : Discard an inbox item that was never converted or booked [scope:documents:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/inbox-items/{id}/convert : Register a supplier invoice from an inbox item, with its document as underlag [scope:suppliers:write risk:medium idempotent dry-run]
POST /companies/{companyId}/inbox-items/{id}/match-supplier : Set which supplier an inbox item comes from [scope:documents:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/inbox-items/{id}/match-transaction : Pair an inbox item with the bank transaction it documents [scope:documents:write risk:low idempotent dry-run reversible]
PUT /companies/{companyId}/inbox-items/{id}/purchase-category : Set, or clear, what an inbox item bought (its purchase category) [scope:documents:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/inbox-items/{id}/restore : Put a deleted inbox item back in the inbox, as it was deleted [scope:documents:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/inbox-items/{id}/stamp : Mark an inbox item as consumed by a journal entry [scope:documents:write risk:low idempotent]
POST /companies/{companyId}/inbox-items/{id}/unmatch-transaction : Release an inbox item's bank transaction match [scope:documents:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/inbox-items/removed : List the inbox items deleted most recently that can still be put back [scope:documents:read risk:low idempotent]
GET /companies/{companyId}/signing-requests : List the company's BankID signing requests, newest first, with every signer's status [scope:documents:read risk:low idempotent]
POST /companies/{companyId}/signing-requests : Send an archived PDF for BankID signing: one link per signer, mailed when they have an address [scope:documents:write risk:medium idempotent dry-run]
GET /companies/{companyId}/signing-requests/{id} : Read one BankID signing request: every signer's status and, once completed, the signed PDF and the evidence package [scope:documents:read risk:low idempotent]
POST /companies/{companyId}/signing-requests/{id}/cancel : Cancel an open signing request: its links stop working; signatures already made stay [scope:documents:write risk:low idempotent dry-run]
POST /companies/{companyId}/signing-requests/{id}/signers/{signerId}/remind : Mail a pending signer again, once a day at most; the mail carries a new link and the old one stops working [scope:documents:write risk:low idempotent dry-run]
```

### Company registers (Bolaget) (17)

Full detail: [references/company-registers.md](references/company-registers.md)

```text
GET /companies/{companyId}/beneficial-owners : Read the verkliga huvudmän: the proposal from the aktiebok, the confirmed set and the record of assessments [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/beneficial-owners/assessments : Record an assessment of the verkliga huvudmän (LRVH 2:1): who they are and why, or that there is none [scope:companies:write risk:medium idempotent dry-run]
GET /companies/{companyId}/company-roles : List the company's roles over time (board, VD, firmatecknare, revisor, verkliga huvudmän) and the firmateckning [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/company-roles : Add a role from a date: board member, chair, suppleant, VD, vice VD, firmatecknare, revisor or contact person [scope:companies:write risk:low idempotent dry-run]
POST /companies/{companyId}/company-roles/{id}/end : End a role on a date (the last day in it). The row is kept [scope:companies:write risk:low idempotent dry-run]
GET /companies/{companyId}/corporate-meetings : List the company's bolagsstämmor, styrelsemöten and per capsulam decisions, newest first [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/corporate-meetings : Plan a meeting: an årsstämma (prefilled from the årsredovisning and the roles), an extra stämma, a styrelsemöte or a per capsulam decision [scope:companies:write risk:low idempotent dry-run]
GET /companies/{companyId}/corporate-meetings/{id} : Read one meeting: its minutes paragraph by paragraph, röstlängd, attendance, signers, effects on the roles and warnings [scope:companies:read risk:low idempotent]
PATCH /companies/{companyId}/corporate-meetings/{id} : Change a meeting whose minutes are not signed: date, place, chair, protokollförare, justerare, kallelse, attendance or röstlängd presence [scope:companies:write risk:low idempotent dry-run]
POST /companies/{companyId}/corporate-meetings/{id}/decisions : Add or change a decision (paragraph) in a meeting's unsigned minutes, with its terms per kind [scope:companies:write risk:low idempotent dry-run]
POST /companies/{companyId}/corporate-meetings/{id}/hold : Mark a meeting as held: a board meeting takes its minutes number, an årsstämma records its date on the årsredovisning [scope:companies:write risk:medium idempotent dry-run]
POST /companies/{companyId}/share-classes : Add a share class with its votes per share and the förbehåll of the bolagsordning [scope:companies:write risk:low idempotent dry-run]
PATCH /companies/{companyId}/share-classes/{id} : Change a share class's name, votes per share or förbehåll; its code stays [scope:companies:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/share-register : Read the aktiebok as of a date: holders with shares, votes and percent, share numbers, classes and notes [scope:companies:read risk:low idempotent]
GET /companies/{companyId}/share-register/events : List every aktiebok entry in entry order, each with a Swedish sentence and whether a rättelse voided it [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/share-register/events : Add a dated entry to the aktiebok: an issue, a transfer, a cancellation, a conversion, a split, an aktiebrev, a pledge or a note [scope:companies:write risk:medium idempotent dry-run]
POST /companies/{companyId}/signatory-rules : Set the firmateckning from a date; the rule in force ends the day before [scope:companies:write risk:low idempotent dry-run]
```

### Capital events (Bolaget) (8)

Full detail: [references/capital-events.md](references/capital-events.md)

```text
POST /companies/{companyId}/capital-changes : Record a nyemission, fondemission or minskning av aktiekapitalet, with its allotment and its filing deadlines [scope:companies:write risk:medium idempotent dry-run]
POST /companies/{companyId}/capital-changes/{id}/book : Book a capital change: a nyemission's payment (D bank / K 2082, 2097), or the registration of any change [scope:bookkeeping:write risk:high idempotent dry-run]
GET /companies/{companyId}/capital-events : Read the capital events: dividends with the split per holder, aktieägartillskott, and nyemission, fondemission and minskning [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/dividends : Record a dividend decided by the bolagsstämma and split it over the holders of the aktiebok [scope:companies:write risk:medium idempotent dry-run]
POST /companies/{companyId}/dividends/{id}/book : Book a decided dividend: D 2098 (or 2091) / K 2898 on the decision day, and freeze the split per holder [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/dividends/{id}/pay : Mark a booked dividend paid: book D 2898 / K bank, or link the payout verifikat already booked from the bank [scope:bookkeeping:write risk:high idempotent dry-run]
GET /companies/{companyId}/ku31/{year} : Read the KU31 status of an inkomstår: who received a dividend, what is reported, what still blocks the file [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/shareholder-contributions : Register and book an aktieägartillskott (villkorat or ovillkorat), or the repayment of a villkorat one [scope:bookkeeping:write risk:high idempotent dry-run]
```

### Owner tax (Bolaget) (7)

Full detail: [references/owner-tax.md](references/owner-tax.md)

```text
GET /companies/{companyId}/k10/{year} : Read the K10 underlag per delägare for an inkomstår: gränsbelopp, lönebaserat utrymme, dividend and sparat utdelningsutrymme [scope:payroll:read risk:low idempotent]
PUT /companies/{companyId}/k10/{year}/owners/{partyId} : Save what a delägare enters for the K10 underlag of a year: sparat utdelningsutrymme, an omkostnadsbelopp, a löneunderlag or own pay that differs from the payroll [scope:companies:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/ku20/{year} : Read the KU20 status of an inkomstår: interest the company paid to natural persons on their loans, the tax withheld, and what blocks the file [scope:companies:read risk:low idempotent]
GET /companies/{companyId}/owner-loans : Read the owner loan register: loans and security between the company and its owners, board, VD and related persons, with the låneförbud check and the ledger reconciliation [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/owner-loans : Register a loan between the company and an owner, board member, VD or related person, or security the company gave for one; checked against the låneförbud (ABL 21 kap.) [scope:companies:write risk:medium idempotent dry-run]
PATCH /companies/{companyId}/owner-loans/{id} : Update an owner loan: outstanding after a repayment, terms, the exception claimed, or mark it repaid or cancelled [scope:companies:write risk:medium idempotent dry-run]
POST /companies/{companyId}/owner-loans/{id}/interest : Record the interest on an owner loan for an inkomstår and the tax withheld: the figures KU20 reports [scope:companies:write risk:low idempotent dry-run reversible]
```

### Banking (67)

Full detail: [references/banking.md](references/banking.md)

```text
GET /companies/{companyId}/bank-connections : List PSD2 bank connections with sync freshness and consent expiry [scope:companies:read risk:low idempotent]
POST /companies/{companyId}/bank-connections/{connectionId}/sync : Sync one bank connection now instead of waiting for the nightly run [scope:transactions:write risk:low idempotent]
GET /companies/{companyId}/bank-feed : The company's Open Payments bank connections and whether it may make one [scope:transactions:read risk:low idempotent]
GET /companies/{companyId}/bank-feed/banks : The banks a company can connect with BankID through Open Payments [scope:transactions:read risk:low idempotent]
GET /companies/{companyId}/bank-feed/banks/{bic} : One bank's details: how a person signs there, and the sparbanker behind a shared BIC [scope:transactions:read risk:low idempotent]
POST /companies/{companyId}/bank-feed/invites : Send the company's firmatecknare a link to connect the bank with BankID, without an Accounted login [scope:transactions:write risk:medium idempotent dry-run]
GET /companies/{companyId}/bank-feed/switch-progress : Where the company stands in the switch from Enable Banking to Open Payments [scope:transactions:read risk:low idempotent]
GET /companies/{companyId}/cash-accounts : List bank/cash accounts with the bank-reported balance [scope:transactions:read risk:low idempotent]
POST /companies/{companyId}/cash-accounts : Create a bank account by hand (no bank connection), with the payee details invoices print, or a company card [scope:companies:write risk:low idempotent dry-run]
PATCH /companies/{companyId}/cash-accounts/{id} : Edit a bank account: verifikationsserie, payee details, name, or turn it on/off [scope:companies:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/cash-accounts/{id}/set-primary : Make a bank account the company's primary [scope:companies:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/cash-accounts/change-ledgers : Change which 19xx ledger account bank-connected accounts book on from now on [scope:companies:write risk:medium idempotent dry-run reversible]
PUT /companies/{companyId}/cash-accounts/payee-defaults : Choose which bank account invoices in a currency tell the customer to pay to [scope:companies:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/imports/bank : Import a bank-file (CSV / Excel / XML / CAMT053) [scope:transactions:write risk:medium idempotent]
POST /companies/{companyId}/imports/bank/{id}/undo : Undo a bank file import: delete the rows it created that are still unbooked [scope:transactions:write risk:high idempotent dry-run]
POST /companies/{companyId}/imports/deposit-specification : Attach a deposit specification (BG Max or camt.054) to the bank rows that are its deposits [scope:transactions:write risk:medium idempotent dry-run]
POST /companies/{companyId}/imports/sie : Import a SIE4 file [scope:bookkeeping:write risk:high idempotent reversible]
POST /companies/{companyId}/imports/sie/{id}/resume : Resume an interrupted SIE import from where it stopped [scope:bookkeeping:write risk:medium idempotent dry-run]
POST /companies/{companyId}/imports/sie/{id}/undo : Undo an SIE import by batch storno: every entry it posted is reversed, nothing is deleted [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/imports/sie/upload : Reserve a direct SIE upload [scope:bookkeeping:write risk:low reversible]
POST /companies/{companyId}/imports/skattekonto-file : Import a skattekontoutdrag file (Skatteverket tax account statement) into the skattekonto rows [scope:transactions:write risk:medium idempotent dry-run]
GET /companies/{companyId}/pos-sales/clearing-balance : The till's card and Swish money not yet in the bank: the clearing account balance and the days not booked yet [scope:transactions:read risk:low idempotent]
GET /companies/{companyId}/pos-sales/connections : The point-of-sale venues the company has connected, with their health and account mapping [scope:transactions:read risk:low idempotent]
POST /companies/{companyId}/pos-sales/connections : Connect a point-of-sale venue, so its business days are fetched every morning [scope:companies:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/pos-sales/connections/{connectionId}/disconnect : Stop fetching a point-of-sale venue's days [scope:companies:write risk:medium idempotent dry-run reversible]
PATCH /companies/{companyId}/pos-sales/connections/{connectionId}/settings : Change the accounts a point-of-sale venue's days are booked to [scope:companies:write risk:medium idempotent dry-run reversible]
GET /companies/{companyId}/pos-sales/days : The business days fetched from the company's point-of-sale venues, newest first [scope:transactions:read risk:low idempotent]
GET /companies/{companyId}/pos-sales/days/{dayId} : One point-of-sale day: its receipts and the voucher it books as [scope:transactions:read risk:low idempotent]
POST /companies/{companyId}/pos-sales/days/{dayId}/book : Book a point-of-sale day as its daily takings voucher, with the day report as underlag [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/pos-sales/fetch : Fetch point-of-sale days now instead of waiting for the morning run [scope:transactions:write risk:low idempotent dry-run]
GET /companies/{companyId}/pos-sales/venues : The point-of-sale venues this company may connect, and how to get one opened [scope:transactions:read risk:low idempotent]
GET /companies/{companyId}/reconciliation/accounts : List the accounts that can be reconciled, with status per account [scope:reconciliation:read risk:low idempotent]
GET /companies/{companyId}/reconciliation/accounts/{accountKey} : The reconciliation bridge for one account [scope:reconciliation:read risk:low idempotent]
GET /companies/{companyId}/reconciliation/accounts/{accountKey}/items : List the rows behind one account's bridge, bucketed [scope:reconciliation:read risk:low idempotent]
POST /companies/{companyId}/reconciliation/accounts/{accountKey}/items/{itemId}/ignore : Ignore or restore one outside row [scope:reconciliation:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/reconciliation/accounts/{accountKey}/links : Link outside rows to existing verifikat (pairs or proposals) [scope:reconciliation:write risk:medium idempotent dry-run reversible]
DELETE /companies/{companyId}/reconciliation/accounts/{accountKey}/links/{linkId} : Remove a link between an outside row and a verifikat [scope:reconciliation:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/reconciliation/accounts/{accountKey}/residual : Book the remainder of a bank selection as a fee/interest/rounding verifikat and link the selection [scope:transactions:write risk:medium idempotent dry-run]
GET /companies/{companyId}/reconciliation/accounts/{accountKey}/signoff : Sign-off history for one reconcilable account [scope:reconciliation:read risk:low idempotent reversible]
POST /companies/{companyId}/reconciliation/accounts/{accountKey}/signoff : Mark an account reconciled through a date (sign-off) [scope:reconciliation:signoff risk:medium idempotent dry-run reversible]
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
POST /companies/{companyId}/transactions/{id}/match-batch : Book one bank payment against several customer invoices, or several supplier invoices, in one verifikat [scope:transactions:write risk:high idempotent dry-run]
POST /companies/{companyId}/transactions/{id}/match-expense-payout : Book an outgoing bank transaction as the repayment of one person's expense claims [scope:transactions:write risk:medium idempotent dry-run]
POST /companies/{companyId}/transactions/{id}/match-invoice : Match a positive bank transaction to a customer invoice [scope:transactions:write risk:high idempotent]
POST /companies/{companyId}/transactions/{id}/match-supplier-invoice : Match a negative bank transaction to a supplier invoice [scope:transactions:write risk:high idempotent]
POST /companies/{companyId}/transactions/{id}/refresh-exchange-rate : Fill in the Riksbanken rate and SEK amount of an unbooked foreign-currency transaction [scope:transactions:write risk:low idempotent dry-run]
POST /companies/{companyId}/transactions/{id}/uncategorize : Reverse the categorization of a transaction (storno + reset) [scope:transactions:write risk:medium idempotent dry-run]
POST /companies/{companyId}/transactions/batch-categorize : Categorize up to 100 transactions in one call (partial-success) [scope:transactions:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/transactions/bulk-book : Book several SEK bank transactions as one samlingsverifikat, or link them to one posted verifikat [scope:transactions:write risk:high idempotent dry-run]
POST /companies/{companyId}/transactions/ingest : Bulk-ingest transactions (up to 500 per call) [scope:transactions:write risk:medium idempotent dry-run]
GET /companies/{companyId}/webshop-orders : The order and refund rows synced from the company's webshops, newest first [scope:transactions:read risk:low idempotent]
GET /companies/{companyId}/webshop-orders/{orderId} : One webshop order row with its line items and the booking the Orders page would prefill [scope:transactions:read risk:low idempotent]
POST /companies/{companyId}/webshop-orders/{orderId}/book : Book one webshop order or refund with your own lines, linked to the order with its orderunderlag [scope:bookkeeping:write risk:high idempotent dry-run]
POST /companies/{companyId}/webshop-orders/book-day : Book a store's orders and refunds of one day and one payment method as one verifikat, with a day summary as underlag [scope:bookkeeping:write risk:high idempotent dry-run]
GET /companies/{companyId}/webshop-orders/oss-underlag : Underlag for the OSS declaration (unionsordningen): a quarter's sales to consumers in other EU countries, per country and VAT rate, in euro [scope:reports:read risk:low idempotent]
```

### Employees (32)

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
GET /companies/{companyId}/salary/fora-report : The Fora monthly report for a payment month: each coded worker, their FOK code and the pay Fora is told about [scope:payroll:read risk:low idempotent]
GET /companies/{companyId}/salary/premium-rules : List OB and overtime premium rules [scope:payroll:read risk:low idempotent]
POST /companies/{companyId}/salary/premium-rules : Create an OB or overtime premium rule [scope:payroll:write risk:low idempotent dry-run reversible]
PATCH /companies/{companyId}/salary/premium-rules/{id} : Update an OB or overtime premium rule [scope:payroll:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/salary/premium-rules/{id} : Delete an OB or overtime premium rule [scope:payroll:write risk:low idempotent dry-run]
GET /companies/{companyId}/salary/settings : Get the company payroll settings [scope:payroll:read risk:low idempotent]
PATCH /companies/{companyId}/salary/settings : Partially update the company payroll settings [scope:payroll:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/salary/vacation-liability/reconcile : Book the semesterlöneskuld at its computed value on a date: the difference to 2920/2940 as one verifikat [scope:payroll:write risk:medium idempotent dry-run]
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
POST /companies/{companyId}/salary-runs/{id}/send-payslips : Send the employees on an approved salary run their payslip: a secure email link, or the PDF to their Kivra or Billo mailbox [scope:payroll:write risk:medium idempotent dry-run]
POST /companies/{companyId}/salary-runs/{id}/unapprove : Recall the approval of a salary run (approved back to review) [scope:payroll:write risk:medium idempotent dry-run reversible]
```

### Reports (59)

Full detail: [references/reports.md](references/reports.md)

```text
GET /companies/{companyId}/audit-trail : The audit log: every trigger-recorded change to the books and their settings, newest first [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/budgets : List the budgets (named versions per fiscal year) [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/budgets : Create a budget for a fiscal year [scope:bookkeeping:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/budgets/{id} : Read one budget and its amounts per account, month and dimension [scope:reports:read risk:low idempotent]
PATCH /companies/{companyId}/budgets/{id} : Rename a budget, make it the default, or archive or restore it [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/budgets/{id} : Delete a budget and its amounts [scope:bookkeeping:write risk:low idempotent dry-run]
POST /companies/{companyId}/budgets/{id}/copy-actuals : Fill a budget with last year's booked result, optionally scaled [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/budgets/{id}/import : Import a budget file (SIE #PBUDGET, Excel or CSV) into a budget [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/budgets/{id}/lines : Save amounts in a budget (account, month, dimension cells) [scope:bookkeeping:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/budgets/{id}/spread : Spread a yearly amount over the months of a budget [scope:bookkeeping:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/cash-forecast : The 13-week liquidity forecast: where the bank balance is heading, by day and by ISO week [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/cash-forecast-rows : The forecast rows: money expected in or out that the books do not hold yet [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/cash-forecast-rows : Add or update forecast rows by your own key, up to 500 at a time [scope:forecast:write risk:low idempotent dry-run reversible]
POST /companies/{companyId}/cash-forecast-rows/cancel : Cancel a forecast row: it leaves the forecast and stays on record [scope:forecast:write risk:low idempotent dry-run]
GET /companies/{companyId}/measures : The defined measures: id, name, precise definition, parameters and the report each equals [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/measures/{measureId} : One defined measure: the value, its definition, what it covers, caveats and an explain handle [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/measures/{measureId}/explain : What a defined measure adds: contributors and the journal lines or invoices behind it, paged [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ar-ledger : AR ledger: unpaid customer invoices with aging [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/avgifter-basis : The year's declared arbetsgivaravgifter per month and sats [scope:payroll:read risk:low idempotent]
GET /companies/{companyId}/reports/balance-sheet : Balance sheet (balansräkning) for a fiscal period or as of a custom date [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/balance-sheet/pdf : Balance sheet (balansräkning) as a PDF [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/behandlingshistorik : Behandlingshistorik (BFL 5 kap. 11 §): who changed what in the books, and when, for a räkenskapsår [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/bokslutsbilagor : Bokslutsbilagor: every balance account at the balansdag with its specification, sign-off and underlag [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/budget-vs-actual : Budget against booked result per account and month [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/continuity-check : IB/UB continuity check: opening balances match prior closing [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/dimension-cross : Result across two dimensions: one dimension's values as rows, another's as columns, one amount per cell [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/dimension-cross/lines : The journal lines behind one cell of the two-dimension result, a page at a time [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/dimension-pnl : Resultat per projekt or kostnadsställe: the income statement with one column per dimension value [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/forenklat-arsbokslut : Förenklat årsbokslut (ideell förening, BFNAR 2010:1): resultaträkning and balansräkning for a räkenskapsår [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/forenklat-arsbokslut/pdf : Förenklat årsbokslut (ideell förening, BFNAR 2010:1) as a PDF for the styrelse to sign [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/general-ledger : General ledger (huvudbok) for a fiscal period [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/income-statement : Income statement (resultatrapport) for a fiscal period or a custom date range [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/income-statement/pdf : Income statement (resultaträkning) as a PDF [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ink2 : INK2 inkomstdeklaration (aktiebolag): INK2, INK2R and INK2S fields for a räkenskapsår [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ink2/sru : INK2 SRU files (INFO.SRU + BLANKETTER.SRU) as a zip, for upload at skatteverket.se [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ink3 : INK3 underlag (ideell förening): INK3R, INK3S and INK3SUF values per ruta for a räkenskapsår [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/journal-register : Journal register (verifikationsregister) for a fiscal period [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/kassaflodesanalys : Kassaflödesanalys (cash flow statement, indirect method) for a räkenskapsår [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/kpi : Business KPIs (nyckeltal) for a fiscal period, as the dashboard shows them [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/monthly-breakdown : Income statement broken down by month for a fiscal period [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/reports/ne-bilaga : NE-bilaga (enskild firma): balansräkning B1-B16 and rutor R1-R11 for a räkenskapsår [scope:reports:read risk:low idempotent]
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
GET /companies/{companyId}/reports/vat-declaration/filings : List the VAT periods the company has recorded as filed [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/reports/vat-declaration/filings : Record that a VAT period was filed outside the Skatteverket connection [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/reports/vat-declaration/filings : Undo a manual "filed" mark on a VAT period [scope:bookkeeping:write risk:low idempotent dry-run reversible]
GET /companies/{companyId}/reports/vat-declaration/settlement-proposal : The proposed momsredovisning verifikat for a VAT period: clear 26xx to 2650 or 1650 [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/unexplained : The unexplained queue: every expected-zero check run for the company, differences first [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/unexplained/{checkId} : One expected-zero check: its definition and basis, the figures it compares, and every result [scope:reports:read risk:low idempotent]
GET /companies/{companyId}/unexplained/{checkId}/explain : What a difference in the queue consists of: its parts and the items behind them, with typed handles [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/vat/settlement : Book the momsredovisning verifikat for a VAT period, exactly as the proposal gives it [scope:bookkeeping:write risk:high idempotent dry-run]
```

### Fixed assets (10)

Full detail: [references/assets.md](references/assets.md)

```text
GET /companies/{companyId}/assets : List the fixed-asset register (anläggningsregister) [scope:reports:read risk:low idempotent]
POST /companies/{companyId}/assets : Register a fixed asset (no voucher is posted) [scope:bookkeeping:write risk:low idempotent dry-run]
GET /companies/{companyId}/assets/{id} : Get one fixed asset [scope:reports:read risk:low idempotent]
PATCH /companies/{companyId}/assets/{id} : Partially update a fixed asset [scope:bookkeeping:write risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/assets/{id} : Delete an asset that never reached the books [scope:bookkeeping:write risk:medium idempotent dry-run]
POST /companies/{companyId}/assets/{id}/components/{componentId}/replace : Replace a K3 component: take the replaced part off the books and register the replacing one [scope:bookkeeping:write risk:high idempotent dry-run reversible]
POST /companies/{companyId}/assets/{id}/dispose : Dispose a fixed asset and post the avyttring voucher [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
PUT /companies/{companyId}/assets/{id}/tax-plan : State the tax depreciation plan of a building or markanläggning: percent a year, the day it starts, the primäravdrag [scope:bookkeeping:write risk:low idempotent dry-run reversible]
PUT /companies/{companyId}/assets/{id}/transition-split : Split an asset on significant components at the transition to K3 (35.18), or undo the split [scope:bookkeeping:write risk:medium idempotent dry-run reversible]
POST /companies/{companyId}/assets/{id}/value-adjustments : Write an asset down to its recoverable amount (nedskrivning), or reverse an earlier write-down, on a balansdag [scope:bookkeeping:write risk:high idempotent dry-run reversible]
```

### Pending operations (approvals) (5)

Full detail: [references/pending-operations.md](references/pending-operations.md)

```text
GET /companies/{companyId}/pending-operations : List pending operations (staged writes waiting for approval) [scope:pending_operations:read risk:low idempotent]
GET /companies/{companyId}/pending-operations/{id} : Read one pending operation and its outcome [scope:pending_operations:read risk:low idempotent]
POST /companies/{companyId}/pending-operations/{id}/approve : Approve a pending operation: commit it and answer the outcome [scope:pending_operations:approve risk:high idempotent]
POST /companies/{companyId}/pending-operations/{id}/reject : Reject a pending operation without committing it [scope:pending_operations:approve risk:low idempotent]
POST /companies/{companyId}/pending-operations/{id}/withdraw : Withdraw a pending operation this key staged itself [risk:low idempotent]
```

### Webhooks (10)

Full detail: [references/webhooks.md](references/webhooks.md)

```text
GET /companies/{companyId}/webhooks : List webhook subscriptions for a company [scope:webhooks:manage risk:low idempotent]
POST /companies/{companyId}/webhooks : Register a webhook subscription [scope:webhooks:manage risk:low idempotent dry-run reversible]
GET /companies/{companyId}/webhooks/{id} : Get a webhook subscription by id [scope:webhooks:manage risk:low idempotent]
PATCH /companies/{companyId}/webhooks/{id} : Update a webhook subscription [scope:webhooks:manage risk:low idempotent dry-run reversible]
DELETE /companies/{companyId}/webhooks/{id} : Delete a webhook subscription [scope:webhooks:manage risk:medium idempotent]
GET /companies/{companyId}/webhooks/{id}/deliveries : List deliveries for a webhook subscription [scope:webhooks:manage risk:low idempotent]
POST /companies/{companyId}/webhooks/{id}/rotate-secret : Rotate the HMAC signing secret on a webhook [scope:webhooks:manage risk:medium idempotent]
POST /companies/{companyId}/webhooks/{id}/test : Send a synthetic test event to a webhook [scope:webhooks:manage risk:low]
POST /companies/{companyId}/webhooks/{id}/verify : Verify a webhook endpoint's ownership now [scope:webhooks:manage risk:low idempotent]
POST /webhook-deliveries/{id}/retry : Retry a webhook delivery [scope:webhooks:manage risk:medium]
```

### Portfolio (1)

Full detail: [references/portfolio.md](references/portfolio.md)

```text
GET /portfolio/overview : Cross-company overview: unbooked, inbox and next deadline per company the key can reach [scope:companies:read risk:low idempotent]
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
(`https://app.accounted.se/api/v1/openapi.json`), and its runtime request
validators, so schema drift between this text and the server cannot occur for
a matching `api_version`. CI regenerates and diffs it on every change.

Before first use in a new environment, smoke-test:

```bash
curl -s https://app.accounted.se/api/v1/health
curl -s https://app.accounted.se/api/v1/companies -H "Authorization: Bearer $ACCOUNTED_API_KEY"
```

If `meta.api_version` in responses is newer than the version in this skill's
index header, refetch the skill (or read the changelog at
https://app.accounted.se/docs/api/changelog) before relying on endpoint details.
