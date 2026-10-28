<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Suppliers (AP) endpoints

Accounts payable: supplier register, received supplier invoices (register -> approve -> book if deferred -> pay via a supplier payment file, a bank payment order signed with BankID in Accounted, or mark-paid, or credit), the Bankgiro Lookup checks (the registered name behind a payee giro, the company's own giro numbers), and expense claims (utlägg) with their payouts.

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
    expense_claims: { expense_claim_id: string, handle?: string, employee_id: string | null, claimant_name: string, description: string, expense_date: string, amount_sek: number, vat_sek: number, currency: string, amount_in_currency: number | null, exchange_rate: number | null, expense_account: string, liability_account: string, document_id: string | null, status: "registered" | "paid", journal_entry_id: string | null, payout_batch_id: string | null, created_at: string }[],
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

Books a business cost someone paid privately: Debit the cost account (net), Debit 2641 (vat_amount), Credit the person's liability account (gross), in one verifikat posted immediately. The liability account follows the claimant: employee_id books 2820; otherwise the owner's account for the legal form (2893 aktiebolag, 2018 enskild firma as egen insättning, 2890 förening member) with claimant_name. Foreign currency converts at exchange_rate or Riksbanken's rate for expense_date. reverse_charge (eu_services or non_eu_services) books omvänd skattskyldighet for a service under huvudregeln (SaaS, licences, ads, consulting) from a seller abroad that charged no VAT: the fiktiv moms 2645/2614 and the 4535|4531/4598 basis pair join the generated rows. lines replaces the generated rows (templates, hand-built rows) and must credit the liability account with exactly amount. dimensions ({sie_dim_no: code}, kostnadsställe/projekt) tags the cost line, or with lines every class 3-8 line, where a line's own dimensions win per key. document_id attaches the receipt to the verifikat; inbox_item_id marks the inbox item booked. Idempotent. Dry-runnable.

**Use when:** A receipt was paid with a private card or cash: the answer to "Vem betalade?" is the owner or an employee, not the company account.
**Do not use for:** A purchase the company paid itself (categorize the bank transaction or register a supplier invoice), an unpaid supplier invoice (POST /supplier-invoices) or mileage (körjournal).

**Pitfalls:**
- amount is gross incl. VAT and vat_amount must be below it. Foreign VAT is not deductible on 2641: for a receipt from a seller abroad send vat_amount 0. Add reverse_charge only for a service under huvudregeln (SaaS, licences, ads, consulting) bought from a seller abroad that charged no VAT. Hotel, restaurant, taxi, passenger transport and event admission abroad are taxed where performed, and a VAT-exempt service (e.g. a bank fee) carries none: no reverse_charge, the whole amount is cost.
- With reverse_charge, an expense_account that reports a momsruta of its own that does not match the kind (4512, 4545-4547, 4531 with eu_services, a kontoplan momskod for another purchase, a reverse-charge momskod without a 25/12/6 % rate) or is 4598 answers 400 EXPENSE_CLAIM_INVALID_LINES: book on an ordinary cost account.
- The verifikat is posted at once and is immutable: undo it with DELETE /expense-claims/{id}, which posts a storno.
- employee_id wins over claimant_name: the employee's own name is stored.
- A date in a locked period or behind the company lock date returns 400 PERIOD_LOCKED; no open fiscal year returns EXPENSE_CLAIM_NO_FISCAL_PERIOD.
- expense_account is a STRING in class 4-8 ("5410"), never a number.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

Request body:
```ts
{
  description: string,
  expense_date: string,
  amount: number,
  vat_amount?: number,
  currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD",
  exchange_rate?: number,
  expense_account: string,
  employee_id?: string | null,
  claimant_name?: string,
  document_id?: string | null,
  inbox_item_id?: string | null,
  dimensions?: Record<string, string>,
  reverse_charge?: "eu_services" | "non_eu_services",
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string | null, dimensions?: Record<string, string> }[]
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
    handle?: string,
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
    handle?: string,
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
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

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
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

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

### `GET /api/v1/companies/{companyId}/payment-orders`

**List bank payment orders (betalningar via banken), newest first.**
`scope:suppliers:read · risk:low · idempotent`

Returns the company's bank payment orders, newest first, cursor-paginated: status, amount, execution date, the payee as the order carries it (with its check), the reference, the bank's own status, and the supplier invoice each order pays. Filter by one status, by open (everything not yet closed) or by supplier_invoice_id. Pass next_cursor from the answer as cursor to get the next page; it is null on the last page.

**Use when:** Following up bank payments: what is waiting for approval or signing, what the bank holds, what is paid.
**Do not use for:** Payment files (betalfiler): GET /supplier-payment-batches. Preparing a payment: POST /payment-orders.

**Pitfalls:**
- next_cursor rides in data (not meta): pass it back as ?cursor= until it is null.
- An executed order stays open until its bank debit is matched to the invoice (matched_at); the invoice shows as unpaid until then.
- outcome_unknown true means the bank may hold the payment while its answer was lost: nobody should pay the invoice again; a person resolves it in Accounted.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"draft" \| "approved" \| "submitted" \| "awaiting_signature" \| "awaiting_second_signer" \| "accepted" \| "executed" \| "rejected" \| "cancelled" \| "failed" \| "open" \| "all"` | no | One status; open (every order not closed: drafts, approved, at the bank, and executed ones whose debit is not matched yet); or all (default). |
| `supplier_invoice_id` | query | `string` | no | Only the orders that pay this supplier invoice. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). |
| `cursor` | query | `string` | no | next_cursor from the previous page. Omit for the first page. |

Response `200`:
```ts
{
  data: {
    payment_orders: { payment_order_id: string, handle?: string, supplier_invoice_id: string | null, payment_order_batch_id: string | null, status: "draft" | "approved" | "submitted" | "awaiting_signature" | "awaiting_second_signer" | "accepted" | "executed" | "rejected" | "cancelled" | "failed", amount: number, currency: string, requested_execution_date: string, cash_account_id: string, payee: { type: "bankgiro" | "plusgiro" | "bank_account" | "iban", label: string, name: string, source: "invoice" | "supplier" | "skatteverket" | "employee", check: "unchecked" | "known" | "new" | "changed" }, reference: { type: "ocr" | "message", value: string }, end_to_end_id: string, provider_status: string | null, provider_error_code: string | null, outcome_unknown: boolean, approved_at: string | null, submitted_at: string | null, signed_at: string | null, executed_at: string | null, cancelled_at: string | null, matched_at: string | null, created_at: string, updated_at: string, supplier_invoice: { supplier_invoice_number: string | null, due_date: string | null, supplier_name: string | null } | null }[],
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
    "payment_orders": [
      {
        "payment_order_id": "7c2e…",
        "supplier_invoice_id": "9e2f…",
        "payment_order_batch_id": null,
        "status": "draft",
        "amount": 737.5,
        "currency": "SEK",
        "requested_execution_date": "2026-10-20",
        "cash_account_id": "41b0…",
        "payee": {
          "type": "bankgiro",
          "label": "BG 5050-1055",
          "name": "Derome Bygg AB",
          "source": "supplier",
          "check": "known"
        },
        "reference": {
          "type": "ocr",
          "value": "4400112233"
        },
        "end_to_end_id": "ACC7C2E1A2F3B4C5",
        "provider_status": null,
        "provider_error_code": null,
        "outcome_unknown": false,
        "approved_at": null,
        "submitted_at": null,
        "signed_at": null,
        "executed_at": null,
        "cancelled_at": null,
        "matched_at": null,
        "created_at": "2026-10-10T09:00:00Z",
        "updated_at": "2026-10-10T09:00:00Z",
        "supplier_invoice": {
          "supplier_invoice_number": "CD3014794407",
          "due_date": "2026-10-20",
          "supplier_name": "Derome Bygg AB"
        }
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

### `POST /api/v1/companies/{companyId}/payment-orders`

**Prepare draft bank payments (betalningar via banken) for supplier invoices, or one payment in to the skattekonto.**
`scope:suppliers:write · risk:medium · idempotent · dry-run · reversible`

Creates one draft payment order per payable supplier invoice, from one of the company's own bank accounts: the remaining amount, the due date (or today when it has passed) unless execution_date is given, the supplier's bankgiro, plusgiro or bank account, and the OCR or invoice number as reference. Nothing reaches the bank: a draft is approved by a person (POST /payment-orders/approve) and then signed with BankID on the Betalningar page in Accounted. The database decides each order's payee check (known, new, changed) from the supplier card, the invoice and payments a person already approved; new and changed accounts need that person's confirmation at approval. Invoices that cannot be paid are skipped with a reason; the request fails only when nothing is payable. Dry-runnable: ?dry_run=true answers the lines without creating anything; each line carries document: what the invoice document states (document_id, the account and the OCR read off it, its total and due date) and checks (same, differs or missing) for the account and the reference against what would be paid. With skattekonto instead of supplier_invoice_ids it creates one draft payment in to the skattekonto: Skatteverket's bankgiro 5050-1055 with the company's OCR number (set by Accounted, never typed). skattekonto.source names what it pays: next_charge (default: what the synced skattekonto lacks for its next charge), vat_declaration (ruta 49 of the momsdeklaration as filed, due on its deadline), agi (avdragen skatt + arbetsgivaravgifter of the arbetsgivardeklaration, due the 12th, 17th in January and August) or due_date (everything declared due on skattekonto.due_date as one payment, its parts in skattekonto.combined); skattekonto.amount pays another amount instead. The day defaults to the banking day before the due date. The synced saldo comes back as information and is never netted. Nothing is booked when the order is made or paid: the bank row to Skatteverket is booked like any other, against the skattekonto account (1630).

**Use when:** The user wants to pay approved supplier invoices from their bank account in Accounted instead of a payment file, or to pay the moms or the arbetsgivardeklaration (or any amount) in to the skattekonto after filing. Call with the invoices or skattekonto and the account; then hand the person the Betalningar link (GET /payment-orders/signing-link).
**Do not use for:** A payment file (POST /supplier-payment-batches), marking an invoice paid (mark-paid), or signing: no API or MCP door signs.

**Pitfalls:**
- PAYMENTS_UNAVAILABLE: bank payments are not switched on for the company (no provider, or a sandbox company). Check GET /payment-orders/availability first.
- PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE: the account needs a Swedish IBAN in SEK, enabled, at a bank the provider reaches; details.reason says which.
- PAYMENT_ORDERS_INELIGIBLE: no invoice in the selection is payable; details.skipped names each reason.
- An invoice already in an open bank payment or an active betalfil is skipped (already_in_payment, in_payment_file), never paid twice.
- use_stated_payee_for pays the account the invoice states instead of the supplier card for the listed invoices; the database then marks the order's payee changed and a person confirms it at approval.
- Only SEK; at most 100 invoices per call; execution_date may not be in the past.
- Send supplier_invoice_ids or skattekonto, never both.
- One open payment to Skatteverket per execution_date: an unsigned one takes the amount as an addition (skattekonto.merged_into); a signed one refuses SKATTEKONTO_PAYMENT_ALREADY_IN_PAYMENT, pick another day. VAT and AGI due the same day: source due_date. Paying one alone warns same_due_date_parts.
- source due_date never nets: a declaration asking for nothing (a refund in ruta 49, already paid) is left out and listed in skattekonto.combined.excluded.
- SKATTEKONTO_PAYMENT_NOTHING_DUE: the declaration asks for no payment (details.reason refund, zero, already_paid, period_not_ended; for due_date also no_declaration, nothing_payable) or nothing is due on the skattekonto; skattekonto.amount pays in anyway.
- skattekonto.warnings not_filed: the declaration is not on record as filed; possible_duplicate: a bank payment to the skattekonto of the same amount was executed since the period. Tell the person before they sign.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

Request body:
```ts
{
  supplier_invoice_ids?: string[],
  skattekonto?: {
    source?: "next_charge" | "vat_declaration" | "agi" | "due_date",
    period_type?: "monthly" | "quarterly" | "yearly",
    year?: number,
    period?: number,
    month?: number,
    fiscal_period_id?: string,
    due_date?: string,
    amount?: number
  },
  cash_account_id: string,
  execution_date?: string,
  use_stated_payee_for?: string[]
}
```

Example request:
```json
{
  "supplier_invoice_ids": [
    "9e2f…"
  ],
  "cash_account_id": "41b0…"
}
```

Response `200`:
```ts
{
  data: {
    payment_orders: { payment_order_id: string, handle?: string, supplier_invoice_id: string | null, payment_order_batch_id: string | null, status: "draft" | "approved" | "submitted" | "awaiting_signature" | "awaiting_second_signer" | "accepted" | "executed" | "rejected" | "cancelled" | "failed", amount: number, currency: string, requested_execution_date: string, cash_account_id: string, payee: { type: "bankgiro" | "plusgiro" | "bank_account" | "iban", label: string, name: string, source: "invoice" | "supplier" | "skatteverket" | "employee", check: "unchecked" | "known" | "new" | "changed" }, reference: { type: "ocr" | "message", value: string }, end_to_end_id: string, provider_status: string | null, provider_error_code: string | null, outcome_unknown: boolean, approved_at: string | null, submitted_at: string | null, signed_at: string | null, executed_at: string | null, cancelled_at: string | null, matched_at: string | null, created_at: string, updated_at: string, supplier_invoice: { supplier_invoice_number: string | null, due_date: string | null, supplier_name: string | null } | null }[],
    skipped: { supplier_invoice_id: string, reason: "not_payable" | "nothing_remaining" | "credit_note" | "foreign_currency" | "payee_missing" | "payee_invalid" | "reference_missing" | "attest_required" | "payee_unconfirmed" | "payee_rejected" | "not_found" | "in_bank_payment" | "in_payment_file" | "already_in_payment" | "auto_debit" }[],
    warnings: { supplier_invoice_id: string, code: "unattested" | "ocr_invalid" | "payee_changed" | "payee_new" | "date_moved", alternative_payee?: string | null, from?: string, to?: string }[],
    skattekonto?: { source: { kind: "vat_declaration" | "agi", tax_period: string, declared: number, due_date: string | null, filed: boolean, paid_at: string | null } | null, combined?: { due_date: string, total: number, components: { source: "vat_declaration" | "agi", period: string, amount: number }[], excluded: { source: "vat_declaration" | "agi", period: string, declared: number, reason: "refund" | "zero" | "already_paid" | "period_not_ended" }[] } | null, balance: { saldo: number, fetched_at: string | null } | null, warnings: { code: "late" | "date_moved" | "not_filed" | "possible_duplicate" | "same_due_date_parts", due?: string, from?: string, to?: string, payment_order_id?: string, executed_at?: string | null, source?: "vat_declaration" | "agi", period?: string, parts?: { source: "vat_declaration" | "agi", period: string, amount: number }[], total?: number, replaces_draft?: boolean, suggested_source?: { source: "due_date", due_date: string } }[], replaced_draft_ids: string[], merged_into?: { payment_order_id: string, status: string, amount: number, total: number } } | null,
    next: { approve: string, sign_in_app: string }
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
    "payment_orders": [
      {
        "payment_order_id": "7c2e…",
        "supplier_invoice_id": "9e2f…",
        "payment_order_batch_id": null,
        "status": "draft",
        "amount": 737.5,
        "currency": "SEK",
        "requested_execution_date": "2026-10-20",
        "cash_account_id": "41b0…",
        "payee": {
          "type": "bankgiro",
          "label": "BG 5050-1055",
          "name": "Derome Bygg AB",
          "source": "supplier",
          "check": "known"
        },
        "reference": {
          "type": "ocr",
          "value": "4400112233"
        },
        "end_to_end_id": "ACC7C2E1A2F3B4C5",
        "provider_status": null,
        "provider_error_code": null,
        "outcome_unknown": false,
        "approved_at": null,
        "submitted_at": null,
        "signed_at": null,
        "executed_at": null,
        "cancelled_at": null,
        "matched_at": null,
        "created_at": "2026-10-10T09:00:00Z",
        "updated_at": "2026-10-10T09:00:00Z",
        "supplier_invoice": null
      }
    ],
    "skipped": [],
    "warnings": [],
    "skattekonto": null,
    "next": {
      "approve": "/api/v1/companies/{companyId}/payment-orders/approve",
      "sign_in_app": "https://app.accounted.se/payments"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/payment-orders/{id}`

**Read one bank payment order.**
`scope:suppliers:read · risk:low · idempotent`

Returns the order with its payee (as the order carries it, with its check), reference, status, the bank's own status and error code, its timestamps and the supplier invoice it pays.

**Use when:** Checking where one payment stands.
**Do not use for:** Several orders at once (GET /payment-orders).

**Pitfalls:**
- An order of another company answers 404, like one that does not exist.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    payment_order_id: string,
    handle?: string,
    supplier_invoice_id: string | null,
    payment_order_batch_id: string | null,
    status: "draft" | "approved" | "submitted" | "awaiting_signature" | "awaiting_second_signer" | "accepted" | "executed" | "rejected" | "cancelled" | "failed",
    amount: number,
    currency: string,
    requested_execution_date: string,
    cash_account_id: string,
    payee: { type: "bankgiro" | "plusgiro" | "bank_account" | "iban", label: string, name: string, source: "invoice" | "supplier" | "skatteverket" | "employee", check: "unchecked" | "known" | "new" | "changed" },
    reference: { type: "ocr" | "message", value: string },
    end_to_end_id: string,
    provider_status: string | null,
    provider_error_code: string | null,
    outcome_unknown: boolean,
    approved_at: string | null,
    submitted_at: string | null,
    signed_at: string | null,
    executed_at: string | null,
    cancelled_at: string | null,
    matched_at: string | null,
    created_at: string,
    updated_at: string,
    supplier_invoice: { supplier_invoice_number: string | null, due_date: string | null, supplier_name: string | null } | null
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
    "payment_order_id": "7c2e…",
    "supplier_invoice_id": "9e2f…",
    "payment_order_batch_id": null,
    "status": "draft",
    "amount": 737.5,
    "currency": "SEK",
    "requested_execution_date": "2026-10-20",
    "cash_account_id": "41b0…",
    "payee": {
      "type": "bankgiro",
      "label": "BG 5050-1055",
      "name": "Derome Bygg AB",
      "source": "supplier",
      "check": "known"
    },
    "reference": {
      "type": "ocr",
      "value": "4400112233"
    },
    "end_to_end_id": "ACC7C2E1A2F3B4C5",
    "provider_status": null,
    "provider_error_code": null,
    "outcome_unknown": false,
    "approved_at": null,
    "submitted_at": null,
    "signed_at": null,
    "executed_at": null,
    "cancelled_at": null,
    "matched_at": null,
    "created_at": "2026-10-10T09:00:00Z",
    "updated_at": "2026-10-10T09:00:00Z",
    "supplier_invoice": {
      "supplier_invoice_number": "CD3014794407",
      "due_date": "2026-10-20",
      "supplier_name": "Derome Bygg AB"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/payment-orders/{id}/cancel`

**Cancel a bank payment order.**
`scope:suppliers:write · risk:medium · idempotent · dry-run`

Before the bank has the payment (draft, approved) the order is cancelled in Accounted. After that the bank is asked, and the order is cancelled only when the bank confirms the cancel; any other bank answer leaves the payment where it is and is reported as an error code. An executed payment cannot be cancelled. An order whose bank outcome is unknown is not cancelled here: a person resolves it in Accounted after checking the online bank. Dry-runnable.

**Use when:** A prepared or approved payment should not be made, or a payment the bank holds must be stopped before execution.
**Do not use for:** Un-paying an invoice, or an executed payment (ask the bank to recall it).

**Pitfalls:**
- PAYMENT_CANCEL_NEEDS_SIGNING: the bank wants the cancel signed; cancel it in the online bank.
- PAYMENT_CANCEL_TOO_LATE: executed, or past the bank's cut-off.
- PAYMENT_CANCEL_UNSIGNED_REFUSED: the bank holds the payment unsigned and refused the cancel, typically while a signing of it is open; nothing is paid unless someone signs it. Retry in a few minutes.
- PAYMENT_CANCEL_NOT_CONFIRMED: the bank did not confirm; check the payment in the online bank. The order is unchanged.
- PAYMENT_CANCEL_CONFIRMATION_REQUIRED: the bank may hold the payment but its answer was lost; a person resolves the order in Accounted.
- PAYMENT_ORDER_CREATE_IN_PROGRESS: the payment is on its way to the bank right now; wait a few minutes.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

Response `200`:
```ts
{
  data: { payment_order_id: string, cancelled: boolean, status: string },
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
    "payment_order_id": "7c2e…",
    "cancelled": true,
    "status": "cancelled"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/payment-orders/approve`

**Approve (attest) draft bank payments so they can be signed.**
`scope:suppliers:write · risk:high · idempotent · dry-run · reversible`

Moves draft orders to approved: the attestation that these invoices are to be paid, from this account, to these payees. An order to an account that is new for the supplier or differs from the supplier card (payee.check new or changed) needs its invoice named in confirmed_payee_invoice_ids: one confirmation per invoice, never one flag for a whole selection. Nothing reaches the bank: signing with BankID happens on the Betalningar page, by a person. All or nothing: a draft that changed meanwhile fails the request. Undo with POST /payment-orders/unapprove.

**Use when:** The person behind the API key has checked the drafts and attests them before signing in Accounted.
**Do not use for:** Signing (only a person signs, in Accounted) or preparing (POST /payment-orders).

**Pitfalls:**
- PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED: details.invoices lists the invoices whose account must be confirmed; resend with them in confirmed_payee_invoice_ids after checking the account.
- PAYMENT_ORDERS_WRONG_STATUS: an order is no longer a draft (details.orders); reload and select again.
- Not offered over MCP: attestation is a person's act. An agent prepares and hands out the Betalningar link.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ payment_order_ids: string[], confirmed_payee_invoice_ids?: string[] }
```

Example request:
```json
{
  "payment_order_ids": [
    "7c2e…"
  ]
}
```

Response `200`:
```ts
{
  data: { approved_payment_order_ids: string[], sign_in_app: string },
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
    "approved_payment_order_ids": [
      "7c2e…"
    ],
    "sign_in_app": "https://app.accounted.se/payments"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/payment-orders/availability`

**Whether the company can pay through its bank from Accounted, and from which accounts.**
`scope:suppliers:read · risk:low · idempotent`

Answers available (a payment provider serves this installation, the company is on a paid plan and it is not a sandbox), why not when it is false (reason: no_provider, not_in_pilot, subscription, sandbox), the provider, and the company's bank accounts with payable true or a reason (account_disabled, not_sek, iban_missing, bank_unknown, bank_not_supported: the payment provider does not pay from this bank, Svea Bank today). signer_known says whether the calling person has a BankID login on file, so signing needs no typed personnummer. IBANs are masked.

**Use when:** Before preparing a bank payment: pick a payable cash_account_id.
**Do not use for:** Payment files, which need no provider (GET /supplier-payment-batches/preview).

**Pitfalls:**
- available false means POST /payment-orders answers PAYMENTS_UNAVAILABLE; pay with a payment file instead.
- reason subscription: bank payments are part of the paid plan; the company upgrades under Inställningar, Abonnemang.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    available: boolean,
    reason: "no_provider" | "not_in_pilot" | "subscription" | "sandbox" | null,
    provider: string | null,
    accounts: { cash_account_id: string, name: string | null, ledger_account: string, iban: string | null, bank_name: string | null, payable: boolean, reason: "account_disabled" | "not_sek" | "iban_missing" | "bank_unknown" | "bank_not_supported" | null }[],
    signer_known: boolean
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
    "available": true,
    "reason": null,
    "provider": "open_payments",
    "accounts": [
      {
        "cash_account_id": "41b0…",
        "name": "Företagskonto",
        "ledger_account": "1930",
        "iban": "SE35 **** 0003",
        "bank_name": "Swedbank",
        "payable": true,
        "reason": null
      }
    ],
    "signer_known": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/payment-orders/signing-link`

**The Betalningar page link where a person approves and signs bank payments, with what is waiting there.**
`scope:suppliers:read · risk:low · idempotent`

Answers the URL of the Betalningar page in Accounted (optionally with orders preselected), how many orders wait for approval, how many wait for a BankID signing, how many the bank holds, how many have an unknown bank outcome, and the company's verification at the provider when it answers. Approval and signing are a person's acts in Accounted; no door here does them.

**Use when:** After preparing payments, to hand the person the place where they sign; or to report what is waiting.
**Do not use for:** The orders themselves (GET /payment-orders).

**Pitfalls:**
- verification is null when the provider did not answer in time; it is informational here.
- verification.state says what to do: not_started, link_expired, expiring or expired call for POST /payment-orders/verification/start.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `payment_order_ids` | query | `string` | no | Comma-separated payment_order_id values to preselect on the page; omit for the page as it stands. |

Response `200`:
```ts
{
  data: {
    url: string,
    awaiting_approval: number,
    awaiting_signature: number,
    at_bank: number,
    outcome_unknown: number,
    verification: { status: "valid" | "invalid" | "unknown", valid_until: string | null, state: "not_started" | "form_open" | "awaiting_signatory" | "link_expired" | "valid" | "expiring" | "expired", link_expires_at: string | null } | null,
    note: string
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
    "url": "https://app.accounted.se/payments?orders=7c2e…",
    "awaiting_approval": 1,
    "awaiting_signature": 0,
    "at_bank": 0,
    "outcome_unknown": 0,
    "verification": {
      "status": "valid",
      "valid_until": "2027-10-03",
      "state": "valid",
      "link_expires_at": null
    },
    "note": "Approval and BankID signing happen in Accounted, by a person: open the url. No API or MCP door signs a payment."
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/payment-orders/unapprove`

**Take approved bank payments back to draft.**
`scope:suppliers:write · risk:low · idempotent · dry-run · reversible`

Moves approved orders back to draft so they can be edited or cancelled before signing. Only orders the bank does not have yet (status approved) can go back; anything submitted is cancelled instead (POST /payment-orders/{id}/cancel). All or nothing.

**Use when:** An attested payment should not be signed as it stands.
**Do not use for:** Stopping a payment the bank has (cancel) or removing a draft (cancel).

**Pitfalls:**
- PAYMENT_ORDERS_WRONG_STATUS: an order is not approved any more (details.unapproved lists what did move).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ payment_order_ids: string[] }
```

Example request:
```json
{
  "payment_order_ids": [
    "7c2e…"
  ]
}
```

Response `200`:
```ts
{
  data: { unapproved_payment_order_ids: string[] },
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
    "unapproved_payment_order_ids": [
      "7c2e…"
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/payment-orders/usage`

**Bank payments sent and accounts used in a month, against the monthly cap.**
`scope:suppliers:read · risk:low · idempotent`

Counts the payments that reached the provider (an order with a provider payment id) and the accounts they left from, in one month in Stockholm time, against what the company may send per month. Payments are capped: included_payments is the cap (10 a month unless raised for the company), remaining_payments what the month still takes, and a BankID signing that would pass the cap is refused with BANK_PAYMENTS_ALLOWANCE_EXCEEDED. Accounts are counted, not capped. Payment files are not counted. The month defaults to the current one.

**Use when:** Before a batch of bank payments, to see how many the month still takes.
**Do not use for:** Payment files (pain.001): they are not bank payments and are neither counted nor capped.

**Pitfalls:**
- A person asks for a higher cap under Settings, Connections, Bank payments; no API raises it.
- extra_payments is non-zero only when two signings raced past the cap or the cap was lowered mid-month; the counter is read from the orders, never edited.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period` | query | `string` | no | YYYY-MM in Stockholm time. Default: the current month. |

Response `200`:
```ts
{
  data: {
    period: string,
    payments_sent: number,
    accounts_used: number,
    included_payments: number,
    included_accounts: number,
    remaining_payments: number,
    extra_payments: number,
    extra_accounts: number
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
    "period": "2026-10",
    "payments_sent": 4,
    "accounts_used": 1,
    "included_payments": 10,
    "included_accounts": 2,
    "remaining_payments": 6,
    "extra_payments": 0,
    "extra_accounts": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/payment-orders/verification`

**The company's verification (know your customer) at the payment provider, and where it stands.**
`scope:suppliers:read · risk:low · idempotent`

Answers whether the provider has verified the company (status, valid_until) and the derived state: not_started, form_open, awaiting_signatory, link_expired, valid, expiring (within 30 days of valid_until), expired. Payments are refused until the status is valid. The stored answer is used when it is under six hours old; the provider is asked again when it is older or a form is out. A missing, expired or expiring verification is started or renewed with POST /payment-orders/verification/start, which answers a form link (valid 24 h) a signatory fills in and signs.

**Use when:** Bank payments are available but signing is refused for the company, before the first payment, or to see whether a renewal is due.
**Do not use for:** Whether payments are switched on at all (GET /payment-orders/availability).

**Pitfalls:**
- PAYMENT_PROVIDER_UNAVAILABLE is transient: the provider did not answer and nothing was on file; try again shortly.
- state link_expired: the 24-hour form link ran out unsigned; start again rather than re-sending the old link.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    status: "valid" | "invalid" | "unknown",
    valid_until: string | null,
    state: "not_started" | "form_open" | "awaiting_signatory" | "link_expired" | "valid" | "expiring" | "expired",
    link_expires_at: string | null
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
    "status": "valid",
    "valid_until": "2027-10-03",
    "state": "valid",
    "link_expires_at": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/payment-orders/verification/start`

**Start or renew the company's verification at the payment provider and get the form link.**
`scope:suppliers:write · risk:low · dry-run · reversible`

Creates a verification form at the provider and answers its link, which a person fills in and a signatory of the company signs with BankID. The link is valid 24 hours (expires_at); starting again makes a new form and a new link. The state is then form_open, or awaiting_signatory with handoff true (the link goes to a firmatecknare rather than the caller). The provider approves afterwards; read the result with GET /payment-orders/verification. Changes nothing in the books.

**Use when:** GET /payment-orders/verification answers a state of not_started, link_expired, expiring or expired.
**Do not use for:** Checking the status (GET /payment-orders/verification).

**Pitfalls:**
- The link is for a person who may sign for the company; it is not an API. Hand it over once and do not store it.
- A non-signatory can fill the form in and share it with a signatory to sign; pass handoff true when the link is for the signatory.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ handoff?: boolean }
```

Example request:
```json
{
  "handoff": true
}
```

Response `200`:
```ts
{
  data: {
    url: string,
    expires_at: string,
    state: "not_started" | "form_open" | "awaiting_signatory" | "link_expired" | "valid" | "expiring" | "expired"
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
    "url": "https://kyc.openbankingplatform.com/…",
    "expires_at": "2026-10-14T09:00:00.000Z",
    "state": "awaiting_signatory"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/payments/creditor-lookup`

**The name Bankgirot has registered for a bankgiro or plusgiro number, and whether an OCR passes its check.**
`scope:suppliers:read · risk:low · idempotent`

Asks Bankgirot (through the payment provider's premium Bankgiro Lookup) which name is registered for a bankgiro or plusgiro number before money goes there: the check against invoice fraud and typos. With the payment's OCR, ocr_valid says whether the creditor accepts it. Enabled only when the installation has switched the lookups on (OPENPAYMENTS_BANKGIRO_LOOKUP); otherwise enabled is false and nothing is asked. Advice, never a gate: a refusal is a typed reason, and the payment may still be prepared.

**Use when:** Before paying a supplier for the first time, when an invoice states another account than the supplier card, or when a new supplier card carries a giro: compare creditor_name with the supplier name.
**Do not use for:** The company's own giro numbers (GET /payments/giro-numbers). Bank accounts (clearing + account) or IBANs: Bankgirot does not register them.

**Pitfalls:**
- Every enabled call may cost a premium fee at the provider; answers are cached for ten minutes per company and question.
- A name that differs from the supplier card is a reason for a person to check with the supplier, not proof of fraud: companies register trade names.
- reason not_found means Bankgirot knows no such number: check the digits before paying.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `giro` | query | `string` | yes | The bankgiro or plusgiro number, as typed or stored (digits, spaces and dashes). |
| `type` | query | `"bankgiro" \| "plusgiro"` | yes | Which kind of giro number `giro` is. |
| `ocr` | query | `string` | no | The payment's OCR reference, when it has one: the creditor's OCR check runs on it and ocr_valid answers. |
| `invoice_ref` | query | `string` | no | The payment's free reference (the invoice number) when it has no OCR. Ignored when ocr is given. |

Response `200`:
```ts
{
  data: {
    enabled: boolean,
    available: boolean,
    reason: "premium_not_enabled" | "provider_refused" | "not_found" | "invalid_number" | "org_number_missing" | null,
    creditor_name: string | null,
    ocr_valid: boolean | null,
    warnings: { code: string, text: string | null }[]
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
    "enabled": true,
    "available": true,
    "reason": null,
    "creditor_name": "Derome Bygg AB",
    "ocr_valid": true,
    "warnings": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/payments/giro-numbers`

**The bankgiro and plusgiro numbers Bankgirot has registered to the company's own organisationsnummer.**
`scope:companies:read · risk:low · idempotent`

Asks Bankgirot (through the payment provider's premium Bankgiro Lookup) which giro numbers are registered to the company, so the invoice payee (the bankgiro printed on the company's invoices) can be picked from the registry instead of typed. Enabled only when the installation has switched the lookups on (OPENPAYMENTS_BANKGIRO_LOOKUP); otherwise enabled is false and nothing is asked.

**Use when:** Setting up or checking the bankgiro the company prints on its invoices (cash account payee details).
**Do not use for:** A supplier's giro (GET /payments/creditor-lookup). Reading the payee details already saved (GET /cash-accounts).

**Pitfalls:**
- Every enabled call may cost a premium fee at the provider; the answer is cached for ten minutes per company.
- An empty list with available true means Bankgirot has no giro registered to this organisationsnummer.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    enabled: boolean,
    available: boolean,
    reason: "premium_not_enabled" | "provider_refused" | "not_found" | "invalid_number" | "org_number_missing" | null,
    giro_numbers: { number: string, type: "bankgiro" | "plusgiro", name: string | null }[]
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
    "enabled": true,
    "available": true,
    "reason": null,
    "giro_numbers": [
      {
        "number": "5050-1055",
        "type": "bankgiro",
        "name": "Derome Bygg AB"
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/payments/signing-links`

**Ask someone without an Accounted login to sign approved bank payments with BankID: a signing link.**
`scope:suppliers:write · risk:medium · idempotent · dry-run`

Creates a link, valid 72 hours, to a page at /betala/<token> where the company's firmatecknare sees the basket (payee, amount, date and reference per payment, the account paying, who asked, the note) and signs it with BankID at their bank, without logging in to Accounted. The orders must be approved, from one account and in one currency; if any of them leaves approved before the signing (cancelled, signed or un-approved elsewhere) the page says so and signs nothing. The link is consumed when the signing finalises. With recipient_email it is mailed (template payment_signing_request); the url is answered either way. Owners and admins, or the person who prepared every order. Dry-runnable: ?dry_run=true answers the basket and mints nothing.

**Use when:** A byrå or an agent prepared supplier payments and a person approved them, but the client's firmatecknare signs at the bank.
**Do not use for:** Signing in person (the Betalningar page), approving drafts (POST /payment-orders/approve) or payment files.

**Pitfalls:**
- The url carries the credential: hand it to the signer only, once, and do not store it.
- PAYMENT_ORDERS_WRONG_STATUS: an order is not approved (details.orders); approve it first.
- PAYMENT_SIGNING_LINK_ALREADY_OPEN: another open link covers an order (details.signing_link_ids); it is cancelled on the Betalningar page.
- PAYMENT_ORDERS_MIXED_ACCOUNTS / PAYMENT_ORDERS_MIXED_CURRENCY: one link is one signing, from one account in one currency.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

Request body:
```ts
{ payment_order_ids: string[], recipient_email?: string | null, note?: string | null }
```

Example request:
```json
{
  "payment_order_ids": [
    "7c2e…"
  ],
  "recipient_email": "anna@example.se",
  "note": "Leverantörsbetalningar för oktober."
}
```

Response `200`:
```ts
{
  data: {
    signing_link_id: string,
    url: string,
    expires_at: string,
    email_sent: boolean,
    order_count: number,
    total_amount: number,
    currency: string
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
    "signing_link_id": "5d1a…",
    "url": "https://app.accounted.se/betala/…",
    "expires_at": "2026-10-17T09:00:00.000Z",
    "email_sent": true,
    "order_count": 1,
    "total_amount": 737.5,
    "currency": "SEK"
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
- status does not say whether an invoice is attested (an attested invoice past its due date is overdue): read approved_at, which kontantmetoden companies leave null (no attest step there). bank_entered_at is set while a payment entered at the bank by hand has not landed; it clears itself when a payment is recorded on the invoice.
- An invoice a bank payment or a payment file already covers keeps its status (approved, overdue) and remaining_amount until the payment lands: read open_payment, null when nothing covers it. payment_order.provider_status RCVD means the payment waits at the bank unsigned.
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
  data: { id: string, handle?: string, supplier_id: string, supplier_name: string, arrival_number: number, supplier_invoice_number: string | null, invoice_date: string, due_date: string, status: "registered" | "approved" | "paid" | "partially_paid" | "overdue" | "disputed" | "credited" | "reversed", currency: string, subtotal: number, vat_amount: number, total: number, paid_amount: number, remaining_amount: number, is_credit_note: boolean, is_self_billed: boolean, self_billing_number: number | null, self_billing_agreement_ref: string | null, paid_at: string | null, approved_at: string | null, bank_entered_at: string | null, created_at: string, open_payment: { batch: { id: string, created_at: string } | null, payment_order: { id: string, status: "draft" | "approved" | "submitted" | "awaiting_signature" | "awaiting_second_signer" | "accepted" | "executed" | "rejected" | "cancelled" | "failed", created_at: string, provider_status: string | null, provider_error_code: string | null } | null } | null }[],
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
      "approved_at": null,
      "bank_entered_at": null,
      "created_at": "2026-05-13T15:00:00Z",
      "open_payment": null
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

Creates a supplier invoice in `registered` status and posts the registration journal entry under faktureringsmetoden (Debit expense + Debit 2641 Ingående moms / Credit 2440 Leverantörsskulder). Under kontantmetoden no JE is posted at this stage, except for an EU goods acquisition (reverse_charge_kind eu_goods): ML 2023:200 7 kap. 26 § puts its reverse-charge moms in the period the invoice is issued whatever the accounting method, so it is booked like under faktureringsmetoden and its payment clears 2440. Under both methods an EU goods registration is dated on the invoice date, or on the 15th of the month after delivery_date when that is earlier (7 kap. 26 §: the moms belongs at the latest to the period holding that day); send delivery_date to apply it. Under defer_invoice_booking (faktureringsmetoden, Registrera men bokför inte) no JE is posted either: book it afterwards with POST /supplier-invoices/{id}/book. Idempotent (mandatory Idempotency-Key). Dry-runnable.

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
- Underlag: upload the invoice PDF with POST /documents first and pass its id as document_id. The document is stored on the invoice and linked to the registration verifikat. A document that is missing, belongs to another company, or is already linked returns 400 SI_CREATE_INVALID_INPUT.
- Paid privately (eget utlägg): set paid_with_private_funds=true. The invoice is registered as paid and one verifikat books the expense against the payer: the owner (2893 AB, 2018 EF; claimant_name names them) or an employee (employee_id, 2820). payment_date is the out-of-pocket date (defaults to invoice_date). inbox_item_id takes the underlag from an inbox item and is only accepted on this path. With reverse charge the verifikat also books the fiktiv moms and basis pair the registration would, and the payer is owed the net. Not combinable with periodisering.
- Reverse charge from a supplier in another EU country books the basis pair as services (4535/4598, momsdeklaration ruta 21) unless reverse_charge_kind says "eu_goods" (4515/4598, ruta 20); the fiktiv moms on 2645/2614 is the same. reverse_charge_kind on an invoice without reverse charge, or from a supplier that is not eu_business, returns 400 SI_CREATE_INVALID_INPUT.
- Periodisering: items[].accrual_period_start + accrual_period_end (and optionally accrual_balance_account, defaulting from the cost account to a 17xx förutbetald kostnad) spread the cost over the period under faktureringsmetoden. Refused under kontantmetoden and with reverse charge. A 29xx accrual_balance_account (e.g. 2990) books an upplupen kostnad: a period wholly before the invoice month (a period reaching that month returns 400 VALIDATION_ERROR: split the line), each month booked on its last day (debit cost / credit 29xx) right after the registration, which debits 29xx on the invoice date. A month that is locked, closed, on or before the company lock date or without a fiscal year refuses the whole registration with 400 SI_ACCRUED_COST_PERIOD_LOCKED (details.blocked); nothing is written.
- A company that is not VAT-registered cannot book input VAT: a line with vat_rate or vat_amount above 0 returns 400 SI_CREATE_INVALID_INPUT, and an omitted vat_rate defaults to 0. items[].vat_amount overrides line_total × vat_rate (partial deduction, rounding on the supplier's side).
- VAT is booked per rate the way the invoice states it: on the summed base of each rate (not rounded line by line), or the per-rate figure in vat_breakdown ([{ vat_rate: 0.25, vat_amount: 3864.11 }]) when it lies within half an öre per line of that. The figure is spread over the lines (items[].vat_amount in the response, at most one öre from each line's own rounding) so they sum to it. A figure further off, a rate the lines do not carry or leave out, or a rate with an items[].vat_amount override returns 400 VAT_BREAKDOWN_MISMATCH.
- due_date is optional: omitted, it is invoice_date plus the supplier's default_payment_terms (30 days when unset).
- Självfaktura (self-billing, ML 17 kap 15 §): set is_self_billed=true and omit supplier_invoice_number. The company issues the invoice in the supplier's name: the number comes from the company's own series (company_settings.self_billing_prefix, SF-001, SF-002, ...), and the document (with "Självfakturering", the agreement and the acceptance clause) is archived as the underlag; download it with GET /supplier-invoices/{id}/self-billing-pdf. The agreement is self_billing_agreement_ref, defaulting to the supplier's; none gives 400 SI_SELF_BILL_AGREEMENT_MISSING. A supplier or company card missing a name, address, the seller's VAT number or the buyer's org number gives 400 SI_SELF_BILL_PARTY_INCOMPLETE. SEK only, standard Swedish VAT only, no reverse charge, no document_id, inbox_item_id or paid_with_private_funds: 400 SI_SELF_BILL_UNSUPPORTED (details.reason).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  supplier_id: string,
  document_id?: string,
  supplier_invoice_number?: string,
  is_self_billed?: boolean,
  self_billing_agreement_ref?: string,
  invoice_date: string,
  due_date?: string,
  delivery_date?: string | "",
  currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD",
  exchange_rate?: number,
  vat_treatment?: "standard_25" | "reduced_12" | "reduced_6" | "reverse_charge" | "export" | "exempt",
  reverse_charge?: boolean,
  reverse_charge_kind?: "eu_goods" | "eu_services",
  payment_reference?: string,
  notes?: string,
  ore_rounding?: boolean,
  paid_with_private_funds?: boolean,
  employee_id?: string | null,
  claimant_name?: string,
  inbox_item_id?: string | null,
  payment_date?: string,
  default_dimensions?: Record<string, string>,
  vat_breakdown?: { vat_rate: 0 | 0.06 | 0.12 | 0.25, vat_amount: number }[],
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
    handle?: string,
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
    is_self_billed: boolean,
    self_billing_number: number | null,
    self_billing_agreement_ref: string | null,
    document_id: string | null,
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
- A self-billing invoice (is_self_billed=true) is one the company issued in the supplier's name: supplier_invoice_number is the company's own series number and the document is GET .../self-billing-pdf.
- registration_journal_entry_id and payment_journal_entry_id let you trace the SI to its bokföring rows; they are null when no JE has been posted (e.g. on a kontantmetoden SI before payment).
- status does not say whether an invoice is attested (an attested invoice past its due date is overdue): read approved_at, which kontantmetoden companies leave null (no attest step there). bank_entered_at is set while a payment entered at the bank by hand has not landed; it clears itself when a payment is recorded on the invoice.

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
    handle?: string,
    supplier_id: string,
    arrival_number: number,
    supplier_invoice_number: string | null,
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
    reverse_charge_kind: "eu_goods" | "eu_services" | null,
    paid_amount: number,
    remaining_amount: number,
    is_credit_note: boolean,
    credited_invoice_id: string | null,
    is_self_billed: boolean,
    self_billing_number: number | null,
    self_billing_agreement_ref: string | null,
    registration_journal_entry_id: string | null,
    payment_journal_entry_id: string | null,
    notes: string | null,
    approved_at: string | null,
    bank_entered_at: string | null,
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
  notes?: string,
  auto_debit?: boolean
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
    handle?: string,
    supplier_id: string,
    arrival_number: number,
    supplier_invoice_number: string | null,
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
    reverse_charge_kind: "eu_goods" | "eu_services" | null,
    paid_amount: number,
    remaining_amount: number,
    is_credit_note: boolean,
    credited_invoice_id: string | null,
    is_self_billed: boolean,
    self_billing_number: number | null,
    self_billing_agreement_ref: string | null,
    registration_journal_entry_id: string | null,
    payment_journal_entry_id: string | null,
    notes: string | null,
    approved_at: string | null,
    bank_entered_at: string | null,
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

### `DELETE /api/v1/companies/{companyId}/supplier-invoices/{id}`

**Delete an unbooked, unpaid supplier invoice (no verifikat, no payment).**
`scope:suppliers:write · risk:medium · idempotent · dry-run`

Removes a supplier invoice that never reached the books: status registered, approved or overdue, no registration verifikat, no payment, no accrual schedule and no payment-batch row. Its lines go with it. A booked invoice is never deleted: withdraw it with a credit note (POST /supplier-invoices/{id}/credit), which keeps both verifikat in the audit trail (BFL 5 kap 5 §). Idempotent. Dry-runnable.

**Use when:** A supplier invoice was registered by mistake (a duplicate, the wrong company, a quote) under defer_invoice_booking or kontantmetoden, so no verifikat exists yet.
**Do not use for:** Booked invoices (credit them), credit notes (undo the credit on the original: POST /supplier-invoices/{id}/uncredit) or discarding an inbox item (DELETE /inbox-items/{id}).

**Pitfalls:**
- An invoice with a registration verifikat, a payment or an accrual schedule answers 400 SI_DELETE_HAS_BOOKING with details.reason (registration_journal_entry, payments, accrual_schedule).
- A credit note answers 400 SI_DELETE_CREDIT_NOTE; paid, partially paid or credited invoices answer 400 SI_DELETE_INVALID_STATUS.
- An invoice in a payment batch (even a cancelled one) answers 409 SI_DELETE_IN_PAYMENT_BATCH: the batch rows document the payment instruction.
- The ankomstnummer the invoice held is not reused.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

Response `200`:
```ts
{
  data: { supplier_invoice_id: string, deleted: true },
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
    "supplier_invoice_id": "3b4c…",
    "deleted": true
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

Attests a supplier invoice that has not been approved yet (status `registered` or `overdue`) as the API key's user. With the company's attest policy on (GET /supplier-invoices/attest-policy) only its attesters may attest, the registrant not unless the policy allows it, and in mode `all` the invoice is attested only when every attester has approved: until then the status stays and `attest.remaining_user_ids` names who is left. The resulting status is `approved`, or `overdue` when the invoice is still past its due date. No journal entry is posted here: the registration JE was already booked at :create under accrual (or, under defer_invoice_booking, is posted by POST /supplier-invoices/{id}/book), or is deferred to :mark-paid under cash. Idempotent. Dry-runnable.

**Use when:** A registered SI has been reviewed and you want to mark it ready for payment. With the attest policy on, payments leave an unattested invoice out (attest_required).
**Do not use for:** Posting a journal entry (already done at :create under accrual). Paying the SI (use :mark-paid). Re-approving an already-approved SI (returns 400 SI_APPROVE_NOT_REGISTERED).

**Pitfalls:**
- Idempotency-Key is mandatory.
- Returns 400 SI_APPROVE_NOT_REGISTERED when the invoice is already approved (approved_at set) or sits in a settled status. Use the detail endpoint to inspect status first if unsure.
- Returns 403 ATTEST_NOT_ALLOWED when the attest policy does not let this user attest the invoice (not an attester, or the registrant), and 409 ATTEST_ALREADY_GIVEN when the user already attested it in this round.
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
    handle?: string,
    status: "approved" | "overdue" | "registered",
    arrival_number: number,
    supplier_invoice_number: string | null,
    approved_at: string | null,
    attest: { approved: boolean, required: boolean, remaining_user_ids: string[] }
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
    "supplier_invoice_number": "2026-1234",
    "approved_at": "2026-10-14T09:00:00.000Z",
    "attest": {
      "approved": true,
      "required": true,
      "remaining_user_ids": []
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/supplier-invoices/{id}/attestations`

**Where the attest of one supplier invoice stands: who attested, who is left, every decision.**
`scope:suppliers:read · risk:low · idempotent`

Answers whether the attest policy requires attest for the invoice, whether it is satisfied, the attesters who approved in the current round and those still missing, the latest rejection with its comment, every decision (approved or rejected, who, when, source app / email_link / api / mcp) and whether the API key's user may approve or reject it now. A rejection starts a new round: approvals before it no longer count.

**Use when:** An invoice is left out of payment with attest_required, or before attesting.
**Do not use for:** The policy itself (GET /supplier-invoices/attest-policy).

**Pitfalls:**
- An invoice of another company answers 404 SI_NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    supplier_invoice_id: string,
    required: boolean,
    satisfied: boolean,
    blocked: boolean,
    approved_at: string | null,
    approved_by: { user_id: string, name: string | null, email: string | null } | null,
    approved: { user_id: string, name: string | null, email: string | null }[],
    remaining: { user_id: string, name: string | null, email: string | null }[],
    latest_rejection: { user: { user_id: string, name: string | null, email: string | null }, comment: string | null, decided_at: string } | null,
    attestations: { attestation_id: string, user: { user_id: string, name: string | null, email: string | null }, decision: "approved" | "rejected", comment: string | null, source: "app" | "email_link" | "api" | "mcp", decided_at: string }[],
    viewer: { may_approve: boolean, may_reject: boolean, reason: string | null }
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
    "supplier_invoice_id": "0e9c…",
    "required": true,
    "satisfied": false,
    "blocked": false,
    "approved_at": null,
    "approved_by": null,
    "approved": [],
    "remaining": [
      {
        "user_id": "3f0c…",
        "name": "Anna Ek",
        "email": "anna@example.se"
      }
    ],
    "latest_rejection": null,
    "attestations": [],
    "viewer": {
      "may_approve": false,
      "may_reject": false,
      "reason": "registrant"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/supplier-invoices/{id}/bank-entered`

**Mark a supplier invoice as entered in the internet bank ("inlagd i banken"), or clear the mark.**
`scope:suppliers:write · risk:low · idempotent · dry-run · reversible`

Records that the payment was entered in the bank by hand, so the invoice stops showing as waiting to be paid. A mark, not a payment: it books nothing and changes no amount or status; the payment is still recorded by :mark-paid or the bank match, and the mark clears itself when one of those lands. entered=true needs an unpaid, payable invoice (approved, overdue, partially_paid, and registered under kontantmetoden, which has no attest step; never a credit note); entered=false clears it in any status. Marking an already marked invoice keeps the first timestamp. Idempotent. Dry-runnable.

**Use when:** The user paid the invoice by typing it into the internet bank (not through a betalfil) and wants the list to say so until the bank transaction arrives.
**Do not use for:** Recording the payment itself (POST /supplier-invoices/{id}/mark-paid) or payment batches (betalfil).

**Pitfalls:**
- A registered invoice still waiting for attest (faktureringsmetoden), a paid or credited invoice, or a credit note, answers 400 SI_BANK_ENTERED_NOT_PAYABLE with details.currentStatus.
- details.reason race means a payment landed between the read and the write: reload.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ entered: boolean }
```

Example request:
```json
{
  "entered": true
}
```

Response `200`:
```ts
{
  data: { supplier_invoice_id: string, bank_entered_at: string | null },
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
    "supplier_invoice_id": "3b4c…",
    "bank_entered_at": "2026-09-06T10:00:00.000Z"
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

For companies with defer_invoice_booking=true (Registrera men bokför inte): POST /supplier-invoices registers the invoice without posting anything, and this step posts the registration verifikat afterwards (Debit cost accounts per line + 2641 ingående moms, or fiktiv moms for reverse charge; Credit 2440 Leverantörsskulder; periodiserade lines on 17xx or 29xx with their schedules). Dated on the invoice date. An upplupen kostnad (29xx line) books each month of its period on the last day of that month right after; a month that cannot take the entry refuses the booking with SI_ACCRUED_COST_PERIOD_LOCKED before anything is posted. The invoice is claimed with a compare-and-set, so a concurrent book, payment or credit cancels this entry instead of double-posting. The retained source document is anchored to the verifikat. Idempotent. Dry-runnable: the dry run previews the exact lines and writes nothing.

**Use when:** A supplier invoice is registered, approved or overdue, has no registration_journal_entry_id, and the company books supplier invoices in a separate step (defer_invoice_booking).
**Do not use for:** Paid or partially paid invoices (a payment books the registration first through this step; a kontantmetoden payment books the whole invoice), credit notes, or any supplier invoice under kontantmetoden (booked at payment via :mark-paid).

**Pitfalls:**
- An invoice that already has a registration_journal_entry_id answers 400 SI_BOOK_ALREADY_BOOKED.
- Status other than registered, approved or overdue answers 400 SI_BOOK_INVALID_STATUS with details.currentStatus.
- Under kontantmetoden answers 400 SI_BOOK_CASH_METHOD.
- A locked or closed period, or an invoice date on or before the company lock date (bookkeeping_locked_through), answers 400 PERIOD_LOCKED with details.reason, details.fiscal_period_id and details.invoice_date. Nothing is generated, so no voucher number is spent: unlock the period (only if the user asked for that correction) and retry.
- No open fiscal year covering the invoice date answers 400 SI_BOOK_NO_FISCAL_PERIOD.
- Booking does not attest the invoice: :approve is a separate step and may come before or after.
- Settling an unbooked invoice (mark-paid, a bank match, a samlingsbetalning, a link to an existing verifikat) runs this step first and refuses the payment with its code when it refuses: there is no need to call it before paying, and no way to pay around it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

Response `200`:
```ts
{
  data: {
    supplier_invoice: { id: string, handle?: string, arrival_number: number | null, supplier_invoice_number: string | null, status: string, invoice_date: string, due_date: string | null, currency: string, total: number, registration_journal_entry_id: string | null },
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

Creates a kreditfaktura that reverses the whole original supplier invoice. When the original reached the ledger the reversing JE is posted on the credit note's date (Debit 2440 / Credit expense + Credit 2641). The original status flips to `credited`; periodisering schedules on it stop. With inbox_item_id (a supplier's credit note in the inbox) the credit note carries that document's date, number and file as underlag, and the item is marked handled. Idempotent. Dry-runnable.

**Use when:** The supplier sent a credit note for a whole registered, approved, partially_paid or paid invoice (pass inbox_item_id when it is in the inbox), or you need to nullify such an invoice (a returned shipment, a vendor dispute resolution). Use dry-run to confirm the totals first.
**Do not use for:** A credit note for PART of an invoice (400 SI_CREDIT_PARTIAL: this always reverses the whole invoice). Editing line items on an unchanged invoice (use PATCH on `registered` SIs). Crediting an already-credited SI (409 SI_CREDIT_ALREADY_CREDITED); undo a credit with POST /supplier-invoices/{id}/uncredit.

**Pitfalls:**
- Idempotency-Key is mandatory.
- The credit note is dated credit_date, else the inbox item's credit note date, else today (Stockholm). That date must fall in an open fiscal period: a locked one returns 400 SI_CREDIT_PERIOD_LOCKED and is never re-dated for you.
- With inbox_item_id the credit note must be from the invoice's supplier and for its whole total in its currency: otherwise 400 SI_CREDIT_PARTIAL or SI_CREDIT_DOCUMENT_MISMATCH (details carry both totals). A credit_date or document date before the invoice date is a 400 VALIDATION_ERROR.
- The reversal is built from the invoice's stored rows. Rows that do not add up to the invoice total, or no rows at all (typically an invoice imported from another system), return 409 SI_CREDIT_ROWS_MISMATCH with details.rows_payable_sek and details.invoice_payable_sek, on a dry run too and before anything is written. Do not retry: book the credit note as a verifikat of its own (debit 2440 by the invoice total, credit the cost accounts and 2641), then settle a still unpaid invoice against that verifikat in the app or with the MCP tool gnubok_link_supplier_invoice_to_voucher.
- Cash basis (kontantmetoden): an unpaid original gets no reversing JE; recognition waits for the refund. The credit-note row is still created so the AP audit trail stays consistent.
- The original SI is flipped to `credited` regardless of how much of it was already paid; reconcile the bank refund via the transactions endpoints.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  credit_date?: string,
  supplier_credit_note_number?: string,
  document_id?: string,
  inbox_item_id?: string
}
```

Example request:
```json
{
  "inbox_item_id": "1b2c…"
}
```

Response `200`:
```ts
{
  data: {
    credit_note_id: string,
    original_id: string,
    arrival_number: number,
    supplier_invoice_number: string | null,
    invoice_date: string,
    registration_journal_entry_id: string | null,
    document_id: string | null,
    inbox_item_id: string | null
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
    "supplier_invoice_number": "K-10045",
    "invoice_date": "2026-09-18",
    "registration_journal_entry_id": "9c2f…",
    "document_id": "4f1c…",
    "inbox_item_id": "1b2c…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/supplier-invoices/{id}/items/{itemId}`

**Move one supplier-invoice line to another account, correcting the registration verifikat inline.**
`scope:suppliers:write · risk:high · idempotent · dry-run · reversible`

Changes the account of one line on an unsettled supplier invoice (registered, approved, overdue). When the invoice has a posted registration verifikat, the same verifikat is corrected inside itself through the inline rättelse (the old line is struck and replaced, split when the verifikat carries one line per account), logged with who and when (BFL 5 kap 5 §); that is only allowed in an open, unlocked period. Without a verifikat only the line changes. A standard BAS account missing from the chart is added. Idempotent. Dry-runnable: the preview carries the planned rättelse lines.

**Use when:** A supplier invoice line was booked on the wrong cost account (e.g. 6580 instead of 6550) and the period is still open.
**Do not use for:** Settled invoices (paid, credited), locked or closed periods (storno through POST /journal-entries/{id}/reverse and a new verifikat), or changing amounts or VAT.

**Pitfalls:**
- A settled invoice answers 409 SI_ITEM_ACCOUNT_SETTLED.
- A locked or closed period answers 409 JOURNAL_RATTELSE_PERIOD_LOCKED: past a lock, storno is the only lawful correction.
- When the verifikat was already corrected by hand and holds no matching line on the old account, the answer is 409 SI_ITEM_ACCOUNT_NO_MATCHING_LINE and nothing changes.
- A foreign-currency line moves the kronor the registration booked (the line at the invoice's stored rate); an invoice without that rate answers 409 SI_ITEM_ACCOUNT_FX_RATE_UNKNOWN and nothing changes.
- account_number is a STRING ("6550"), never a number.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `itemId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

Request body:
```ts
{ account_number: string }
```

Example request:
```json
{
  "account_number": "6550"
}
```

Response `200`:
```ts
{
  data: { changed: boolean, corrected?: boolean },
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
    "changed": true,
    "corrected": true
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
- Foreign-currency SIs under accrual: amount is in the invoice currency and the verifikat is in SEK. The SEK cleared off 2440 is read from the ledger (the registration verifikat minus earlier payments), never computed by the caller; an SI with no registration verifikat (migrated) clears at its own exchange_rate, and one with no rate either returns 400 SI_FX_RATE_MISSING. State what the payment cost in SEK with amount_sek (the SEK that left the payment account; the difference to the cleared SEK books on 3960 gain / 7960 loss) or with exchange_rate_difference (cleared SEK minus paid SEK; 0 for none). One of the two is required, not both.
- Foreign-currency SI whose linked vouchers contradict each other (a batch voucher shared with another invoice, payment rows that do not add up to paid_amount, a registration or payment voucher reversed with no single correction), or whose 2440 balance is more than 10% away from remaining_amount x exchange_rate (reason ledger_rate_mismatch: the registration was corrected for something other than the rate), or whose history is longer than one request resolves (reason ledger_history_too_long: more than 50 payment rows or 20 storno hops), returns 409 SI_PAID_SEK_UNRESOLVED with details.reason and books nothing. Check the SEK against the ledger and resend with explicit SEK lines.
- Kontantmetoden company paying an SI that was registered on 2440 (booked at receipt, before a switch of method): the payment clears 2440 like under faktureringsmetoden, so a foreign-currency one needs amount_sek or exchange_rate_difference too. Only an SI never registered gets the cash entry (expense + ingående moms at payment).
- Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): an SI registered without its verifikat is booked first by the :book step (Debit cost + 2641 / Credit 2440, dated on the invoice date, periodiseringar included), then the payment clears that 2440. registration_journal_entry_id in the response names it, and the dry run returns it as registration_journal_entry. When the book step refuses (invoice date in a locked period PERIOD_LOCKED, no fiscal year SI_BOOK_NO_FISCAL_PERIOD, a locked accrual month SI_ACCRUED_COST_PERIOD_LOCKED, a partially paid SI SI_BOOK_INVALID_STATUS), the payment is refused with that code, details.registration_first is true, and nothing is booked.
- Strict-mode: a JE creation failure ABORTS before the status flip. There is no partial-state recovery banner: retry the call.
- Cash basis (kontantmetoden) recognizes the expense + ingående moms HERE, not at :create.
- Cash basis + öresavrundning: a SEK invoice with ore_rounding on and an öre-bearing total is paid in whole kronor, so the generated entry credits the payment account with the rounded amount and books the residual on 3740 (no VAT). amount, paid_amount and remaining_amount stay in exact öre. Invoices whose rounding is already an invoice row on 3740 have a whole-krona total and are unaffected.
- payment_account picks the BAS account credited for the payment (1930 Företagskonto when omitted, on both the accrual and the cash path). It must be active in the chart of accounts: an unknown or deactivated account returns 400 ACCOUNTS_NOT_IN_CHART and books nothing. Beyond that it is credited exactly as given, with no range check: 19xx bank or kassa is the ordinary choice, but 1630 (betald via skattekontot) and 2893 / 2018 / 2820 (someone else paid, utlägg) are equally valid, so choosing an account that does not represent where the money actually came from is the caller's error to avoid. Unlike the dashboard dialog, this endpoint does not read the company's last-used payment account: omitting the field always means 1930.
- An invoice with a bank payment order that is signed or being signed (awaiting_signature, awaiting_second_signer, accepted) returns 409 SI_BANK_PAYMENT_UNDER_WAY, also under dry-run and with no force: the bank still pays it. Let that payment settle the invoice, or cancel the order first.
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
  amount_sek?: number,
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
    handle?: string,
    status: "paid" | "partially_paid",
    total: number,
    paid_amount: number,
    remaining_amount: number,
    paid_at: string | null,
    payment_journal_entry_id: string | null,
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
    "id": "0e9c…",
    "status": "paid",
    "total": 1250,
    "paid_amount": 1250,
    "remaining_amount": 0,
    "paid_at": "2026-05-13",
    "payment_journal_entry_id": "7b3a…",
    "registration_journal_entry_id": "5d1f…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/supplier-invoices/{id}/reject`

**Reject (neka) the attest of a supplier invoice that waits for it, with an optional comment.**
`scope:suppliers:write · risk:low · idempotent · dry-run`

Records the rejection and its comment in the attest trail as the API key's user. The attest round starts over: approvals given so far no longer count, and the attest mail's links for the invoice stop working. The invoice stays registered (or overdue past its due date); nothing is booked or paid. Whoever may approve may reject: with the attest policy on only its attesters, not the registrant unless the policy allows it. Idempotency-Key is mandatory: a replay answers the first call. Dry-runnable.

**Use when:** An attester does not accept the invoice (wrong amount, not ordered, wrong supplier) and the registrant should look again.
**Do not use for:** Withdrawing a booked invoice (POST /supplier-invoices/{id}/credit) or deleting an unbooked one.

**Pitfalls:**
- ATTEST_NOT_PENDING: the invoice is already attested or settled.
- ATTEST_NOT_ALLOWED: the attest policy does not let this user decide on the invoice.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ comment?: string | null }
```

Example request:
```json
{
  "comment": "Fel belopp, kontakta leverantören."
}
```

Response `200`:
```ts
{
  data: { supplier_invoice_id: string, attestation_id: string, status: string },
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
    "supplier_invoice_id": "0e9c…",
    "attestation_id": "9a1b…",
    "status": "registered"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/supplier-invoices/{id}/self-billing-pdf`

**Download the self-billing invoice (självfaktura) PDF.**
`scope:suppliers:read · risk:low · idempotent`

Returns the self-billing invoice the company issued in the supplier's name as application/pdf: "Självfakturering", the number from the company's own series, both parties, the agreement and the acceptance clause. A credit note of one renders as its kreditfaktura.

**Use when:** You need the document of a self-billing invoice (is_self_billed=true) to send to the supplier or archive outside Accounted.
**Do not use for:** An ordinary supplier invoice: its document is the supplier's own, in the document archive (document_id). That answers 404.

**Pitfalls:**
- Only for is_self_billed=true; any other supplier invoice answers 404 SI_NOT_FOUND.
- Rendered from the parties frozen at issue, so later changes to the supplier card or the company settings do not change it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200` (`application/pdf`).

---

### `POST /api/v1/companies/{companyId}/supplier-invoices/{id}/uncredit`

**Undo the credit of a supplier invoice ("Ångra kreditering"): storno the credit note's verifikat and restore the invoice.**
`scope:suppliers:write · risk:high · idempotent · dry-run`

For an original supplier invoice with status credited: posts a storno cancelling the live credit note's verifikat (dated on that verifikat's date, never an edit or delete), marks the credit note reversed (the row is kept for the archive and the ankomstnummer series), and restores the original's status and remaining amount from its payments (paid, partially_paid, overdue, approved, or registered when it has no verifikat). The invoice can be credited again afterwards. An invoice that is not credited is an idempotent no-op (changed=false). Dry-runnable: the preview names the storno and the restored status.

**Use when:** A supplier invoice was credited by mistake and the credit should be taken back.
**Do not use for:** Crediting an invoice (POST /supplier-invoices/{id}/credit), deleting an unbooked invoice (DELETE /supplier-invoices/{id}) or reversing an arbitrary verifikat.

**Pitfalls:**
- Pass the ORIGINAL invoice id, not the credit note's.
- The credit note's verifikat must lie in an open, unlocked period: otherwise the dry run answers 400 PERIOD_LOCKED and the commit 400 SI_UNCREDIT_FAILED.
- A credit verifikat already reversed by hand is fine: the row cleanup still runs and reversal_entry_id is null.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

Response `200`:
```ts
{
  data: {
    supplier_invoice: { supplier_invoice_id: string, arrival_number: number | null, supplier_invoice_number: string | null, status: string, invoice_date: string, due_date: string | null, currency: string, total: number, remaining_amount: number | null, registration_journal_entry_id: string | null },
    reversal_entry_id: string | null,
    reversed_credit_note_id: string | null,
    changed: boolean
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
      "supplier_invoice_id": "3b4c…",
      "arrival_number": 118,
      "supplier_invoice_number": "55012",
      "status": "approved",
      "invoice_date": "2026-09-03",
      "due_date": "2026-10-03",
      "currency": "SEK",
      "total": 6250,
      "remaining_amount": 6250,
      "registration_journal_entry_id": "6d7e…"
    },
    "reversal_entry_id": "9a8b…",
    "reversed_credit_note_id": "5c6d…",
    "changed": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/supplier-invoices/attest-policy`

**Read the company's attest policy for supplier invoices.**
`scope:suppliers:read · risk:low · idempotent`

Whether the policy is on, the amount in SEK from which attest is required (null = every invoice), the attesters, mode any (one attester is enough) or all (every attester who may attest the invoice), and whether the person who registered an invoice may attest it. With the policy on, an invoice that needs attest is left out of bank payments and payment files until the policy is satisfied. Kontantmetoden has no attest step and the policy does not apply there.

**Use when:** Before attesting or preparing payments: who may attest, and why an invoice waits.
**Do not use for:** Where one invoice's attest stands (GET /supplier-invoices/{id}/attestations).

**Pitfalls:**
- A company that never saved a policy answers enabled false with no attesters.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    enabled: boolean,
    threshold_amount: number | null,
    mode: "any" | "all",
    attesters: { user_id: string, name: string | null, email: string | null }[],
    preparer_may_attest: boolean,
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
    "enabled": true,
    "threshold_amount": 5000,
    "mode": "any",
    "attesters": [
      {
        "user_id": "3f0c…",
        "name": "Anna Ek",
        "email": "anna@example.se"
      }
    ],
    "preparer_may_attest": false,
    "updated_at": "2026-10-14T09:00:00.000Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PUT /api/v1/companies/{companyId}/supplier-invoices/attest-policy`

**Save the company's attest policy for supplier invoices.**
`scope:suppliers:write · risk:high · idempotent · dry-run · reversible`

Replaces the policy: enabled, threshold_amount (SEK, null = every invoice), mode any or all, the attesters (company members who may write) and preparer_may_attest. With it on, POST /supplier-invoices/{id}/approve only accepts the attesters (not the registrant unless preparer_may_attest), approved_at is set when the policy is satisfied, and payments leave an invoice out until then (attest_required). Owners and admins only. Idempotent. Dry-runnable.

**Use when:** Setting up or changing who attests supplier invoices.
**Do not use for:** Attesting an invoice (POST /supplier-invoices/{id}/approve).

**Pitfalls:**
- ATTEST_POLICY_NO_ATTESTERS: a policy that is on needs at least one attester.
- ATTEST_POLICY_ATTESTER_NOT_MEMBER: every attester must be a member who may write; details.user_ids names the others.
- FORBIDDEN: only an owner or admin saves the policy.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  enabled: boolean,
  threshold_amount: number | null,
  mode: "any" | "all",
  attesters: string[],
  preparer_may_attest?: boolean
}
```

Example request:
```json
{
  "enabled": true,
  "threshold_amount": 5000,
  "mode": "any",
  "attesters": [
    "3f0c…"
  ],
  "preparer_may_attest": false
}
```

Response `200`:
```ts
{
  data: {
    enabled: boolean,
    threshold_amount: number | null,
    mode: "any" | "all",
    attesters: { user_id: string, name: string | null, email: string | null }[],
    preparer_may_attest: boolean,
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
    "enabled": true,
    "threshold_amount": 5000,
    "mode": "any",
    "attesters": [
      {
        "user_id": "3f0c…",
        "name": "Anna Ek",
        "email": "anna@example.se"
      }
    ],
    "preparer_may_attest": false,
    "updated_at": "2026-10-14T09:00:00.000Z"
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
    supplier_payment_batches: { supplier_payment_batch_id: string, handle?: string, format: "pain001" | "bg_lb", status: "created" | "cancelled", currency: string, total_amount: number, item_count: number, settled_count: number, msg_id: string, file_generated_at: string | null, download_count: number, created_at: string, cancelled_at: string | null, supplier_invoice_ids: string[] }[],
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

**Create a supplier payment file (betalfil: pain.001, or an LB file for Svea Bank) for one or more supplier invoices.**
`scope:suppliers:write · risk:high · idempotent · dry-run`

Creates a payment batch: an immutable snapshot of one credit transfer per invoice (amount, payment date, the supplier's bankgiro / plusgiro / bank account, OCR or invoice-number reference) and the company's own bank details as debtor, with a pain.001 MsgId fixed at creation. The file takes the form the company's bank accepts (format: pain001, or bg_lb, Bankgirot's LB file, for Svea Bank, which takes no pain.001). Every invoice is re-read and re-checked inside one transaction, so an invoice settled or already batched meanwhile is refused. Books nothing and marks nothing paid. Download the file with GET /supplier-payment-batches/{id}/file and upload it in the bank, where the payments are signed; afterwards settle each invoice with mark-paid or bank matching. Idempotent. Dry-runnable.

**Use when:** The user wants to pay approved supplier invoices through their bank's file upload (typically the weekly or monthly payment run).
**Do not use for:** Marking invoices paid (POST /supplier-invoices/{id}/mark-paid), paying salaries (salary-runs/{id}/payment-file) or sending anything to the bank: this only produces the file.

**Pitfalls:**
- Money leaves the company's account once the file is uploaded and signed in the bank: preview first (POST /supplier-payment-batches/preview) and check amounts and payees.
- An invoice already in an active batch answers 409 SI_BATCH_DUPLICATE_INVOICE with details.invoices; resend with confirm_already_batched true only when paying it twice is intended, otherwise cancel the old batch.
- Incomplete company bank details answer 400 SI_BATCH_DEBTOR_INCOMPLETE; details.missing is iban, bic, org_number, swedbank_ids or bankgiro. iban and bic concern the paying account, the company's primary bank account (the one salaries are booked on), named in details.account: fill in its IBAN or BIC under Inställningar → Fakturor, Bankkonton för kundfakturor. The rest are company settings: swedbank_ids means a Swedbank company lacks swedbank_signer_id or swedbank_corporate_pay_id, bankgiro that a Svea Bank company lacks the bankgiro its LB file is sent from.
- An ineligible invoice fails the whole request with 400 SI_BATCH_INELIGIBLE_INVOICE and a reason per invoice; amount above the remaining amount answers 400 SI_BATCH_AMOUNT_EXCEEDS_REMAINING.
- A Swedbank company (swedbank_signer_id set, or swedbank_ids missing) can only pay bank accounts in a file: a bankgiro or plusgiro payee is ineligible with reason swedbank_iso2_giro_payee. A Svea Bank company's LB file pays bankgiro and plusgiro only: a bank-account payee is ineligible with reason lb_bank_account_payee. Leave those invoices out (the preview already does) and create the batch with the rest.
- A payment_date in the past is moved to today (banks reject passed execution dates). Only SEK invoices; at most 100 per batch.
- Between two requests (dry run, then create) a supplier's bank details can change: pass expected_payees from the dry run's items (payee.fingerprint, amount) and create answers 409 SI_BATCH_PAYEE_CHANGED instead of paying a changed account. A staged MCP create is pinned this way automatically.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

Request body:
```ts
{
  format?: "pain001" | "bg_lb",
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
    handle?: string,
    msg_id: string,
    format: "pain001" | "bg_lb",
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

Returns the batch, the company bank details it debits (as snapshotted at creation), and one line per invoice: amount, payment date, payee, reference, and the invoice's live status and remaining amount. file names the download filename, its content type and the v1 path that serves the file (available only while the batch is not cancelled).

**Use when:** Checking what a betalfil pays, or which of its invoices are settled.
**Do not use for:** Getting the file itself: GET /supplier-payment-batches/{id}/file.

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
    handle?: string,
    format: "pain001" | "bg_lb",
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
    file: { filename: string, content_type: "application/xml" | "text/plain", available: boolean, download: string }
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
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

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

**Download the payment file (pain.001, or the LB file for Svea Bank) of a supplier payment batch.**
`scope:suppliers:write · risk:low · idempotent`

Returns the batch's payment file inline as `content` (a string), with filename, content_type, charset and sha256, in the same shape as the salary payment file: pain.001 XML written as UTF-8, or Bankgirot's LB file (format bg_lb, text/plain) written as ISO 8859-1. The file regenerates from the stored batch, so every download is byte-identical (same MsgId) and the bank's duplicate detection works. Each call records the download on the batch (file_generated_at, download_count). Upload the file in the bank's file channel, where the payments are signed; nothing is sent to the bank by this call and nothing is booked.

**Use when:** The batch is created and the user (or their payment operator) needs the file to upload in the bank.
**Do not use for:** Creating the batch (POST /supplier-payment-batches) or marking invoices paid (mark-paid after the bank executed).

**Pitfalls:**
- Write `content` to `filename` in `charset` (UTF-8 for pain001, ISO 8859-1 for bg_lb with its CRLF line endings), exactly as returned; do not re-indent or re-encode the file.
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
    format: "pain001" | "bg_lb",
    filename: string,
    content_type: "application/xml" | "text/plain",
    charset: "utf-8" | "iso-8859-1",
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
    "charset": "utf-8",
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

Evaluates the given supplier invoices exactly as create will: eligible lines with the default amount (the remaining amount), payment date (the due date, or today when it has passed), payee (bankgiro, plusgiro or bank account from the supplier) and reference (OCR when valid, else the invoice number), plus non-blocking warnings; excluded invoices with the reason; the file form the company's bank takes (format: pain001, or bg_lb for Svea Bank); and whether the company's own bank details are complete. The file pays from the company's primary bank account, the account salaries are booked on, with that account's IBAN and BIC; org number, and the bankgiro an LB file is sent from, come from company settings. Reads only; creates nothing.

**Use when:** Before creating a payment batch, to see what would be paid and what blocks it.
**Do not use for:** Creating the batch (POST /supplier-payment-batches) or listing unpaid supplier invoices (GET /supplier-invoices).

**Pitfalls:**
- Excluded reasons: not_payable (draft, paid, credited...), nothing_remaining, credit_note, foreign_currency (only SEK), payee_missing / payee_invalid (fix the supplier's bankgiro, plusgiro or clearing + account number), reference_missing (no valid OCR and no supplier invoice number: add one of them to the invoice), payee_unconfirmed / payee_rejected (the invoice states bank details the supplier card lacks and a person has not approved them, or rejected them: a person decides in Accounted under Att göra; gnubok_confirm_supplier_payee stages the approval), attest_required (the attest policy of the company requires attest for the invoice and it has not been given: an attester approves it first), not_found, in_bank_payment, swedbank_iso2_giro_payee (the company pays through Swedbank, whose ISO 2.0 file agreement pays to bank accounts only: a supplier with a bankgiro or plusgiro is left out; pay those invoices with a bank payment or in the internet bank), lb_bank_account_payee (the company's bank takes only an LB file, which here pays to bankgiro and plusgiro only: a supplier paid to a bank account is left out; pay it in the internet bank).
- debtor_ok false means create will refuse with SI_BATCH_DEBTOR_INCOMPLETE: debtor_missing names what to fill in (iban or bic: the paying account, named in debtor_account, has no IBAN or its bank cannot be determined; fill it in on that account under Inställningar → Fakturor, Bankkonton för kundfakturor, or make another account primary under Inställningar → Bokföring. org_number, swedbank_ids: a Swedbank company's swedbank_signer_id and swedbank_corporate_pay_id, which Swedbank assigns and refuses a file without, or bankgiro: the company's bankgiro, which an LB file is sent from).
- already_batched is a warning here but a refusal at create unless confirm_already_batched is true: paying the same invoice twice is the risk.
- Only SEK invoices; at most 100 per call.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{ format?: "pain001" | "bg_lb", supplier_invoice_ids: string[] }
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
    eligible: { supplier_invoice_id: string, supplier_name: string, supplier_invoice_number: string | null, amount: number, payment_date: string, payee: { type: "bankgiro" | "plusgiro" | "bank_account", label: string }, reference: { type: "ocr" | "invoice_number", value: string }, warnings: ("unattested" | "already_batched" | "ocr_invalid" | "payee_city_missing")[], active_supplier_payment_batch_id: string | null }[],
    excluded: { supplier_invoice_id: string, reason: "not_payable" | "nothing_remaining" | "credit_note" | "foreign_currency" | "payee_missing" | "payee_invalid" | "reference_missing" | "attest_required" | "auto_debit" | "payee_unconfirmed" | "payee_rejected" | "not_found" | "in_bank_payment" | "swedbank_iso2_giro_payee" | "lb_bank_account_payee" }[],
    format: "pain001" | "bg_lb",
    total_amount: number,
    currency: "SEK",
    debtor_ok: boolean,
    debtor_missing: "iban" | "bic" | "org_number" | "swedbank_ids" | "bankgiro" | null,
    debtor_account: { cash_account_id: string | null, name: string | null, ledger_account: string, iban_last4: string | null } | null
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
    "format": "pain001",
    "total_amount": 737.5,
    "currency": "SEK",
    "debtor_ok": true,
    "debtor_missing": null,
    "debtor_account": null
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
  data: { id: string, handle?: string, name: string, supplier_type: "swedish_business" | "eu_business" | "non_eu_business", email: string | null, org_number: string | null, vat_number: string | null, default_payment_terms: number, default_currency: string, party_id?: string | null, archived_at: string | null, created_at: string }[],
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

Creates a new supplier for the company. Bankgiro (with its Luhn check digit), plusgiro, IBAN and BIC are format-checked, since payment files read them. Omitted supplier_type is swedish_business. Requires Idempotency-Key (UUID). Supports ?dry_run=true: the dry run answers the would-be record without id and timestamps.

**Use when:** You need to register a new supplier before booking supplier invoices against them. Use dry-run first to catch validation errors before committing.
**Do not use for:** Updating an existing supplier (PATCH instead). Creating customers (different resource).

**Pitfalls:**
- Idempotency-Key is mandatory: calls without it return 400 VALIDATION_ERROR.
- org_number uniqueness is enforced at the database level; duplicate inserts return 409 SUPPLIER_DUPLICATE_ORG_NUMBER.
- A Swedish-shaped org_number is stored as the 10-digit key; a foreign registration number is stored as sent.
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
  default_currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD" | null,
  self_billing_agreement_ref?: string,
  auto_debit?: boolean,
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
    handle?: string,
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
    clearing_number: string | null,
    account_number: string | null,
    iban: string | null,
    bic: string | null,
    default_expense_account: string | null,
    default_payment_terms: number,
    default_currency: string,
    self_billing_agreement_ref: string | null,
    notes: string | null,
    party_id: string | null,
    archived_at: string | null,
    created_at: string,
    updated_at: string,
    auto_debit: boolean
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
    "phone": null,
    "address_line1": "Box 123",
    "address_line2": null,
    "postal_code": "111 22",
    "city": "Stockholm",
    "country": "SE",
    "org_number": "5566778899",
    "vat_number": "SE556677889901",
    "bankgiro": "123-4567",
    "plusgiro": null,
    "bank_account": null,
    "clearing_number": null,
    "account_number": null,
    "iban": null,
    "bic": null,
    "default_expense_account": "5410",
    "default_payment_terms": 14,
    "default_currency": "SEK",
    "notes": null,
    "party_id": null,
    "archived_at": null,
    "created_at": "2026-04-12T08:30:00Z",
    "updated_at": "2026-04-12T08:30:00Z"
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
    handle?: string,
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
    clearing_number: string | null,
    account_number: string | null,
    default_expense_account: string | null,
    default_payment_terms: number,
    default_currency: string,
    self_billing_agreement_ref: string | null,
    auto_debit: boolean,
    notes: string | null,
    party_id: string | null,
    archived_at: string | null,
    created_at: string,
    updated_at: string,
    party?: { id: string, display_name: string, legal_name: string | null, org_number: string | null, vat_number: string | null, country: string | null, kind: string, status: "confirmed" | "suggested", roles: { supplier_id: string | null, customer_id: string | null }, registry: { legal_name: string | null, legal_form: string | null, status: { label: string, active: boolean } | null, warning: string | null, registrations: { f_tax: boolean | null, vat: boolean | null, employer: boolean | null }, industry: { code: string, label: string } | null, seat: string | null, registered_at: string | null, active_since: string | null, active_until: string | null, employees_band: string | null, turnover: { band: string, year: string | null } | null, workplaces: number | null, contact: { email: string | null, phone: string | null, address: { co: string | null, street: string | null, postal_code: string | null, city: string | null } | null }, vat_number: string | null, fetched_at: string | null } | null, ledger: { occurrences: number, expense_sek: number, revenue_sek: number, first_seen: string | null, last_seen: string | null, dominant_account: string | null } | null, identities: { scheme: string, value: string, status: string, seen_count: number }[] } | null
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
`scope:suppliers:write · risk:medium · idempotent · dry-run · reversible`

Patches the supplier with the fields sent; every field is optional and the rest stay as they are. An empty string clears a text field (null for email and default_expense_account). archived_at: null un-archives a supplier archived with DELETE. An archived supplier's identifying fields (name, type, org and VAT number, address, bank details) are räkenskapsinformation and cannot change until it is un-archived. The dry run answers the would-be supplier with `changes` (each changed field, from and to) and `payment_details_changed`. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** A supplier needs other contact details, address, payment details (bankgiro, plusgiro, clearing and account number, IBAN, BIC), VAT number, default expense account, payment terms or notes, e.g. a supplier imported from SIE with only a name and a bankgiro. Dry-run first to confirm the change.
**Do not use for:** Archiving a supplier (DELETE sets archived_at). Creating one (POST /suppliers). Merging duplicates: there is no merge; archive the duplicate once its invoices are closed.

**Pitfalls:**
- Idempotency-Key is mandatory; calls without it return 400.
- An empty body returns 400 VALIDATION_ERROR.
- org_number uniqueness is enforced at DB level: 409 SUPPLIER_DUPLICATE_ORG_NUMBER.
- An archived supplier refuses a change to an identifying field with 400 VALIDATION_ERROR (details.field archived_at, details.offending_fields); send archived_at: null first.
- Changing default_expense_account does not rebook earlier supplier invoices: only future bookings pick up the new default.
- A Swedish bank account payee is clearing_number + account_number; bank_account is free text that payment files only read with an explicit clearing number.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. |

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
  default_currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD" | null,
  self_billing_agreement_ref?: string | null,
  auto_debit?: boolean,
  notes?: string,
  archived_at?: unknown
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
    handle?: string,
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
    clearing_number: string | null,
    account_number: string | null,
    iban: string | null,
    bic: string | null,
    default_expense_account: string | null,
    default_payment_terms: number,
    default_currency: string,
    self_billing_agreement_ref: string | null,
    notes: string | null,
    party_id: string | null,
    archived_at: string | null,
    created_at: string,
    updated_at: string,
    auto_debit: boolean
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
    "phone": null,
    "address_line1": "Box 123",
    "address_line2": null,
    "postal_code": "111 22",
    "city": "Stockholm",
    "country": "SE",
    "org_number": "5566778899",
    "vat_number": "SE556677889901",
    "bankgiro": "123-4567",
    "plusgiro": null,
    "bank_account": null,
    "clearing_number": null,
    "account_number": null,
    "iban": null,
    "bic": null,
    "default_expense_account": "5410",
    "default_payment_terms": 14,
    "default_currency": "SEK",
    "notes": "New payment terms agreed 2026-05-12.",
    "party_id": null,
    "archived_at": null,
    "created_at": "2026-04-12T08:30:00Z",
    "updated_at": "2026-05-12T09:00:00Z"
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
  suppliers: { name: string, supplier_type?: "swedish_business" | "eu_business" | "non_eu_business", email?: string, phone?: string, address_line1?: string, address_line2?: string, postal_code?: string, city?: string, country?: string, org_number?: string, vat_number?: string, bankgiro?: string, plusgiro?: string, bank_account?: string, iban?: string, bic?: string, clearing_number?: string, account_number?: string, default_expense_account?: string, default_payment_terms?: number, default_currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD" | null, self_billing_agreement_ref?: string, auto_debit?: boolean, notes?: string }[],
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
