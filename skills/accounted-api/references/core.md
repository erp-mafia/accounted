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

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `cursor` | query | `string` | no | Opaque cursor from the previous page's meta.next_cursor. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). Larger values are clamped to 100. |

Response `200`:
```ts
{
  data: { id: string, name: string, org_number: string | null, entity_type: string, role: "owner" | "admin" | "member" | "viewer", created_at: string }[],
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

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  name: string,
  entity_type: "enskild_firma" | "aktiebolag" | "ideell_forening",
  org_number?: string,
  vat_registered: boolean,
  moms_period?: "monthly" | "quarterly" | "yearly" | null,
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
    entity_type: "enskild_firma" | "aktiebolag" | "ideell_forening",
    org_number: string | null,
    vat_registered: boolean,
    moms_period: "monthly" | "quarterly" | "yearly" | null,
    accounting_method: "accrual" | "cash",
    fiscal_period: { start_date: string, end_date: string, name: string },
    team_id: string | null
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

### `GET /api/v1/companies/{companyId}/settings`

**Read the company settings.**
`scope:companies:read · risk:low · idempotent`

Returns every company setting the API can write: contact and address, invoice payment details and layout, invoice email texts and recipients, reminders, voucher series, feature toggles, the tax profile (VAT/moms, F-skatt, employer registration, fiscal year, accounting method, share capital) and the bookkeeping lock, plus the fixed legal identity (entity_type, org_number). contact_person is the default "Vår referens" on new invoices.

**Use when:** Before creating invoices (payment details must exist), before any settings change, or to learn how the books are kept (accounting_method: accrual = faktureringsmetoden, cash = kontantmetoden; moms_period).
**Do not use for:** Payroll settings (GET /salary/settings) or fiscal periods and their locks (GET /fiscal-periods).

**Pitfalls:**
- Fields that were never set read null, not a default.
- bookkeeping_locked_through is the company-wide lock: nothing on or before that date can be booked or changed.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    company_id: string,
    entity_type: string | null,
    org_number: string | null,
    onboarding_complete: boolean | null,
    contact_person: string | null,
    company_name: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    country: string | null,
    phone: string | null,
    email: string | null,
    website: string | null,
    tax_contact_name: string | null,
    tax_contact_phone: string | null,
    tax_contact_email: string | null,
    bank_name: string | null,
    clearing_number: string | null,
    account_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    swish: string | null,
    iban: string | null,
    bic: string | null,
    invoice_prefix: string | null,
    invoice_default_notes: string | null,
    invoice_company_name_position: string | null,
    invoice_late_fee_text: string | null,
    invoice_credit_terms_text: string | null,
    invoice_email_reply_to: string | null,
    invoice_primary_color: string | null,
    invoice_accent_color: string | null,
    invoice_font_family: string | null,
    invoice_header_text: string | null,
    invoice_footer_text: string | null,
    default_voucher_series: string | null,
    sector_slug: string | null,
    salary_vacation_year_basis: string | null,
    vat_number: string | null,
    moms_period: string | null,
    vat_filing_method: string | null,
    periodisk_sammanstallning_period: string | null,
    periodisk_sammanstallning_filing_method: string | null,
    accounting_method: string | null,
    bookkeeping_locked_through: string | null,
    ore_rounding: boolean | null,
    invoice_show_ocr: boolean | null,
    invoice_show_bankgiro: boolean | null,
    invoice_show_plusgiro: boolean | null,
    invoice_show_swish: boolean | null,
    invoice_show_logo: boolean | null,
    invoice_show_company_name: boolean | null,
    invoice_payment_links_enabled: boolean | null,
    send_invoice_reminders: boolean | null,
    reminder_fee_enabled: boolean | null,
    dimensions_enabled: boolean | null,
    mileage_enabled: boolean | null,
    sales_orders_enabled: boolean | null,
    quotes_enabled: boolean | null,
    proforma_enabled: boolean | null,
    recurring_invoices_enabled: boolean | null,
    self_billing_enabled: boolean | null,
    f_skatt: boolean | null,
    vat_registered: boolean | null,
    vat_taxable_base_over_40m: boolean | null,
    vat_has_eu_trade: boolean | null,
    periodisk_sammanstallning_enabled: boolean | null,
    kontrolluppgifter_enabled: boolean | null,
    rot_rut_enabled: boolean | null,
    oss_enabled: boolean | null,
    ioss_enabled: boolean | null,
    intrastat_enabled: boolean | null,
    punktskatt_enabled: boolean | null,
    fyllnadsinbetalning_enabled: boolean | null,
    pays_salaries: boolean | null,
    employer_registered: boolean | null,
    employer_seasonal: boolean | null,
    defer_invoice_booking: boolean | null,
    next_invoice_number: number | null,
    next_arrival_number: number | null,
    invoice_default_days: number | null,
    reminder_days_level_1: number | null,
    reminder_days_level_2: number | null,
    reminder_days_level_3: number | null,
    reminder_fee_amount: number | null,
    reminder_interest_rate_override: number | null,
    fiscal_year_start_month: number | null,
    preliminary_tax_monthly: number | null,
    aktiekapital: number | null,
    antal_aktier: number | null,
    auto_lock_period_days: number | null,
    invoice_payment_accounts?: unknown,
    invoice_email_texts?: unknown,
    invoice_email_cc_addresses?: unknown,
    invoice_email_bcc_addresses?: unknown,
    reminder_text_overrides?: unknown,
    default_voucher_series_per_source_type?: unknown,
    voucher_series_labels?: unknown
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
    "company_id": "aaaa1111-2222-4333-8444-555566667777",
    "entity_type": "aktiebolag",
    "company_name": "Acme AB",
    "contact_person": "Anna Andersson",
    "bankgiro": "991-2346",
    "vat_registered": true,
    "moms_period": "quarterly",
    "accounting_method": "accrual",
    "bookkeeping_locked_through": "2026-06-30"
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/settings`

**Partially update company settings (contact, invoicing, reminders, voucher series, toggles).**
`scope:companies:write · risk:medium · idempotent · dry-run · reversible`

Patches any subset of the non-legal company settings: contact and address, invoice payment details (bank account, Bankgiro, Plusgiro, Swish, IBAN/BIC, per-currency payment accounts), invoice numbering, layout and branding, invoice email texts and fixed copy recipients, reminders, voucher series, feature toggles and the vacation-year basis. Same rules as the settings page. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** The payment or contact details on invoices change, invoice texts or reminders should be adjusted, or a feature should be switched on or off.
**Do not use for:** VAT, F-skatt, fiscal year, accounting method or share capital (PATCH /settings/tax-profile), the bookkeeping lock (PATCH /settings/bookkeeping-lock), payroll settings (PATCH /salary/settings). entity_type and org_number are fixed.

**Pitfalls:**
- Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.
- contact_person is stored as default_our_reference: the default "Vår referens" on new invoices.
- bankgiro and plusgiro must carry a valid Luhn check digit; null or empty string clears them.
- invoice_email_texts only accepts the placeholders {fakturanummer} {kundnamn} {förnamn} {företag} {förfallodatum} {belopp}.
- reminder_days_level_1 < _2 < _3 must hold after the change (stored values fill in the ones not sent).
- The booking engine reads default_voucher_series_per_source_type, not default_voucher_series: send the map to move bookings to another series.
- salary_vacation_year_basis cannot change while open vacation balances exist.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  company_name?: string,
  address_line1?: string,
  address_line2?: string,
  postal_code?: string,
  city?: string,
  country?: string,
  phone?: string,
  email?: string | "",
  website?: string | "",
  tax_contact_name?: string | null,
  tax_contact_phone?: string | null,
  tax_contact_email?: string | null | "",
  bank_name?: string | null,
  clearing_number?: string | null | "",
  account_number?: string | null | "",
  bankgiro?: string | null | "",
  plusgiro?: string | null | "",
  swish?: string | null,
  iban?: string | null | "",
  bic?: string | null | "",
  invoice_payment_accounts?: Record<string, { bank_name?: string | null, clearing_number?: string | null | "", account_number?: string | null | "", bankgiro?: string | null | "", plusgiro?: string | null | "", swish?: string | null, iban?: string | null | "", bic?: string | null | "", bank_code?: string | null | "", foreign_account_number?: string | null | "" }>,
  invoice_prefix?: string | null,
  next_invoice_number?: number,
  next_arrival_number?: number,
  invoice_default_days?: number,
  invoice_default_notes?: string | null,
  ore_rounding?: boolean,
  invoice_show_ocr?: boolean,
  invoice_show_bankgiro?: boolean,
  invoice_show_plusgiro?: boolean,
  invoice_show_swish?: boolean,
  invoice_show_logo?: boolean,
  invoice_show_company_name?: boolean,
  invoice_company_name_position?: "header" | "footer",
  invoice_late_fee_text?: string | null,
  invoice_credit_terms_text?: string | null,
  invoice_payment_links_enabled?: boolean,
  invoice_email_texts?: {
    sv?: { subject?: string, greeting?: string, body?: string, signoff?: string },
    en?: { subject?: string, greeting?: string, body?: string, signoff?: string }
  } | null,
  invoice_email_cc_addresses?: string[] | null,
  invoice_email_bcc_addresses?: string[] | null,
  invoice_email_reply_to?: string | null,
  invoice_primary_color?: string,
  invoice_accent_color?: string,
  invoice_font_family?: "Helvetica" | "Times-Roman" | "Courier" | "Source Sans 3" | "Source Serif 4" | "Custom",
  invoice_header_text?: string | null,
  invoice_footer_text?: string | null,
  send_invoice_reminders?: boolean,
  reminder_days_level_1?: number,
  reminder_days_level_2?: number,
  reminder_days_level_3?: number,
  reminder_text_overrides?: {
    level_1?: { subject?: string, body?: string },
    level_2?: { subject?: string, body?: string },
    level_3?: { subject?: string, body?: string }
  } | null,
  reminder_fee_enabled?: boolean,
  reminder_fee_amount?: number,
  reminder_interest_rate_override?: number | null,
  default_voucher_series?: string,
  default_voucher_series_per_source_type?: Record<string, string>,
  voucher_series_labels?: Record<string, string>,
  sector_slug?: string | null,
  dimensions_enabled?: boolean,
  mileage_enabled?: boolean,
  sales_orders_enabled?: boolean,
  quotes_enabled?: boolean,
  proforma_enabled?: boolean,
  recurring_invoices_enabled?: boolean,
  self_billing_enabled?: boolean,
  salary_vacation_year_basis?: "calendar" | "statutory_apr_mar",
  contact_person?: string | null
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
    entity_type: string | null,
    org_number: string | null,
    onboarding_complete: boolean | null,
    contact_person: string | null,
    company_name: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    country: string | null,
    phone: string | null,
    email: string | null,
    website: string | null,
    tax_contact_name: string | null,
    tax_contact_phone: string | null,
    tax_contact_email: string | null,
    bank_name: string | null,
    clearing_number: string | null,
    account_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    swish: string | null,
    iban: string | null,
    bic: string | null,
    invoice_prefix: string | null,
    invoice_default_notes: string | null,
    invoice_company_name_position: string | null,
    invoice_late_fee_text: string | null,
    invoice_credit_terms_text: string | null,
    invoice_email_reply_to: string | null,
    invoice_primary_color: string | null,
    invoice_accent_color: string | null,
    invoice_font_family: string | null,
    invoice_header_text: string | null,
    invoice_footer_text: string | null,
    default_voucher_series: string | null,
    sector_slug: string | null,
    salary_vacation_year_basis: string | null,
    vat_number: string | null,
    moms_period: string | null,
    vat_filing_method: string | null,
    periodisk_sammanstallning_period: string | null,
    periodisk_sammanstallning_filing_method: string | null,
    accounting_method: string | null,
    bookkeeping_locked_through: string | null,
    ore_rounding: boolean | null,
    invoice_show_ocr: boolean | null,
    invoice_show_bankgiro: boolean | null,
    invoice_show_plusgiro: boolean | null,
    invoice_show_swish: boolean | null,
    invoice_show_logo: boolean | null,
    invoice_show_company_name: boolean | null,
    invoice_payment_links_enabled: boolean | null,
    send_invoice_reminders: boolean | null,
    reminder_fee_enabled: boolean | null,
    dimensions_enabled: boolean | null,
    mileage_enabled: boolean | null,
    sales_orders_enabled: boolean | null,
    quotes_enabled: boolean | null,
    proforma_enabled: boolean | null,
    recurring_invoices_enabled: boolean | null,
    self_billing_enabled: boolean | null,
    f_skatt: boolean | null,
    vat_registered: boolean | null,
    vat_taxable_base_over_40m: boolean | null,
    vat_has_eu_trade: boolean | null,
    periodisk_sammanstallning_enabled: boolean | null,
    kontrolluppgifter_enabled: boolean | null,
    rot_rut_enabled: boolean | null,
    oss_enabled: boolean | null,
    ioss_enabled: boolean | null,
    intrastat_enabled: boolean | null,
    punktskatt_enabled: boolean | null,
    fyllnadsinbetalning_enabled: boolean | null,
    pays_salaries: boolean | null,
    employer_registered: boolean | null,
    employer_seasonal: boolean | null,
    defer_invoice_booking: boolean | null,
    next_invoice_number: number | null,
    next_arrival_number: number | null,
    invoice_default_days: number | null,
    reminder_days_level_1: number | null,
    reminder_days_level_2: number | null,
    reminder_days_level_3: number | null,
    reminder_fee_amount: number | null,
    reminder_interest_rate_override: number | null,
    fiscal_year_start_month: number | null,
    preliminary_tax_monthly: number | null,
    aktiekapital: number | null,
    antal_aktier: number | null,
    auto_lock_period_days: number | null,
    invoice_payment_accounts?: unknown,
    invoice_email_texts?: unknown,
    invoice_email_cc_addresses?: unknown,
    invoice_email_bcc_addresses?: unknown,
    reminder_text_overrides?: unknown,
    default_voucher_series_per_source_type?: unknown,
    voucher_series_labels?: unknown
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
    "company_id": "aaaa1111-2222-4333-8444-555566667777",
    "bankgiro": "991-2346",
    "contact_person": "Anna Andersson",
    "email": "faktura@acme.example"
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/settings/bookkeeping-lock`

**Set, move or remove the company-wide bookkeeping lock date.**
`scope:companies:write · risk:high · idempotent · dry-run · reversible`

Sets bookkeeping_locked_through (nothing dated on or before it can be booked, corrected or attached) and auto_lock_period_days. Moving the date back or clearing it reopens those dates, exactly as the settings page allows; the response then carries the warning BOOKKEEPING_LOCK_MOVED_BACKWARDS. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** A period is reconciled and filed and should be protected, or a locked date must be reopened for a correction.
**Do not use for:** Locking or closing a single fiscal period (POST /fiscal-periods/{id}/lock, /close), or correcting a posted verifikat (storno or rättelse).

**Pitfalls:**
- Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.
- Refused while an SIE import is still holding a fiscal period (finish the import first).
- A backwards move is allowed but high risk. When it reopens a filed momsdeklaration period it is refused with 409 BOOKKEEPING_LOCK_REOPENS_FILED_VAT (details.filed_periods) unless acknowledge_filed_vat_periods is true: reopen a filed period only to book a correction and file a corrected declaration for it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  bookkeeping_locked_through?: string | null,
  auto_lock_period_days?: number | null,
  acknowledge_filed_vat_periods?: boolean
}
```

Example request:
```json
{
  "bookkeeping_locked_through": "2026-06-30"
}
```

Response `200`:
```ts
{
  data: {
    company_id: string,
    entity_type: string | null,
    org_number: string | null,
    onboarding_complete: boolean | null,
    contact_person: string | null,
    company_name: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    country: string | null,
    phone: string | null,
    email: string | null,
    website: string | null,
    tax_contact_name: string | null,
    tax_contact_phone: string | null,
    tax_contact_email: string | null,
    bank_name: string | null,
    clearing_number: string | null,
    account_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    swish: string | null,
    iban: string | null,
    bic: string | null,
    invoice_prefix: string | null,
    invoice_default_notes: string | null,
    invoice_company_name_position: string | null,
    invoice_late_fee_text: string | null,
    invoice_credit_terms_text: string | null,
    invoice_email_reply_to: string | null,
    invoice_primary_color: string | null,
    invoice_accent_color: string | null,
    invoice_font_family: string | null,
    invoice_header_text: string | null,
    invoice_footer_text: string | null,
    default_voucher_series: string | null,
    sector_slug: string | null,
    salary_vacation_year_basis: string | null,
    vat_number: string | null,
    moms_period: string | null,
    vat_filing_method: string | null,
    periodisk_sammanstallning_period: string | null,
    periodisk_sammanstallning_filing_method: string | null,
    accounting_method: string | null,
    bookkeeping_locked_through: string | null,
    ore_rounding: boolean | null,
    invoice_show_ocr: boolean | null,
    invoice_show_bankgiro: boolean | null,
    invoice_show_plusgiro: boolean | null,
    invoice_show_swish: boolean | null,
    invoice_show_logo: boolean | null,
    invoice_show_company_name: boolean | null,
    invoice_payment_links_enabled: boolean | null,
    send_invoice_reminders: boolean | null,
    reminder_fee_enabled: boolean | null,
    dimensions_enabled: boolean | null,
    mileage_enabled: boolean | null,
    sales_orders_enabled: boolean | null,
    quotes_enabled: boolean | null,
    proforma_enabled: boolean | null,
    recurring_invoices_enabled: boolean | null,
    self_billing_enabled: boolean | null,
    f_skatt: boolean | null,
    vat_registered: boolean | null,
    vat_taxable_base_over_40m: boolean | null,
    vat_has_eu_trade: boolean | null,
    periodisk_sammanstallning_enabled: boolean | null,
    kontrolluppgifter_enabled: boolean | null,
    rot_rut_enabled: boolean | null,
    oss_enabled: boolean | null,
    ioss_enabled: boolean | null,
    intrastat_enabled: boolean | null,
    punktskatt_enabled: boolean | null,
    fyllnadsinbetalning_enabled: boolean | null,
    pays_salaries: boolean | null,
    employer_registered: boolean | null,
    employer_seasonal: boolean | null,
    defer_invoice_booking: boolean | null,
    next_invoice_number: number | null,
    next_arrival_number: number | null,
    invoice_default_days: number | null,
    reminder_days_level_1: number | null,
    reminder_days_level_2: number | null,
    reminder_days_level_3: number | null,
    reminder_fee_amount: number | null,
    reminder_interest_rate_override: number | null,
    fiscal_year_start_month: number | null,
    preliminary_tax_monthly: number | null,
    aktiekapital: number | null,
    antal_aktier: number | null,
    auto_lock_period_days: number | null,
    invoice_payment_accounts?: unknown,
    invoice_email_texts?: unknown,
    invoice_email_cc_addresses?: unknown,
    invoice_email_bcc_addresses?: unknown,
    reminder_text_overrides?: unknown,
    default_voucher_series_per_source_type?: unknown,
    voucher_series_labels?: unknown
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
    "company_id": "aaaa1111-2222-4333-8444-555566667777",
    "bookkeeping_locked_through": "2026-06-30",
    "auto_lock_period_days": null
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/settings/tax-profile`

**Change the tax and legal profile: VAT, F-skatt, employer registration, fiscal year, accounting method.**
`scope:companies:write · risk:high · idempotent · dry-run · reversible`

Patches the settings that decide how the books are kept and declared: VAT registration, VAT number and moms period, EU trade and periodisk sammanställning, F-skatt, preliminary tax, employer registration, fiscal year start month, accounting method (faktureringsmetoden/kontantmetoden), deferred invoice booking, share capital and the optional deadline reminders. Runs the settings page rules and, like it, regenerates the tax deadlines. Owner or admin only. Idempotent (mandatory Idempotency-Key). Dry-runnable.

**Use when:** The company registered or deregistered for VAT or as an employer, Skatteverket changed its moms period, or the fiscal year or accounting method was changed with the authorities.
**Do not use for:** Invoice, contact or payment details (PATCH /settings), the bookkeeping lock (PATCH /settings/bookkeeping-lock), entity type or org number (fixed).

**Pitfalls:**
- Only an owner or admin of the company may change settings: other members get 403 FORBIDDEN.
- Saving regenerates the system tax deadlines for this year and next; completed deadlines keep their status.
- vat_registered=true needs vat_number (SE + 12 digits) and moms_period, stored or sent.
- vat_registered=false also turns off vat_taxable_base_over_40m, vat_has_eu_trade and periodisk_sammanstallning_enabled.
- vat_taxable_base_over_40m requires moms_period=monthly; periodisk sammanställning requires VAT registration and EU trade.
- An enskild firma must keep fiscal_year_start_month=1 (BFL 3 kap.).
- aktiekapital and antal_aktier are set or cleared together.
- accounting_method=cash turns defer_invoice_booking off (deferred booking is accrual only).
- accounting_method can only change while the current fiscal year has no posted verifikat (409 ACCOUNTING_METHOD_CHANGE_MID_YEAR): the method governs the whole year (BFL 5 kap 2 §), and for VAT a move to bokslutsmetoden also needs Skatteverket (ML 7 kap 17 §).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  f_skatt?: boolean,
  vat_registered?: boolean,
  vat_number?: string | null,
  moms_period?: "monthly" | "quarterly" | "yearly" | null,
  vat_taxable_base_over_40m?: boolean,
  vat_has_eu_trade?: boolean,
  vat_filing_method?: "electronic" | "paper",
  periodisk_sammanstallning_enabled?: boolean,
  periodisk_sammanstallning_period?: "monthly" | "quarterly",
  periodisk_sammanstallning_filing_method?: "electronic" | "paper",
  kontrolluppgifter_enabled?: boolean,
  rot_rut_enabled?: boolean,
  oss_enabled?: boolean,
  ioss_enabled?: boolean,
  intrastat_enabled?: boolean,
  punktskatt_enabled?: boolean,
  fyllnadsinbetalning_enabled?: boolean,
  fiscal_year_start_month?: number,
  preliminary_tax_monthly?: number | null,
  pays_salaries?: boolean,
  employer_registered?: boolean | null,
  employer_seasonal?: boolean,
  accounting_method?: "accrual" | "cash",
  defer_invoice_booking?: boolean,
  aktiekapital?: number | null,
  antal_aktier?: number | null
}
```

Example request:
```json
{
  "vat_registered": true,
  "vat_number": "SE556677889901",
  "moms_period": "quarterly"
}
```

Response `200`:
```ts
{
  data: {
    company_id: string,
    entity_type: string | null,
    org_number: string | null,
    onboarding_complete: boolean | null,
    contact_person: string | null,
    company_name: string | null,
    address_line1: string | null,
    address_line2: string | null,
    postal_code: string | null,
    city: string | null,
    country: string | null,
    phone: string | null,
    email: string | null,
    website: string | null,
    tax_contact_name: string | null,
    tax_contact_phone: string | null,
    tax_contact_email: string | null,
    bank_name: string | null,
    clearing_number: string | null,
    account_number: string | null,
    bankgiro: string | null,
    plusgiro: string | null,
    swish: string | null,
    iban: string | null,
    bic: string | null,
    invoice_prefix: string | null,
    invoice_default_notes: string | null,
    invoice_company_name_position: string | null,
    invoice_late_fee_text: string | null,
    invoice_credit_terms_text: string | null,
    invoice_email_reply_to: string | null,
    invoice_primary_color: string | null,
    invoice_accent_color: string | null,
    invoice_font_family: string | null,
    invoice_header_text: string | null,
    invoice_footer_text: string | null,
    default_voucher_series: string | null,
    sector_slug: string | null,
    salary_vacation_year_basis: string | null,
    vat_number: string | null,
    moms_period: string | null,
    vat_filing_method: string | null,
    periodisk_sammanstallning_period: string | null,
    periodisk_sammanstallning_filing_method: string | null,
    accounting_method: string | null,
    bookkeeping_locked_through: string | null,
    ore_rounding: boolean | null,
    invoice_show_ocr: boolean | null,
    invoice_show_bankgiro: boolean | null,
    invoice_show_plusgiro: boolean | null,
    invoice_show_swish: boolean | null,
    invoice_show_logo: boolean | null,
    invoice_show_company_name: boolean | null,
    invoice_payment_links_enabled: boolean | null,
    send_invoice_reminders: boolean | null,
    reminder_fee_enabled: boolean | null,
    dimensions_enabled: boolean | null,
    mileage_enabled: boolean | null,
    sales_orders_enabled: boolean | null,
    quotes_enabled: boolean | null,
    proforma_enabled: boolean | null,
    recurring_invoices_enabled: boolean | null,
    self_billing_enabled: boolean | null,
    f_skatt: boolean | null,
    vat_registered: boolean | null,
    vat_taxable_base_over_40m: boolean | null,
    vat_has_eu_trade: boolean | null,
    periodisk_sammanstallning_enabled: boolean | null,
    kontrolluppgifter_enabled: boolean | null,
    rot_rut_enabled: boolean | null,
    oss_enabled: boolean | null,
    ioss_enabled: boolean | null,
    intrastat_enabled: boolean | null,
    punktskatt_enabled: boolean | null,
    fyllnadsinbetalning_enabled: boolean | null,
    pays_salaries: boolean | null,
    employer_registered: boolean | null,
    employer_seasonal: boolean | null,
    defer_invoice_booking: boolean | null,
    next_invoice_number: number | null,
    next_arrival_number: number | null,
    invoice_default_days: number | null,
    reminder_days_level_1: number | null,
    reminder_days_level_2: number | null,
    reminder_days_level_3: number | null,
    reminder_fee_amount: number | null,
    reminder_interest_rate_override: number | null,
    fiscal_year_start_month: number | null,
    preliminary_tax_monthly: number | null,
    aktiekapital: number | null,
    antal_aktier: number | null,
    auto_lock_period_days: number | null,
    invoice_payment_accounts?: unknown,
    invoice_email_texts?: unknown,
    invoice_email_cc_addresses?: unknown,
    invoice_email_bcc_addresses?: unknown,
    reminder_text_overrides?: unknown,
    default_voucher_series_per_source_type?: unknown,
    voucher_series_labels?: unknown,
    deadlines_regenerated: boolean
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
    "company_id": "aaaa1111-2222-4333-8444-555566667777",
    "vat_registered": true,
    "vat_number": "SE556677889901",
    "moms_period": "quarterly",
    "deadlines_regenerated": true
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
    error: { code?: string, message?: string, details?: unknown } | null,
    started_at: string | null,
    completed_at: string | null,
    poll_url: string,
    webhook_event: "operation.completed"
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
