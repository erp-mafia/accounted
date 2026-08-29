<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Core endpoints

Connectivity, company discovery, async-operation polling, and company settings. Every session starts with GET /companies to resolve the companyId that all other URLs need.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies`

**List companies the API key can access.**
`scope:companies:read · risk:low · idempotent`

Returns every non-archived company the API key user is a member of, together with their role. Use the returned `id` as `{companyId}` in subsequent endpoints.

**Use when:** You need to discover which company IDs an API key has access to before calling company-scoped endpoints.
**Do not use for:** Fetching a single company you already know the id of: use GET /api/v1/companies/{companyId} for that.

**Pitfalls:**
- Multi-company keys (e.g. consultants) will see >1 result. Always pass the correct companyId in subsequent paths.
- Archived companies are excluded; if a company disappears the user has been removed from it or it was archived.

Response `200`:
```ts
{
  data: { id: string, name: string, org_number: string, entity_type: string, role: "owner" | "admin" | "member" | "viewer", created_at: string }[],
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
      "id": "8fd5b1f4-…",
      "name": "Acme AB",
      "org_number": "556677-8899",
      "entity_type": "aktiebolag",
      "role": "owner",
      "created_at": "2025-01-04T08:00:00Z"
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

### `POST /api/v1/companies`

**Create a company and set it up for bookkeeping.**
`scope:companies:write · risk:medium · dry-run`

Creates a new company owned by the API key user (or attached to one of their teams) and sets it up in one call: owner membership, BAS chart of accounts for the company form, compliance settings, the first fiscal period and the automatic tax deadlines. A 30-day trial with every paid capability starts immediately. Intended for partner platforms provisioning client companies (byrå/vertical SaaS) and for agents onboarding a user.

**Use when:** A platform or agent needs to provision a company that does not exist in Accounted yet. The caller becomes its owner; invite the end customer afterwards.
**Do not use for:** Companies that already exist (list them with GET /api/v1/companies), or changing settings on an existing company (PATCH /api/v1/companies/{companyId}/settings).

**Pitfalls:**
- A VAT-registered company MUST send moms_period (monthly / quarterly / yearly); the request is refused otherwise, because a missing period silently produces zero VAT deadlines.
- Bookkeeping duty under BFL starts when the company exists with a fiscal period: do not create companies to try things out. Use a test-mode key (dry run) for that.
- Enskild firma always runs on the calendar year; fiscal_year_start_month is ignored for it.
- first_fiscal_year is only for a company in its first year (BFL 3 kap.: up to 18 months). Omit it for an established company.
- Not idempotent, and Idempotency-Key is not honoured on this company-less route: a retry after a network failure creates a second company. List GET /api/v1/companies before retrying.
- org_number is required for a VAT-registered company (the invoice momsregistreringsnummer derives from it), and f_skatt must be stated explicitly: F-skatt approval is never assumed.
- accounting_method may be omitted: it then defaults by form (aktiebolag accrual, enskild firma cash) and the response shows the resolved value. The cash default is only legal when turnover normally stays under 3 MSEK (BFL 4 kap 4 §): send accrual explicitly for a larger enskild firma.

Request body:
```ts
{
  name: string,
  entity_type: "enskild_firma" | "aktiebolag",
  org_number?: string,
  vat_registered: boolean,
  moms_period?: "monthly" | "quarterly" | "yearly",
  accounting_method?: "accrual" | "cash",
  f_skatt: boolean,
  fiscal_year_start_month?: number,
  first_fiscal_year?: { start: string, end: string },
  address_line1?: string,
  postal_code?: string,
  city?: string,
  team_id?: string
}
```

Example request:
```json
{
  "name": "Acme AB",
  "entity_type": "aktiebolag",
  "org_number": "5566778899",
  "vat_registered": true,
  "moms_period": "quarterly",
  "accounting_method": "accrual",
  "f_skatt": true
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    entity_type: "enskild_firma" | "aktiebolag",
    org_number: string,
    vat_registered: boolean,
    moms_period: "monthly" | "quarterly" | "yearly",
    accounting_method: "accrual" | "cash",
    fiscal_period: { start_date: string, end_date: string, name: string },
    team_id: string
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
    "id": "8fd5b1f4-…",
    "name": "Acme AB",
    "entity_type": "aktiebolag",
    "org_number": "5566778899",
    "vat_registered": true,
    "moms_period": "quarterly",
    "accounting_method": "accrual",
    "fiscal_period": {
      "start_date": "2026-01-01",
      "end_date": "2026-12-31",
      "name": "Räkenskapsår 2026"
    },
    "team_id": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/settings`

**Partially update company settings.**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

Patches the company payment details (bank account, Bankgiro, Plusgiro, Swish, IBAN/BIC), the contact details shown on invoices (contact_person, email, phone, website), and the custom invoice email texts. All fields optional; at least one must be supplied. Idempotent (mandatory Idempotency-Key). Dry-runnable. The same validation as the MCP staging tool applies: Bankgiro/Plusgiro numbers are Luhn-checked and invoice email texts only accept a fixed placeholder set.

**Use when:** You need to change the payment or contact details that appear on invoices, or override the invoice email texts, directly over REST instead of the staged MCP flow.
**Do not use for:** Legal or tax profile changes (org number, VAT registration, fiscal year, accounting method): those are not exposed on the public API. Reading settings (no GET endpoint yet; use the MCP tool gnubok_get_company_settings).

**Pitfalls:**
- Idempotency-Key is mandatory; calls without it return 400.
- contact_person is stored as default_our_reference: the default "Our reference" value on new invoices.
- bankgiro and plusgiro must carry a valid Luhn check digit; null or empty string clears them.
- invoice_email_texts only accepts the placeholders {fakturanummer} {kundnamn} {förnamn} {företag} {förfallodatum} {belopp}; any other {token} is rejected. Null clears every override.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  bank_name?: string,
  clearing_number?: string | "",
  account_number?: string | "",
  bankgiro?: string | "",
  plusgiro?: string | "",
  swish?: string,
  iban?: string | "",
  bic?: string | "",
  contact_person?: string,
  email?: string | "",
  phone?: string,
  website?: string | "",
  invoice_email_texts?: {
    sv?: { subject?: string, greeting?: string, body?: string, signoff?: string },
    en?: { subject?: string, greeting?: string, body?: string, signoff?: string }
  }
}
```

Example request:
```json
{
  "bankgiro": "991-2346",
  "contact_person": "Anna Andersson"
}
```

Response `200`:
```ts
{
  data: {
    company_id: string,
    bank_name: string,
    clearing_number: string,
    account_number: string,
    bankgiro: string,
    plusgiro: string,
    swish: string,
    iban: string,
    bic: string,
    contact_person: string,
    email: string,
    phone: string,
    website: string,
    invoice_email_texts: { sv?: { subject?: string, greeting?: string, body?: string, signoff?: string }, en?: { subject?: string, greeting?: string, body?: string, signoff?: string } }
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
    "company_id": "aaaa1111-2222-4333-8444-555566667777",
    "bank_name": "Testbanken",
    "clearing_number": null,
    "account_number": null,
    "bankgiro": "991-2346",
    "plusgiro": null,
    "swish": null,
    "iban": null,
    "bic": null,
    "contact_person": "Anna Andersson",
    "email": "faktura@acme.example",
    "phone": null,
    "website": null,
    "invoice_email_texts": null
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/health`

**Health check.**
`risk:low · idempotent`

Reports the API is reachable and what version is currently served. Public; no auth required.

**Use when:** You want to verify connectivity, latency, or which API version is live before issuing other requests.
**Do not use for:** Anything that needs authenticated data. This endpoint returns no company-specific information.

**Pitfalls:**
- A 200 here only means the API process responds: downstream Postgres/Supabase may still be degraded.

Response `200`:
```ts
{
  data: { status: "ok" | "degraded", service: "gnubok", api_version: string, timestamp: string },
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
    "status": "ok",
    "service": "gnubok",
    "api_version": "2026-05-12",
    "timestamp": "2026-05-12T16:25:06Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/operations/{id}`

**Poll a long-running operation by id.**
`scope:operations:read · risk:low · idempotent`

Returns the current snapshot of a v1 async operation: status (queued / running / succeeded / failed / cancelled), progress (jsonb, free-form), result (on success), and error (on failure). The operation_id is returned by the POST endpoints that initiate async work (period close, year-end, currency revaluation, SIE import).

**Use when:** You started an async operation and need to know whether it has finished. Poll every 5-30 seconds until a terminal status. (The 202 response advertises `operation.completed` as the eventual push signal, but that webhook event is not deliverable yet — polling is the only supported completion signal today.)
**Do not use for:** Fetching the resource the operation produced: once status=succeeded, read the result field or call the resource-specific GET endpoint. Cancelling a running operation (no cancel endpoint exists in v1).

**Pitfalls:**
- Terminal statuses (`succeeded`, `failed`, `cancelled`) are final; the row never transitions out of them.
- progress is free-form jsonb; agents should treat it as opaque except for the documented fields `phase` (string), `current` / `total` (numbers for percent calculation).
- started_at is null while status=queued (the work has not begun yet); completed_at is null until a terminal status is reached.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    operation_id: string,
    type: string,
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled",
    progress?: Record<string, unknown>,
    result?: unknown,
    error: { code?: string, message?: string, details?: unknown },
    started_at: string,
    completed_at: string,
    poll_url: string,
    webhook_event: "operation.completed"
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
    "operation_id": "0e9c-…",
    "type": "fiscal_periods.year_end",
    "status": "succeeded",
    "progress": {
      "phase": "committed",
      "current": 142,
      "total": 142
    },
    "result": {
      "journal_entries_created": 4,
      "opening_balances_set": 138
    },
    "error": null,
    "started_at": "2026-05-12T10:01:23Z",
    "completed_at": "2026-05-12T10:01:48Z",
    "poll_url": "/api/v1/operations/0e9c-…",
    "webhook_event": "operation.completed"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
