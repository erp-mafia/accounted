<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Invoices (AR) endpoints

Accounts receivable invoices: draft -> send -> paid/credited; the F-series number is assigned at send, not create. Supplier bills you receive are a different resource: see suppliers.md. Customer and article registers: customers.md. Recurring invoice schedules (återkommande fakturor) create an invoice from the same lines every 1-12 months; ?stage=true proposes a schedule or a change for a person to approve. Collections: overdue invoices handed to the collections provider the company activated (the handover and escalations are staged for a person to approve in Accounted), the case on each invoice, and booking what the provider collected and paid out. Setting a customer invoice off against a supplier invoice of the same counterparty: setoffs.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/collections/candidates`

**List the overdue customer invoices that could be handed over to the company's collections provider.**
`scope:invoices:read · risk:low · idempotent`

Overdue customer invoices (due date passed, Europe/Stockholm) that are issued and still owed, checked against the handover rules: SEK and a Swedish customer, at least the company's minimum, no open case, a complete postal address, an org number for a business, not time-barred, no ROT/RUT share refused by Skatteverket. The bank check (an unbooked payment that may be this invoice) and a consumer's age are checked when the invoice is handed over, not here.

**Use when:** Deciding which overdue invoices to stage for collection with accounted_send_invoice_to_collection.
**Do not use for:** Reading an invoice's case (accounted_get_collection_case) or listing every unpaid invoice (GET /invoices).

**Pitfalls:**
- needs_attestation=true means only a person can hand the invoice over in the web UI (the invoice has no delivery record, was imported, or the customer answered a reminder).
- COLLECTIONS_DISABLED or COLLECTIONS_NOT_ACTIVE: the company has not activated collections, or it is switched off on this installation.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `include_ineligible` | query | `boolean \| "true" \| "false"` | no | Also list overdue invoices that fail a check, with the checks they fail. |

Response `200`:
```ts
{
  data: {
    candidates: { invoice_id: string, invoice_number: string | null, customer_id: string | null, customer_name: string | null, due_date: string, overdue_days: number, claim_amount: number, remaining_amount: number, eligible: boolean, blocks: string[], needs_attestation: boolean }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "candidates": [
      {
        "invoice_id": "7d1e…",
        "invoice_number": "F-1042",
        "customer_id": "1c2d…",
        "customer_name": "Kund AB",
        "due_date": "2026-09-01",
        "overdue_days": 33,
        "claim_amount": 12500,
        "remaining_amount": 12500,
        "eligible": true,
        "blocks": [],
        "needs_attestation": false
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

### `POST /api/v1/companies/{companyId}/collections/payments/{paymentId}/book`

**Book a payment a debtor made to the collections provider as a payment of the invoice.**
`scope:invoices:write · risk:high · idempotent · dry-run`

Books the capital the debtor paid on the day they paid, against the clearing account for money the provider holds (default 1689), with the provider's payment data rendered as the voucher's underlag. A payment the books refuse (a locked period, an invoice already paid) answers outcome needs_review with the reason and waits for a person. The dry run reads only and names the invoice and the clearing account; the staged booking pins the payment day.

**Use when:** accounted_list_collection_settlements lists a collected payment as pending or needs_review.
**Do not use for:** Payments the customer made to the company itself (mark the invoice paid; it is reported to the provider).

**Pitfalls:**
- A booked payment is corrected only with "Bokför om" under Avräkningar; a generic storno of its voucher is refused.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `paymentId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ payment_date?: string }
```

Example request:
```json
{
  "collected_payment_id": "8a2b…"
}
```

Response `200`:
```ts
{
  data: {
    outcome: "booked" | "needs_review",
    journal_entry_id?: string | null,
    invoice_payment_id?: string,
    write_off_id?: string,
    already_booked?: boolean,
    reason?: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "outcome": "booked",
    "journal_entry_id": "je…",
    "already_booked": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/collections/settlements`

**List the payments debtors made to the collections provider and the provider's payouts, with how far each is booked.**
`scope:invoices:read · risk:low · idempotent · reversible`

Newest first, up to 200 of each. With settlement_id it also returns that payout's lines: the account each books to and the choices a person (or an approved staged booking) must make before it books. Served whatever the collections start gates say.

**Use when:** Before booking a collected payment or a payout, or to see what waits in Avräkningar.
**Do not use for:** Open collection cases (accounted_get_collection_case) or invoices not handed over.

**Pitfalls:**
- A payout in needs_mapping with reason possible_duplicate is answered by a person in the web UI, not by an agent.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `settlement_id` | query | `string` | no | A payout to read with its lines. |

Response `200`:
```ts
{
  data: {
    provider: string | null,
    settlements: { settlement_id: string, provider_settlement_ref: string, payment_date: string, amount: number, currency: string, status: string, needs_mapping_reason: string | null, journal_entry_id: string | null, voucher: string | null, bank_reference: string | null, acknowledged: boolean, duplicate_cleared: boolean, ignored_reason: string | null }[],
    collected_payments: { collected_payment_id: string, case_id: string, invoice_id: string, invoice_number: string | null, customer_name: string | null, paid_at: string, capital_paid: number, to_agency: number, status: string, review_reason: string | null, journal_entry_id: string | null, voucher: string | null, settlement_id: string | null }[],
    settlement: { settlement_id: string, provider_settlement_ref: string, payment_date: string, amount: number, currency: string, status: string, needs_mapping_reason: string | null, journal_entry_id: string | null, voucher: string | null, bank_reference: string | null, acknowledged: boolean, duplicate_cleared: boolean, ignored_reason: string | null, settlement_date: string | null, provider_status_ok: boolean, document_id: string | null, duplicate_of: { journal_entry_id: string, voucher: string | null } | null, lines: { position: number, kind: string, in_payout: boolean, amount: number, tax_amount: number, account_number: string | null, vat_account_number: string | null, chosen_by_person: boolean, needs_account: "vat" | "any" | null, needs_vat_account: boolean }[], voucher_preview: { account_number: string, debit: number, credit: number }[] | null } | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "provider": "Acme Inkasso",
    "settlements": [
      {
        "settlement_id": "5c1e…",
        "amount": 843.75,
        "status": "needs_mapping",
        "needs_mapping_reason": "vat_unconfirmed"
      }
    ],
    "collected_payments": [
      {
        "collected_payment_id": "8a2b…",
        "capital_paid": 1000,
        "status": "pending"
      }
    ],
    "settlement": {
      "settlement_id": "5c1e…",
      "lines": [
        {
          "position": 1,
          "kind": "agency_fee_vat",
          "needs_account": "vat"
        }
      ],
      "voucher_preview": null
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/collections/settlements/{settlementId}/book`

**Book a payout from the collections provider as one voucher, with the settlement PDF as its underlag.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Records the accounts chosen for the lines the ledger could not place (lines), books the payout's pending collected payments first, then posts one voucher dated the payout day: principal against the clearing account, the provider's fees and their VAT, the payout to the payout account. The dry run reads only and previews that voucher (voucher_lines); it refuses a payout the ledger cannot book with the choices given (409 COLLECTION_SETTLEMENT_NEEDS_PERSON with the reason). The staged booking pins the payout's day, amount, lines and voucher: a payout or voucher that changed before approval answers 409 COLLECTION_SETTLEMENT_CHANGED. A payout that still needs a person at commit answers outcome needs_mapping with the reason.

**Use when:** accounted_list_collection_settlements lists a payout as received or needs_mapping, and its lines show the choices to make.
**Do not use for:** A payout held as a possible duplicate of one booked by hand: a person answers that in Avräkningar.

**Pitfalls:**
- Pass a choice for every line with needs_account or needs_vat_account; VAT takes 2641 (deductible) or 6062 (cost) only.
- 409 COLLECTION_SETTLEMENT_POSSIBLE_DUPLICATE: a bank row of the payout already sits on a voucher.
- 409 COLLECTION_SETTLEMENT_CHANGED: read the payout again and stage a new booking.
- 409 COLLECTION_SETTLEMENT_NEEDS_PERSON at staging: details.reason and details.issues say what is missing (a line without an account, an unbooked collected payment, a payout that does not balance).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `settlementId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  lines?: { position: number, account_number?: string, vat_account_number?: string }[],
  payment_date?: string,
  expected_amount?: number,
  expected_lines?: { position: number, kind: string, amount: number, tax_amount: number }[],
  expected_voucher?: { account_number: string, debit: number, credit: number }[]
}
```

Example request:
```json
{
  "settlement_id": "5c1e…",
  "lines": [
    {
      "position": 1,
      "account_number": "2641"
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    outcome: "booked" | "needs_mapping",
    journal_entry_id?: string,
    already_booked?: boolean,
    acknowledged?: boolean,
    reason?: string,
    issues?: { reason: string, position: number | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "outcome": "booked",
    "journal_entry_id": "je…",
    "acknowledged": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/invoices`

**List invoices for a company.**
`scope:invoices:read · risk:low · idempotent`

Cursor-paginated invoice list ordered by created_at DESC, id ASC (newest-registered first; the `invoice_date` column is the business date and is filterable via ?date_from / ?date_to but is not the sort key). Includes the customer name inline; pass ?expand=customer for the full customer record, ?expand=items for line items.

**Use when:** You need to enumerate invoices for a company: for AR reporting, payment matching, or building an invoice dashboard.
**Do not use for:** Fetching a single invoice you already know the id of: use GET /api/v1/companies/{companyId}/invoices/{id}. Supplier invoices are a different resource (supplier-invoices).

**Pitfalls:**
- Draft invoices have invoice_number=null until they are sent.
- payment_reference is the reference the invoice asks the payer to quote, the one its PDF prints; payment_reference_type says how it is built. ocr: the digits of invoice_number followed by a Luhn (10-modulen) check digit, 2 to 25 digits (invoice 2026-0042 gives 202600425). When the company setting invoice_ocr_length_digit is true, Bankgirot's length digit stands before the check digit (202600425 becomes 2026004206), for a bankgiro whose OCR control also checks the length; without it the reference fits a control of the check digit alone. invoice_number: the invoice number as it is, written as the message of the payment. An invoice carries ocr when it is printed in Swedish with a bankgiro or plusgiro and the company has not turned the OCR reference off, otherwise invoice_number; the value follows those settings, as the PDF does. Both are null when the document asks for no payment under a reference: no number yet (a draft), a credit note, a quote, a proforma, a delivery note, an invoice debited by Autogiro. An incoming payment is matched under either form.
- remaining_amount is the unpaid portion (total − paid_amount); use status=paid or remaining_amount=0 to filter for closed invoices. Crediting an invoice sets its remaining_amount to 0: the credit note settles it.
- Credit notes appear with status=credited and a credited_invoice_id field on the detail endpoint.
- Ordering is by created_at (registration time), not invoice_date. Backdated invoices therefore appear where they were created, not where their date falls: filter on ?date_from / ?date_to when you care about the business date.
- Cursor pagination: pass ?cursor=<next_cursor> from the previous response. A stale or tampered cursor is ignored and the first page is returned again.
- Quotes (document_type=quote, offert) carry valid_until and quote_status (open | accepted | declined | expired). "expired" is derived: an open quote past valid_until; filter with ?quote_status=expired. Quotes never book and are never payable: convert an accepted quote to an invoice in the dashboard first.
- The register holds invoices issued in Accounted and invoices registered from the books (already booked, linked to their verifikat). A company migrated or backfilled mid-year can still have customer invoices that exist only as journal entries and are NOT in this list. Check meta.coverage: when has_pre_register_invoices is true, treat periods before covers_from as not answered by this endpoint (query journal entries instead).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"draft" \| "sent" \| "paid" \| "partially_paid" \| "overdue" \| "cancelled" \| "credited" \| "written_off"` | no | Only invoices in this status. overdue = past due_date with remaining_amount > 0, partially_paid included. |
| `customer_id` | query | `string` | no | Only invoices to this customer (id). |
| `document_type` | query | `"invoice" \| "proforma" \| "delivery_note" \| "quote"` | no | Only this document type. Default: every type. |
| `quote_status` | query | `"open" \| "accepted" \| "declined" \| "expired"` | no | Quotes only (implies document_type=quote). expired = open with valid_until before today. |
| `currency` | query | `string` | no | 3-letter ISO 4217 code, uppercase (e.g. SEK, EUR). |
| `date_from` | query | `string` | no | YYYY-MM-DD. Invoices with invoice_date on or after this date. |
| `date_to` | query | `string` | no | YYYY-MM-DD. Invoices with invoice_date on or before this date. |
| `cursor` | query | `string` | no | Opaque cursor from the previous page's meta.next_cursor. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). Larger values are clamped to 100. |
| `expand` | query | `string` | no | Comma-separated related records to embed: customer, items. An unknown key returns 400 VALIDATION_ERROR. |

Response `200`:
```ts
{
  data: { id: string, handle?: string, invoice_number: string | null, external_invoice_number: string | null, is_self_billed: boolean, customer_id: string, customer_name: string, invoice_date: string, due_date: string, status: "draft" | "sent" | "paid" | "partially_paid" | "overdue" | "cancelled" | "credited" | "written_off", document_type: "invoice" | "proforma" | "delivery_note" | "quote", valid_until: string | null, quote_status: "open" | "accepted" | "declined" | "expired" | null, currency: string, subtotal: number, vat_amount: number, total: number, amount_to_pay: number, ore_rounding_amount: number, remaining_amount: number, payment_reference: string | null, payment_reference_type: "ocr" | "invoice_number" | null, paid_at: string | null, created_at: string }[],
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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
      "amount_to_pay": 12500,
      "ore_rounding_amount": 0,
      "remaining_amount": 12500,
      "payment_reference": "202600425",
      "payment_reference_type": "ocr",
      "paid_at": null,
      "created_at": "2026-05-01T09:14:33Z"
    }
  ],
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12",
    "next_cursor": null,
    "coverage": {
      "covers_from": "2026-05-01",
      "has_pre_register_invoices": true
    }
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices`

**Create a draft invoice, proforma, or delivery note.**
`scope:invoices:draft · risk:medium · idempotent · dry-run · reversible`

Creates an invoice in draft status. The F-series invoice_number is allocated atomically on the first send action (PR-B-2b). Per-item VAT rates are validated against the customer's allowed rates (mixed-rate invoices supported). Non-SEK invoices are converted to SEK at the Riksbanken exchange rate fetched at create time. An invoice can state its own VAT treatment (vat_treatment, delivery_country for goods shipped abroad: export ruta 36, intra-EU supply ruta 35; reverse_charge_domestic for construction services, ruta 41) instead of the customer's, validated against the legal preconditions. Supports skattereduktion lines (items[].deduction_type = "rot"|"rut"|"gron_teknik" with invoice-level deduction_personnummer + deduction_housing_designation, or deduction_apartment_number + deduction_brf_org_number for bostadsrätt), article linkage (items[].article_id + optional revenue_account override from the artikelregister), and project/cost-centre tagging (default_dimensions / items[].dimensions). Idempotent (mandatory Idempotency-Key). Dry-runnable: the preview returns the validated would-be invoice + items with computed totals; no journal entry is involved at draft stage (posting happens on :send). Set is_self_billed=true (with external_invoice_number + received_date) to instead register a received self-billing invoice (mottagen självfaktura, ML 17 kap 15§): a sale booked immediately with the counterparty's number, not a draft.

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
- A self-billed sale books VAT per rate as the customer's document does: on the summed base of each rate, or the figure in vat_breakdown (percent rates, [{ vat_rate: 25, vat_amount: 1967.2 }]) when it lies within half an öre per line of that; else 400 VAT_BREAKDOWN_MISMATCH. vat_breakdown without is_self_billed returns 400 VALIDATION_ERROR.
- Project/cost-center tagging: pass default_dimensions ({"6":"P001"} = project, {"1":"KS01"} = kostnadsställe) for the whole invoice and/or items[].dimensions per line (per-line wins per key). Tags are stored on the draft and applied to the journal entry lines when the invoice is sent. When the company has the dimension registry enabled, unknown or archived codes are rejected at :send with 400 DIMENSION_VALIDATION_FAILED — list valid codes via GET /dimensions.
- ROT/RUT: set items[].deduction_type ("rot"|"rut") on labor lines plus labor_hours and work_type (Skatteverket arbetstypskod). The invoice must carry deduction_personnummer AND housing info: deduction_housing_designation (fastighetsbeteckning) for småhus, or deduction_apartment_number + deduction_brf_org_number for bostadsrätt. deduction_amount is computed server-side and cannot be set by the caller; the response exposes deduction_total and remaining_amount = total - deduction_total (Skatteverket pays the rest via 1513). Validation failures return 400 INVOICE_CREATE_ROT_RUT_VALIDATION, as does a deduction line on a quote, proforma or delivery note (a skattereduktion exists on an invoice only).
- Grön teknik: items[].deduction_type "gron_teknik" on the labor AND material lines of the installation, work_type INSTALLATION_SOLCELLER (15 %), INSTALLATION_LAGRING or INSTALLATION_LADDPUNKT (50 %) of the line total incl. VAT. Put labor and material on lines of their own (the invoice must show the cost of labor and of material); travel, freight, machinery, projektering and rented material stay on lines without a deduction. At a fixed price (totalentreprenad) Skatteverket counts labor and material as 97 % of the price: flag a line with 97 % of it and leave 3 % on an unflagged line. Selling material only gives no reduction. labor_hours (the hours actually worked, also at a fixed price) are required on at least one line per installation type, not on every line. Personnummer and housing info are required as for ROT. The yearly ceiling is 50 000 kr per person, separate from ROT/RUT (a warning, never an error). A grön teknik line cannot share an invoice with ROT/RUT lines (400 INVOICE_CREATE_ROT_RUT_VALIDATION). The payout file comes from POST /api/rot-rut/payout-file with deduction_type gron_teknik, uploaded in Skatteverket's e-tjänst for grön teknik.
- Articles: pass items[].article_id (from the artikelregister, GET /articles) to link a line to a catalog article; price/description are still taken from the request body (the API never auto-fills from the article: send the values you want on the invoice). items[].revenue_account is the legacy wire name for an optional BAS class 1-3 posting-account override and is validated against the chart of accounts.
- Per-invoice VAT treatment (vat_treatment + delivery_country): the customer decides by default; an invoice can state its own supply instead. delivery_country is the ISO code of the country the GOODS are transported to, and setting it makes the invoice a supply of goods. vat_treatment export + delivery_country outside the EU (e.g. a Swedish buyer, goods shipped to NO) = export of goods: 0 %, revenue 3105, moms_ruta 36, notice "Export, undantagen från skatteplikt, ML 10 kap. 64 §". vat_treatment reverse_charge + delivery_country in another EU member state = intra-EU supply of goods: 0 %, revenue 3108, moms_ruta 35, periodisk sammanställning, notice citing Article 138 / ML 10 kap. 42 §; it needs the customer's vat_number to be its VIES-validated number from a member state other than Sweden (a Swedish buyer qualifies when its card carries its number from that state; its SE number does not, and a per-invoice buyer VAT number is not supported yet). vat_treatment standard = Swedish VAT at the line rates, always allowed (e.g. no export evidence, or a consumer in another member state under the distance-sales threshold). Without delivery_country, export / reverse_charge are the services treatments (3305 ruta 40, notice "Tjänst tillhandahållen utomlands, ej svensk moms, ML 6 kap. 33 §" / 3308 ruta 39) and only accepted where the customer already gets them. delivery_country alone implies the treatment (SE = standard, EU = reverse_charge, elsewhere = export). Use XI for Northern Ireland. A goods treatment allows only 0 % on its priced lines (omit vat_rate); invoice a Swedish-VAT supply separately. Refusals are 400 INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_REQUIRED, _DELIVERY_COUNTRY_MISMATCH, _BUYER_VAT_NUMBER_REQUIRED (details.reason) and _NOT_VAT_REGISTERED: the invoice never gets 0 % without the facts. The dry run returns vat_treatment, moms_ruta, reverse_charge_text, vat_treatment_override and delivery_country: check them before sending. vat_treatment reverse_charge_domestic = omvänd betalningsskyldighet for construction services (ML 16 kap. 13 §: the buyer is a construction business and the supply a construction service, which only the seller can state): 0 %, revenue 3231, moms_ruta 41, notice "Omvänd betalningsskyldighet, byggtjänster, ML 16 kap. 13 §", the buyer's VAT number printed. It needs customer_type swedish_business and a Swedish vat_number (SE + 12 digits) on the customer, takes no delivery_country and allows only 0 % lines; refusals are 400 INVOICE_VAT_TREATMENT_DOMESTIC_BUYER_REQUIRED (details.reason: private_person, not_swedish_business, missing, not_swedish_vat_number) and _DELIVERY_COUNTRY_MISMATCH.
- EU customers: reverse charge (0 %, ruta 39) needs customer_type eu_business, a VIES-validated vat_number and a country other than SE. When any of those is missing the invoice is created WITH Swedish VAT and the 201 carries meta.warnings (codes EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED, EU_BUSINESS_VAT_NUMBER_MISSING, EU_BUSINESS_COUNTRY_IS_SE, each with a remediation). A Swedish rate set explicitly on a line to a validated EU or non-EU business is accepted (taxed-where-performed supplies) but flagged as SWEDISH_VAT_TO_REVERSE_CHARGE_CUSTOMER / SWEDISH_VAT_TO_EXPORT_CUSTOMER. Warnings never fail the request; read them before sending. Dry-run returns the same list.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  customer_id: string,
  invoice_date: string,
  due_date: string,
  delivery_date?: string | "",
  currency: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD",
  document_type?: "invoice" | "proforma" | "delivery_note" | "quote",
  valid_until?: string | "",
  your_reference?: string,
  our_reference?: string,
  invoice_marking?: string,
  delivery_address?: {
    name?: string | null,
    address_line1?: string | null,
    address_line2?: string | null,
    postal_code?: string | null,
    city?: string | null,
    country?: string | "" | null
  } | null,
  notes?: string,
  payment_link_url?: string | "",
  payment_link_auto?: boolean,
  qr_mode?: "auto" | "bank_app" | "swish" | "payment_link" | "none" | null,
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
  vat_breakdown?: { vat_rate: 0 | 6 | 12 | 25, vat_amount: number }[],
  payment_cash_account_id?: string | "" | null,
  vat_treatment?: "standard" | "export" | "reverse_charge" | "reverse_charge_domestic" | null,
  delivery_country?: string | null,
  items: { line_type?: "product" | "text", description: string, quantity: number, unit: string, unit_price: number, discount_percent?: number | null, vat_rate?: number, article_id?: string | null, revenue_account?: string | null, sales_order_item_id?: string | null, deduction_type?: "rot" | "rut" | "gron_teknik" | null, labor_hours?: number | null, work_type?: string | null, housing_designation?: string | null, apartment_number?: string | null, brf_org_number?: string | "" | null, accrual_period_start?: string | null, accrual_period_end?: string | null, accrual_balance_account?: string | null, dimensions?: Record<string, string> }[]
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
    handle?: string,
    invoice_number: string | null,
    external_invoice_number?: string | null,
    is_self_billed?: boolean,
    customer_id: string,
    invoice_date: string,
    due_date: string,
    status: string,
    document_type: string,
    valid_until?: string | null,
    quote_status?: string | null,
    currency: string,
    subtotal: number,
    vat_amount: number,
    total: number,
    amount_to_pay: number,
    ore_rounding_amount: number,
    remaining_amount: number,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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
    "invoice_number": null,
    "customer_id": "a8f1…",
    "invoice_date": "2026-05-12",
    "due_date": "2026-06-11",
    "status": "draft",
    "currency": "SEK",
    "subtotal": 10000,
    "vat_amount": 2500,
    "total": 12500,
    "amount_to_pay": 12500,
    "ore_rounding_amount": 0,
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
- total is the exact invoice total the books carry; amount_to_pay is what the invoice asks the customer for: total after öresavrundning (ore_rounding_amount), minus any ROT/RUT deduction. Reconcile payments against amount_to_pay. A credit note carries the credited invoice's rounding choice, so a whole credit has the same ore_rounding_amount with the opposite sign. An issued invoice keeps the rounding it was issued with: a later change of the company setting changes neither field.
- payment_reference is the reference the invoice asks the payer to quote, the one its PDF prints; payment_reference_type says how it is built. ocr: the digits of invoice_number followed by a Luhn (10-modulen) check digit, 2 to 25 digits (invoice 2026-0042 gives 202600425). When the company setting invoice_ocr_length_digit is true, Bankgirot's length digit stands before the check digit (202600425 becomes 2026004206), for a bankgiro whose OCR control also checks the length; without it the reference fits a control of the check digit alone. invoice_number: the invoice number as it is, written as the message of the payment. An invoice carries ocr when it is printed in Swedish with a bankgiro or plusgiro and the company has not turned the OCR reference off, otherwise invoice_number; the value follows those settings, as the PDF does. Both are null when the document asks for no payment under a reference: no number yet (a draft), a credit note, a quote, a proforma, a delivery note, an invoice debited by Autogiro. An incoming payment is matched under either form.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `expand` | query | `string` | no | Comma-separated related records to embed: items, payments. An unknown key returns 400 VALIDATION_ERROR. |

Response `200`:
```ts
{
  data: {
    id: string,
    handle?: string,
    invoice_number: string | null,
    external_invoice_number?: string | null,
    is_self_billed?: boolean,
    customer_id: string,
    invoice_date: string,
    due_date: string,
    status: string,
    document_type: string,
    valid_until?: string | null,
    quote_status?: string | null,
    quote_decided_at?: string | null,
    currency: string,
    total: number,
    amount_to_pay: number,
    ore_rounding_amount: number,
    ore_rounding?: boolean | null,
    remaining_amount: number,
    payment_reference?: string | null,
    payment_reference_type?: "ocr" | "invoice_number" | null,
    paid_at: string | null,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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
    "amount_to_pay": 12500,
    "ore_rounding_amount": 0,
    "remaining_amount": 12500,
    "payment_reference": "202600425",
    "payment_reference_type": "ocr",
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
`scope:invoices:draft · risk:low · idempotent · dry-run · reversible`

Partial update for invoices in draft status. Allowed fields: invoice_date, due_date, delivery_date, your_reference, our_reference, notes, default_dimensions (project/cost-centre tags, e.g. {"6":"P001"}; replaces the whole bag), vat_treatment + delivery_country (the per-invoice VAT treatment, same rules as POST /invoices), and an optional items array. When items is present, it fully REPLACES the draft's line items and subtotal / VAT / total are recomputed against the invoice's existing customer (same validation as POST /invoices); when omitted, items and totals are unchanged. customer_id, currency, and document_type are immutable: replace those by deleting the draft and recreating it. Returns 409 INVOICE_UPDATE_NOT_DRAFT if the invoice is no longer in draft status. Idempotent and dry-runnable.

**Use when:** You need to correct a typo, push the due date, update a customer reference, or rewrite the line items on a draft you have not sent yet. The invoice number stays null until the first :send action.
**Do not use for:** Updating a sent / paid / credited invoice (those are immutable per ML 17 kap; issue a credit note via POST /:id:credit in PR-B-2b). Changing currency or customer: drafts are cheap to delete and recreate.

**Pitfalls:**
- Idempotency-Key is mandatory.
- A 409 INVOICE_UPDATE_NOT_DRAFT means the invoice has been sent / paid / credited / cancelled. The DELETE handler on this path uses its own code, INVOICE_DELETE_NOT_DRAFT.
- items is a FULL REPLACE (no per-line merge): send the complete new line set, minimum one item. Omitting items keeps the current lines untouched. VAT rates are re-validated against the customer type and totals are recomputed server-side.
- items are always built against the invoice's EXISTING customer: customer_id cannot change on PATCH.
- vat_treatment and delivery_country are a pair: sending either replaces both (null clears), omitting both keeps the draft's. Changing them re-decides the VAT of the lines even without items: the current lines are rebuilt, so a draft whose lines carry 25 % cannot become an export of goods until its lines are 0 % (send items with vat_rate 0 or omitted). A draft that states its own treatment keeps it across edits that do not mention it, and falls back to the customer's treatment (the statement cleared) if a later customer change no longer supports it.
- default_dimensions replaces the entire bag (no per-key merge): read the current value first if you want to add a tag. Send {} to clear all tags. Codes are validated against the dimension registry at :send, not at PATCH time.
- When items are replaced, the VAT treatment is decided again from the customer's current row (customer_type, vat_number validation, country), so it can differ from the draft's stored one: an eu_business whose country is SE gets Swedish VAT, never reverse charge. The 200 may carry meta.warnings about the treatment (same codes as POST /invoices: EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED, EU_BUSINESS_VAT_NUMBER_MISSING, EU_BUSINESS_COUNTRY_IS_SE, SWEDISH_VAT_TO_REVERSE_CHARGE_CUSTOMER, SWEDISH_VAT_TO_EXPORT_CUSTOMER). The update succeeded; the warning says why the rates are what they are.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  invoice_date?: string,
  due_date?: string,
  delivery_date?: string | unknown,
  your_reference?: string | unknown,
  our_reference?: string | unknown,
  notes?: string | unknown,
  delivery_address?: {
    name?: string | null,
    address_line1?: string | null,
    address_line2?: string | null,
    postal_code?: string | null,
    city?: string | null,
    country?: string | "" | null
  } | null,
  default_dimensions?: Record<string, string>,
  payment_cash_account_id?: string | unknown,
  qr_mode?: "auto" | "bank_app" | "swish" | "payment_link" | "none" | null,
  vat_treatment?: "standard" | "export" | "reverse_charge" | "reverse_charge_domestic" | null,
  delivery_country?: string | null,
  items?: { line_type?: "product" | "text", description: string, quantity: number, unit: string, unit_price: number, discount_percent?: number | null, vat_rate?: number, article_id?: string | null, revenue_account?: string | null, sales_order_item_id?: string | null, deduction_type?: "rot" | "rut" | "gron_teknik" | null, labor_hours?: number | null, work_type?: string | null, housing_designation?: string | null, apartment_number?: string | null, brf_org_number?: string | "" | null, accrual_period_start?: string | null, accrual_period_end?: string | null, accrual_balance_account?: string | null, dimensions?: Record<string, string> }[]
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
    handle?: string,
    invoice_number: string | null,
    external_invoice_number?: string | null,
    is_self_billed?: boolean,
    customer_id: string,
    invoice_date: string,
    due_date: string,
    status: string,
    document_type: string,
    valid_until?: string | null,
    quote_status?: string | null,
    quote_decided_at?: string | null,
    currency: string,
    total: number,
    amount_to_pay: number,
    ore_rounding_amount: number,
    ore_rounding?: boolean | null,
    remaining_amount: number,
    payment_reference?: string | null,
    payment_reference_type?: "ocr" | "invoice_number" | null,
    paid_at: string | null,
    created_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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
`scope:invoices:write · risk:high · idempotent · dry-run`

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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { deleted?: boolean, cancelled?: boolean, invoice_number?: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
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

### `POST /api/v1/companies/{companyId}/invoices/{id}/book`

**Book a sent customer invoice that was issued without a verifikat (the deferred Bokför step).**
`scope:invoices:write · risk:high · idempotent · dry-run`

For companies with defer_invoice_booking=true (Registrera men bokför inte): :send and :mark-sent issue the invoice without posting anything, and this step posts the revenue verifikat afterwards (Debit 1510 Kundfordringar / Credit revenue per VAT rate + utgående moms; ROT/RUT share on 1513; periodiserade lines on 29xx or 17xx with their schedules). Dated on the invoice date. An upplupen intäkt (17xx line, months before the invoice month) books each month of its period on the last day of that month right after; a month that cannot take the entry refuses the booking with INVOICE_ACCRUED_INCOME_PERIOD_LOCKED before anything is posted. The invoice is claimed with a compare-and-set, so a concurrent book, payment or credit cancels this entry instead of double-posting. The delivered PDF, if archived at send, is linked to the verifikat. Idempotent. Dry-runnable: the dry run previews the exact lines and writes nothing.

**Use when:** A customer invoice is sent or overdue, has no journal_entry_id, and the company books invoices in a separate step (defer_invoice_booking), typically after someone has checked the kontering.
**Do not use for:** Drafts (issue them with :send or :mark-sent first), paid or partially paid invoices (a payment books the sale first through this step; a kontantmetoden payment books the whole sale), credit notes, quotes, proformas or delivery notes, or any invoice under kontantmetoden (booked at payment).

**Pitfalls:**
- An invoice that already has a journal_entry_id answers 400 INVOICE_BOOK_ALREADY_BOOKED.
- Status other than sent or overdue answers 400 INVOICE_BOOK_INVALID_STATUS with details.currentStatus.
- Under kontantmetoden answers 400 INVOICE_BOOK_CASH_METHOD: nothing books before payment.
- A locked or closed period, or an invoice date on or before the company lock date (bookkeeping_locked_through), answers 400 PERIOD_LOCKED with details.reason, details.fiscal_period_id and details.invoice_date. Nothing is generated, so no voucher number is spent: unlock the period (only if the user asked for that correction) and retry.
- No open fiscal year covering the invoice date answers 400 INVOICE_BOOK_NO_FISCAL_PERIOD: create the räkenskapsår first.
- A posted verifikat is permanent: undo a wrong booking with storno (POST /journal-entries/{id}/reverse), never by editing.
- Settling an unbooked invoice (mark-paid, a bank match, a samlingsbetalning, a link to an existing verifikat) runs this step first and refuses the payment with its code when it refuses: there is no need to call it before recording a payment, and no way to pay around it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: {
    invoice: { id: string, handle?: string, invoice_number: string | null, status: string, invoice_date: string, due_date: string | null, currency: string, total: number, journal_entry_id: string | null },
    journal_entry_id: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "invoice": {
      "id": "7d1e…",
      "invoice_number": "F-1042",
      "status": "sent",
      "invoice_date": "2026-09-10",
      "due_date": "2026-10-10",
      "currency": "SEK",
      "total": 12500,
      "journal_entry_id": "9a0b…"
    },
    "journal_entry_id": "9a0b…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/cancel`

**Cancel (makulera) a quote or a proforma invoice.**
`scope:invoices:write · risk:low · idempotent · dry-run`

Sets status cancelled on a quote (document_type=quote) or a proforma (document_type=proforma). The document stays, with its number; neither carries a verifikat, so nothing is booked or reversed. The invoice.cancelled event records who cancelled it. A sales invoice is refused: delete a draft (DELETE /invoices/{id}) and credit an issued one (POST /invoices/{id}/credit). Cancelling an already cancelled document answers it unchanged with already_cancelled=true. Idempotent. Dry-runnable.

**Use when:** A quote will not go ahead (withdrawn, replaced by a new quote) or a proforma will never become an invoice, and the user wants it out of the open documents.
**Do not use for:** Recording that the customer declined a quote (POST /invoices/{id}/quote-status with declined keeps it as a decided quote), deleting a draft invoice, or crediting an issued invoice.

**Pitfalls:**
- Only quotes and proformas: any other document answers 400 INVOICE_CANCEL_NOT_QUOTE_OR_PROFORMA with details.documentType.
- A quote with live invoices converted from it can still be cancelled: those invoices stay as they are (credit them separately if needed), and a part not yet invoiced can no longer be invoiced from the quote (converting a cancelled quote answers INVOICE_CONVERT_SOURCE_CANCELLED).
- A cancelled quote cannot be decided again (quote-status answers INVOICE_QUOTE_NOT_DECIDABLE): create a new quote instead.
- A dry run of an already cancelled document answers 409 INVOICE_ALREADY_CANCELLED: there is nothing left to stage.
- 409 INVOICE_CANCEL_RACE means the document changed between the read and the write (a conversion or another cancel): re-read it before retrying.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: {
    id: string,
    handle?: string,
    invoice_number: string | null,
    document_type: "quote" | "proforma",
    status: "cancelled",
    quote_status: "open" | "accepted" | "declined" | null,
    already_cancelled: boolean
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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
    "invoice_number": "OF-007",
    "document_type": "quote",
    "status": "cancelled",
    "quote_status": "open",
    "already_cancelled": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/invoices/{id}/collection`

**Read an invoice's collection case: stage, what the provider waits for, the actions it offers, amounts and timeline.**
`scope:invoices:read · risk:low · idempotent`

The invoice's open case, or its latest closed or refused one, re-read from the provider when it was last read more than a minute ago. Works whatever the company's plan or switches say: an open case is always readable.

**Use when:** Following up an invoice handed over to collection, or before accounted_collection_case_action to see which actions the case offers.
**Do not use for:** Finding invoices to hand over (accounted_list_collection_candidates).

**Pitfalls:**
- case=null means the invoice was never handed over.
- submission_status=submitted means the handover is still being registered; it is retried automatically.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    case: { case_id: string, invoice_id: string, origin: string, start_step: string, submission_status: string, case_number: string | null, merged: boolean, stage: string, decision_kind: string | null, is_open: boolean, close_reason: string | null, provider_state_label: string | null, next_action_date: string | null, next_action_label: string | null, actions: string[], claim_amount: number, outstanding_principal: number | null, outstanding_total: number | null, paused_by_sweep: boolean, opened_at: string, closed_at: string | null, last_synced_at: string | null, sync_error: string | null, events: { event_id: string, occurred_at: string, kind: string, stage_from: string | null, stage_to: string | null, direction: string | null, label: string, amount: number | null }[] } | null,
    withdraw_fee: { may_apply: boolean, free_days: number | null, free_until: string | null } | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "case": {
      "case_id": "2b9c…",
      "stage": "reminder",
      "is_open": true,
      "actions": [
        "pause",
        "withdraw",
        "dispute"
      ]
    },
    "withdraw_fee": {
      "may_apply": false,
      "free_days": 14,
      "free_until": "2026-10-20T09:00:00.000Z"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/collection`

**Hand an overdue customer invoice over to the company's collections provider.**
`scope:invoices:write · risk:high · idempotent · dry-run`

Runs every handover check again (eligibility, the bank check for unbooked payments that may be this invoice, the amount still owed), then registers the claim with the provider, which starts with a reminder or a collection notice. The invoice PDF goes with it. The invoice's status does not change; payments recorded later are reported to the provider. The dry run checks everything as reads and contacts no provider.

**Use when:** accounted_list_collection_candidates lists the invoice as eligible and the customer has not paid.
**Do not use for:** Invoices that need a person's attestation (imported, no delivery record, a customer answer to a reminder, a bank not synced in 24 hours): only a person can hand those over in the web UI.

**Pitfalls:**
- expected_remaining must equal what is still owed: a payment that arrived meanwhile answers 409 COLLECTION_REMAINING_CHANGED.
- 409 COLLECTION_BANK_CANDIDATES: an unbooked incoming payment may be this invoice; book it or let a person dismiss it.
- 409 COLLECTION_BANK_STALE: the account the customer pays to was not synced in 24 hours.
- 409 COLLECTION_REMINDER_FEE_NOT_AGREED: a reminder needs a reminder fee agreed by the invoice date; omit start_step to start at the inkassokrav.
- Approval is web-only: a person approves the staged operation in Accounted.
- Over REST, send it with ?stage=true: a direct call answers 400 STAGE_REQUIRED and hands nothing over.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  expected_remaining: number,
  start_step?: "reminder" | "collection" | null,
  bank_attested?: boolean,
  delivery_attested?: boolean,
  imported_attested?: boolean,
  response_attested?: boolean
}
```

Example request:
```json
{
  "invoice_id": "7d1e…",
  "expected_remaining": 12500,
  "start_step": "collection"
}
```

Response `200`:
```ts
{
  data: {
    case: { case_id: string, invoice_id: string, origin: string, start_step: string, submission_status: string, case_number: string | null, merged: boolean, stage: string, decision_kind: string | null, is_open: boolean, close_reason: string | null, provider_state_label: string | null, next_action_date: string | null, next_action_label: string | null, actions: string[], claim_amount: number, outstanding_principal: number | null, outstanding_total: number | null, paused_by_sweep: boolean, opened_at: string, closed_at: string | null, last_synced_at: string | null, sync_error: string | null, events: { event_id: string, occurred_at: string, kind: string, stage_from: string | null, stage_to: string | null, direction: string | null, label: string, amount: number | null }[] },
    registered: boolean
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "case": {
      "case_id": "2b9c…",
      "stage": "registered",
      "submission_status": "registered"
    },
    "registered": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/collection/actions`

**Act on an invoice's open collection case: pause, resume, withdraw, mark disputed, or answer what the provider waits for.**
`scope:invoices:write · risk:high · idempotent · dry-run`

Only the actions the case offers right now are accepted (accounted_get_collection_case lists them). Pausing, resuming, withdrawing and disputing serve the open case and always run. Approving the next step, contesting a dispute, overriding the customer's "already paid" and approving legal action escalate against the customer: they re-run the bank check and only a person can approve them in Accounted.

**Use when:** The case waits for a decision (stage awaiting_decision), the customer disputes the claim, or the company wants to pause or withdraw it.
**Do not use for:** Recording a payment (mark the invoice paid; it is reported to the provider).

**Pitfalls:**
- dispute and confirm_not_paid need a message of at least ten characters.
- withdraw can cost a fee at the provider once its free period has passed (accounted_get_collection_case withdraw_fee.may_apply): show the user, then pass fee_acknowledged=true.
- already_paid is never sent: record the payment on the invoice instead (409 COLLECTION_REGISTER_PAYMENT); it is reported to the provider.
- start is not taken here: starting a delivered invoice is a handover, through accounted_send_invoice_to_collection (409 COLLECTION_START_VIA_HANDOVER).
- 409 CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE: the case does not offer that action in its current stage.
- Over REST, an escalation (approve_step, contest_dispute, confirm_not_paid, approve_legal_action) is sent with ?stage=true: a direct call answers 400 STAGE_REQUIRED. pause, resume, withdraw and dispute also commit directly.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  action: "start" | "pause" | "resume" | "withdraw" | "dispute" | "contest_dispute" | "approve_step" | "already_paid" | "confirm_not_paid" | "approve_legal_action" | "decline_legal_action",
  step?: "reminder" | "collection" | null,
  message?: string | null,
  until?: string | null,
  fee_acknowledged?: boolean
}
```

Example request:
```json
{
  "invoice_id": "7d1e…",
  "action": "pause",
  "until": "2026-11-01"
}
```

Response `200`:
```ts
{
  data: {
    case: { case_id: string, invoice_id: string, origin: string, start_step: string, submission_status: string, case_number: string | null, merged: boolean, stage: string, decision_kind: string | null, is_open: boolean, close_reason: string | null, provider_state_label: string | null, next_action_date: string | null, next_action_label: string | null, actions: string[], claim_amount: number, outstanding_principal: number | null, outstanding_total: number | null, paused_by_sweep: boolean, opened_at: string, closed_at: string | null, last_synced_at: string | null, sync_error: string | null, events: { event_id: string, occurred_at: string, kind: string, stage_from: string | null, stage_to: string | null, direction: string | null, label: string, amount: number | null }[] }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "case": {
      "case_id": "2b9c…",
      "stage": "paused"
    }
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

Creates and issues a credit note referencing the original invoice. The credit note mirrors the original line for line with reversed-sign amounts (the same VAT, revenue accounts, ROT/RUT and periodisering fields, and payee) and gets invoice_number=KR-<original> (a self-billed original: KR-<its external number>). Posts a reversing journal entry (Debit revenue + Debit output VAT / Credit AR 1510; on ROT/RUT Credit 1513 for Skatteverket's share and 1510 for the customer's; Debit 29xx where revenue is still deferred, and the accrual schedule stops) whenever the original sale reached the ledger: always under faktureringsmetoden, and under kontantmetoden once the original was paid or otherwise booked (status paid, a linked verifikat, a payment date, or a non-zero paid amount). Only a kontantmetod invoice carrying none of those signals is credited without an entry, because nothing has been recognised yet. Under deferred booking (defer_invoice_booking) an original that was never booked is booked first on its own invoice date, exactly as POST /invoices/{id}/book does (original_journal_entry_id), then credited; when that booking is refused the credit is refused before anything is written (400 INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED or INVOICE_CREDIT_ORIGINAL_BOOK_FAILED). The original transitions to status=credited once the entry exists. The credit note keeps the credited invoice's öresavrundning choice (ore_rounding), so its amount_to_pay and ore_rounding_amount mirror the original's with the opposite sign whatever the company setting is today. The credit note is dated today (Europe/Stockholm); a locked or closed period, or no fiscal period for today, returns 400 INVOICE_CREDIT_PERIOD_LOCKED before anything is written. Idempotent and dry-runnable. Emits credit_note.created. It delivers nothing and records no delivery: every response carries warning CREDIT_NOTE_NOT_DELIVERED, so fetch GET /invoices/{id}/pdf and send it to the customer yourself.

**Use when:** You need to legally cancel an issued invoice (ML 17 kap 22-23§). The original invoice cannot be edited once issued: credit it and reissue corrected.
**Do not use for:** Cancelling a draft (DELETE the draft instead). Refunding a partial payment without invalidating the whole invoice (book the refund manually via the journal-entries API in a future PR).

**Pitfalls:**
- Idempotency-Key is mandatory. Retried credits with the same key replay the cached response: no duplicate credit note is created.
- The original invoice must be in sent / paid / overdue status. Drafts, cancelled invoices, and already-credited invoices are rejected with specific error codes. A credit note cannot itself be credited (400 INVOICE_CREDIT_NOT_INVOICE).
- Fails closed: when the reversing entry cannot be posted the request fails (500 INVOICE_CREDIT_ISSUE_INCOMPLETE with details.failure_steps), the credit note stays a draft and the original is untouched; retry once the cause is fixed and the same credit note is issued. 500 INVOICE_CREDIT_REPAIR_REQUIRED means the entry posted but a later step did not finish: retrying completes it.
- Credit-note items mirror the original's lines with negated values. To credit only part of an invoice (line-level), credit the full invoice first then reissue with the corrected lines.
- Under kontantmetoden a journal entry is posted only when the original carries a booking signal (status paid, a linked verifikat, a payment date, or a non-zero paid amount): crediting an invoice with none of those creates the row without an entry (the deferral is correct, not a failure). Use the dry run to read `would_create_journal_entry` before committing.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
    handle?: string,
    invoice_number: string,
    credited_invoice_id: string,
    status: "sent",
    total: number,
    amount_to_pay: number,
    ore_rounding_amount: number,
    ore_rounding: boolean | null,
    journal_entry_id: string | null,
    original_journal_entry_id?: string,
    warnings?: { code: string, message: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
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
    "amount_to_pay": -12500,
    "ore_rounding_amount": 0,
    "ore_rounding": true,
    "journal_entry_id": "8b4b…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/link-credit-note`

**Link an existing credit note to the existing invoice it credits.**
`scope:invoices:write · risk:medium · idempotent · dry-run`

For a credit note (kreditfaktura) that exists without a link to its original, typically one imported at a system change whose reference was only free text: sets the credit note's credited_invoice_id, leaves it at status sent (where an issued credit note rests) and moves the invoice to status credited, exactly what POST /invoices/{id}/credit leaves behind in the kundreskontra. The two then net there and the invoice is no longer open or overdue. It never books a verifikat and creates no document. Allowed only where an ordinary credit would not have booked either: kontantmetoden, the invoice issued and unpaid with no verifikat, the credit note with no verifikat, the same customer, the same currency (and rate), and the credit note crediting the whole open amount. Everything else is refused with a code that names the reason. Idempotency: a second call answers 409 INVOICE_CREDIT_LINK_ALREADY_LINKED. Dry-runnable. Emits credit_note.created.

**Use when:** A fully credited invoice still shows as open or overdue in the kundreskontra because its credit note already exists as a separate document with no link to it (credited_invoice_id is null), and neither document has a verifikat.
**Do not use for:** Crediting an invoice that has no credit note yet (POST /invoices/{id}/credit creates and books it), recording a payment, or settling booked invoices against each other.

**Pitfalls:**
- Never use POST /invoices/{id}/credit for this: it creates a second credit note next to the existing one.
- 409 INVOICE_CREDIT_LINK_BOOKING_REQUIRED (details.reason) means an ordinary credit would have booked a verifikat that does not exist: accrual_method (faktureringsmetoden), original_paid_or_booked, credit_note_booked, rot_rut or customer_loss_decision. Nothing is booked for you: the entries have to be made in the bookkeeping first, and the link is then not needed for the ledger.
- 400 INVOICE_CREDIT_LINK_AMOUNT_MISMATCH: details.reason exceeds_open_amount (the credit is larger than what the invoice still asks for) or partial_credit (it is smaller; a partial credit cannot be linked yet). details carries credit_amount and open_amount.
- 409 INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN: the invoice is a draft, cancelled, already credited (details.status), itself a credit note, or already has a credit note (details.reason).
- 400 INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE: credit_note_id is not an issued document with a total below zero and nothing refunded on it.
- The invoice and the credit note must belong to the same customer and carry the same currency: 400 INVOICE_CREDIT_LINK_CUSTOMER_MISMATCH and INVOICE_CREDIT_LINK_CURRENCY_MISMATCH.
- 409 INVOICE_CREDIT_LINK_RACE means one of the two changed between the read and the write: re-read both before retrying.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ credit_note_id: string }
```

Example request:
```json
{
  "credit_note_id": "7b1d…"
}
```

Response `200`:
```ts
{
  data: {
    invoice: { id: string, handle?: string, invoice_number: string | null, status: "credited" },
    credit_note: { id: string, invoice_number: string | null, status: "sent", credited_invoice_id: string },
    credited_amount: number,
    currency: string,
    journal_entry_id: unknown
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "invoice": {
      "id": "0e9c…",
      "invoice_number": "207",
      "status": "credited"
    },
    "credit_note": {
      "id": "7b1d…",
      "invoice_number": "208",
      "status": "sent",
      "credited_invoice_id": "0e9c…"
    },
    "credited_amount": 12500,
    "currency": "SEK",
    "journal_entry_id": null
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

Marks a sent / overdue / partially_paid invoice as paid (or partially_paid). Books the payment via Debit the bank account (`payment_account` when the body names one, else the one the invoice asked to be paid to, else the company's primary bank account) / Credit 1510 under faktureringsmetoden, or Debit the bank account / Credit revenue + Credit output VAT under kontantmetoden. Optional body supports partial payments via custom balanced journal lines and exchange-rate adjustments for foreign-currency invoices. On a credit note (kreditfaktura) it records the refund paid back to the customer instead: Debit 1510 / Credit the bank account, for what the customer has tillgodo. Idempotent and dry-runnable. Emits invoice.paid (not for a refund).

**Use when:** A customer paid an invoice via a channel other than the synced bank account (cash, manual transfer, separate processor). Use dry-run to confirm the booking before committing.
**Do not use for:** Reverting a payment: the public API does not expose unmark-paid. Issue a credit note via POST /:id/credit to cancel the underlying invoice instead. Bank-matched payments: those flow through the transactions endpoints.

**Pitfalls:**
- Idempotency-Key is mandatory. Retried marks with the same key replay the cached response.
- Not payable: a quote (400 INVOICE_QUOTE_NOT_PAYABLE), a delivery note, a document outside sent/overdue/partially_paid, or an invoice with an active credit note, a draft included (400 INVOICE_PAID_NOT_PAYABLE; details.reason says which). A payment_date after today (Swedish calendar day) returns 400 PAYMENT_DATE_IN_FUTURE. All of these fire under dry-run too.
- `payment_account` is the 19xx account the money landed on, for a company that receives customer payments on another bank account than the invoice names or the primary. It must be the ledger account of one of the company's own enabled cash accounts (GET /cash-accounts): anything else returns 400 INVOICE_PAID_PAYMENT_ACCOUNT_INVALID with details.available_payment_accounts and books nothing, under dry-run too. It is not sent together with `lines` (400 VALIDATION_ERROR). The dry run answers the resolved account as payment_account.
- Custom `lines` must balance (sum of debits = sum of credits, both > 0). Otherwise returns 400 INVOICE_PAID_LINES_UNBALANCED.
- For foreign-currency invoices, supply `exchange_rate_difference` (SEK delta vs the invoice's booked rate) to book the FX adjustment correctly: the bank takes that figure plus the delta, 1510 clears what it carries and the gap lands on 3960/7960. Omitting it on a non-SEK invoice books the bank at what 1510 carries, with no FX gain/loss.
- Custom `lines` are journal lines and therefore SEK, while `total` / `paid_amount` / `remaining_amount` are stored in the invoice currency. A line total equal to what 1510 carries pays the whole remainder, any other its share of that (at `invoice.exchange_rate` when the ledger cannot say); a non-SEK invoice with no exchange_rate on file returns 400 MATCH_INVOICE_BOOKING_RATE_MISSING rather than silently treating the SEK amount as invoice currency. When a SEK invoice's own verifikat booked its öresavrundning, lines that settle it in full credit 1510 what it carries for it: lines that would leave öre on 1510 return 400 INVOICE_PAID_ORE_LEFT with details.carried, the figure to credit.
- Cash basis (kontantmetoden) recognizes revenue HERE, not at :mark-sent. The dashboard tracks this via company_settings.accounting_method.
- Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): an invoice sent without its verifikat is booked first by the :book step (Debit 1510 / Credit revenue + output VAT, dated on the invoice date), then the payment clears that 1510. sale_journal_entry_id in the response names it, and the dry run returns it as sale_entry. When the book step refuses (invoice date in a locked period PERIOD_LOCKED, no fiscal year INVOICE_BOOK_NO_FISCAL_PERIOD, a partially paid invoice INVOICE_BOOK_INVALID_STATUS), or the payment date is locked (PERIOD_LOCKED with details.payment_date), the payment is refused with that code, details.sale_first is true, and nothing is booked.
- Credit notes: the refund is recorded for an issued SEK credit note with its verifikat and no ROT/RUT, up to what the customer has tillgodo (409 CREDIT_NOTE_REFUND_UNSUPPORTED or CREDIT_NOTE_REFUND_NOTHING_OWED otherwise). Custom `lines` must debit 1510 only. When the credit note's verifikat booked its öresavrundning, the refund that settles it pays back what 1510 carries for it, so refunded_amount can differ from the total by the öre; custom `lines` that would leave öre on 1510 return 400 CREDIT_NOTE_REFUND_ORE_LEFT with details.owed, the figure to send. 409 CREDIT_NOTE_REFUND_LIKELY_BOOKED when a manual verifikat already debits 1510 with the amount; `force: true` (fresh Idempotency-Key) books it anyway.
- Duplicate-payment guard: if an unlinked inbound bank transaction looks like this payment, returns 409 INVOICE_PAID_LIKELY_DUPLICATE with candidate transactions. Retry with `force: true` to bypass, but the retry MUST use a fresh Idempotency-Key (the original is body-hash bound; reusing it returns 400 IDEMPOTENCY_KEY_REUSE). The guard is also evaluated under dry-run, so a successful dry-run does not guarantee a successful commit.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  payment_date?: string,
  exchange_rate_difference?: number,
  notes?: string,
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, dimensions?: Record<string, string> }[],
  force?: boolean,
  payment_account?: string
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
    handle?: string,
    invoice_number: string,
    status: "paid" | "partially_paid" | "sent" | "overdue",
    total: number,
    paid_amount: number,
    remaining_amount: number,
    paid_at: string | null,
    journal_entry_id: string | null,
    sale_journal_entry_id?: string,
    refunded_amount?: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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

Marks a draft invoice as sent: for invoices delivered outside Accounted (an external e-invoice provider, postal, manual email). Not needed after a successful Peppol send (POST /invoices/{id}/send-peppol, accounted_send_invoice_peppol or the dashboard): that flow issues the invoice itself. If a Peppol send reports that the invoice was sent but could not be marked as sent (issuance.ok=false with warning PEPPOL_SENT_NOT_ISSUED, invoice still in draft), :mark-sent is the documented recovery and completes the issuance; a number already allocated is reused, never consumed twice. Peppol sending needs a per-company access grant (POST /peppol/access-request, or Inställningar > Kopplingar > E-faktura via Peppol (Settings > Connections > E-invoicing via Peppol) in the dashboard; check an invoice with GET /invoices/{id}/peppol): senders whose org number is not a personnummer (every legal form except enskild firma), standard invoices only, Swedish org-number buyers whose org number is not a personnummer, SEK with taxable Swedish VAT at 6/12/25 % only, no ROT/RUT deductions. Allocates the F-series invoice_number atomically (ML 17 kap 24§ p.2). When the company books at issue (faktureringsmetoden without defer_invoice_booking), also posts the invoice journal entry (Debit AR 1510 / Credit revenue + output VAT); under defer_invoice_booking the invoice is marked sent without a verifikat and is booked afterwards with POST /invoices/{id}/book. With body paid_at_issue: { account_number } (a 19xx kassa, bank or Swish account) the invoice is issued already paid, a kontantfaktura: one verifikat on the invoice date, Debit that account / Credit revenue + output VAT, no 1510 leg, in either accounting method, and status ends paid (no :mark-paid afterwards). Emits invoice.sent. Idempotent and dry-runnable. The companion :send action (PR-B-2b-3) adds PDF rendering and email delivery on top of this same flow.

**Use when:** You delivered the invoice through a channel other than Accounted's email or Peppol send (an external e-invoice provider, postal, your own SMTP) and need to record it as sent so the F-series number is allocated and the journal entry is posted; or a Peppol send was accepted by the network but reported that the invoice could not be marked as sent. With paid_at_issue: the customer paid when the invoice was issued (Swish, card, cash at the counter) and the invoice is also the receipt.
**Do not use for:** Sending the invoice via Accounted email: use :send (PR-B-2b-3) for that. Marking an already-sent invoice as paid: use :mark-paid (PR-B-2b-2).

**Pitfalls:**
- Only invoices in `status=draft` can be marked sent. Other states return 409 INVOICE_UPDATE_NOT_DRAFT (re-used; the action is structurally an update).
- Allocation is atomic. If a concurrent transition beats the agent's request to the same draft, the runner-up gets 409 INVOICE_UPDATE_NOT_DRAFT and no number is consumed.
- A delivery note (document_type=delivery_note) keeps its own D-series number: mark-sent books nothing and takes no F-number. It is never emailed, so this is its only way to sent.
- A momsfri sale (a company outside the VAT register, vat_treatment=exempt, vat_amount=0) states no moms_ruta. Any other invoice without one, an imported draft, returns 400 VALIDATION_ERROR (details.field moms_ruta): send its items again with PATCH /invoices/{id}, or re-create it.
- A faktura states the seller's and the buyer's name and address (ML 17 kap 24 §) on a sale to a business or another legal person, and to a private person only for construction work (a ROT or grön teknik line). A domestic sale without VAT from a VAT-registered company is an exempt supply that needs no invoice (ML 17 kap 12 §) and is not asked either. A förenklad faktura may leave them out (ML 17 kap 26-28 §§): at most 4 000 kr including VAT, or any amount from a seller outside the VAT register, but never where the buyer in another EU country pays the VAT (reverse charge, or an EU business buying from a seller outside the VAT register). Otherwise a missing company name or address (company settings) returns 400 INVOICE_SEND_SELLER_ADDRESS_MISSING and a missing customer name or address (a street plus a postal code or town, or a postal code and town) 400 INVOICE_SEND_BUYER_ADDRESS_MISSING, both before a number is allocated. A förenklad faktura without them is issued with warning SELLER_ADDRESS_MISSING or BUYER_ADDRESS_MISSING, but it must still identify the seller (its name, organisationsnummer or VAT number): without any of them it returns 400 INVOICE_SEND_SELLER_ADDRESS_MISSING.
- Idempotency-Key is mandatory. A retried mark-sent with the same key replays the cached response.
- Fails closed: when the invoice's verifikat cannot be posted (no open or a locked period, a required dimension, an account outside the chart) the invoice stays a draft, keeps any number already allocated, and the request fails with the engine's code or 500 INVOICE_MARK_SENT_BOOK_FAILED (details.reason in Swedish). Fix the cause and retry.
- paid_at_issue is only for a plain faktura: a proforma or quote (details.reason not_invoice), a självfaktura (self_billed) or an invoice with periodised lines (periodisering) returns 400 INVOICE_PAID_AT_ISSUE_NOT_ALLOWED before anything changes; issue it without paid_at_issue and record the payment with :mark-paid. account_number must be a 19xx account (400 VALIDATION_ERROR otherwise) that exists in the chart. It always settles the full amount on the invoice date: for a partial or later payment, issue without it and use :mark-paid.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ paid_at_issue?: { account_number: string } }
```

Example request:
```json
{
  "paid_at_issue": {
    "account_number": "1930"
  }
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    handle?: string,
    invoice_number: string,
    status: "sent" | "paid",
    total: number,
    journal_entry_id: string | null,
    warnings?: { code: string, message: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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
- An invoice without a customer (customer_id null, e.g. its customer was deleted) has no buyer to print: 409 INVOICE_CUSTOMER_MISSING. Set customer_id on the draft or delete it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200` (`application/pdf`).

---

### `GET /api/v1/companies/{companyId}/invoices/{id}/peppol`

**Check whether a customer invoice can be sent over Peppol, to which participant, and what is missing.**
`scope:invoices:read · risk:low · idempotent`

Runs every gate the Peppol send applies, as reads, and lists each failing one: the access point is configured, the company is not the demo company, the company has Peppol access and sends remain, the invoice is a plain invoice in draft/sent/overdue, a draft can be issued (payee account), and the BIS Billing 3 document builds (EN 16931 + Sweden CIUS preflight). Answers the sender and recipient participant ids (0007 + org number). The recipient's registration in the Peppol network is not looked up here: the send does that on commit.

**Use when:** Before POST /invoices/{id}/send-peppol, to fix what is missing (a buyer reference, a Bankgiro, the org number) instead of learning it from a refused send.
**Do not use for:** Downloading the UBL XML (the dashboard export) or reading past transmissions (GET /invoices/{id}/peppol/deliveries).

**Pitfalls:**
- ready=true means nothing on Accounted's side stops the send; the buyer can still be unregistered in Peppol, which the send answers as 422 PEPPOL_RECIPIENT_NOT_REACHABLE.
- A draft without a number is validated with a placeholder number: the real F-series number is allocated only when the send commits.
- PEPPOL_ACCESS_REQUIRED means the company has not been granted Peppol: request it with POST /peppol/access-request.
- Peppol here is BIS Billing 3: senders whose org number is not a personnummer (every legal form except enskild firma), standard invoices only (no credit notes, quotes, proformas or self-billing), Swedish org-number buyers whose org number is not a personnummer, SEK with taxable Swedish VAT at 6/12/25 %, no ROT/RUT deductions. Anything else is listed as a blocker.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    invoice_id: string,
    invoice_number: string | null,
    invoice_status: string,
    ready: boolean,
    will_issue_invoice: boolean,
    sender: { scheme: string, identifier: string } | null,
    recipient: { scheme: string, identifier: string } | null,
    transport: { available: boolean, provider: string | null, reason: string | null },
    access: { status: "none" | "requested" | "enabled" | "disabled", send_enabled: boolean, receive_enabled?: boolean, max_sends: number | null, sent_count: number, remaining_sends: number | null },
    blockers: { code: string, field: string | null, message_sv: string, message_en: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "invoice_id": "7d1e…",
    "invoice_number": "F-1042",
    "invoice_status": "sent",
    "ready": false,
    "will_issue_invoice": false,
    "sender": {
      "scheme": "0007",
      "identifier": "5560160680"
    },
    "recipient": {
      "scheme": "0007",
      "identifier": "5566778899"
    },
    "transport": {
      "available": true,
      "provider": "qvalia",
      "reason": null
    },
    "access": {
      "status": "enabled",
      "send_enabled": true,
      "max_sends": 50,
      "sent_count": 3,
      "remaining_sends": 47
    },
    "blockers": [
      {
        "code": "BUYER_REFERENCE_REQUIRED",
        "field": "invoice.your_reference",
        "message_sv": "Märkning eller Er referens krävs för Peppol när inköpsordernummer saknas.",
        "message_en": "A marking or buyer reference is required for Peppol when no purchase order reference is available."
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

### `GET /api/v1/companies/{companyId}/invoices/{id}/peppol/deliveries`

**List an invoice's Peppol deliveries and their network status.**
`scope:invoices:read · risk:low · idempotent`

Every document staged for the Peppol network for this invoice, newest first, with its lifecycle status (staged through submission_accepted, transport_succeeded and the buyer's business response), the access point's submission id and the SHA-256 of the exact XML. Also answers whether sending is available in this environment and the company's access grant. Status updates arrive asynchronously from the access point.

**Use when:** After a send, to follow the delivery, or before resending, to see whether the invoice already went out.
**Do not use for:** Checking whether an invoice can be sent (GET /invoices/{id}/peppol) or email deliveries.

**Pitfalls:**
- submission_accepted means the access point took the document, not that the buyer received it; transport_succeeded and business_accepted come later.
- outcome_unreported=true (submission_accepted for over 24 hours) means the access point has not reported an outcome back. It is not a failed delivery: do not resend, and ask the buyer when certainty is needed.
- A delivery in retryable_failure, failed or no_route can be resent with POST /invoices/{id}/send-peppol (a failed one as a new delivery that replaces its submission); a business_rejected one cannot: the buyer refused the invoice.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    invoice_id: string,
    deliveries: { delivery_id: string, idempotency_key: string, recipient_scheme: string, recipient_identifier: string, xml_sha256: string, provider: string | null, provider_submission_id: string | null, status: string, status_at: string, status_detail: string | null, submitted_at: string | null, terminal_at: string | null, outcome_unreported?: true, outcome_hint?: string }[],
    transport: { available: boolean, provider: string | null, reason: string | null },
    access: { status: "none" | "requested" | "enabled" | "disabled", send_enabled: boolean, receive_enabled?: boolean, max_sends: number | null, sent_count: number, remaining_sends: number | null }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "invoice_id": "7d1e…",
    "deliveries": [
      {
        "delivery_id": "2b9c…",
        "idempotency_key": "5e3f…",
        "recipient_scheme": "0007",
        "recipient_identifier": "5566778899",
        "xml_sha256": "a3f1…",
        "provider": "qvalia",
        "provider_submission_id": "int-1",
        "status": "transport_succeeded",
        "status_at": "2026-09-26T10:01:00Z",
        "status_detail": null,
        "submitted_at": "2026-09-26T10:00:02Z",
        "terminal_at": null
      }
    ],
    "transport": {
      "available": true,
      "provider": "qvalia",
      "reason": null
    },
    "access": {
      "status": "enabled",
      "send_enabled": true,
      "receive_enabled": false,
      "max_sends": 50,
      "sent_count": 3,
      "remaining_sends": 47
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/{id}/quote-status`

**Record the customer decision on a quote (offert).**
`scope:invoices:write · risk:low · idempotent · dry-run · reversible`

Sets quote_status on a quote (document_type=quote) to open, accepted or declined. Any transition between the three is allowed until the quote has been converted to an invoice; after that the decision is locked (409 INVOICE_QUOTE_ALREADY_INVOICED). "expired" is never written: it is derived from valid_until and reported as effective_quote_status. Accepting a quote past valid_until is allowed (pass valid_until here to extend an expired quote so it reads as open again). No journal entry, number allocation or event is involved. Idempotent and dry-runnable.

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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ status: "open" | "accepted" | "declined", valid_until?: string | "" }
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
    handle?: string,
    invoice_number: string | null,
    document_type: "quote",
    status: string,
    quote_status: "open" | "accepted" | "declined",
    effective_quote_status: "open" | "accepted" | "declined" | "expired",
    quote_decided_at: string | null,
    valid_until: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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

The full send pipeline: preflight PDF render → allocate F-series number atomically → final PDF render → issue: flip status to sent and post the journal entry (real invoice, unless kontantmetoden or defer_invoice_booking; a deferred invoice is booked afterwards with POST /invoices/{id}/book) BEFORE the email, fail closed → email via the email extension (Resend or SMTP; the PDF, then the invoice's own attachments, copy to company) → archive PDF as underlag → emit invoice.sent. A refused journal entry returns the engine's error and nothing is sent; post-email failures surface as warnings.

**Use when:** You want Accounted to deliver the invoice to the customer via email. Peppol e-invoices go through POST /invoices/{id}/send-peppol (check readiness first with GET /invoices/{id}/peppol; per-company access grant requested with POST /peppol/access-request or under Inställningar > Kopplingar > E-faktura via Peppol (Settings > Connections > E-invoicing via Peppol); senders whose org number is not a personnummer (every legal form except enskild firma), standard invoices only, Swedish org-number buyers whose org number is not a personnummer, SEK with taxable Swedish VAT at 6/12/25 % only, no ROT/RUT deductions). A successful Peppol send issues the invoice itself, so do not call :mark-sent after it; only if it reports that the invoice was sent via Peppol but could not be marked as sent (issuance.ok=false) does :mark-sent complete the issuance. For invoices delivered through another channel (an external e-invoice provider, postal, own SMTP) use :mark-sent instead.
**Do not use for:** Re-sending an already-sent invoice (returns 409 INVOICE_UPDATE_NOT_DRAFT). Sending a delivery note (400 INVOICE_SEND_DELIVERY_NOTE: it is marked sent with :mark-sent, never emailed). Sending a credit note (use the :credit endpoint to issue the kreditfaktura, then deliver its PDF yourself).

**Pitfalls:**
- Idempotency-Key is mandatory.
- Email service must be configured: without RESEND_API_KEY + RESEND_FROM_EMAIL (or an SMTP relay via EMAIL_PROVIDER=smtp) the endpoint returns 503 INVOICE_SEND_EMAIL_NOT_CONFIGURED.
- Customer must have an email address. 400 INVOICE_SEND_NO_CUSTOMER_EMAIL otherwise.
- A faktura states the seller's and the buyer's name and address (ML 17 kap 24 §): 400 INVOICE_SEND_SELLER_ADDRESS_MISSING or INVOICE_SEND_BUYER_ADDRESS_MISSING before a number is allocated, on the same rule as :mark-sent. A förenklad faktura (at most 4 000 kr including VAT, or any amount from a seller outside the VAT register; never where the buyer in another EU country pays the VAT) may leave them out and is sent with warning SELLER_ADDRESS_MISSING or BUYER_ADDRESS_MISSING, but it must still identify the seller (name, organisationsnummer or VAT number), or it is refused with INVOICE_SEND_SELLER_ADDRESS_MISSING. An invoice to a private person needs neither unless it is construction work (a ROT or grön teknik line), and neither does a domestic sale without VAT from a VAT-registered company (an exempt supply, ML 17 kap 12 §).
- An invoice without a customer (customer_id null, e.g. its customer was deleted) is refused with 409 INVOICE_CUSTOMER_MISSING before anything changes. Set customer_id on the draft or delete it.
- A cancelled invoice is rejected (400 INVOICE_SEND_CANCELLED): its F-series number is preserved for compliance but the document is not a valid faktura.
- The journal entry is posted before the email leaves: a refusal (400 MANDATORY_DIMENSION_MISSING or DIMENSION_VALIDATION_FAILED, a locked period, ...) returns the engine's error, the invoice stays in `draft` and no email is sent. Fix the tag or the period and send again.
- Email failure with nothing booked (kontantmetoden, deferred booking, proforma) returns 502 INVOICE_SEND_PROVIDER_FAILED with the invoice back in `draft`; the F-series number stays consumed (same orphan window as :mark-sent). Email failure after the journal entry posted returns 502 INVOICE_SEND_ISSUED_NOT_DELIVERED: the invoice stays issued (`sent`, booked, PDF archived) and must be delivered another way; do not call :send again.
- After the email succeeds, archive-link/event failures become warnings on the response.
- additional_cc and additional_bcc require the API key user to be an owner or admin of the company.
- The deprecated cc response field contains only the first address. Use cc_addresses for the complete CC list.
- BCC recipients are retained only in the restricted delivery archive and are omitted from normal and dry-run responses.
- email_subject and email_body replace the subject and the message of this one email (the greeting and sign-off stay) and take the same placeholders as the company email texts; they are not stored on the invoice. Empty or whitespace-only means the company or stock text.
- attachment_document_ids attaches existing documents of the same company (404 INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND for an unknown or foreign id); there is no upload here. At most 10 files and 25 MB together (400 INVOICE_ATTACHMENTS_TOO_MANY / INVOICE_ATTACHMENTS_TOO_LARGE). Once the invoice is sent its attachments are fixed and their documents can no longer be deleted (BFL retention).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  additional_cc?: string[],
  additional_bcc?: string[],
  email_subject?: string | null,
  email_body?: string | null,
  attachment_document_ids?: string[]
}
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
    handle?: string,
    invoice_number: string,
    status: "sent",
    total: number,
    message_id: string | null,
    sent_to: string,
    cc: string | null,
    cc_addresses: string[],
    journal_entry_id: string | null,
    warnings?: { code: string, message: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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

### `POST /api/v1/companies/{companyId}/invoices/{id}/send-peppol`

**Send a customer invoice as a Peppol e-invoice (BIS Billing 3) through the access point.**
`scope:invoices:write · risk:high · idempotent · dry-run`

Builds the BIS Billing 3 UBL document, stages it as a delivery (retained with the invoice's fiscal year), looks the buyer up in the Peppol network and submits it. A draft is numbered first (the number is in the document) and issued before the network gets it (status sent, verifikat under faktureringsmetoden); once the network accepted it the PDF is archived as underlag, as :mark-sent does. Resending the exact same document while its delivery is live replays the first submission instead of transmitting twice; after a failed delivery it is sent again as a new delivery that replaces the failed submission at the access point, and counts as a send. The dry run validates everything as reads and contacts no network.

**Use when:** The buyer receives e-invoices over Peppol (typically public sector, where Lag 2018:1277 requires it, or a company that asks for it) and GET /invoices/{id}/peppol shows no blockers.
**Do not use for:** Emailing the invoice (POST /invoices/{id}/send), recording one delivered another way (:mark-sent), credit notes, quotes or proformas.

**Pitfalls:**
- Needs the company's Peppol access: 403 PEPPOL_ACCESS_REQUIRED until it is switched on (POST /peppol/access-request; immediate for a company on a paid plan), 409 PEPPOL_SEND_LIMIT_REACHED once the monthly sending cap is used.
- A buyer not registered in Peppol answers 422 PEPPOL_RECIPIENT_NOT_REACHABLE and nothing is transmitted; a failed lookup answers 502 PEPPOL_LOOKUP_FAILED and is safe to retry.
- 422 PEPPOL_SUBMISSION_REJECTED is the access point's verdict on the document and ends the delivery (failed): fix what the reason names and send again, which stages a new delivery; once issued, a correction of the invoice itself is a credit note plus a new invoice.
- 502 PEPPOL_SUBMISSION_FAILED and 409 PEPPOL_SEND_PRECONDITION_FAILED leave the delivery resendable: retry later or fix the Peppol settings.
- When the invoice stays issued after the failure (issued before this send, or a draft booked on issue) the codes are 422 PEPPOL_SUBMISSION_REJECTED_AFTER_ISSUE and 502 PEPPOL_SUBMISSION_FAILED_AFTER_ISSUE, with details.invoice_status and details.journal_entry_id: the invoice is issued, so resend it or deliver the PDF another way.
- 409 PEPPOL_DUPLICATE_INVOICE_NUMBER: the access point already holds an invoice with this number for this recipient (ends the delivery). 409 PEPPOL_BUSINESS_REJECTED: the buyer refused the invoice via Peppol; it is not sent again, credit it and create a new invoice. 409 CONNECTOR_PEPPOL_RESEND_NOT_FAILED: a resend was refused because the access point has not reported the earlier delivery as failed (nothing is sent).
- A draft whose verifikat the engine refuses (400 MANDATORY_DIMENSION_MISSING or DIMENSION_VALIDATION_FAILED, a locked period, ...) is not transmitted: the engine's error comes back and the invoice stays in draft. If the network then fails to take a draft that was booked on issue, the invoice stays issued (details.invoice_status sent) and can be resent.
- An invoice date outside every fiscal year answers 422 PEPPOL_FISCAL_PERIOD_MISSING (the delivery needs its retention basis).
- Files attached to the invoice in Accounted travel inside the e-faktura as embedded PDFs (AdditionalDocumentReference; the dry run lists them under preview.attachments). A file that is not a PDF, or more than 5 MB together, answers 400 VALIDATION_ERROR naming it (details.issues: PEPPOL_ATTACHMENT_NOT_PDF, PEPPOL_ATTACHMENTS_TOO_LARGE) before anything is issued or sent.
- Peppol here is BIS Billing 3: senders whose org number is not a personnummer (every legal form except enskild firma), standard invoices only (no credit notes, quotes, proformas or self-billing), Swedish org-number buyers whose org number is not a personnummer, SEK with taxable Swedish VAT at 6/12/25 %, no ROT/RUT deductions. Anything else is listed as a blocker.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: {
    invoice_id: string,
    invoice_number: string | null,
    invoice_status: string,
    network_submitted: true,
    already_submitted: boolean,
    delivery: { delivery_id: string, idempotency_key: string, recipient_scheme: string, recipient_identifier: string, xml_sha256: string, provider: string | null, provider_submission_id: string | null, status: string, status_at: string, status_detail: string | null, submitted_at: string | null, terminal_at: string | null, outcome_unreported?: true, outcome_hint?: string },
    recipient: { scheme: string, identifier: string } | null,
    journal_entry_id: string | null,
    issuance: { ok: true, partial_failures: unknown[] } | { ok: false, error_code: string } | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "invoice_id": "7d1e…",
    "invoice_number": "F-1042",
    "invoice_status": "sent",
    "network_submitted": true,
    "already_submitted": false,
    "delivery": {
      "delivery_id": "2b9c…",
      "idempotency_key": "5e3f…",
      "recipient_scheme": "0007",
      "recipient_identifier": "5566778899",
      "xml_sha256": "a3f1…",
      "provider": "qvalia",
      "provider_submission_id": "int-1",
      "status": "submission_accepted",
      "status_at": "2026-09-26T10:00:02Z",
      "status_detail": null,
      "submitted_at": "2026-09-26T10:00:02Z",
      "terminal_at": null
    },
    "recipient": {
      "scheme": "0007",
      "identifier": "5566778899"
    },
    "journal_entry_id": "9a0b…",
    "issuance": {
      "ok": true,
      "partial_failures": []
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/invoices/{id}/underlag`

**List the archived documents a customer invoice rests on (its underlag), oldest link first.**
`scope:invoices:read · risk:low · idempotent`

Each row names the document, its own verifikat (journal_entry_id, voucher) when it has one, and when it was linked. Underlag is internal: it is never sent with the invoice. Files that go out with the invoice are its Bilagor (attachment_document_ids on the send endpoints).

**Use when:** The end customer asks what an invoiced line rests on, or you need the documents filed behind an invoice.
**Do not use for:** The files emailed with the invoice (attachment_document_ids on POST /invoices/{id}/send) or a verifikat's own underlag (GET /documents?journal_entry_id=).

**Pitfalls:**
- Works in every state of the invoice, drafts included.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    invoice_id: string,
    underlag: { document_id: string, file_name: string, mime_type: string | null, file_size_bytes: number | null, journal_entry_id: string | null, voucher: string | null, document_created_at: string | null, attached_at: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "invoice_id": "1d2e…",
    "underlag": [
      {
        "document_id": "4f1c…",
        "file_name": "dahl-faktura-88412.pdf",
        "mime_type": "application/pdf",
        "file_size_bytes": 61204,
        "journal_entry_id": "9a7e…",
        "voucher": "B14",
        "document_created_at": "2026-10-02T08:12:44Z",
        "attached_at": "2026-11-06T13:05:10Z"
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

### `POST /api/v1/companies/{companyId}/invoices/{id}/underlag`

**Link archived documents to a customer invoice as its underlag.**
`scope:invoices:write · risk:low · idempotent · dry-run · reversible`

Links each document by reference, in any state of the invoice (sent and paid included). The document keeps its own verifikat link: a supplier invoice's underlag stays on the supplier invoice's verifikat. A document already linked stays linked once, so a repeat is harmless. Answers the invoice's whole underlag list. Underlag is internal: it is never sent with the invoice. Files that go out with the invoice are its Bilagor (attachment_document_ids on the send endpoints). Dry-runnable.

**Use when:** An invoice rests on documents already in the archive: the wholesaler invoices behind invoiced material, a time report, a delivery note. Upload a new file first (POST /documents) and link its id.
**Do not use for:** Sending files with the invoice (attachment_document_ids on the send endpoints) or making a document a verifikat's underlag (POST /documents/{id}/link).

**Pitfalls:**
- Every document must be a current version in the same company: anything else is 404 INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND with the ids in details.document_ids, and nothing is linked.
- At most 25 documents per call and 100 per invoice (400 INVOICE_UNDERLAG_TOO_MANY).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ document_ids: string[] }
```

Example request:
```json
{
  "document_ids": [
    "4f1c…"
  ]
}
```

Response `200`:
```ts
{
  data: {
    invoice_id: string,
    attached_document_ids: string[],
    underlag: { document_id: string, file_name: string, mime_type: string | null, file_size_bytes: number | null, journal_entry_id: string | null, voucher: string | null, document_created_at: string | null, attached_at: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "invoice_id": "1d2e…",
    "attached_document_ids": [
      "4f1c…"
    ],
    "underlag": [
      {
        "document_id": "4f1c…",
        "file_name": "dahl-faktura-88412.pdf",
        "mime_type": "application/pdf",
        "file_size_bytes": 61204,
        "journal_entry_id": "9a7e…",
        "voucher": "B14",
        "document_created_at": "2026-10-02T08:12:44Z",
        "attached_at": "2026-11-06T13:05:10Z"
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

### `DELETE /api/v1/companies/{companyId}/invoices/{id}/underlag/{documentId}`

**Remove one document from a customer invoice's underlag.**
`scope:invoices:write · risk:low · idempotent · dry-run · reversible`

Removes only the link, in any state of the invoice: the document stays in the archive and keeps its own verifikat link. Dry-runnable.

**Use when:** A document was linked to the wrong invoice.
**Do not use for:** Deleting the document (DELETE /documents/{id}) or removing a file the invoice was sent with (fixed once sent).

**Pitfalls:**
- A document that is not underlag of the invoice is 404 INVOICE_UNDERLAG_NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `documentId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: { invoice_id: string, document_id: string, detached: true },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "invoice_id": "1d2e…",
    "document_id": "4f1c…",
    "detached": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/invoices/bulk-book`

**Book many customer invoices in one call, each with its own outcome.**
`scope:invoices:write · risk:high · idempotent · dry-run`

The bulk Bokför of the invoice list. Per invoice id (at most 200, duplicates processed once): a sent or overdue invoice without a verifikat gets the same revenue verifikat as POST /invoices/{id}/book; a draft is issued and booked like :mark-sent (F-series number allocated, marked sent WITHOUT email, verifikat posted, PDF archived, invoice.sent emitted), but only when the company books at issue: under defer_invoice_booking a draft fails with INVOICE_BOOK_DEFERRED_DRAFT and is not touched. Partial success: items are booked one by one in order, a failed item never stops the others and never undoes the ones before it, and the answer is 200 with one result per unique id plus a summary. Only whole-batch preconditions fail the request (kontantmetoden, unreadable settings). Idempotent. Dry-runnable: the dry run answers per item what would happen, with the lines, and writes nothing.

**Use when:** Several invoices are waiting to be booked (the unbooked list, or MCP-created drafts in a company that books at issue) and the user wants them booked together.
**Do not use for:** Sending invoices to customers (no email is sent here: use :send), paid invoices, credit notes, or kontantmetoden companies.

**Pitfalls:**
- Check data.summary.failed and each data.results[].error_code: a 200 does not mean every invoice was booked.
- Under kontantmetoden the whole request answers 400 INVOICE_BOOK_CASH_METHOD.
- Per-item codes mirror POST /invoices/{id}/book (INVOICE_NOT_FOUND, INVOICE_BOOK_ALREADY_BOOKED, INVOICE_BOOK_INVALID_STATUS, INVOICE_BOOK_NOT_BOOKABLE, INVOICE_BOOK_DEFERRED_DRAFT, PERIOD_LOCKED, INVOICE_BOOK_NO_FISCAL_PERIOD, INVOICE_BOOK_CONFLICT) plus the issuance codes for drafts (INVOICE_SEND_PAYMENT_ACCOUNT_MISSING, INVOICE_SEND_VAT_NUMBER_MISSING, INVOICE_SEND_SELLER_ADDRESS_MISSING, INVOICE_SEND_BUYER_ADDRESS_MISSING, INVOICE_MARK_SENT_*).
- A draft that is issued consumes its F-number even if a later step fails; a locked period is checked first, so a lock never costs a number.
- A retried call with a new Idempotency-Key is safe: booked invoices answer INVOICE_BOOK_ALREADY_BOOKED per item.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ invoice_ids: string[] }
```

Example request:
```json
{
  "invoice_ids": [
    "7d1e…",
    "8e2f…"
  ]
}
```

Response `200`:
```ts
{
  data: {
    results: { id: string, handle?: string, status: "booked" | "failed", journal_entry_id?: string | null, error_code?: string, error?: string }[],
    summary: { total: number, booked: number, failed: number }
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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
        "id": "7d1e…",
        "status": "booked",
        "journal_entry_id": "9a0b…"
      },
      {
        "id": "8e2f…",
        "status": "failed",
        "error_code": "INVOICE_BOOK_INVALID_STATUS",
        "error": "Endast skickade eller förfallna fakturor kan bokföras i efterhand."
      }
    ],
    "summary": {
      "total": 2,
      "booked": 1,
      "failed": 1
    }
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
`scope:invoices:draft · risk:medium · idempotent · dry-run · reversible`

Bulk-creation endpoint. Each invoice in the request array is validated and inserted independently. By default, individual failures do not roll back successes: the response carries a per-item results array with ok/error markers and a summary. Idempotent (the whole batch is keyed by the single Idempotency-Key). Dry-runnable.

**Use when:** You're importing a batch of invoices from another system, or producing many invoices programmatically (e.g. monthly subscription billing). Use dry-run first to validate the whole batch before committing.
**Do not use for:** Sending the same invoice to multiple customers: POST /invoices once per customer. Long-running imports of > 50 invoices: split into pages. Transactional all-or-nothing imports: not yet supported (passing all_or_nothing: true returns 501 NOT_IMPLEMENTED; the flag is reserved for a future RPC).

**Pitfalls:**
- Idempotency-Key is mandatory and covers the WHOLE batch. A retried bulk-create returns the cached full response: it does not retry only the failed items.
- Passing all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist; omit the flag (or pass false).
- Each item is built exactly like POST /invoices: the same fields (line discounts, text rows, articles, posting accounts, periodisering, ROT/RUT, per-invoice VAT treatment, payee account) and the same validation and error codes. A failing item is a per-item failure, not a whole-batch failure.
- Currency conversion is best-effort PER ITEM. A failed Riksbanken fetch leaves that item's SEK columns null but does NOT fail the item.
- Quotes (document_type: quote) are refused per item as VALIDATION_ERROR: a quote carries its own OF-number, valid_until and quote_status. Create quotes one at a time with POST /invoices.
- Self-billing invoices (is_self_billed: true) are refused per item as VALIDATION_ERROR: they are booked at once, not drafted. Register them one at a time with POST /invoices.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  invoices: { customer_id: string, invoice_date: string, due_date: string, delivery_date?: string | "", currency: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD", document_type?: "invoice" | "proforma" | "delivery_note" | "quote", valid_until?: string | "", your_reference?: string, our_reference?: string, invoice_marking?: string, delivery_address?: { name?: string | null, address_line1?: string | null, address_line2?: string | null, postal_code?: string | null, city?: string | null, country?: string | "" | null } | null, notes?: string, payment_link_url?: string | "", payment_link_auto?: boolean, qr_mode?: "auto" | "bank_app" | "swish" | "payment_link" | "none" | null, deduction_personnummer?: string, deduction_housing_designation?: string, deduction_apartment_number?: string, deduction_brf_org_number?: string | "", save_as_draft?: boolean, ore_rounding?: boolean, default_dimensions?: Record<string, string>, is_self_billed?: boolean, external_invoice_number?: string | "", self_billing_agreement_ref?: string, received_date?: string | "", vat_breakdown?: { vat_rate: 0 | 6 | 12 | 25, vat_amount: number }[], payment_cash_account_id?: string | "" | null, vat_treatment?: "standard" | "export" | "reverse_charge" | "reverse_charge_domestic" | null, delivery_country?: string | null, items: { line_type?: "product" | "text", description: string, quantity: number, unit: string, unit_price: number, discount_percent?: number | null, vat_rate?: number, article_id?: string | null, revenue_account?: string | null, sales_order_item_id?: string | null, deduction_type?: "rot" | "rut" | "gron_teknik" | null, labor_hours?: number | null, work_type?: string | null, housing_designation?: string | null, apartment_number?: string | null, brf_org_number?: string | "" | null, accrual_period_start?: string | null, accrual_period_end?: string | null, accrual_balance_account?: string | null, dimensions?: Record<string, string> }[] }[],
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
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
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

---

### `GET /api/v1/companies/{companyId}/invoices/late-payment-interest`

**Dröjsmålsränta per customer invoice: interest earned by invoices paid late, and interest accrued on overdue unpaid ones.**
`scope:invoices:read · risk:low · idempotent`

Statutory late-payment interest (Räntelagen 6 §): Riksbankens referensränta for each half-year plus eight percentage points, or the company's own rate when it set one, on 365 days. Each payment that arrived after the due date earns interest on its own amount from the due date to its payment date; an open invoice accrues on its remaining amount up to as_of. Only payments booked in Accounted count: payment dates that came with an import, payments linked to imported verifikat, credit notes, customer losses and collection-provider payments are left out. Amounts are in each invoice's currency. Nothing is booked or sent.

**Use when:** Preparing a räntefaktura (interest invoice) after late payments, or checking what an overdue customer owes in interest.
**Do not use for:** Listing unpaid invoices without interest (GET /invoices) or invoices that could go to collection (GET /collections/candidates).

**Pitfalls:**
- An invoice paid late before the company moved to Accounted is not listed: its payment date came with the import.
- The interest is per invoice currency; totals are grouped by currency, never converted.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `as_of` | query | `string` | no | Compute up to this date (YYYY-MM-DD): payments after it are ignored and open invoices accrue to it. Default today, Europe/Stockholm. |

Response `200`:
```ts
{
  data: {
    as_of: string,
    rate: number,
    rate_is_override: boolean,
    consumer_rate_ceiling: number | null,
    paid_late: { invoice_id: string, invoice_number: string, customer_name: string | null, currency: string, due_date: string, paid_late_amount: number, last_payment_date: string, days_late: number, interest: number }[],
    overdue_open: { invoice_id: string, invoice_number: string, customer_name: string | null, currency: string, due_date: string, remaining_amount: number, days_overdue: number, interest: number }[],
    totals: { currency: string, paid_late_interest: number, overdue_interest: number }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "as_of": "2026-10-26",
    "rate": 0.1,
    "rate_is_override": false,
    "paid_late": [
      {
        "invoice_id": "7d1e…",
        "invoice_number": "F-1042",
        "customer_name": "Kund AB",
        "currency": "SEK",
        "due_date": "2026-09-01",
        "paid_late_amount": 12500,
        "last_payment_date": "2026-09-21",
        "days_late": 20,
        "interest": 68.49
      }
    ],
    "overdue_open": [],
    "totals": [
      {
        "currency": "SEK",
        "paid_late_interest": 68.49,
        "overdue_interest": 0
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

### `GET /api/v1/companies/{companyId}/recurring-invoice-schedules`

**List the company's recurring invoice schedules, newest first.**
`scope:invoices:read · risk:low · idempotent`

Each schedule creates a customer invoice on day_of_month (clamped to the last day in shorter months) every interval_months months at send_hour, Europe/Stockholm, from its template lines. Answers status, auto_send, next_run_date, the last run and its invoice, the lines in their order and what one run bills excl. VAT. Filter by status. Paged with limit and offset: total_count, has_more and next_offset say what is left.

**Use when:** Before changing a schedule (its recurring_schedule_id and lines), or to see what will be invoiced and when.
**Do not use for:** The invoices a schedule created (GET /invoices), or a schedule's run history in detail.

**Pitfalls:**
- Send a line back with its article_id when you replace the lines: a line without it loses the link to its article.
- next_run_date is a day in Europe/Stockholm; the run happens at send_hour that day.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"active" \| "paused"` | no | Only active or only paused schedules. Default both. |
| `limit` | query | `number` | no | Schedules per page, 1-100. Default 50. |
| `offset` | query | `number` | no | Schedules to skip: next_offset of the previous page. Default 0. |

Response `200`:
```ts
{
  data: {
    schedules: { recurring_schedule_id: string, name: string, status: "active" | "paused", customer_id: string, customer_name: string | null, day_of_month: number, interval_months: number, send_hour: number, payment_terms_days: number, currency: string, auto_send: boolean, next_run_date: string, period_start: string | null, last_run_at: string | null, last_invoice_id: string | null, last_run_warning: string | null, generated_count: number, monthly_total_excl_vat: number, default_dimensions: Record<string, string>, items: { line_type: string, description: string, quantity: number, unit: string, unit_price: number, vat_rate: number | null, dimensions: Record<string, string>, article_id: string | null }[] }[],
    count: number,
    total_count: number,
    has_more: boolean,
    next_offset?: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "schedules": [
      {
        "recurring_schedule_id": "5c2d…",
        "name": "Månadsavgift support",
        "status": "active",
        "customer_id": "0a1b…",
        "customer_name": "Kunden AB",
        "day_of_month": 25,
        "interval_months": 1,
        "send_hour": 8,
        "payment_terms_days": 30,
        "currency": "SEK",
        "auto_send": false,
        "next_run_date": "2026-12-25",
        "period_start": null,
        "last_run_at": "2026-11-25T07:00:12Z",
        "last_invoice_id": "9e8f…",
        "last_run_warning": null,
        "generated_count": 4,
        "monthly_total_excl_vat": 5000,
        "default_dimensions": {},
        "items": [
          {
            "line_type": "product",
            "description": "Support {månad}",
            "quantity": 1,
            "unit": "st",
            "unit_price": 5000,
            "vat_rate": null,
            "dimensions": {},
            "article_id": null
          }
        ]
      }
    ],
    "count": 1,
    "total_count": 1,
    "has_more": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/recurring-invoice-schedules`

**Create a recurring invoice schedule: a customer invoice from the same lines every interval_months months.**
`scope:invoices:write · risk:medium · idempotent · dry-run · reversible`

The schedule creates a customer invoice on day_of_month (29-31 clamp to the last day in shorter months) every interval_months months at send_hour, Europe/Stockholm, from its template lines, first on start_date or the next occurrence of day_of_month. With auto_send false (the default) each invoice is a draft for a person to send; with auto_send true each one is numbered, issued and emailed to the customer with no further approval. ?stage=true proposes the schedule for a person to approve instead of creating it. Dry-runnable: the preview names the first run and what one run bills.

**Use when:** The customer is invoiced the same thing on a fixed rhythm: a subscription, a retainer, rent or a support agreement.
**Do not use for:** A single invoice (POST /invoices), or changing a schedule that exists (PATCH /recurring-invoice-schedules/{id}).

**Pitfalls:**
- auto_send true needs a customer with an email address, else 400 VALIDATION_ERROR (details.field auto_send). Its proposal is high risk: approving it lets every run email an invoice.
- start_date off the grid (not on day_of_month, clamped) or in the past answers 400 VALIDATION_ERROR (details.field start_date).
- A line's article_id must be one of the company's articles (400, details.field items); {periodstart}, {periodslut} and {nästa periodstart} need period_start.
- Over MCP the schedule is always staged: nothing exists until a person approves it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  customer_id: string,
  name: string,
  day_of_month: number,
  interval_months?: number,
  send_hour?: number,
  payment_terms_days?: number,
  currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD",
  your_reference?: string,
  our_reference?: string,
  notes?: string,
  auto_send?: boolean,
  default_dimensions?: Record<string, string>,
  start_date?: string,
  period_start?: string | null,
  items: { line_type?: "product" | "text", description: string, quantity: number, unit?: string, unit_price: number, vat_rate?: 0 | 6 | 12 | 25 | null, dimensions?: Record<string, string>, article_id?: string | null }[]
}
```

Example request:
```json
{
  "customer_id": "0a1b…",
  "name": "Månadsavgift support",
  "day_of_month": 25,
  "items": [
    {
      "description": "Support {månad}",
      "quantity": 1,
      "unit": "st",
      "unit_price": 5000
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    recurring_schedule_id: string,
    name: string,
    customer_id: string,
    day_of_month: number,
    interval_months: number,
    send_hour: number,
    currency: string,
    auto_send: boolean,
    status: "active",
    next_run_date: string,
    item_count: number
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "recurring_schedule_id": "5c2d…",
    "name": "Månadsavgift support",
    "customer_id": "0a1b…",
    "day_of_month": 25,
    "interval_months": 1,
    "send_hour": 8,
    "currency": "SEK",
    "auto_send": false,
    "status": "active",
    "next_run_date": "2026-12-25",
    "item_count": 1
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/recurring-invoice-schedules/{id}`

**Change a recurring invoice schedule: its fields, its status (pause or resume) or all of its lines.**
`scope:invoices:write · risk:medium · idempotent · dry-run · reversible`

Changes only the fields given; items replaces every line. status paused stops the schedule, active resumes it. A new day_of_month, or resuming a schedule whose next_run_date has passed, moves next_run_date to the next run strictly after today (never today, so no edit sends an invoice the same hour); next_run_date given re-phases the schedule and wins. Any other change leaves next_run_date alone. ?stage=true proposes the change for a person to approve instead of making it. Dry-runnable: the preview shows the schedule as it is (current), the changes and the schedule as it would be (proposed).

**Use when:** A price, a line, the rhythm or the customer of a schedule changes, or the schedule should pause or resume.
**Do not use for:** Creating a schedule (POST /recurring-invoice-schedules), or changing an invoice a schedule already created (PATCH /invoices/{id}).

**Pitfalls:**
- An unknown schedule_id answers 404 RECURRING_SCHEDULE_NOT_FOUND.
- next_run_date off the grid of the day_of_month in effect, or not after today, answers 400 VALIDATION_ERROR (details.field next_run_date). A proposal approved after its next_run_date passed rolls it forward on the same grid.
- Turning auto_send on, or moving an auto-sending schedule to another customer, needs that customer's email address (400, details.field auto_send); the proposal is then high risk.
- items replaces every line: send the ones to keep too, each with its article_id.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  customer_id?: string,
  name?: string,
  day_of_month?: number,
  interval_months?: number,
  send_hour?: number,
  payment_terms_days?: number,
  currency?: "SEK" | "EUR" | "USD" | "GBP" | "NOK" | "DKK" | "CHF" | "CAD",
  your_reference?: string | null,
  our_reference?: string | null,
  notes?: string | null,
  auto_send?: boolean,
  status?: "active" | "paused",
  next_run_date?: string,
  default_dimensions?: Record<string, string>,
  period_start?: string | null,
  items?: { line_type?: "product" | "text", description: string, quantity: number, unit?: string, unit_price: number, vat_rate?: 0 | 6 | 12 | 25 | null, dimensions?: Record<string, string>, article_id?: string | null }[]
}
```

Example request:
```json
{
  "status": "paused"
}
```

Response `200`:
```ts
{
  data: {
    recurring_schedule_id: string,
    status: "active" | "paused",
    updated_fields: string[],
    items_replaced: boolean,
    item_count?: number,
    next_run_date?: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "recurring_schedule_id": "5c2d…",
    "status": "paused",
    "updated_fields": [
      "status"
    ],
    "items_replaced": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/setoffs`

**Set off (kvitta) an open customer invoice against an open supplier invoice of the same counterparty: one verifikat, both invoices lowered, the net left to pay or receive.**
`scope:invoices:write · risk:high · idempotent · dry-run · reversible`

Books Dr accounts payable / Cr accounts receivable (the accounts the invoices' own vouchers booked) for amount, at most the smaller remaining amount (the default). An amount within a krona of the customer invoice's remaining amount (its rounded Att betala) settles it in full, the öresavrundning on 3740. VAT is untouched. Both invoices get a payment row dated setoff_date and their remaining amounts go down; the net is then matched to the bank line like any part payment. A kvittningsavräkning is archived on the verifikat as underlag. SEK only; refused for credit notes, ROT/RUT invoices, invoices not booked as receivable or payable (kontantmetoden), an open collection case, or a supplier invoice with a payment on its way.

**Use when:** A company sells to and buys from the same legal person and settles the two against each other instead of paying both in full.
**Do not use for:** Settling a credit note against its invoice (credit the invoice), or recording a payment received or made (mark the invoice paid or match the bank line).

**Pitfalls:**
- Both cards must belong to the same counterparty (same organisation number, or merged in Motparter): 422 SETOFF_PARTY_MISMATCH / SETOFF_NO_PARTY.
- A supplier invoice entered at the bank, in a payment file or in an open payment order is refused (409 SETOFF_PAYMENT_IN_FLIGHT): the bank would pay the full amount.
- A mistake is undone by reversing (storno) the set-off verifikat; it is never corrected in place.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  invoice_id: string,
  supplier_invoice_id: string,
  amount?: number,
  setoff_date?: string,
  note?: string,
  party_id?: string
}
```

Example request:
```json
{
  "invoice_id": "2a9c…",
  "supplier_invoice_id": "79f1…",
  "setoff_date": "2026-09-30",
  "note": "Kvittning enligt flexavtal"
}
```

Response `200`:
```ts
{
  data: {
    setoff_id: string,
    journal_entry_id: string,
    voucher_series: string | null,
    voucher_number: number | null,
    party_id: string,
    amount: number,
    setoff_date: string,
    invoice: { invoice_id: string, status: string, remaining_amount: number },
    supplier_invoice: { supplier_invoice_id: string, status: string, remaining_amount: number },
    net: { direction: "we_pay" | "they_pay" | "settled", amount: number },
    underlag_document_id: string | null
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "setoff_id": "5d1e…",
    "journal_entry_id": "c41d…",
    "amount": 1388,
    "invoice": {
      "invoice_id": "2a9c…",
      "status": "paid",
      "remaining_amount": 0
    },
    "supplier_invoice": {
      "supplier_invoice_id": "79f1…",
      "status": "partially_paid",
      "remaining_amount": 3116
    },
    "net": {
      "direction": "we_pay",
      "amount": 3116
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/setoffs/counterparty`

**A counterparty that is both customer and supplier, as one relation: its open customer and supplier invoices, the net per currency and its set-offs.**
`scope:reports:read · risk:low · idempotent`

Name the counterparty by exactly one of party_id, customer_id or supplier_id. Every customer and supplier card of the same legal person (one party, linked by organisation number) is included. Each open invoice says whether it can be set off now and why not (ineligible_reason). The net is receivable minus payable: above zero they pay us, below zero we pay them. Credit notes are not included.

**Use when:** Deciding what to set off between a customer that is also a supplier, or checking what is left to pay or receive after a set-off.
**Do not use for:** The full kund- or leverantörsreskontra (use the ledger reports).

**Pitfalls:**
- A card without an organisation number has no party until it is merged in Motparter (404 SETOFF_PARTY_NOT_FOUND).
- Totals are per currency; only SEK invoices can be set off.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `party_id` | query | `string` | no | The counterparty (Motparter). |
| `customer_id` | query | `string` | no | A customer card of the counterparty. |
| `supplier_id` | query | `string` | no | A supplier card of the counterparty. |

Response `200`:
```ts
{
  data: {
    party: { party_id: string, name: string, org_number: string | null },
    customers: { customer_id: string, name: string }[],
    suppliers: { supplier_id: string, name: string }[],
    receivables: { invoice_id: string, customer_id: string | null, number: string | null, invoice_date: string, due_date: string | null, currency: string, total: number, remaining_amount: number, status: string, setoff_eligible: boolean, ineligible_reason: "credit_note" | "not_open" | "currency" | "deduction" | "not_booked" | "no_party" | "collection_open" | "payment_in_flight" | null }[],
    payables: { supplier_invoice_id: string, supplier_id: string | null, number: string | null, arrival_number: number | null, invoice_date: string, due_date: string | null, currency: string, total: number, remaining_amount: number, status: string, setoff_eligible: boolean, ineligible_reason: "credit_note" | "not_open" | "currency" | "deduction" | "not_booked" | "no_party" | "collection_open" | "payment_in_flight" | null }[],
    totals: { currency: string, receivable: number, payable: number, net: number, direction: "they_pay" | "we_pay" | "settled" }[],
    setoffs: { setoff_id: string, setoff_date: string, amount: number, status: "booked" | "reversed", invoice_id: string, supplier_invoice_id: string, journal_entry_id: string, note: string | null }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string }, payment_order_id?: string, supplier_invoice_id?: string }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "party": {
      "party_id": "7fc2…",
      "name": "Exempel Energi AB",
      "org_number": "5599887766"
    },
    "totals": [
      {
        "currency": "SEK",
        "receivable": 1388,
        "payable": 4504,
        "net": -3116,
        "direction": "we_pay"
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
