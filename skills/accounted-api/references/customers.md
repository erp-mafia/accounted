<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Customers and articles endpoints

The customer register (bulk-create supported, archive via DELETE) and the read-only article register used for invoice line linkage.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/articles`

**List the article register (artikelregister).**
`scope:invoices:read · risk:low · idempotent`

Returns the company's articles ordered by name. Pass ?include_inactive=true to include soft-deactivated articles. Use the returned id as items[].article_id when creating invoices; housework_type carries the ROT/RUT arbetstypskod for service articles, and revenue_account the optional BAS class-3 override.

**Use when:** You need the article catalog before composing invoice lines: to resolve an article_id, read its price/VAT defaults, or find ROT/RUT-tagged service articles (housework_type set).
**Do not use for:** Creating or editing articles (dashboard-only for now). Invoice line creation itself (POST …/invoices with items[].article_id).

**Pitfalls:**
- Linking article_id does NOT auto-fill the invoice line: send description, unit_price, vat_rate etc. explicitly on the item (copy them from this response).
- price_excl_vat always excludes VAT.
- price_excl_vat is denominated in the article's own currency, which is NOT always SEK. Check currency before copying the price onto an invoice line: the invoice carries a single currency for all its lines and there is no FX conversion here.
- housework_type is an arbetstypskod hint (e.g. BYGG, STAD); the invoice line still needs deduction_type + labor_hours + work_type set explicitly for ROT/RUT.
- Inactive articles (active=false) are hidden by default but remain linkable for historical reads.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    articles: { id: string, article_number: string, name: string, name_en: string, type: "vara" | "tjanst", unit: string, price_excl_vat: number, currency: string, vat_rate: number, revenue_account: string, cost_price: number, ean: string, housework_type: string, notes: string, active: boolean, created_at: string, updated_at: string }[]
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
    "articles": [
      {
        "id": "0e9c…",
        "article_number": "A-0001",
        "name": "Takarbete",
        "name_en": null,
        "type": "tjanst",
        "unit": "tim",
        "price_excl_vat": 850,
        "currency": "SEK",
        "vat_rate": 25,
        "revenue_account": null,
        "cost_price": null,
        "ean": null,
        "housework_type": "BYGG",
        "notes": null,
        "active": true,
        "created_at": "2026-05-01T09:14:33Z",
        "updated_at": "2026-05-01T09:14:33Z"
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

### `GET /api/v1/companies/{companyId}/customers`

**List customers for a company.**
`scope:customers:read · risk:low · idempotent`

Returns active customers in created-first order. Pass ?include_archived=true to include archived rows. Use ?search to match against name or org_number.

**Use when:** You need a customer roster: for building a UI picker, syncing a CRM, or resolving a customer_id before creating an invoice.
**Do not use for:** Fetching a single customer you already know the id of: use GET /api/v1/companies/{companyId}/customers/{id}. Suppliers are a separate resource.

**Pitfalls:**
- Archived customers are hidden by default; the dashboard makes the same choice.
- org_number is included so callers can match against external CRM identifiers; for sole traders (enskild firma) it equals the personnummer.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, name: string, customer_type: "individual" | "swedish_business" | "eu_business" | "non_eu_business", email: string, org_number: string, vat_number: string, default_payment_terms: number, archived_at: string, created_at: string }[],
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
      "id": "a8f1…",
      "name": "Acme AB",
      "customer_type": "business",
      "email": "finance@acme.example",
      "org_number": "556677-8899",
      "vat_number": "SE556677889901",
      "default_payment_terms": 30,
      "archived_at": null,
      "created_at": "2025-04-12T08:30:00Z"
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

### `POST /api/v1/companies/{companyId}/customers`

**Create a customer.**
`scope:customers:write · risk:low · idempotent · dry-run · reversible`

Creates a new customer for the company. Requires Idempotency-Key (UUID). Supports ?dry_run=true for input validation without committing: the dry-run response shows the would-be record minus id and timestamps. EU-business customers with a VAT number are auto-validated against VIES on commit.

**Use when:** You need to register a new customer before invoicing them. Use dry-run first to catch validation errors before committing.
**Do not use for:** Updating an existing customer (PATCH instead). Creating suppliers (different resource).

**Pitfalls:**
- Idempotency-Key is mandatory: calls without it return 400 VALIDATION_ERROR.
- org_number uniqueness is enforced at the database level; duplicate inserts return 409 CUSTOMER_DUPLICATE_ORG_NUMBER.
- A personnummer-shaped org_number on customer_type=individual is treated as the personnummer submitted in the wrong field: it is stored encrypted as personal_number, returned masked (********-1234), and org_number is left empty. Prefer passing it as personal_number. Next to a different personal_number in the same body it is a 400.
- An org_number shaped like a Swedish personnummer is rejected for business customer_types: create the customer as customer_type=individual with personal_number so the number is masked and protected.
- personal_number is accepted only for customer_type=individual, stored encrypted, and returned in the masked form ********-1234.
- If default_payment_terms is omitted, it defaults to the company setting invoice_default_days, falling back to 30.
- VIES validation runs only on commit. Dry-run skips the external call and leaves vat_number_validated=false in the preview.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  name: string,
  customer_type: "individual" | "swedish_business" | "eu_business" | "non_eu_business",
  customer_number?: string,
  contact_person?: string,
  email?: string,
  phone?: string,
  invoice_email_cc_addresses?: string[],
  invoice_email_bcc_addresses?: string[],
  address_line1?: string,
  address_line2?: string,
  postal_code?: string,
  city?: string,
  country?: string,
  org_number?: string,
  vat_number?: string,
  personal_number?: string,
  language?: "sv" | "en",
  default_payment_terms?: number,
  notes?: string
}
```

Example request:
```json
{
  "name": "Acme AB",
  "customer_type": "swedish_business",
  "email": "finance@acme.test",
  "org_number": "556677-8899",
  "default_payment_terms": 30
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    customer_type: "individual" | "swedish_business" | "eu_business" | "non_eu_business",
    customer_number: string,
    contact_person: string,
    email: string,
    phone: string,
    invoice_email_cc_addresses: string[],
    invoice_email_bcc_addresses: string[],
    address_line1: string,
    address_line2: string,
    postal_code: string,
    city: string,
    country: string,
    org_number: string,
    vat_number: string,
    vat_number_validated: boolean,
    personal_number: string,
    default_payment_terms: number,
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
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "name": "Acme AB",
    "customer_type": "swedish_business",
    "email": "finance@acme.test",
    "org_number": "556677-8899",
    "vat_number_validated": false,
    "default_payment_terms": 30,
    "archived_at": null,
    "created_at": "2026-05-12T16:00:00Z",
    "updated_at": "2026-05-12T16:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/customers/{id}`

**Retrieve a single customer by id.**
`scope:customers:read · risk:low · idempotent`

Returns the full customer record. Pass ?expand=invoices to embed any open invoices (sent / partially_paid / overdue) for the customer in the same response.

**Use when:** You need the full customer record: address, payment terms, VAT validation status, contact details: before invoicing or syncing to another system.
**Do not use for:** Listing customers (use the list endpoint). Looking up arbitrary supplier or employee records (different resources).

**Pitfalls:**
- archived_at is non-null when the customer has been soft-deleted; the customer is still queryable by id but excluded from default lists.
- vat_number_validated reflects the last successful VIES check; it can become stale if the EU registry revokes a number.
- personal_number is always returned in the masked form ********-1234; the stored value is encrypted and never leaves the API.

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
    customer_type: string,
    customer_number: string,
    contact_person: string,
    email: string,
    phone: string,
    invoice_email_cc_addresses: string[],
    invoice_email_bcc_addresses: string[],
    address_line1: string,
    address_line2: string,
    postal_code: string,
    city: string,
    country: string,
    org_number: string,
    vat_number: string,
    vat_number_validated: boolean,
    personal_number: string,
    default_payment_terms: number,
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
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "a8f1…",
    "name": "Acme AB",
    "customer_type": "business",
    "email": "finance@acme.example",
    "org_number": "556677-8899",
    "vat_number": "SE556677889901",
    "vat_number_validated": true,
    "country": "Sweden",
    "default_payment_terms": 30,
    "archived_at": null,
    "created_at": "2025-04-12T08:30:00Z",
    "updated_at": "2026-04-30T11:22:09Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/customers/{id}`

**Partially update a customer.**
`scope:customers:write · risk:low · idempotent · dry-run · reversible`

Patches the customer with the supplied fields. All fields optional. Idempotent (mandatory Idempotency-Key). Dry-runnable. When vat_number changes on an eu_business customer, VIES re-validation runs on commit (best-effort).

**Use when:** You need to change a customer's contact details, payment terms, address, or VAT registration. Use dry-run first to confirm the merged record before committing.
**Do not use for:** Archiving a customer (use DELETE: sets archived_at). Replacing the entire record (no PUT verb is exposed; PATCH is partial).

**Pitfalls:**
- Idempotency-Key is mandatory; calls without it return 400.
- org_number uniqueness is enforced at DB level: 23505 → 409 CUSTOMER_DUPLICATE_ORG_NUMBER.
- VIES re-validation is best-effort and runs only on commit. A VIES timeout does not fail the update.
- personal_number: a plaintext value is stored encrypted (individual customers only); the masked form a read returned (********-1234) means "leave unchanged" and is never stored; null clears it. Changing customer_type away from individual clears any stored personal_number.
- An org_number shaped like a Swedish personnummer is rejected for business customer_types (400 CUSTOMER_ORG_NUMBER_IS_PERSONAL). On an individual it is the personnummer in the wrong field: it is stored encrypted as personal_number and org_number is cleared; next to a different personal_number in the same body it is 400 CUSTOMER_PERSONAL_NUMBER_CONFLICT.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  name?: string,
  customer_type?: "individual" | "swedish_business" | "eu_business" | "non_eu_business",
  customer_number?: string,
  contact_person?: string,
  email?: string,
  phone?: string,
  invoice_email_cc_addresses?: string[],
  invoice_email_bcc_addresses?: string[],
  address_line1?: string,
  address_line2?: string,
  postal_code?: string,
  city?: string,
  country?: string,
  org_number?: string,
  vat_number?: string,
  personal_number?: string,
  language?: "sv" | "en",
  default_payment_terms?: number,
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
    customer_type: string,
    customer_number: string,
    contact_person: string,
    email: string,
    phone: string,
    invoice_email_cc_addresses: string[],
    invoice_email_bcc_addresses: string[],
    address_line1: string,
    address_line2: string,
    postal_code: string,
    city: string,
    country: string,
    org_number: string,
    vat_number: string,
    vat_number_validated: boolean,
    personal_number: string,
    default_payment_terms: number,
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
    partial_expansions?: string[]
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "name": "Acme AB",
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

### `DELETE /api/v1/companies/{companyId}/customers/{id}`

**Archive a customer (soft-delete).**
`scope:customers:write · risk:medium · idempotent · dry-run · reversible`

Sets archived_at on the customer; the record is preserved (invoices and audit history remain intact) but excluded from default list responses. To un-archive, PATCH archived_at back to null. Idempotent: archiving an already-archived customer is a no-op. Dry-runnable.

**Use when:** You want to remove a customer from active rosters without losing their history. Idempotent: re-archiving is safe.
**Do not use for:** Permanently deleting a customer with all history: the public API does not expose hard-delete. GDPR erasure requests go through a dedicated workflow.

**Pitfalls:**
- Idempotency-Key is mandatory.
- A customer with any open invoice (sent / partially_paid / overdue) cannot be archived: returns 409 CUSTOMER_HAS_INVOICES. Issue a kreditfaktura first if you need to close the relationship cleanly. This protects ML 17 kap 24§: the customer record is the canonical source of buyer name/address for invoice reissuance.
- 204 No Content is returned on success: there is no response body to parse.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `204`.

---

### `POST /api/v1/companies/{companyId}/customers/bulk-create`

**Create up to 50 customers in one call (partial-success).**
`scope:customers:write · risk:low · idempotent · dry-run · reversible`

Bulk-create endpoint mirroring /invoices/bulk-create. Each customer is validated and inserted independently: per-item failures do not roll back items that succeeded. Returns a results array plus a summary. Idempotent over the whole batch. Dry-runnable.

**Use when:** You're importing a roster of customers from another CRM, or seeding a fresh company with its existing client list. Use dry-run first to validate the batch.
**Do not use for:** Updating existing customers: PATCH /customers/{id} once per customer. Bulk uploads of > 50 customers: split into pages of 50. Transactional all-or-nothing imports: passing all_or_nothing: true returns 501 NOT_IMPLEMENTED.

**Pitfalls:**
- Idempotency-Key is mandatory and covers the WHOLE batch. A retried bulk-create returns the cached full response: it does not retry only the failed items.
- Passing all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist; omit the flag or pass false.
- org_number uniqueness is enforced at the DB level: items with duplicates fail individually with CUSTOMER_DUPLICATE_ORG_NUMBER.
- VIES validation for eu_business customers is best-effort per item; a VIES timeout leaves vat_number_validated=false but does NOT fail the item.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  customers: { name: string, customer_type: "individual" | "swedish_business" | "eu_business" | "non_eu_business", customer_number?: string, contact_person?: string, email?: string, phone?: string, invoice_email_cc_addresses?: string[], invoice_email_bcc_addresses?: string[], address_line1?: string, address_line2?: string, postal_code?: string, city?: string, country?: string, org_number?: string, vat_number?: string, personal_number?: string, language?: "sv" | "en", default_payment_terms?: number, notes?: string }[],
  all_or_nothing?: boolean
}
```

Example request:
```json
{
  "customers": [
    {
      "name": "Acme AB",
      "customer_type": "swedish_business",
      "org_number": "556677-8899"
    },
    {
      "name": "Foo OY",
      "customer_type": "eu_business",
      "vat_number": "FI12345678"
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
          "name": "Acme AB"
        }
      },
      {
        "ok": true,
        "request_index": 1,
        "data": {
          "id": "4d2a…",
          "name": "Foo OY"
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
