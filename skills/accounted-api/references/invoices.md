<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Invoices (AR) endpoints

Accounts receivable invoices: draft -> send -> paid/credited; the F-series number is assigned at send, not create. Supplier bills you receive are a different resource: see suppliers.md. Customer and article registers: customers.md.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/invoices`

**List invoices for a company.**
`scope:invoices:read · risk:low · idempotent`

Cursor-paginated invoice list ordered by created_at DESC, id ASC (newest-registered first; the `invoice_date` column is the business date and is filterable via ?date_from / ?date_to but is not the sort key). Includes the customer name inline; pass ?expand=customer for the full customer record, ?expand=items for line items.

**Use when:** You need to enumerate invoices for a company: for AR reporting, payment matching, or building an invoice dashboard.
**Do not use for:** Fetching a single invoice you already know the id of: use GET /api/v1/companies/{companyId}/invoices/{id}. Supplier invoices are a different resource (supplier-invoices).

**Pitfalls:**
- Draft invoices have invoice_number=null until they are sent.
- remaining_amount is the unpaid portion (total − paid_amount); use status=paid or remaining_amount=0 to filter for closed invoices.
- Credit notes appear with status=credited and a credited_invoice_id field on the detail endpoint.
- Ordering is by created_at (registration time), not invoice_date. Backdated invoices therefore appear where they were created, not where their date falls: filter on ?date_from / ?date_to when you care about the business date.
- Cursor pagination: pass ?cursor=<next_cursor> from the previous response. A stale or tampered cursor is ignored and the first page is returned again.
- Quotes (document_type=quote, offert) carry valid_until and quote_status (open | accepted | declined | expired). "expired" is derived: an open quote past valid_until; filter with ?quote_status=expired. Quotes never book and are never payable: convert an accepted quote to an invoice in the dashboard first.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, invoice_number: string, customer_id: string, customer_name: string, invoice_date: string, due_date: string, status: "draft" | "sent" | "paid" | "partially_paid" | "overdue" | "cancelled" | "credited", document_type: "invoice" | "proforma" | "delivery_note" | "quote", valid_until: string, quote_status: "open" | "accepted" | "declined" | "expired", currency: string, subtotal: number, vat_amount: number, total: number, remaining_amount: number, paid_at: string, created_at: string }[],
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": [
    {
      "id": "0e9c…",
      "invoice_number": "2026-0042",
      "customer_id": "a8f1…",
      "customer_name": "Acme AB",
      "invoice_date": "2026-05-01",
      "due_date": "2026-05-31",
      "status": "sent",
      "document_type": "invoice",
      "currency": "SEK",
      "subtotal": 10000,
      "vat_amount": 2500,
      "total": 12500,
      "remaining_amount": 12500,
      "paid_at": null,
      "created_at": "2026-05-01T09:14:33Z"
    }
  ],
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12",
    "next_cursor": null
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices`

**Create a draft invoice, proforma, or delivery note.**
`scope:invoices:write · risk:medium · idempotent · dry-run · reversible`

Creates an invoice in draft status. The F-series invoice_number is allocated atomically on the first send action (PR-B-2b). Per-item VAT rates are validated against the customer's allowed rates (mixed-rate invoices supported). Non-SEK invoices are converted to SEK at the Riksbanken exchange rate fetched at create time. Supports ROT/RUT deduction lines (items[].deduction_type = "rot"|"rut" with invoice-level deduction_personnummer + deduction_housing_designation, or deduction_apartment_number + deduction_brf_org_number for bostadsrätt), article linkage (items[].article_id + optional revenue_account override from the artikelregister), and project/cost-centre tagging (default_dimensions / items[].dimensions). Idempotent (mandatory Idempotency-Key). Dry-runnable: the preview returns the validated would-be invoice + items with computed totals; no journal entry is involved at draft stage (posting happens on :send). Set is_self_billed=true (with external_invoice_number + received_date) to instead register a received self-billing invoice (mottagen självfaktura, ML 17 kap 15§): a sale booked immediately with the counterparty's number, not a draft.

**Use when:** You need to issue a new invoice, proforma, or delivery note. Use dry-run first to confirm VAT calculations and currency conversion before committing.
**Do not use for:** Updating an existing invoice (PATCH instead, drafts only). Issuing a credit note (use POST /:id:credit in PR-B-2b). Posting a previously-created draft to the journal (use POST /:id:send in PR-B-2b).

**Pitfalls:**
- Idempotency-Key is mandatory; calls without it return 400.
- For mixed-rate invoices, set vat_rate per item explicitly. Items where vat_rate is omitted use the customer's default rate from getVatRules().
- Non-SEK currencies require an active Riksbanken exchange-rate fetch. Failure is non-fatal: the invoice is created with null SEK fields and the agent can recompute later.
- invoice_number is null on creation. The number is allocated atomically when the invoice transitions out of draft. Counting on a specific number at create time is a bug.
- document_type='delivery_note' produces no VAT and a different number sequence (D-series). Most use cases want the default document_type='invoice'.
- document_type='quote' (offert) requires valid_until (YYYY-MM-DD, the expiry; due_date mirrors it). A quote is numbered OF-nnn from its own series at create, starts as quote_status='open', never posts a journal entry, never emits invoice.created and cannot be sent-and-booked or paid: record the customer decision with POST /invoices/{id}/quote-status and convert an accepted quote to an invoice in the dashboard.
- is_self_billed=true registers a self-billing invoice your CUSTOMER issued on your behalf (a sale for you). It is booked immediately (not a draft, no F-number), so external_invoice_number and received_date are required and it is NOT dry-run-free of side effects on the live call. Do NOT set it for a normal invoice you issue yourself.
- Project/cost-center tagging: pass default_dimensions ({"6":"P001"} = project, {"1":"KS01"} = kostnadsställe) for the whole invoice and/or items[].dimensions per line (per-line wins per key). Tags are stored on the draft and applied to the journal entry lines when the invoice is sent. When the company has the dimension registry enabled, unknown or archived codes are rejected at :send with 400 DIMENSION_VALIDATION_FAILED — list valid codes via GET /dimensions.
- ROT/RUT: set items[].deduction_type ("rot"|"rut") on labor lines plus labor_hours and work_type (Skatteverket arbetstypskod). The invoice must carry deduction_personnummer AND housing info: deduction_housing_designation (fastighetsbeteckning) for småhus, or deduction_apartment_number + deduction_brf_org_number for bostadsrätt. deduction_amount is computed server-side and cannot be set by the caller; the response exposes deduction_total and remaining_amount = total - deduction_total (Skatteverket pays the rest via 1513). Validation failures return 400 INVOICE_CREATE_ROT_RUT_VALIDATION.
- Articles: pass items[].article_id (from the artikelregister, GET /articles) to link a line to a catalog article; price/description are still taken from the request body (the API never auto-fills from the article: send the values you want on the invoice). items[].revenue_account is the legacy wire name for an optional BAS class 1-3 posting-account override and is validated against the chart of accounts.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  customer_id: string,
  invoice_date: string,
  due_date: string,
  delivery_date?: string | "",
  currency: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK",
  document_type?: "invoice" | "proforma" | "delivery_note" | "quote",
  valid_until?: string | "",
  your_reference?: string,
  our_reference?: string,
  invoice_marking?: string,
  notes?: string,
  payment_link_url?: string | "",
  payment_link_auto?: boolean,
  deduction_personnummer?: string,
  deduction_housing_designation?: string,
  deduction_apartment_number?: string,
  deduction_brf_org_number?: string | "",
  save_as_draft?: boolean,
  ore_rounding?: boolean,
  default_dimensions?: Record<string, string>,
  is_self_billed?: boolean,
  external_invoice_number?: string | "",
  self_billing_agreement_ref?: string,
  received_date?: string | "",
  items: { line_type?: "product" | "text", description: string, quantity: number, unit: string, unit_price: number, discount_percent?: number, vat_rate?: number, article_id?: string, revenue_account?: string, deduction_type?: "rot" | "rut", labor_hours?: number, work_type?: string, housing_designation?: string, apartment_number?: string, brf_org_number?: string | "", accrual_period_start?: string, accrual_period_end?: string, accrual_balance_account?: string, dimensions?: Record<string, string> }[]
}
```

Example request:
```json
{
  "customer_id": "a8f1…",
  "invoice_date": "2026-05-12",
  "due_date": "2026-06-11",
  "currency": "SEK",
  "items": [
    {
      "description": "Konsultation",
      "quantity": 8,
      "unit": "tim",
      "unit_price": 1250
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    invoice_number: string,
    customer_id: string,
    invoice_date: string,
    due_date: string,
    status: string,
    document_type: string,
    valid_until?: string,
    quote_status?: string,
    currency: string,
    subtotal: number,
    vat_amount: number,
    total: number,
    remaining_amount: number,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "invoice_number": null,
    "customer_id": "a8f1…",
    "invoice_date": "2026-05-12",
    "due_date": "2026-06-11",
    "status": "draft",
    "currency": "SEK",
    "subtotal": 10000,
    "vat_amount": 2500,
    "total": 12500,
    "remaining_amount": 12500
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/invoices/{id}`

**Retrieve a single invoice by id.**
`scope:invoices:read · risk:low · idempotent`

Returns the full invoice record with the customer embedded. Pass ?expand=items for line items, ?expand=payments for payment history, or ?expand=items,payments for both.

**Use when:** You have an invoice id (from a webhook, the list endpoint, or a customer transaction) and need the full record including amounts, dates, status, and the customer details.
**Do not use for:** Listing invoices (use GET /api/v1/companies/{companyId}/invoices). Bookkeeping verifikationer tied to the invoice (use the journal-entries endpoints in a later phase).

**Pitfalls:**
- Returns 404 if the invoice does not belong to the company in the URL: does not leak existence across companies.
- paid_at and remaining_amount can lag behind the latest payment by a few seconds during high-volume reconciliation.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    invoice_number: string,
    customer_id: string,
    invoice_date: string,
    due_date: string,
    status: string,
    document_type: string,
    valid_until?: string,
    quote_status?: string,
    quote_decided_at?: string,
    currency: string,
    total: number,
    remaining_amount: number,
    paid_at: string,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "invoice_number": "2026-0042",
    "customer_id": "a8f1…",
    "customer": {
      "id": "a8f1…",
      "name": "Acme AB"
    },
    "invoice_date": "2026-05-01",
    "due_date": "2026-05-31",
    "status": "sent",
    "total": 12500,
    "remaining_amount": 12500,
    "paid_at": null,
    "created_at": "2026-05-01T09:14:33Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/invoices/{id}`

**Update a draft invoice (metadata fields, optionally replacing line items).**
`scope:invoices:write · risk:low · idempotent · dry-run · reversible`

Partial update for invoices in draft status. Allowed fields: invoice_date, due_date, delivery_date, your_reference, our_reference, notes, default_dimensions (project/cost-centre tags, e.g. {"6":"P001"}; replaces the whole bag), and an optional items array. When items is present, it fully REPLACES the draft's line items and subtotal / VAT / total are recomputed against the invoice's existing customer (same validation as POST /invoices); when omitted, items and totals are unchanged. customer_id, currency, and document_type are immutable: replace those by deleting the draft and recreating it. Returns 409 INVOICE_UPDATE_NOT_DRAFT if the invoice is no longer in draft status. Idempotent and dry-runnable.

**Use when:** You need to correct a typo, push the due date, update a customer reference, or rewrite the line items on a draft you have not sent yet. The invoice number stays null until the first :send action.
**Do not use for:** Updating a sent / paid / credited invoice (those are immutable per ML 17 kap; issue a credit note via POST /:id:credit in PR-B-2b). Changing currency or customer: drafts are cheap to delete and recreate.

**Pitfalls:**
- Idempotency-Key is mandatory.
- A 409 INVOICE_UPDATE_NOT_DRAFT means the invoice has been sent / paid / credited / cancelled. The DELETE handler on this path uses its own code, INVOICE_DELETE_NOT_DRAFT.
- items is a FULL REPLACE (no per-line merge): send the complete new line set, minimum one item. Omitting items keeps the current lines untouched. VAT rates are re-validated against the customer type and totals are recomputed server-side.
- items are always built against the invoice's EXISTING customer: customer_id cannot change on PATCH.
- default_dimensions replaces the entire bag (no per-key merge): read the current value first if you want to add a tag. Send {} to clear all tags. Codes are validated against the dimension registry at :send, not at PATCH time.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  invoice_date?: string,
  due_date?: string,
  delivery_date?: string | unknown,
  your_reference?: string | unknown,
  our_reference?: string | unknown,
  notes?: string | unknown,
  default_dimensions?: Record<string, string>,
  items?: { line_type?: "product" | "text", description: string, quantity: number, unit: string, unit_price: number, discount_percent?: number, vat_rate?: number, article_id?: string, revenue_account?: string, deduction_type?: "rot" | "rut", labor_hours?: number, work_type?: string, housing_designation?: string, apartment_number?: string, brf_org_number?: string | "", accrual_period_start?: string, accrual_period_end?: string, accrual_balance_account?: string, dimensions?: Record<string, string> }[]
}
```

Example request:
```json
{
  "due_date": "2026-07-15",
  "notes": "Förlängd förfallotid"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    invoice_number: string,
    customer_id: string,
    invoice_date: string,
    due_date: string,
    status: string,
    document_type: string,
    valid_until?: string,
    quote_status?: string,
    quote_decided_at?: string,
    currency: string,
    total: number,
    remaining_amount: number,
    paid_at: string,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "status": "draft",
    "due_date": "2026-07-15",
    "notes": "Förlängd förfallotid"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/invoices/{id}`

**Delete a draft invoice (hard delete if unnumbered, makulering if numbered).**
`scope:invoices:write · risk:high · dry-run`

Removes an invoice in draft status. An unnumbered draft (never finalized: no F-series number was consumed) is hard deleted and responds { deleted: true }; its line items cascade. A numbered draft is makulerad: the row and its number are retained, status flips to cancelled, and the response is { cancelled: true, invoice_number } so the F-series stays gap-free per ML 17 kap 24 and BFNAR 2013:2. Returns 409 INVOICE_DELETE_NOT_DRAFT for any non-draft status: sent / paid / credited invoices are immutable and must be reversed via a credit note. Requires Idempotency-Key; dry-runnable.

**Use when:** You created a draft by mistake, or want to discard a draft instead of sending it. Check the response shape: deleted means the row is gone, cancelled means it survives as makulerad with its number.
**Do not use for:** Withdrawing a sent / paid invoice (issue a credit note via POST /:id/credit). Editing a draft (use PATCH). Cancelling recurring schedules.

**Pitfalls:**
- Idempotency-Key is mandatory. A repeated DELETE with a fresh key returns 404 for a hard-deleted draft (the row is gone) and 409 INVOICE_DELETE_NOT_DRAFT for a makulerad one (status is now cancelled).
- 409 INVOICE_DELETE_NOT_DRAFT means the invoice left draft status: it is immutable and can only be reversed via a credit note.
- 409 INVOICE_CANCEL_RACE means the invoice was finalized or sent concurrently: re-read the invoice before retrying.
- The hard-delete path emits an invoice.draft_deleted audit event; the makulering path leaves its trail in the invoice row itself.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { deleted?: boolean, cancelled?: boolean, invoice_number?: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "cancelled": true,
    "invoice_number": "2026-0042"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/credit`

**Issue a credit note (kreditfaktura) against an invoice.**
`scope:invoices:write · risk:high · idempotent · dry-run`

Creates a credit note referencing the original invoice. The credit note carries reversed-sign amounts (matching the original line for line) and gets invoice_number=KR-<original>. The original invoice transitions to status=credited. Under faktureringsmetoden, posts a reversing journal entry (Credit AR 1510 / Debit revenue + Debit output VAT). Under kontantmetoden the credit note still creates the row but defers the reversal entry until refund. Idempotent and dry-runnable. Emits invoice.credited.

**Use when:** You need to legally cancel an issued invoice (ML 17 kap 22-23§). The original invoice cannot be edited once issued: credit it and reissue corrected.
**Do not use for:** Cancelling a draft (DELETE the draft instead). Refunding a partial payment without invalidating the whole invoice (book the refund manually via the journal-entries API in a future PR).

**Pitfalls:**
- Idempotency-Key is mandatory. Retried credits with the same key replay the cached response: no duplicate credit note is created.
- The original invoice must be in sent / paid / overdue status. Drafts, cancelled invoices, and already-credited invoices are rejected with specific error codes.
- Credit-note items mirror the original's lines with negated values. To credit only part of an invoice (line-level), credit the full invoice first then reissue with the corrected lines.
- Under kontantmetoden no journal entry is created here: refund booking is deferred. A `JOURNAL_ENTRY_NOT_POSTED` warning is NOT emitted in this case (the deferral is correct, not a failure).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ reason?: string }
```

Example request:
```json
{
  "reason": "Felaktig kund"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    invoice_number: string,
    credited_invoice_id: string,
    status: "sent",
    total: number,
    journal_entry_id: string,
    warnings?: { code: string, message: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "ccccccc-c…",
    "invoice_number": "KR-2026-0042",
    "credited_invoice_id": "0e9c…",
    "status": "sent",
    "total": -12500,
    "journal_entry_id": "8b4b…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/mark-paid`

**Record a payment against an invoice.**
`scope:invoices:write · risk:medium · idempotent · dry-run`

Marks a sent / overdue invoice as paid (or partially_paid). Books the payment via Debit 1930 / Credit 1510 under faktureringsmetoden, or Debit 1930 / Credit revenue + Credit output VAT under kontantmetoden. Optional body supports partial payments via custom balanced journal lines and exchange-rate adjustments for foreign-currency invoices. Idempotent and dry-runnable. Emits invoice.paid.

**Use when:** A customer paid an invoice via a channel other than the synced bank account (cash, manual transfer, separate processor). Use dry-run to confirm the booking before committing.
**Do not use for:** Reverting a payment: the public API does not expose unmark-paid. Issue a credit note via POST /:id/credit to cancel the underlying invoice instead. Bank-matched payments: those flow through the transactions endpoints.

**Pitfalls:**
- Idempotency-Key is mandatory. Retried marks with the same key replay the cached response.
- Custom `lines` must balance (sum of debits = sum of credits, both > 0). Otherwise returns 400 INVOICE_PAID_LINES_UNBALANCED.
- For foreign-currency invoices, supply `exchange_rate_difference` (SEK delta vs the invoice's booked rate) to book the FX adjustment correctly. Omitting it on a non-SEK invoice will mis-book the FX gain/loss.
- Custom `lines` are journal lines and therefore SEK, while `total` / `paid_amount` / `remaining_amount` are stored in the invoice currency. The route converts the line total via `invoice.exchange_rate`; a non-SEK invoice with no exchange_rate on file returns 400 MATCH_INVOICE_BOOKING_RATE_MISSING rather than silently treating the SEK amount as invoice currency.
- Cash basis (kontantmetoden) recognizes revenue HERE, not at :mark-sent. The dashboard tracks this via company_settings.accounting_method.
- Duplicate-payment guard: if an unlinked inbound bank transaction looks like this payment, returns 409 INVOICE_PAID_LIKELY_DUPLICATE with candidate transactions. Retry with `force: true` to bypass, but the retry MUST use a fresh Idempotency-Key (the original is body-hash bound; reusing it returns 400 IDEMPOTENCY_KEY_REUSE). The guard is also evaluated under dry-run, so a successful dry-run does not guarantee a successful commit.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  payment_date?: string,
  exchange_rate_difference?: number,
  notes?: string,
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, dimensions?: Record<string, string> }[],
  force?: boolean
}
```

Example request:
```json
{
  "payment_date": "2026-05-12"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    invoice_number: string,
    status: "paid" | "partially_paid",
    total: number,
    paid_amount: number,
    remaining_amount: number,
    paid_at: string,
    journal_entry_id: string,
    warnings?: { code: string, message: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "invoice_number": "2026-0042",
    "status": "paid",
    "total": 12500,
    "paid_amount": 12500,
    "remaining_amount": 0,
    "paid_at": "2026-05-12",
    "journal_entry_id": "7b3a…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/mark-sent`

**Transition a draft invoice to sent (without emailing).**
`scope:invoices:write · risk:medium · idempotent · dry-run`

Marks a draft invoice as sent: for invoices delivered outside Accounted (an external e-invoice provider, postal, manual email). Not needed after a successful dashboard Peppol send: that flow issues the invoice itself. If the dashboard reports that the invoice was sent via Peppol but could not be marked as sent (the send response carried issuance.ok=false and the invoice is still in draft), :mark-sent is the documented recovery and completes the issuance; a number already allocated is reused, never consumed twice. Peppol sending lives in the dashboard invoice page behind a per-company access grant (requested under Inställningar > Fakturering (Settings > Invoicing); aktiebolag senders, standard invoices only, Swedish org-number buyers whose org number is not a personnummer, SEK with taxable Swedish VAT at 6/12/25 % only, no ROT/RUT deductions); a v1 or MCP Peppol send action is not yet available. Allocates the F-series invoice_number atomically (ML 17 kap 24§ p.2). When the company books at issue (faktureringsmetoden without defer_invoice_booking), also posts the invoice journal entry (Debit AR 1510 / Credit revenue + output VAT). Emits invoice.sent. Idempotent and dry-runnable. The companion :send action (PR-B-2b-3) adds PDF rendering and email delivery on top of this same flow.

**Use when:** You delivered the invoice through a channel other than Accounted's email or a successful dashboard Peppol send (an external e-invoice provider, postal, your own SMTP) and need to record it as sent so the F-series number is allocated and the journal entry is posted; or a dashboard Peppol send was accepted by the network but reported that the invoice could not be marked as sent.
**Do not use for:** Sending the invoice via Accounted email: use :send (PR-B-2b-3) for that. Marking an already-sent invoice as paid: use :mark-paid (PR-B-2b-2).

**Pitfalls:**
- Only invoices in `status=draft` can be marked sent. Other states return 409 INVOICE_UPDATE_NOT_DRAFT (re-used; the action is structurally an update).
- Allocation is atomic. If a concurrent transition beats the agent's request to the same draft, the runner-up gets 409 INVOICE_UPDATE_NOT_DRAFT and no number is consumed.
- Delivery notes (document_type=delivery_note) don't transition to sent: they were never drafts in the f-series sense. This endpoint will reject them with 400 VALIDATION_ERROR.
- Idempotency-Key is mandatory. A retried mark-sent with the same key replays the cached response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    invoice_number: string,
    status: "sent",
    total: number,
    journal_entry_id: string,
    warnings?: { code: string, message: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "invoice_number": "2026-0042",
    "status": "sent",
    "total": 12500,
    "journal_entry_id": "7b3a…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/invoices/{id}/pdf`

**Download the rendered invoice PDF.**
`scope:invoices:read · risk:low · idempotent`

Returns the invoice as application/pdf. The descriptive filename contains company, customer, document type, invoice number or draft identifier, and invoice date. This endpoint is byte-equivalent to the dashboard download.

**Use when:** You need to fetch an invoice PDF for archival, forwarding to a customer outside the Accounted send flow, or attaching to an external workflow.
**Do not use for:** Sending the invoice to the customer: use POST /invoices/{id}/send, which renders the PDF, emails it, and archives it as a verifikationsunderlag in one atomic step.

**Pitfalls:**
- Drafts (no invoice_number yet) render with an "utkast" filename. The PDF carries no F-series number: do not treat it as a finalized invoice.
- PDF rendering can take several hundred milliseconds for invoices with many line items. Cache on the client if requesting repeatedly.
- Credit notes embed the original invoice's löpnummer per ML 17 kap 22-23§: if the original was hard-deleted (not possible via Accounted but theoretically via a manual DB edit), the reference is omitted.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200` (`application/pdf`).

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/quote-status`

**Record the customer decision on a quote (offert).**
`scope:invoices:write · risk:low · idempotent · dry-run · reversible`

Sets quote_status on a quote (document_type=quote) to open, accepted or declined. Any transition between the three is allowed until the quote has been converted to an invoice; after that the decision is locked (409 INVOICE_QUOTE_ALREADY_INVOICED). "expired" is never written: it is derived from valid_until and reported as effective_quote_status. Accepting a quote past valid_until is allowed (extend valid_until with PATCH if you want it to read as open again). No journal entry, number allocation or event is involved. Idempotent and dry-runnable.

**Use when:** The customer answered a quote and you want Accounted to reflect it (accepted / declined), or you want to reopen a decision that was recorded by mistake.
**Do not use for:** Creating the invoice from an accepted quote (convert it in the dashboard; the conversion marks the quote accepted itself). Regular invoices, proformas or delivery notes: they return 400 INVOICE_NOT_A_QUOTE.

**Pitfalls:**
- Only document_type=quote rows are decidable; anything else returns 400 INVOICE_NOT_A_QUOTE.
- A cancelled quote returns 400 INVOICE_QUOTE_NOT_DECIDABLE.
- Once an active invoice exists with converted_from_id = this quote, the decision is locked: 409 INVOICE_QUOTE_ALREADY_INVOICED. Cancelling that invoice frees the quote again.
- Setting status=open clears quote_decided_at; accepted/declined stamp it with the request time.
- Idempotency-Key is mandatory. A retried call with the same key replays the cached response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ status: "open" | "accepted" | "declined" }
```

Example request:
```json
{
  "status": "accepted"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    invoice_number: string,
    document_type: "quote",
    status: string,
    quote_status: "open" | "accepted" | "declined",
    effective_quote_status: "open" | "accepted" | "declined" | "expired",
    quote_decided_at: string,
    valid_until: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "invoice_number": "OF-007",
    "document_type": "quote",
    "status": "sent",
    "quote_status": "accepted",
    "effective_quote_status": "accepted",
    "quote_decided_at": "2026-09-02T09:14:33Z",
    "valid_until": "2026-09-30"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/send`

**Send a draft invoice to the customer by email.**
`scope:invoices:write · risk:high · idempotent · dry-run`

The full send pipeline: preflight PDF render → allocate F-series number atomically → final PDF render → email via the email extension (Resend or SMTP; PDF attachment, copy to company) → flip status to sent → post journal entry (real invoice, unless kontantmetoden or defer_invoice_booking) → archive PDF as underlag → emit invoice.sent. Email failure is a hard 502 before state changes; post-email failures surface as warnings but the invoice IS marked sent.

**Use when:** You want Accounted to deliver the invoice to the customer via email. Peppol e-invoices are sent from the invoice page in the dashboard (per-company access grant requested under Inställningar > Fakturering (Settings > Invoicing); aktiebolag senders, standard invoices only, Swedish org-number buyers whose org number is not a personnummer, SEK with taxable Swedish VAT at 6/12/25 % only, no ROT/RUT deductions); a v1 or MCP Peppol send action is not yet available. A successful dashboard Peppol send issues the invoice itself, so do not call :mark-sent after it; only if the dashboard reports that the invoice was sent via Peppol but could not be marked as sent does :mark-sent complete the issuance. For invoices delivered through another channel (an external e-invoice provider, postal, own SMTP) use :mark-sent instead.
**Do not use for:** Re-sending an already-sent invoice (returns 409 INVOICE_UPDATE_NOT_DRAFT). Sending a delivery note (no F-series lifecycle). Sending a credit note (use the :credit endpoint to issue the kreditfaktura; subsequent re-send of the credit note via :mark-sent is the supported path).

**Pitfalls:**
- Idempotency-Key is mandatory.
- Email service must be configured: without RESEND_API_KEY + RESEND_FROM_EMAIL (or an SMTP relay via EMAIL_PROVIDER=smtp) the endpoint returns 503 INVOICE_SEND_EMAIL_NOT_CONFIGURED.
- Customer must have an email address. 400 INVOICE_SEND_NO_CUSTOMER_EMAIL otherwise.
- A cancelled invoice is rejected (400 INVOICE_SEND_CANCELLED): its F-series number is preserved for compliance but the document is not a valid faktura.
- Email failure before the status flip leaves the F-series number consumed but the invoice in `draft` status. Same orphan window as :mark-sent (architecturally tracked, matches internal route).
- After the email succeeds, journal-entry/archive/event failures become warnings on the response; the invoice IS marked sent regardless.
- additional_cc and additional_bcc require the API key user to be an owner or admin of the company.
- The deprecated cc response field contains only the first address. Use cc_addresses for the complete CC list.
- BCC recipients are retained only in the restricted delivery archive and are omitted from normal and dry-run responses.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ additional_cc?: string[], additional_bcc?: string[] }
```

Example request:
```json
{
  "additional_cc": [
    "case-owner@company.test"
  ],
  "additional_bcc": [
    "invoice-archive@company.test"
  ]
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    invoice_number: string,
    status: "sent",
    total: number,
    message_id: string,
    sent_to: string,
    cc: string,
    cc_addresses: string[],
    journal_entry_id: string,
    warnings?: { code: string, message: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "invoice_number": "2026-0042",
    "status": "sent",
    "total": 12500,
    "message_id": "re_abc123",
    "sent_to": "finance@acme.test",
    "cc": "billing@gnubok-user.test",
    "cc_addresses": [
      "billing@gnubok-user.test"
    ],
    "journal_entry_id": "7b3a…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/bulk-create`

**Create up to 50 draft invoices in one call (partial-success).**
`scope:invoices:write · risk:medium · idempotent · dry-run · reversible`

Bulk-creation endpoint. Each invoice in the request array is validated and inserted independently. By default, individual failures do not roll back successes: the response carries a per-item results array with ok/error markers and a summary. Idempotent (the whole batch is keyed by the single Idempotency-Key). Dry-runnable.

**Use when:** You're importing a batch of invoices from another system, or producing many invoices programmatically (e.g. monthly subscription billing). Use dry-run first to validate the whole batch before committing.
**Do not use for:** Sending the same invoice to multiple customers: POST /invoices once per customer. Long-running imports of > 50 invoices: split into pages. Transactional all-or-nothing imports: not yet supported (passing all_or_nothing: true returns 501 NOT_IMPLEMENTED; the flag is reserved for a future RPC).

**Pitfalls:**
- Idempotency-Key is mandatory and covers the WHOLE batch. A retried bulk-create returns the cached full response: it does not retry only the failed items.
- Passing all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist; omit the flag (or pass false).
- Each per-item invoice still goes through the same VAT-rule validation as POST /invoices. A mismatched per-item vat_rate produces a per-item failure, not a whole-batch failure.
- Currency conversion is best-effort PER ITEM. A failed Riksbanken fetch leaves that item's SEK columns null but does NOT fail the item.
- Quotes (document_type: quote) are refused per item as VALIDATION_ERROR: a quote carries its own OF-number, valid_until and quote_status. Create quotes one at a time with POST /invoices.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  invoices: { customer_id: string, invoice_date: string, due_date: string, delivery_date?: string | "", currency: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK", document_type?: "invoice" | "proforma" | "delivery_note" | "quote", valid_until?: string | "", your_reference?: string, our_reference?: string, invoice_marking?: string, notes?: string, payment_link_url?: string | "", payment_link_auto?: boolean, deduction_personnummer?: string, deduction_housing_designation?: string, deduction_apartment_number?: string, deduction_brf_org_number?: string | "", save_as_draft?: boolean, ore_rounding?: boolean, default_dimensions?: Record<string, string>, is_self_billed?: boolean, external_invoice_number?: string | "", self_billing_agreement_ref?: string, received_date?: string | "", items: { line_type?: "product" | "text", description: string, quantity: number, unit: string, unit_price: number, discount_percent?: number, vat_rate?: number, article_id?: string, revenue_account?: string, deduction_type?: "rot" | "rut", labor_hours?: number, work_type?: string, housing_designation?: string, apartment_number?: string, brf_org_number?: string | "", accrual_period_start?: string, accrual_period_end?: string, accrual_balance_account?: string, dimensions?: Record<string, string> }[] }[],
  all_or_nothing?: boolean
}
```

Example request:
```json
{
  "invoices": [
    {
      "customer_id": "a8f1…",
      "invoice_date": "2026-05-12",
      "due_date": "2026-06-11",
      "currency": "SEK",
      "items": [
        {
          "description": "A",
          "quantity": 1,
          "unit": "st",
          "unit_price": 1000
        }
      ]
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    results: { ok: boolean, request_index: number, data?: unknown, error?: { code: string, message: string, details?: unknown } }[],
    summary: { total: number, succeeded: number, failed: number }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "results": [
      {
        "ok": true,
        "request_index": 0,
        "data": {
          "id": "0e9c…",
          "invoice_number": null,
          "status": "draft",
          "total": 1250
        }
      }
    ],
    "summary": {
      "total": 1,
      "succeeded": 1,
      "failed": 0
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
