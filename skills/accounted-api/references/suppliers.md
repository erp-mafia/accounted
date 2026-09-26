<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Suppliers (AP) endpoints

Accounts payable: supplier register, received supplier invoices (register -> approve -> book if deferred -> pay via a supplier payment file or mark-paid, or credit), and expense claims (utlägg) with their payouts.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/expense-claims`

**List expense claims (utlägg): what the company owes owners and employees for private purchases.**
`scope:suppliers:read · risk:low · idempotent`

Returns the utlägg register newest first: each claim's claimant, SEK amount, VAT, cost and liability account, status (registered = still owed, paid = repaid) and the verifikat that booked it. Filter by status or employee_id. Cursor pagination: pass next_cursor back as cursor; next_cursor is null on the last page.

**Use when:** You need the open claims before paying someone back or matching a bank transfer, or you are reconciling 2893/2820/2890 against who is owed what.
**Do not use for:** Supplier invoices (GET /supplier-invoices) or salary (the payroll endpoints); an utlägg put on a payslip is still listed here as registered until the salary run is booked.

**Pitfalls:**
- amount_sek is gross incl. VAT: the amount owed, not the cost.
- A claim on 2018 (enskild firma owner) is an egen insättning, not a debt; it is listed but is not normally paid back.
- The page is in data.expense_claims with data.next_cursor; a cursor that no longer decodes starts from the first page.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"registered" \| "paid"` | no | registered = still owed, paid = repaid. |
| `employee_id` | query | `string` | no | Only this employee's claims. |
| `cursor` | query | `string` | no | next_cursor from the previous page. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). |

Response `200`:
```ts
{
  data: {
    expense_claims: { expense_claim_id: string, employee_id: string | null, claimant_name: string, description: string, expense_date: string, amount_sek: number, vat_sek: number, currency: string, amount_in_currency: number | null, exchange_rate: number | null, expense_account: string, liability_account: string, document_id: string | null, status: "registered" | "paid", journal_entry_id: string | null, payout_batch_id: string | null, created_at: string }[],
    next_cursor: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "expense_claims": [
      {
        "expense_claim_id": "5a0a…",
        "employee_id": null,
        "claimant_name": "Anna Svensson",
        "description": "USB-hubb",
        "expense_date": "2026-09-01",
        "amount_sek": 500,
        "vat_sek": 100,
        "currency": "SEK",
        "amount_in_currency": null,
        "exchange_rate": null,
        "expense_account": "5410",
        "liability_account": "2893",
        "document_id": null,
        "status": "registered",
        "journal_entry_id": "9c1e…",
        "payout_batch_id": null,
        "created_at": "2026-09-01T09:12:00Z"
      }
    ],
    "next_cursor": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/expense-claims`

**Register an expense claim (utlägg) and post its verifikat.**
`scope:suppliers:write · risk:medium · idempotent · dry-run · reversible`

Books a business cost someone paid privately: Debit the cost account (net), Debit 2641 (vat_amount), Credit the person's liability account (gross), in one verifikat posted immediately. The liability account follows the claimant: employee_id books 2820; otherwise the owner's account for the legal form (2893 aktiebolag, 2018 enskild firma as egen insättning, 2890 förening member) with claimant_name. Foreign currency converts at exchange_rate or Riksbanken's rate for expense_date. lines replaces the generated rows (reverse charge, templates) and must credit the liability account with exactly amount. document_id attaches the receipt to the verifikat; inbox_item_id marks the inbox item booked. Idempotent. Dry-runnable.

**Use when:** A receipt was paid with a private card or cash: the answer to "Vem betalade?" is the owner or an employee, not the company account.
**Do not use for:** A purchase the company paid itself (categorize the bank transaction or register a supplier invoice), an unpaid supplier invoice (POST /supplier-invoices) or mileage (körjournal).

**Pitfalls:**
- amount is gross incl. VAT and vat_amount must be below it; foreign VAT is not deductible on 2641, so send vat_amount 0 for a foreign receipt.
- The verifikat is posted at once and is immutable: undo it with DELETE /expense-claims/{id}, which posts a storno.
- employee_id wins over claimant_name: the employee's own name is stored.
- A date in a locked period or behind the company lock date returns 400 PERIOD_LOCKED; no open fiscal year returns EXPENSE_CLAIM_NO_FISCAL_PERIOD.
- expense_account is a STRING in class 4-8 ("5410"), never a number.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  description: string,
  expense_date: string,
  amount: number,
  vat_amount?: number,
  currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF",
  exchange_rate?: number,
  expense_account: string,
  employee_id?: string | null,
  claimant_name?: string,
  document_id?: string | null,
  inbox_item_id?: string | null,
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string | null }[]
}
```

Example request:
```json
{
  "description": "USB-hubb",
  "expense_date": "2026-09-01",
  "amount": 500,
  "vat_amount": 100,
  "expense_account": "5410",
  "claimant_name": "Anna Svensson"
}
```

Response `200`:
```ts
{
  data: {
    expense_claim_id: string,
    employee_id: string | null,
    claimant_name: string,
    description: string,
    expense_date: string,
    amount_sek: number,
    vat_sek: number,
    currency: string,
    amount_in_currency: number | null,
    exchange_rate: number | null,
    expense_account: string,
    liability_account: string,
    document_id: string | null,
    status: "registered" | "paid",
    journal_entry_id: string | null,
    payout_batch_id: string | null,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "expense_claim_id": "5a0a…",
    "employee_id": null,
    "claimant_name": "Anna Svensson",
    "description": "USB-hubb",
    "expense_date": "2026-09-01",
    "amount_sek": 500,
    "vat_sek": 100,
    "currency": "SEK",
    "amount_in_currency": null,
    "exchange_rate": null,
    "expense_account": "5410",
    "liability_account": "2893",
    "document_id": null,
    "status": "registered",
    "journal_entry_id": "9c1e…",
    "payout_batch_id": null,
    "created_at": "2026-09-01T09:12:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/expense-claims/{id}`

**Read one expense claim (utlägg).**
`scope:suppliers:read · risk:low · idempotent`

Returns one claim: who is owed, the SEK amount and VAT, the cost and liability accounts, its status and the verifikat that booked it (journal_entry_id) and, once paid, the payout batch.

**Use when:** You hold an expense_claim_id (from the list or a create) and need its current status.
**Do not use for:** Finding claims: list them with GET /expense-claims?status=registered.

**Pitfalls:**
- An id from another company answers 404 EXPENSE_CLAIM_NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    expense_claim_id: string,
    employee_id: string | null,
    claimant_name: string,
    description: string,
    expense_date: string,
    amount_sek: number,
    vat_sek: number,
    currency: string,
    amount_in_currency: number | null,
    exchange_rate: number | null,
    expense_account: string,
    liability_account: string,
    document_id: string | null,
    status: "registered" | "paid",
    journal_entry_id: string | null,
    payout_batch_id: string | null,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "expense_claim_id": "5a0a…",
    "employee_id": null,
    "claimant_name": "Anna Svensson",
    "description": "USB-hubb",
    "expense_date": "2026-09-01",
    "amount_sek": 500,
    "vat_sek": 100,
    "currency": "SEK",
    "amount_in_currency": null,
    "exchange_rate": null,
    "expense_account": "5410",
    "liability_account": "2893",
    "document_id": null,
    "status": "registered",
    "journal_entry_id": "9c1e…",
    "payout_batch_id": null,
    "created_at": "2026-09-01T09:12:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/expense-claims/{id}`

**Delete a registered expense claim; its verifikat is reversed by storno, never deleted.**
`scope:suppliers:write · risk:medium · idempotent · dry-run`

Removes an unpaid claim from the register. The verifikat that booked it stays (BFL 5 kap 5 §): a storno verifikat reverses it and the receipt stays on the original. A claim scheduled on a draft payslip has that line removed first. Paid claims and claims on a payslip past draft are refused. Answers reversal_entry_id (null when the original verifikat no longer exists). Idempotent. Dry-runnable.

**Use when:** A claim was registered by mistake (wrong person, duplicate receipt) and has not been paid back.
**Do not use for:** Correcting an amount or account on a booked claim (delete and register again, or correct the verifikat), or undoing a payout.

**Pitfalls:**
- A paid claim returns 409 EXPENSE_CLAIM_ALREADY_PAID; a claim on a payslip past draft returns 409 EXPENSE_CLAIM_ON_PAYSLIP.
- The storno is a new verifikat with its own number: the original number is never freed.
- A locked period for the storno date surfaces as PERIOD_LOCKED from the engine.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { deleted: true, expense_claim_id: string, reversal_entry_id: string | null },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "deleted": true,
    "expense_claim_id": "5a0a…",
    "reversal_entry_id": "b7d2…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/expense-claims/payouts`

**Record that the company paid a person back for their expense claims.**
`scope:suppliers:write · risk:medium · idempotent · dry-run`

Books one repayment of N registered claims of ONE person: Debit the liability account (2013 eget uttag for an enskild firma owner's 2018), Credit cash_account (19xx), for the claims' total, and marks them paid, all in one transaction that locks the claims. No money moves: this records a transfer made outside Accounted. Idempotent. Dry-runnable.

**Use when:** The person was paid back from an account without a bank feed, or the transfer cannot be matched to a bank row.
**Do not use for:** A repayment that is a bank transaction in Accounted: match it (POST /transactions/{id}/match-expense-payout), or the row gets booked twice. Repayment through salary is the payroll flow.

**Pitfalls:**
- All claims must belong to one person and one liability account (400 EXPENSE_PAYOUT_MIXED_CLAIMANTS / MIXED_LIABILITY).
- A paid claim returns 409 EXPENSE_PAYOUT_ALREADY_PAID; one on a payslip returns 409 EXPENSE_PAYOUT_ON_PAYSLIP.
- cash_account is a STRING 19xx ("1930") that must be active in the chart.
- Partial payouts are not supported: pay whole claims.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ claim_ids: string[], payout_date: string, cash_account: string, notes?: string }
```

Example request:
```json
{
  "claim_ids": [
    "5a0a…"
  ],
  "payout_date": "2026-09-05",
  "cash_account": "1930"
}
```

Response `200`:
```ts
{
  data: {
    batch_id: string,
    journal_entry_id: string,
    voucher_number: number | null,
    total_sek: number,
    claim_count: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "batch_id": "e1f0…",
    "journal_entry_id": "4d2a…",
    "voucher_number": 118,
    "total_sek": 500,
    "claim_count": 1
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

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
| `status` | query | `"registered" \| "approved" \| "paid" \| "partially_paid" \| "overdue" \| "disputed" \| "credited" \| "reversed"` | no | Only supplier invoices in this status. |
| `supplier_id` | query | `string` | no | Only invoices from this supplier (id). |
| `currency` | query | `string` | no | 3-letter ISO 4217 code, uppercase (e.g. SEK, EUR). |
| `date_from` | query | `string` | no | YYYY-MM-DD. Invoices with invoice_date on or after this date. |
| `date_to` | query | `string` | no | YYYY-MM-DD. Invoices with invoice_date on or before this date. |
| `cursor` | query | `string` | no | Opaque cursor from the previous page's meta.next_cursor. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). Larger values are clamped to 100. |

Response `200`:
```ts
{
  data: { id: string, supplier_id: string, supplier_name: string, arrival_number: number, supplier_invoice_number: string, invoice_date: string, due_date: string, status: "registered" | "approved" | "paid" | "partially_paid" | "overdue" | "disputed" | "credited" | "reversed", currency: string, subtotal: number, vat_amount: number, total: number, paid_amount: number, remaining_amount: number, is_credit_note: boolean, paid_at: string | null, created_at: string }[],
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

Creates a supplier invoice in `registered` status and posts the registration journal entry under faktureringsmetoden (Debit expense + Debit 2641 Ingående moms / Credit 2440 Leverantörsskulder). Under kontantmetoden no JE is posted at this stage. Under defer_invoice_booking (faktureringsmetoden, Registrera men bokför inte) no JE is posted either: book it afterwards with POST /supplier-invoices/{id}/book. Idempotent (mandatory Idempotency-Key). Dry-runnable.

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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  supplier_id: string,
  document_id?: string,
  supplier_invoice_number: string,
  invoice_date: string,
  due_date: string,
  delivery_date?: string | "",
  currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF",
  exchange_rate?: number,
  vat_treatment?: "standard_25" | "reduced_12" | "reduced_6" | "reverse_charge" | "export" | "exempt",
  reverse_charge?: boolean,
  payment_reference?: string,
  notes?: string,
  ore_rounding?: boolean,
  paid_with_private_funds?: boolean,
  employee_id?: string | null,
  claimant_name?: string,
  inbox_item_id?: string | null,
  payment_date?: string,
  default_dimensions?: Record<string, string>,
  items: { description: string, amount?: number, account_number: string, vat_rate?: 0 | 0.06 | 0.12 | 0.25, vat_amount?: number, reverse_charge_rate?: number, apply_slp?: boolean, vat_code?: string, quantity?: number, unit?: string, unit_price?: number, accrual_period_start?: string | null, accrual_period_end?: string | null, accrual_balance_account?: string | null, dimensions?: Record<string, string> }[]
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
    registration_journal_entry_id: string | null,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
| `expand` | query | `string` | no | Comma-separated related records to embed: supplier, items, payments. An unknown key returns 400 VALIDATION_ERROR. |

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
    delivery_date: string | null,
    status: string,
    currency: string,
    exchange_rate: number | null,
    subtotal: number,
    vat_amount: number,
    total: number,
    vat_treatment: string,
    reverse_charge: boolean,
    paid_amount: number,
    remaining_amount: number,
    is_credit_note: boolean,
    credited_invoice_id: string | null,
    registration_journal_entry_id: string | null,
    payment_journal_entry_id: string | null,
    notes: string | null,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
    delivery_date: string | null,
    status: string,
    currency: string,
    exchange_rate: number | null,
    subtotal: number,
    vat_amount: number,
    total: number,
    vat_treatment: string,
    reverse_charge: boolean,
    paid_amount: number,
    remaining_amount: number,
    is_credit_note: boolean,
    credited_invoice_id: string | null,
    registration_journal_entry_id: string | null,
    payment_journal_entry_id: string | null,
    notes: string | null,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

Attests a supplier invoice that has not been approved yet (status `registered` or `overdue`). The resulting status is `approved`, or `overdue` when the invoice is still past its due date. No journal entry is posted here: the registration JE was already booked at :create under accrual (or, under defer_invoice_booking, is posted by POST /supplier-invoices/{id}/book), or is deferred to :mark-paid under cash. Idempotent. Dry-runnable.

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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

### `POST /api/v1/companies/{companyId}/supplier-invoices/{id}/book`

**Book a registered supplier invoice that was registered without a verifikat (the deferred Bokför step).**
`scope:suppliers:write · risk:high · idempotent · dry-run`

For companies with defer_invoice_booking=true (Registrera men bokför inte): POST /supplier-invoices registers the invoice without posting anything, and this step posts the registration verifikat afterwards (Debit cost accounts per line + 2641 ingående moms, or fiktiv moms for reverse charge; Credit 2440 Leverantörsskulder; periodiserade lines on 17xx with their schedules). Dated on the invoice date. The invoice is claimed with a compare-and-set, so a concurrent book, payment or credit cancels this entry instead of double-posting. The retained source document is anchored to the verifikat. Idempotent. Dry-runnable: the dry run previews the exact lines and writes nothing.

**Use when:** A supplier invoice is registered, approved or overdue, has no registration_journal_entry_id, and the company books supplier invoices in a separate step (defer_invoice_booking).
**Do not use for:** Paid or partially paid invoices (their payment booked them in full), credit notes, or any supplier invoice under kontantmetoden (booked at payment via :mark-paid).

**Pitfalls:**
- An invoice that already has a registration_journal_entry_id answers 400 SI_BOOK_ALREADY_BOOKED.
- Status other than registered, approved or overdue answers 400 SI_BOOK_INVALID_STATUS with details.currentStatus.
- Under kontantmetoden answers 400 SI_BOOK_CASH_METHOD.
- A locked or closed period, or an invoice date on or before the company lock date (bookkeeping_locked_through), answers 400 PERIOD_LOCKED with details.reason, details.fiscal_period_id and details.invoice_date. Nothing is generated, so no voucher number is spent: unlock the period (only if the user asked for that correction) and retry.
- No open fiscal year covering the invoice date answers 400 SI_BOOK_NO_FISCAL_PERIOD.
- Booking does not attest the invoice: :approve is a separate step and may come before or after.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: {
    supplier_invoice: { id: string, arrival_number: number | null, supplier_invoice_number: string | null, status: string, invoice_date: string, due_date: string | null, currency: string, total: number, registration_journal_entry_id: string | null },
    journal_entry_id: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "supplier_invoice": {
      "id": "3b4c…",
      "arrival_number": 118,
      "supplier_invoice_number": "55012",
      "status": "approved",
      "invoice_date": "2026-09-03",
      "due_date": "2026-10-03",
      "currency": "SEK",
      "total": 6250,
      "registration_journal_entry_id": "6d7e…"
    },
    "journal_entry_id": "6d7e…"
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: {
    credit_note_id: string,
    original_id: string,
    arrival_number: number,
    supplier_invoice_number: string,
    registration_journal_entry_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

Books the payment journal entry (Debit 2440 / Credit the payment account under accrual; or Debit expense + Debit 2641 / Credit the payment account under cash) and flips the SI status to `paid` (full settlement) or `partially_paid`. The payment account is `payment_account` when supplied, otherwise 1930 Företagskonto. Strict-mode: a JE failure aborts before any SI mutation. Idempotent. Dry-runnable.

**Use when:** You paid a registered or approved leverantörsfaktura through a channel other than the synced bank flow. For bank-matched payments use POST /transactions/{id}/match-supplier-invoice instead: that path also reconciles the bank line.
**Do not use for:** Refunding a payment (the public API does not expose unmark-paid; credit the SI instead). Paying a credited or already-paid SI (returns 409 SI_PAID_ALREADY).

**Pitfalls:**
- Idempotency-Key is mandatory.
- payment_date must fall in an open fiscal period: locked period returns 400 PERIOD_LOCKED.
- exchange_rate_difference (SEK delta vs the booked rate at registration) is required for foreign-currency SIs to book the FX gain/loss to 3960 / 7960. Omitting it on a non-SEK SI under accrual mis-books FX.
- Strict-mode: a JE creation failure ABORTS before the status flip. There is no partial-state recovery banner: retry the call.
- Cash basis (kontantmetoden) recognizes the expense + ingående moms HERE, not at :create.
- Cash basis + öresavrundning: a SEK invoice with ore_rounding on and an öre-bearing total is paid in whole kronor, so the generated entry credits the payment account with the rounded amount and books the residual on 3740 (no VAT). amount, paid_amount and remaining_amount stay in exact öre. Invoices whose rounding is already an invoice row on 3740 have a whole-krona total and are unaffected.
- payment_account picks the BAS account credited for the payment (1930 Företagskonto when omitted, on both the accrual and the cash path). It must be active in the chart of accounts: an unknown or deactivated account returns 400 ACCOUNTS_NOT_IN_CHART and books nothing. Beyond that it is credited exactly as given, with no range check: 19xx bank or kassa is the ordinary choice, but 1630 (betald via skattekontot) and 2893 / 2018 / 2820 (someone else paid, utlägg) are equally valid, so choosing an account that does not represent where the money actually came from is the caller's error to avoid. Unlike the dashboard dialog, this endpoint does not read the company's last-used payment account: omitting the field always means 1930.
- Duplicate-payment guard: on a full settlement, if a business bank transaction of the same amount around payment_date carries the supplier name (first distinctive token, so abbreviated bank text such as "HI3G" for Hi3G Access AB counts), returns 409 SI_PAID_LIKELY_DUPLICATE with candidate transactions. A candidate with match_reason `already_booked` is a bank row that is ALREADY a verifikat: do not pay the invoice, correct the double booking instead. Retry with `force: true` only after the user confirms, and with a fresh Idempotency-Key (the original is body-hash bound). Also evaluated under dry-run. A forced full settlement is recorded in behandlingshistorik together with the candidates the guard would have flagged.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
    paid_at: string | null,
    payment_journal_entry_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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

### `GET /api/v1/companies/{companyId}/supplier-payment-batches`

**List supplier payment batches (betalfiler), newest first, with settlement progress.**
`scope:suppliers:read · risk:low · idempotent`

Returns the company's payment batches, newest first, cursor-paginated: status, total, item count, how many member invoices are settled (derived from the live invoices), download count and the member supplier_invoice_ids. Pass next_cursor from the answer as cursor to get the next page; it is null on the last page.

**Use when:** Checking which betalfiler exist, whether one has been downloaded, or which invoices are already in an active batch.
**Do not use for:** The lines of one batch (GET /supplier-payment-batches/{id}).

**Pitfalls:**
- next_cursor rides in data (not meta): pass it back as ?cursor= until it is null.
- settled_count counts invoices with nothing left to pay, however they were settled; a created batch is not proof the bank executed it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"created" \| "cancelled" \| "all"` | no | created (active), cancelled, or all (default). |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). |
| `cursor` | query | `string` | no | next_cursor from the previous page. Omit for the first page. |

Response `200`:
```ts
{
  data: {
    supplier_payment_batches: { supplier_payment_batch_id: string, format: "pain001", status: "created" | "cancelled", currency: string, total_amount: number, item_count: number, settled_count: number, msg_id: string, file_generated_at: string | null, download_count: number, created_at: string, cancelled_at: string | null, supplier_invoice_ids: string[] }[],
    next_cursor: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "supplier_payment_batches": [
      {
        "supplier_payment_batch_id": "5b0c…",
        "format": "pain001",
        "status": "created",
        "currency": "SEK",
        "total_amount": 12500,
        "item_count": 2,
        "settled_count": 0,
        "msg_id": "ACCOUNTED-5566778899-B5B0C1A2F",
        "file_generated_at": null,
        "download_count": 0,
        "created_at": "2026-09-25T09:00:00Z",
        "cancelled_at": null,
        "supplier_invoice_ids": [
          "9e2f…",
          "0a7d…"
        ]
      }
    ],
    "next_cursor": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/supplier-payment-batches`

**Create a supplier payment file (betalfil, pain.001) for one or more supplier invoices.**
`scope:suppliers:write · risk:high · idempotent · dry-run`

Creates a payment batch: an immutable snapshot of one credit transfer per invoice (amount, payment date, the supplier's bankgiro / plusgiro / bank account, OCR or invoice-number reference) and the company's own bank details as debtor, with a pain.001 MsgId fixed at creation. Every invoice is re-read and re-checked inside one transaction, so an invoice settled or already batched meanwhile is refused. Books nothing and marks nothing paid. Download the XML with GET /supplier-payment-batches/{id}/file and upload it in the bank, where the payments are signed; afterwards settle each invoice with mark-paid or bank matching. Idempotent. Dry-runnable.

**Use when:** The user wants to pay approved supplier invoices through their bank's file upload (typically the weekly or monthly payment run).
**Do not use for:** Marking invoices paid (POST /supplier-invoices/{id}/mark-paid), paying salaries (salary-runs/{id}/payment-file) or sending anything to the bank: this only produces the file.

**Pitfalls:**
- Money leaves the company's account once the file is uploaded and signed in the bank: preview first (POST /supplier-payment-batches/preview) and check amounts and payees.
- An invoice already in an active batch answers 409 SI_BATCH_DUPLICATE_INVOICE with details.invoices; resend with confirm_already_batched true only when paying it twice is intended, otherwise cancel the old batch.
- Incomplete company bank details answer 400 SI_BATCH_DEBTOR_INCOMPLETE; details.missing is iban, bic or org_number (company settings).
- An ineligible invoice fails the whole request with 400 SI_BATCH_INELIGIBLE_INVOICE and a reason per invoice; amount above the remaining amount answers 400 SI_BATCH_AMOUNT_EXCEEDS_REMAINING.
- A payment_date in the past is moved to today (banks reject passed execution dates). Only SEK invoices; at most 100 per batch.
- Between two requests (dry run, then create) a supplier's bank details can change: pass expected_payees from the dry run's items (payee.fingerprint, amount) and create answers 409 SI_BATCH_PAYEE_CHANGED instead of paying a changed account. A staged MCP create is pinned this way automatically.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  format?: "pain001",
  items: { supplier_invoice_id: string, amount?: number, payment_date?: string }[],
  confirm_already_batched?: boolean,
  expected_payees?: { supplier_invoice_id: string, payee_fingerprint: string, amount: number }[]
}
```

Example request:
```json
{
  "items": [
    {
      "supplier_invoice_id": "9e2f…"
    },
    {
      "supplier_invoice_id": "0a7d…",
      "amount": 5000
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    supplier_payment_batch_id: string,
    msg_id: string,
    format: "pain001",
    status: "created",
    currency: string,
    total_amount: number,
    item_count: number,
    created_at: string,
    file: { filename: string, download: string }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "supplier_payment_batch_id": "5b0c…",
    "msg_id": "ACCOUNTED-5566778899-B5B0C1A2F",
    "format": "pain001",
    "status": "created",
    "currency": "SEK",
    "total_amount": 12500,
    "item_count": 2,
    "created_at": "2026-09-25T09:00:00Z",
    "file": {
      "filename": "betalfil_20260925_5b0c1a2f.xml",
      "download": "/api/v1/companies/{companyId}/supplier-payment-batches/{supplier_payment_batch_id}/file"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/supplier-payment-batches/{id}`

**Read one supplier payment batch (betalfil) with its lines and live settlement.**
`scope:suppliers:read · risk:low · idempotent`

Returns the batch, the company bank details it debits (as snapshotted at creation), and one line per invoice: amount, payment date, payee, reference, and the invoice's live status and remaining amount. file names the download filename and the v1 path that serves the XML (available only while the batch is not cancelled).

**Use when:** Checking what a betalfil pays, or which of its invoices are settled.
**Do not use for:** Getting the XML itself: GET /supplier-payment-batches/{id}/file.

**Pitfalls:**
- The payee and amount per line are the snapshot the file pays, even if the supplier's details changed since.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    supplier_payment_batch_id: string,
    format: "pain001",
    status: "created" | "cancelled",
    currency: string,
    total_amount: number,
    item_count: number,
    settled_count: number,
    msg_id: string,
    file_generated_at: string | null,
    download_count: number,
    created_at: string,
    cancelled_at: string | null,
    supplier_invoice_ids: string[],
    debtor: { name: string, iban: string, bic: string },
    items: { supplier_payment_batch_item_id: string, supplier_invoice_id: string, supplier_invoice_number: string | null, arrival_number: number | null, amount: number, payment_date: string, payee_name: string, payee: { type: "bankgiro" | "plusgiro" | "bank_account", label: string }, reference: { type: "ocr" | "invoice_number", value: string }, invoice_status: string | null, remaining_amount: number | null, settled: boolean }[],
    file: { filename: string, content_type: "application/xml", available: boolean, download: string }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "supplier_payment_batch_id": "5b0c…",
    "format": "pain001",
    "status": "created",
    "currency": "SEK",
    "total_amount": 12500,
    "item_count": 2,
    "settled_count": 0,
    "msg_id": "ACCOUNTED-5566778899-B5B0C1A2F",
    "file_generated_at": null,
    "download_count": 0,
    "created_at": "2026-09-25T09:00:00Z",
    "cancelled_at": null,
    "supplier_invoice_ids": [
      "9e2f…",
      "0a7d…"
    ],
    "debtor": {
      "name": "Testbolaget AB",
      "iban": "SE35 **** 0003",
      "bic": "ESSESESS"
    },
    "items": [
      {
        "supplier_payment_batch_item_id": "71c4…",
        "supplier_invoice_id": "9e2f…",
        "supplier_invoice_number": "CD3014794407",
        "arrival_number": 12,
        "amount": 7500,
        "payment_date": "2026-10-01",
        "payee_name": "Derome Bygg AB",
        "payee": {
          "type": "bankgiro",
          "label": "BG 5050-1055"
        },
        "reference": {
          "type": "invoice_number",
          "value": "CD3014794407"
        },
        "invoice_status": "approved",
        "remaining_amount": 7500,
        "settled": false
      }
    ],
    "file": {
      "filename": "betalfil_20260925_5b0c1a2f.xml",
      "content_type": "application/xml",
      "available": true,
      "download": "/api/v1/companies/{companyId}/supplier-payment-batches/{supplier_payment_batch_id}/file"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/supplier-payment-batches/{id}/cancel`

**Cancel (makulera) a supplier payment batch.**
`scope:suppliers:write · risk:medium · idempotent · dry-run`

Marks an active batch cancelled: Accounted stops serving its file and its invoices can go into a new batch. The batch and its lines are kept (they are underlag for the payment instruction). A file already uploaded to the bank is NOT recalled: stop those payments in the bank. Cannot be undone; create a new batch instead. Idempotent. Dry-runnable.

**Use when:** A betalfil was created by mistake or with wrong amounts, before (or instead of) uploading it.
**Do not use for:** Stopping a payment the bank already has (do that in the bank) or un-paying an invoice.

**Pitfalls:**
- An already cancelled batch answers 409 SI_BATCH_ALREADY_CANCELLED.
- download_count above 0 means the file may already be at the bank: check there too.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { supplier_payment_batch_id: string, status: "cancelled", cancelled_at: string | null },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "supplier_payment_batch_id": "5b0c…",
    "status": "cancelled",
    "cancelled_at": "2026-09-25T10:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/supplier-payment-batches/{id}/file`

**Download the pain.001 payment file of a supplier payment batch.**
`scope:suppliers:write · risk:low · idempotent`

Returns the batch's XML payment file inline as `content` (a UTF-8 string), with filename, content_type and sha256, in the same shape as the salary payment file. The file regenerates from the stored batch, so every download is byte-identical (same MsgId) and the bank's duplicate detection works. Each call records the download on the batch (file_generated_at, download_count). Upload the file in the bank's file channel, where the payments are signed; nothing is sent to the bank by this call and nothing is booked.

**Use when:** The batch is created and the user (or their payment operator) needs the file to upload in the bank.
**Do not use for:** Creating the batch (POST /supplier-payment-batches) or marking invoices paid (mark-paid after the bank executed).

**Pitfalls:**
- Write `content` to `filename` as UTF-8, exactly as returned; do not re-indent or re-encode the XML.
- A cancelled batch answers 409 SI_BATCH_CANCELLED: its file is never served again.
- Uploading the same file twice is caught by most banks through the MsgId, but not all: check download_count and the bank before re-uploading.
- Needs suppliers:write although it is a GET: the file is a payment instruction and the download is recorded.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    supplier_payment_batch_id: string,
    format: "pain001",
    filename: string,
    content_type: "application/xml",
    content: string,
    sha256: string,
    msg_id: string,
    item_count: number,
    total_amount: number,
    currency: string,
    download_count: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "supplier_payment_batch_id": "5b0c…",
    "format": "pain001",
    "filename": "betalfil_20260925_5b0c1a2f.xml",
    "content_type": "application/xml",
    "content": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:pain.001.001.03\">…",
    "sha256": "3f9a…",
    "msg_id": "ACCOUNTED-5566778899-B5B0C1A2F",
    "item_count": 2,
    "total_amount": 12500,
    "currency": "SEK",
    "download_count": 1
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/supplier-payment-batches/preview`

**Check which supplier invoices can go into a payment file (betalfil), with amounts, payees and warnings.**
`scope:suppliers:read · risk:low · idempotent`

Evaluates the given supplier invoices exactly as create will: eligible lines with the default amount (the remaining amount), payment date (the due date, or today when it has passed), payee (bankgiro, plusgiro or bank account from the supplier) and reference (OCR when valid, else the invoice number), plus non-blocking warnings; excluded invoices with the reason; and whether the company's own bank details (IBAN, BIC, org number: the pain.001 debtor) are complete. Reads only; creates nothing.

**Use when:** Before creating a payment batch, to see what would be paid and what blocks it.
**Do not use for:** Creating the batch (POST /supplier-payment-batches) or listing unpaid supplier invoices (GET /supplier-invoices).

**Pitfalls:**
- Excluded reasons: not_payable (draft, paid, credited...), nothing_remaining, credit_note, foreign_currency (only SEK), payee_missing / payee_invalid (fix the supplier's bankgiro, plusgiro or clearing + account number), not_found.
- debtor_ok false means create will refuse with SI_BATCH_DEBTOR_INCOMPLETE: debtor_missing names the company setting to fill in (iban, bic or org_number).
- already_batched is a warning here but a refusal at create unless confirm_already_batched is true: paying the same invoice twice is the risk.
- Only SEK invoices; at most 100 per call.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{ format?: "pain001", supplier_invoice_ids: string[] }
```

Example request:
```json
{
  "supplier_invoice_ids": [
    "9e2f…"
  ]
}
```

Response `200`:
```ts
{
  data: {
    eligible: { supplier_invoice_id: string, supplier_name: string, supplier_invoice_number: string, amount: number, payment_date: string, payee: { type: "bankgiro" | "plusgiro" | "bank_account", label: string }, reference: { type: "ocr" | "invoice_number", value: string }, warnings: ("unattested" | "already_batched" | "ocr_invalid" | "payee_city_missing")[], active_supplier_payment_batch_id: string | null }[],
    excluded: { supplier_invoice_id: string, reason: "not_payable" | "nothing_remaining" | "credit_note" | "foreign_currency" | "payee_missing" | "payee_invalid" | "not_found" }[],
    total_amount: number,
    currency: "SEK",
    debtor_ok: boolean,
    debtor_missing: "iban" | "bic" | "org_number" | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "eligible": [
      {
        "supplier_invoice_id": "9e2f…",
        "supplier_name": "Derome Bygg AB",
        "supplier_invoice_number": "CD3014794407",
        "amount": 737.5,
        "payment_date": "2026-10-01",
        "payee": {
          "type": "bankgiro",
          "label": "BG 5050-1055"
        },
        "reference": {
          "type": "invoice_number",
          "value": "CD3014794407"
        },
        "warnings": [
          "payee_city_missing"
        ],
        "active_supplier_payment_batch_id": null
      }
    ],
    "excluded": [],
    "total_amount": 737.5,
    "currency": "SEK",
    "debtor_ok": true,
    "debtor_missing": null
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
| `supplier_type` | query | `"swedish_business" \| "eu_business" \| "non_eu_business"` | no | Only suppliers of this type. |
| `search` | query | `string` | no | Case-insensitive match on the name (anywhere) or the org number (prefix), 1-200 characters. |
| `include_archived` | query | `"true" \| "false"` | no | true also returns archived suppliers. Default: false. |
| `cursor` | query | `string` | no | Opaque cursor from the previous page's meta.next_cursor. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). Larger values are clamped to 100. |

Response `200`:
```ts
{
  data: { id: string, name: string, supplier_type: "swedish_business" | "eu_business" | "non_eu_business", email: string | null, org_number: string | null, vat_number: string | null, default_payment_terms: number, default_currency: string, party_id?: string | null, archived_at: string | null, created_at: string }[],
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
      "org_number": "5566778899",
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
  default_currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | null,
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
    id: string | null,
    name: string,
    supplier_type: "swedish_business" | "eu_business" | "non_eu_business",
    email: string | null,
    phone: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    country: string,
    org_number: string | null,
    vat_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    bank_account: string | null,
    iban: string | null,
    bic: string | null,
    default_expense_account: string | null,
    default_payment_terms: number,
    default_currency: string,
    notes: string | null,
    archived_at: string | null,
    created_at: string | null,
    updated_at: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
    "org_number": "5566778899",
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
| `expand` | query | `string` | no | Comma-separated related records to embed: supplier_invoices, party. An unknown key returns 400 VALIDATION_ERROR. |

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    supplier_type: string,
    email: string | null,
    phone: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    country: string,
    org_number: string | null,
    vat_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    bank_account: string | null,
    iban: string | null,
    bic: string | null,
    default_expense_account: string | null,
    default_payment_terms: number,
    default_currency: string,
    notes: string | null,
    party_id: string | null,
    party?: { id: string, display_name: string, legal_name: string | null, org_number: string | null, vat_number: string | null, country: string | null, kind: string, status: "confirmed" | "suggested", roles: { supplier_id: string | null, customer_id: string | null }, registry: { legal_name: string | null, legal_form: string | null, status: { label: string, active: boolean } | null, warning: string | null, registrations: { f_tax: boolean | null, vat: boolean | null, employer: boolean | null }, industry: { code: string, label: string } | null, seat: string | null, registered_at: string | null, active_since: string | null, active_until: string | null, employees_band: string | null, turnover: { band: string, year: string | null } | null, workplaces: number | null, contact: { email: string | null, phone: string | null, address: { co: string | null, street: string | null, postal_code: string | null, city: string | null } | null }, vat_number: string | null, fetched_at: string | null } | null, ledger: { occurrences: number, expense_sek: number, revenue_sek: number, first_seen: string | null, last_seen: string | null, dominant_account: string | null } | null, identities: { scheme: string, value: string, status: string, seen_count: number }[] } | null,
    archived_at: string | null,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  name?: string,
  supplier_type?: "swedish_business" | "eu_business" | "non_eu_business",
  email?: string | null,
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
  default_expense_account?: string | null,
  default_payment_terms?: number,
  default_currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | null,
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
    email: string | null,
    phone: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    country: string,
    org_number: string | null,
    vat_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    bank_account: string | null,
    iban: string | null,
    bic: string | null,
    default_expense_account: string | null,
    default_payment_terms: number,
    default_currency: string,
    notes: string | null,
    party_id: string | null,
    party?: { id: string, display_name: string, legal_name: string | null, org_number: string | null, vat_number: string | null, country: string | null, kind: string, status: "confirmed" | "suggested", roles: { supplier_id: string | null, customer_id: string | null }, registry: { legal_name: string | null, legal_form: string | null, status: { label: string, active: boolean } | null, warning: string | null, registrations: { f_tax: boolean | null, vat: boolean | null, employer: boolean | null }, industry: { code: string, label: string } | null, seat: string | null, registered_at: string | null, active_since: string | null, active_until: string | null, employees_band: string | null, turnover: { band: string, year: string | null } | null, workplaces: number | null, contact: { email: string | null, phone: string | null, address: { co: string | null, street: string | null, postal_code: string | null, city: string | null } | null }, vat_number: string | null, fetched_at: string | null } | null, ledger: { occurrences: number, expense_sek: number, revenue_sek: number, first_seen: string | null, last_seen: string | null, dominant_account: string | null } | null, identities: { scheme: string, value: string, status: string, seen_count: number }[] } | null,
    archived_at: string | null,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  suppliers: { name: string, supplier_type: "swedish_business" | "eu_business" | "non_eu_business", email?: string, phone?: string, address_line1?: string, address_line2?: string, postal_code?: string, city?: string, country?: string, org_number?: string, vat_number?: string, bankgiro?: string, plusgiro?: string, bank_account?: string, iban?: string, bic?: string, clearing_number?: string, account_number?: string, default_expense_account?: string, default_payment_terms?: number, default_currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | null, notes?: string }[],
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
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
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
