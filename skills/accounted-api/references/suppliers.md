<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Suppliers (AP) endpoints

Accounts payable: supplier register and received supplier invoices (register -> approve -> mark-paid, or credit).

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/supplier-invoices`

**List supplier invoices for a company.**
`scope:suppliers:read · risk:low · idempotent`

Cursor-paginated supplier-invoice list ordered by created_at DESC, id ASC (newest-registered first; the `invoice_date` column is the seller's invoice date and is filterable via ?date_from / ?date_to but is not the sort key). Filters: status, supplier_id, currency, date_from / date_to (filter by invoice_date).

**Use when:** You need to enumerate registered supplier invoices for an AP dashboard, a payment run, or a leverantörsreskontra reconciliation.
**Do not use for:** Fetching a single supplier invoice: use GET /supplier-invoices/{id}. Listing customer invoices (different resource).

**Pitfalls:**
- Credit notes (is_credit_note=true) appear in the same list as the originals; filter by status=credited or check the flag to separate.
- remaining_amount is the unpaid portion; a partially_paid SI has remaining_amount > 0.
- arrival_number is internal book-keeping, not the seller's invoice number: use supplier_invoice_number for matching to received documents.
- Ordering is by created_at (registration time), not invoice_date. A late-registered invoice appears where it was registered: filter on ?date_from / ?date_to when you care about the seller's invoice date.
- Cursor pagination: pass ?cursor=<next_cursor> from the previous response. A stale or tampered cursor is ignored and the first page is returned again.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, supplier_id: string, supplier_name: string, arrival_number: number, supplier_invoice_number: string, invoice_date: string, due_date: string, status: "registered" | "approved" | "paid" | "partially_paid" | "overdue" | "disputed" | "credited" | "reversed", currency: string, subtotal: number, vat_amount: number, total: number, paid_amount: number, remaining_amount: number, is_credit_note: boolean, paid_at: string, created_at: string }[],
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": [
    {
      "id": "0e9c…",
      "supplier_id": "a8f1…",
      "supplier_name": "Office Depot AB",
      "arrival_number": 42,
      "supplier_invoice_number": "2026-1234",
      "invoice_date": "2026-05-10",
      "due_date": "2026-06-09",
      "status": "registered",
      "currency": "SEK",
      "subtotal": 1000,
      "vat_amount": 250,
      "total": 1250,
      "paid_amount": 0,
      "remaining_amount": 1250,
      "is_credit_note": false,
      "paid_at": null,
      "created_at": "2026-05-13T15:00:00Z"
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

### `POST /api/v1/companies/{companyId}/supplier-invoices`

**Register a new supplier invoice.**
`scope:suppliers:write · risk:medium · idempotent · dry-run · reversible`

Creates a supplier invoice in `registered` status and posts the registration journal entry under faktureringsmetoden (Debit expense + Debit 2641 Ingående moms / Credit 2440 Leverantörsskulder). Under kontantmetoden no JE is posted at this stage. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** You're registering an incoming leverantörsfaktura. Use dry-run first to validate VAT calculations + period-lock state before committing.
**Do not use for:** Marking an existing SI as paid (use POST /:id/mark-paid). Issuing a credit note (use POST /:id/credit). Customer invoices (different resource).

**Pitfalls:**
- Idempotency-Key is mandatory.
- invoice_date must fall within an open fiscal period: a date covered by a locked period or the company-wide bookkeeping lock returns 400 PERIOD_LOCKED.
- Under faktureringsmetoden the registration JE is posted atomically with the SI row. JE failure aborts the whole call and no SI row is left behind (strict-mode).
- supplier_id must reference an existing, non-archived supplier in the same company: 404 SUPPLIER_NOT_FOUND otherwise.
- Duplicate (supplier_id, supplier_invoice_number) returns 409 SI_CREATE_DUPLICATE_INVOICE_NUMBER. Use the credit flow on the original instead of re-registering with a tweaked number.
- Foreign currency: omit exchange_rate and the server fetches Riksbanken's rate for invoice_date (ML 8 kap 21-23 §). If no rate can be resolved the create is refused with 400 SI_FX_RATE_MISSING rather than stored unconverted: pass exchange_rate explicitly to proceed. A SEK invoice needs no rate and gets total_sek = total.
- exchange_rate is SEK per 1 unit of the invoice currency and must satisfy 0 < rate < 100000, the same bounds the supplier_invoices CHECK enforces. Out-of-range values return 400 VALIDATION_ERROR; passing an invoice total where a rate belongs is the usual cause.
- Project/cost-center tagging: pass default_dimensions ({"6":"P001"} = project, {"1":"KS01"} = kostnadsställe) for the whole invoice and/or items[].dimensions per line (per-line wins per key). The registration JE lines are tagged accordingly. When the company has the dimension registry enabled, unknown or archived codes are rejected with 400 DIMENSION_VALIDATION_FAILED — list valid codes via GET /dimensions.
- Tjänstepension invoices (Avanza etc.): set items[].apply_slp=true on the 741x premium line and the registration JE also books särskild löneskatt (debit 7533 / credit 2514 at 24.26% of the line amount) beyond the payable: 2440 stays at the invoice total. apply_slp on a non-741x account returns 400 SI_CREATE_SLP_INVALID_ACCOUNT.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  supplier_id: string,
  document_id?: string,
  supplier_invoice_number: string,
  invoice_date: string,
  due_date: string,
  delivery_date?: string | "",
  currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK",
  exchange_rate?: number,
  vat_treatment?: "standard_25" | "reduced_12" | "reduced_6" | "reverse_charge" | "export" | "exempt",
  reverse_charge?: boolean,
  payment_reference?: string,
  notes?: string,
  ore_rounding?: boolean,
  paid_with_private_funds?: boolean,
  payment_date?: string,
  default_dimensions?: Record<string, string>,
  items: { description: string, amount?: number, account_number: string, vat_rate?: 0 | 0.06 | 0.12 | 0.25, vat_amount?: number, reverse_charge_rate?: number, apply_slp?: boolean, vat_code?: string, quantity?: number, unit?: string, unit_price?: number, accrual_period_start?: string, accrual_period_end?: string, accrual_balance_account?: string, dimensions?: Record<string, string> }[]
}
```

Example request:
```json
{
  "supplier_id": "a8f1…",
  "supplier_invoice_number": "2026-1234",
  "invoice_date": "2026-05-10",
  "due_date": "2026-06-09",
  "default_dimensions": {
    "6": "P001"
  },
  "items": [
    {
      "description": "Office supplies",
      "amount": 1000,
      "account_number": "5410",
      "vat_rate": 0.25
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    supplier_id: string,
    arrival_number: number,
    supplier_invoice_number: string,
    invoice_date: string,
    due_date: string,
    status: string,
    currency: string,
    subtotal: number,
    vat_amount: number,
    total: number,
    remaining_amount: number,
    is_credit_note: boolean,
    registration_journal_entry_id: string,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "supplier_id": "a8f1…",
    "arrival_number": 42,
    "supplier_invoice_number": "2026-1234",
    "status": "registered",
    "total": 1250,
    "registration_journal_entry_id": "7b3a…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/supplier-invoices/{id}`

**Retrieve a single supplier invoice by id.**
`scope:suppliers:read · risk:low · idempotent`

Returns the full supplier-invoice record. Pass ?expand=supplier,items,payments to embed the related rows in the same response.

**Use when:** You need the full record before approving, paying, or crediting it, or for audit trail / reconciliation.
**Do not use for:** Listing supplier invoices (use the list endpoint). Customer-invoice lookups (different resource).

**Pitfalls:**
- Credit notes return is_credit_note=true and a credited_invoice_id pointing at the original.
- registration_journal_entry_id and payment_journal_entry_id let you trace the SI to its bokföring rows; they are null when no JE has been posted (e.g. on a kontantmetoden SI before payment).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    supplier_id: string,
    arrival_number: number,
    supplier_invoice_number: string,
    invoice_date: string,
    due_date: string,
    received_date: string,
    delivery_date: string,
    status: string,
    currency: string,
    exchange_rate: number,
    subtotal: number,
    vat_amount: number,
    total: number,
    vat_treatment: string,
    reverse_charge: boolean,
    paid_amount: number,
    remaining_amount: number,
    is_credit_note: boolean,
    credited_invoice_id: string,
    registration_journal_entry_id: string,
    payment_journal_entry_id: string,
    notes: string,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "supplier_id": "a8f1…",
    "arrival_number": 42,
    "supplier_invoice_number": "2026-1234",
    "status": "registered",
    "currency": "SEK",
    "subtotal": 1000,
    "vat_amount": 250,
    "total": 1250,
    "remaining_amount": 1250,
    "is_credit_note": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/supplier-invoices/{id}`

**Update a registered supplier invoice.**
`scope:suppliers:write · risk:low · idempotent · dry-run · reversible`

Patches a supplier invoice with the supplied fields. Only allowed on `registered` status: once approved, paid, or credited, the record is effectively immutable from the API's perspective. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** You need to adjust due_date, or attach a payment reference / notes to a registered SI before approval. Use dry-run to confirm the merged state first.
**Do not use for:** Editing line items (immutable: credit the SI and register a new one). Changing status (use action verbs). Approved/paid/credited SIs (returns 400 SI_NOT_DRAFT). invoice_date / supplier_invoice_number on an SI that already has a registration verifikat (returns 400 SI_EDIT_VERIFIKAT_LOCKED).

**Pitfalls:**
- Returns 400 SI_NOT_DRAFT when current status !== "registered".
- invoice_date and supplier_invoice_number are on the posted registration verifikat (entry_date and description). Once registration_journal_entry_id is set, patching them returns 400 SI_EDIT_VERIFIKAT_LOCKED: correct the entry via a rättelse (gnubok_correct_entry) or credit the SI and re-register. Resending the unchanged value is accepted.
- Patching a field never re-posts the registration JE.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  supplier_invoice_number?: string,
  invoice_date?: string,
  due_date?: string,
  delivery_date?: string | "",
  payment_reference?: string,
  notes?: string
}
```

Example request:
```json
{
  "payment_reference": "OCR-1234567890"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    supplier_id: string,
    arrival_number: number,
    supplier_invoice_number: string,
    invoice_date: string,
    due_date: string,
    received_date: string,
    delivery_date: string,
    status: string,
    currency: string,
    exchange_rate: number,
    subtotal: number,
    vat_amount: number,
    total: number,
    vat_treatment: string,
    reverse_charge: boolean,
    paid_amount: number,
    remaining_amount: number,
    is_credit_note: boolean,
    credited_invoice_id: string,
    registration_journal_entry_id: string,
    payment_journal_entry_id: string,
    notes: string,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "payment_reference": "OCR-1234567890"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/supplier-invoices/{id}/approve`

**Approve a registered or overdue supplier invoice.**
`scope:suppliers:write · risk:low · idempotent · dry-run`

Attests a supplier invoice that has not been approved yet (status `registered` or `overdue`). The resulting status is `approved`, or `overdue` when the invoice is still past its due date. No journal entry is posted here: the registration JE was already booked at :create under accrual, or is deferred to :mark-paid under cash. Idempotent. Dry-runnable.

**Use when:** A registered SI has been reviewed and you want to mark it ready for payment. Many AP workflows gate :mark-paid behind an explicit approval step.
**Do not use for:** Posting a journal entry (already done at :create under accrual). Paying the SI (use :mark-paid). Re-approving an already-approved SI (returns 400 SI_APPROVE_NOT_REGISTERED).

**Pitfalls:**
- Idempotency-Key is mandatory.
- Returns 400 SI_APPROVE_NOT_REGISTERED when the invoice is already approved (approved_at set) or sits in a settled status. Use the detail endpoint to inspect status first if unsure.
- A still-past-due invoice comes back with status "overdue", not "approved": approved_at is the attest marker, the status is derived from the due date.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    status: "approved" | "overdue",
    arrival_number: number,
    supplier_invoice_number: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "status": "approved",
    "arrival_number": 42,
    "supplier_invoice_number": "2026-1234"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/supplier-invoices/{id}/credit`

**Issue a credit note for a supplier invoice.**
`scope:suppliers:write · risk:high · idempotent · dry-run`

Creates a kreditfaktura that reverses the original supplier invoice. Under accrual the reversing JE is posted atomically (Debit 2440 / Credit expense + Credit 2641). The original status flips to `credited`. Strict-mode: any failure rolls back the credit-note row. Idempotent. Dry-runnable.

**Use when:** You need to nullify a registered, approved, partially_paid, or paid supplier invoice: for a returned shipment, an over-invoice, or a vendor dispute resolution. Use dry-run to confirm the totals first.
**Do not use for:** Editing line items on an unchanged invoice (use PATCH on `registered` SIs). Crediting an already-credited SI (returns 409 SI_CREDIT_ALREADY_CREDITED). Reversing a v1-issued credit (no v1 endpoint today: use the dashboard).

**Pitfalls:**
- Idempotency-Key is mandatory.
- Today's date is used as the credit-note invoice_date. It must fall in an open fiscal period: locked period returns 400 SI_CREDIT_PERIOD_LOCKED.
- Cash basis (kontantmetoden): no reversing JE is posted: recognition is deferred until a refund transaction is booked. The credit-note row is still created so the AP audit trail stays consistent.
- The original SI is flipped to `credited` regardless of how much of it was already paid; reconcile the bank refund via the transactions endpoints.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    credit_note_id: string,
    original_id: string,
    arrival_number: number,
    supplier_invoice_number: string,
    registration_journal_entry_id: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "credit_note_id": "4d2a…",
    "original_id": "0e9c…",
    "arrival_number": 43,
    "supplier_invoice_number": "KREDIT-2026-1234",
    "registration_journal_entry_id": "9c2f…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/supplier-invoices/{id}/mark-paid`

**Record a payment against a supplier invoice.**
`scope:suppliers:write · risk:medium · idempotent · dry-run`

Books the payment journal entry (Debit 2440 / Credit 1930 under accrual; or Debit expense + Debit 2641 / Credit 1930 under cash) and flips the SI status to `paid` (full settlement) or `partially_paid`. Strict-mode: a JE failure aborts before any SI mutation. Idempotent. Dry-runnable.

**Use when:** You paid a registered or approved leverantörsfaktura through a channel other than the synced bank flow. For bank-matched payments use POST /transactions/{id}/match-supplier-invoice instead: that path also reconciles the bank line.
**Do not use for:** Refunding a payment (the public API does not expose unmark-paid; credit the SI instead). Paying a credited or already-paid SI (returns 409 SI_PAID_ALREADY).

**Pitfalls:**
- Idempotency-Key is mandatory.
- payment_date must fall in an open fiscal period: locked period returns 400 PERIOD_LOCKED.
- exchange_rate_difference (SEK delta vs the booked rate at registration) is required for foreign-currency SIs to book the FX gain/loss to 3960 / 7960. Omitting it on a non-SEK SI under accrual mis-books FX.
- Strict-mode: a JE creation failure ABORTS before the status flip. There is no partial-state recovery banner: retry the call.
- Cash basis (kontantmetoden) recognizes the expense + ingående moms HERE, not at :create.
- Duplicate-payment guard: on a full settlement, if a business bank transaction of the same amount around payment_date carries the supplier name (first distinctive token, so abbreviated bank text such as "HI3G" for Hi3G Access AB counts), returns 409 SI_PAID_LIKELY_DUPLICATE with candidate transactions. A candidate with match_reason `already_booked` is a bank row that is ALREADY a verifikat: do not pay the invoice, correct the double booking instead. Retry with `force: true` only after the user confirms, and with a fresh Idempotency-Key (the original is body-hash bound). Also evaluated under dry-run.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  amount?: number,
  payment_date?: string,
  exchange_rate_difference?: number,
  notes?: string,
  force?: boolean,
  payment_account?: string,
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, dimensions?: Record<string, string> }[]
}
```

Example request:
```json
{
  "payment_date": "2026-05-13"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    status: "paid" | "partially_paid",
    total: number,
    paid_amount: number,
    remaining_amount: number,
    paid_at: string,
    payment_journal_entry_id: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "status": "paid",
    "total": 1250,
    "paid_amount": 1250,
    "remaining_amount": 0,
    "paid_at": "2026-05-13",
    "payment_journal_entry_id": "7b3a…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/suppliers`

**List suppliers for a company.**
`scope:suppliers:read · risk:low · idempotent`

Returns active suppliers in created-first order. Pass ?include_archived=true to include archived rows. Use ?search to match against name or org_number.

**Use when:** You need a supplier roster: for building a UI picker, resolving a supplier_id before registering a supplier invoice, or syncing an external AP system.
**Do not use for:** Fetching a single supplier you already know the id of: use GET /api/v1/companies/{companyId}/suppliers/{id}. Customers are a separate resource.

**Pitfalls:**
- Archived suppliers are hidden by default; the dashboard makes the same choice.
- org_number identifies legal entities only: suppliers currently have no `individual` type, so the field is Bolagsverket public-record data when present.
- vat_number is stored as supplied; unlike customers, suppliers are not auto-validated against VIES on create. Validate externally if the integration requires it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, name: string, supplier_type: "swedish_business" | "eu_business" | "non_eu_business", email: string, org_number: string, vat_number: string, default_payment_terms: number, default_currency: string, party_id?: string, archived_at: string, created_at: string }[],
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": [
    {
      "id": "a8f1…",
      "name": "Office Depot AB",
      "supplier_type": "swedish_business",
      "email": "invoices@officedepot.example",
      "org_number": "556677-8899",
      "vat_number": "SE556677889901",
      "default_payment_terms": 30,
      "default_currency": "SEK",
      "archived_at": null,
      "created_at": "2026-04-12T08:30:00Z"
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

### `POST /api/v1/companies/{companyId}/suppliers`

**Create a supplier.**
`scope:suppliers:write · risk:low · idempotent · dry-run · reversible`

Creates a new supplier for the company. Requires Idempotency-Key (UUID). Supports ?dry_run=true for input validation without committing: the dry-run response shows the would-be record minus id and timestamps.

**Use when:** You need to register a new supplier before booking supplier invoices against them. Use dry-run first to catch validation errors before committing.
**Do not use for:** Updating an existing supplier (PATCH instead). Creating customers (different resource).

**Pitfalls:**
- Idempotency-Key is mandatory: calls without it return 400 VALIDATION_ERROR.
- org_number uniqueness is enforced at the database level; duplicate inserts return 409 SUPPLIER_DUPLICATE_ORG_NUMBER.
- Unlike customers, suppliers carry no `vat_number_validated` flag: vat_number is stored as supplied without VIES verification. Validate externally if your workflow requires it.
- default_expense_account is a BAS account number (e.g. "5410"); the value is stored as-is and used as the suggested debit account when supplier invoices are booked.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  name: string,
  supplier_type: "swedish_business" | "eu_business" | "non_eu_business",
  email?: string,
  phone?: string,
  address_line1?: string,
  address_line2?: string,
  postal_code?: string,
  city?: string,
  country?: string,
  org_number?: string,
  vat_number?: string,
  bankgiro?: string,
  plusgiro?: string,
  bank_account?: string,
  iban?: string,
  bic?: string,
  clearing_number?: string,
  account_number?: string,
  default_expense_account?: string,
  default_payment_terms?: number,
  default_currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK",
  notes?: string
}
```

Example request:
```json
{
  "name": "Office Depot AB",
  "supplier_type": "swedish_business",
  "email": "invoices@officedepot.example",
  "org_number": "556677-8899",
  "bankgiro": "123-4567",
  "default_expense_account": "5410",
  "default_payment_terms": 30,
  "default_currency": "SEK"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    supplier_type: "swedish_business" | "eu_business" | "non_eu_business",
    email: string,
    phone: string,
    address_line1: string,
    address_line2: string,
    postal_code: string,
    city: string,
    country: string,
    org_number: string,
    vat_number: string,
    bankgiro: string,
    plusgiro: string,
    bank_account: string,
    iban: string,
    bic: string,
    default_expense_account: string,
    default_payment_terms: number,
    default_currency: string,
    notes: string,
    archived_at: string,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "name": "Office Depot AB",
    "supplier_type": "swedish_business",
    "email": "invoices@officedepot.example",
    "org_number": "556677-8899",
    "bankgiro": "123-4567",
    "default_expense_account": "5410",
    "default_payment_terms": 30,
    "default_currency": "SEK",
    "archived_at": null,
    "created_at": "2026-05-13T15:00:00Z",
    "updated_at": "2026-05-13T15:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/suppliers/{id}`

**Retrieve a single supplier by id.**
`scope:suppliers:read · risk:low · idempotent`

Returns the full supplier record. Pass ?expand=supplier_invoices to embed any open supplier invoices (registered / approved / partially_paid / overdue / disputed) for the supplier in the same response. Pass ?expand=party to embed the party (motpart) behind the supplier: legal name, org and VAT number, country, the SCB company-register summary (status, legal form, industry, seat, size, registrations, contact details, fetched date) and what the ledger has seen for it.

**Use when:** You need the full supplier record: address, payment terms, banking details, default expense account: before booking a supplier invoice or syncing to an external AP system.
**Do not use for:** Listing suppliers (use the list endpoint). Looking up customer or employee records (different resources).

**Pitfalls:**
- archived_at is non-null when the supplier has been soft-deleted; the supplier is still queryable by id but excluded from default lists.
- Banking fields (bankgiro / plusgiro / iban / bic) are stored as supplied; no Luhn or IBAN check is performed at this layer.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    supplier_type: string,
    email: string,
    phone: string,
    address_line1: string,
    address_line2: string,
    postal_code: string,
    city: string,
    country: string,
    org_number: string,
    vat_number: string,
    bankgiro: string,
    plusgiro: string,
    bank_account: string,
    iban: string,
    bic: string,
    default_expense_account: string,
    default_payment_terms: number,
    default_currency: string,
    notes: string,
    party_id: string,
    party?: { id: string, display_name: string, legal_name: string, org_number: string, vat_number: string, country: string, kind: string, status: "confirmed" | "suggested", roles: { supplier_id: string, customer_id: string }, registry: { legal_name: string, legal_form: string, status: { label: string, active: boolean }, warning: string, registrations: { f_tax: boolean, vat: boolean, employer: boolean }, industry: { code: string, label: string }, seat: string, registered_at: string, active_since: string, active_until: string, employees_band: string, turnover: { band: string, year: string }, workplaces: number, contact: { email: string, phone: string, address: { co: string, street: string, postal_code: string, city: string } }, vat_number: string, fetched_at: string }, ledger: { occurrences: number, expense_sek: number, revenue_sek: number, first_seen: string, last_seen: string, dominant_account: string }, identities: { scheme: string, value: string, status: string, seen_count: number }[] },
    archived_at: string,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "a8f1…",
    "name": "Office Depot AB",
    "supplier_type": "swedish_business",
    "email": "invoices@officedepot.example",
    "org_number": "556677-8899",
    "bankgiro": "123-4567",
    "default_expense_account": "5410",
    "default_payment_terms": 30,
    "default_currency": "SEK",
    "archived_at": null,
    "created_at": "2026-04-12T08:30:00Z",
    "updated_at": "2026-04-30T11:22:09Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/suppliers/{id}`

**Partially update a supplier.**
`scope:suppliers:write · risk:low · idempotent · dry-run · reversible`

Patches the supplier with the supplied fields. All fields optional. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** You need to change a supplier's contact details, payment terms, banking info, default expense account, or VAT number. Use dry-run first to confirm the merged record before committing.
**Do not use for:** Archiving a supplier (use DELETE: sets archived_at). Replacing the entire record (no PUT verb is exposed; PATCH is partial).

**Pitfalls:**
- Idempotency-Key is mandatory; calls without it return 400.
- org_number uniqueness is enforced at DB level: 23505 → 409 SUPPLIER_DUPLICATE_ORG_NUMBER.
- Changing default_expense_account does not retroactively rebook prior supplier invoices: only future bookings pick up the new default.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  name?: string,
  supplier_type?: "swedish_business" | "eu_business" | "non_eu_business",
  email?: string,
  phone?: string,
  address_line1?: string,
  address_line2?: string,
  postal_code?: string,
  city?: string,
  country?: string,
  org_number?: string,
  vat_number?: string,
  bankgiro?: string,
  plusgiro?: string,
  bank_account?: string,
  iban?: string,
  bic?: string,
  clearing_number?: string,
  account_number?: string,
  default_expense_account?: string,
  default_payment_terms?: number,
  default_currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK",
  notes?: string
}
```

Example request:
```json
{
  "default_payment_terms": 14,
  "notes": "New payment terms agreed 2026-05-12."
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    supplier_type: string,
    email: string,
    phone: string,
    address_line1: string,
    address_line2: string,
    postal_code: string,
    city: string,
    country: string,
    org_number: string,
    vat_number: string,
    bankgiro: string,
    plusgiro: string,
    bank_account: string,
    iban: string,
    bic: string,
    default_expense_account: string,
    default_payment_terms: number,
    default_currency: string,
    notes: string,
    party_id: string,
    party?: { id: string, display_name: string, legal_name: string, org_number: string, vat_number: string, country: string, kind: string, status: "confirmed" | "suggested", roles: { supplier_id: string, customer_id: string }, registry: { legal_name: string, legal_form: string, status: { label: string, active: boolean }, warning: string, registrations: { f_tax: boolean, vat: boolean, employer: boolean }, industry: { code: string, label: string }, seat: string, registered_at: string, active_since: string, active_until: string, employees_band: string, turnover: { band: string, year: string }, workplaces: number, contact: { email: string, phone: string, address: { co: string, street: string, postal_code: string, city: string } }, vat_number: string, fetched_at: string }, ledger: { occurrences: number, expense_sek: number, revenue_sek: number, first_seen: string, last_seen: string, dominant_account: string }, identities: { scheme: string, value: string, status: string, seen_count: number }[] },
    archived_at: string,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "name": "Office Depot AB",
    "default_payment_terms": 14,
    "notes": "New payment terms agreed 2026-05-12."
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/suppliers/{id}`

**Archive a supplier (soft-delete).**
`scope:suppliers:write · risk:medium · idempotent · dry-run · reversible`

Sets archived_at on the supplier; the record is preserved (supplier invoices and audit history remain intact) but excluded from default list responses. To un-archive, PATCH archived_at back to null. Idempotent: archiving an already-archived supplier is a no-op. Dry-runnable.

**Use when:** You want to remove a supplier from active rosters without losing their history. Idempotent: re-archiving is safe.
**Do not use for:** Permanently deleting a supplier with all history: the public API does not expose hard-delete. GDPR erasure requests go through a dedicated workflow.

**Pitfalls:**
- Idempotency-Key is mandatory.
- A supplier with any open supplier invoice (registered / approved / partially_paid / overdue / disputed) cannot be archived: returns 409 SUPPLIER_HAS_INVOICES. Close the invoices first. This protects BFL 7 kap audit: the supplier record is the canonical source of seller name/address for invoice reissuance.
- 204 No Content is returned on success: there is no response body to parse.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `204`.

---

### `POST /api/v1/companies/{companyId}/suppliers/bulk-create`

**Create up to 50 suppliers in one call (partial-success).**
`scope:suppliers:write · risk:low · idempotent · dry-run · reversible`

Bulk-create endpoint mirroring /customers/bulk-create. Each supplier is validated and inserted independently: per-item failures do not roll back items that succeeded. Returns a results array plus a summary. Idempotent over the whole batch. Dry-runnable.

**Use when:** You're importing a roster of suppliers from another AP system, or seeding a fresh company with its existing vendor list. Use dry-run first to validate the batch.
**Do not use for:** Updating existing suppliers: PATCH /suppliers/{id} once per supplier. Bulk uploads of > 50 suppliers: split into pages of 50. Transactional all-or-nothing imports: passing all_or_nothing: true returns 501 NOT_IMPLEMENTED.

**Pitfalls:**
- Idempotency-Key is mandatory and covers the WHOLE batch. A retried bulk-create returns the cached full response: it does not retry only the failed items.
- Passing all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist; omit the flag or pass false.
- org_number uniqueness is enforced at the DB level: items with duplicates fail individually with SUPPLIER_DUPLICATE_ORG_NUMBER.
- No VIES validation runs per item; vat_number is stored as supplied. Validate externally if your workflow requires it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  suppliers: { name: string, supplier_type: "swedish_business" | "eu_business" | "non_eu_business", email?: string, phone?: string, address_line1?: string, address_line2?: string, postal_code?: string, city?: string, country?: string, org_number?: string, vat_number?: string, bankgiro?: string, plusgiro?: string, bank_account?: string, iban?: string, bic?: string, clearing_number?: string, account_number?: string, default_expense_account?: string, default_payment_terms?: number, default_currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK", notes?: string }[],
  all_or_nothing?: boolean
}
```

Example request:
```json
{
  "suppliers": [
    {
      "name": "Office Depot AB",
      "supplier_type": "swedish_business",
      "org_number": "556677-8899"
    },
    {
      "name": "Cloud Hosting GmbH",
      "supplier_type": "eu_business",
      "vat_number": "DE123456789"
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
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
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
          "name": "Office Depot AB"
        }
      },
      {
        "ok": true,
        "request_index": 1,
        "data": {
          "id": "4d2a…",
          "name": "Cloud Hosting GmbH"
        }
      }
    ],
    "summary": {
      "total": 2,
      "succeeded": 2,
      "failed": 0
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
