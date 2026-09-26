<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Periods and registers endpoints

Fiscal periods and their lock/close/year-end lifecycle (async operations), the BAS chart of accounts, cost-center/project dimensions, the compliance pre-flight check, and reading filed VAT declarations (and beslut) from Skatteverket.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/accounts`

**List chart-of-accounts entries (BAS chart).**
`scope:reports:read · risk:low · idempotent`

Returns the company's own chart of accounts (kontoplan), ordered by account_number, which is the BAS sequence (a longer sub-account number such as 19301 sorts directly after 1930). This is not the full BAS 2026 catalogue: a new company starts with a small set of accounts seeded for its company form, and standard BAS accounts join the chart when the user activates them, when an import brings them in, or automatically the first time a verifikat posts to one. Filter with ?class=<0-9>, the first digit of account_number: 1 assets; 2 equity, untaxed reserves and liabilities; 3 operating revenue; 4 goods, materials and subcontracted services; 5 external expenses for premises, leasing, energy, consumables, repairs, vehicles, freight, travel, and advertising and PR; 6 other external expenses such as selling costs, office supplies, telecom, insurance, administration, accounting, IT and consulting services, and hired staff; 7 personnel costs, plus write-downs and depreciation (77xx-78xx); 8 financial items, year-end appropriations (88xx), and tax and the year's result (89xx). Classes 0 and 9 are outside BAS's 1-8 (free for company use) and appear only on internal accounts, typically carried over from an imported chart. Only active accounts are returned by default; pass ?active=false to include deactivated ones.

**Use when:** You need account numbers and names to render verifikation tables, build a custom report, check that an account is active before booking to it, or look up an account's type, normal balance, SRU code or VAT defaults.
**Do not use for:** Fetching balances: use the trial-balance report. Creating, editing, deactivating or deleting accounts: POST /accounts, PATCH and DELETE /accounts/{number}, POST /accounts/activate and /accounts/deactivate.

**Pitfalls:**
- account_number is a STRING: "1930", not 1930. BAS numbers have four digits; a chart imported from another system can also carry longer sub-account numbers such as "19301".
- An account missing from this list is not necessarily unusable. Posting to a standard BAS 2026 account that is not in the chart adds it automatically; posting to a deactivated account, or to a non-BAS number the chart does not contain, fails with ACCOUNTS_NOT_IN_CHART.
- is_system_account=true marks the accounts seeded when the company was created (such as 1510, 1930, 2440, 2611 and 3001). They cannot be deleted and bulk deactivation skips them, but they can still be renamed and deactivated one at a time.
- normal_balance belongs to the account, not to account_type: contra accounts go against their type, such as 1219 (accumulated depreciation, an asset with a credit balance) and 3730 (discounts given, revenue with a debit balance).
- default_vat_rate is a fraction (0, 0.06, 0.12 or 0.25), not a percentage. default_vat_treatment overrides the built-in BAS mapping for the momsdeklaration and is null unless someone set it; it can only be set on class 3 (sales treatments) and classes 4-6 (reverse-charge purchase treatments).
- sort_order is a stored display hint, not a sequence to rely on: every account seeded at company creation carries 0. The list already comes in BAS order.
- Deactivated accounts are excluded by default; pass ?active=false to include them. A deactivated account keeps its history and balances but cannot be used on new verifikat.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `class` | query | `string` | no | Account class, the first digit of account_number (0-9). BAS uses 1-8; 0 and 9 appear only on internal accounts, typically carried over from an imported chart. |
| `active` | query | `"true" \| "false"` | no | false also returns deactivated accounts. Default: active accounts only. |

Response `200`:
```ts
{
  data: {
    accounts: { account_number: string, account_name: string, account_class: number, account_group: string, account_type: "asset" | "equity" | "liability" | "untaxed_reserves" | "revenue" | "expense", normal_balance: "debit" | "credit", is_system_account: boolean, is_active: boolean, description: string | null, default_vat_code: string | null, default_vat_rate: number | null, default_vat_treatment: "standard_25" | "reduced_12" | "reduced_6" | "exempt" | "reverse_charge_domestic" | "reverse_charge_eu_goods" | "reverse_charge_eu_services" | "reverse_charge_non_eu_services" | "export_goods" | "export_services" | "vmb" | "rental_voluntary" | "oss" | "triangulation_eu_goods" | "own_use" | "import_goods" | null, sru_code: string | null, sort_order: number | null }[]
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
    "accounts": [
      {
        "account_number": "1930",
        "account_name": "Företagskonto / checkkonto",
        "account_class": 1,
        "account_group": "19",
        "account_type": "asset",
        "normal_balance": "debit",
        "is_system_account": true,
        "is_active": true,
        "description": null,
        "default_vat_code": null,
        "default_vat_rate": null,
        "default_vat_treatment": null,
        "sru_code": "7281",
        "sort_order": 0
      },
      {
        "account_number": "3001",
        "account_name": "Försäljning inom Sverige, 25 % moms",
        "account_class": 3,
        "account_group": "30",
        "account_type": "revenue",
        "normal_balance": "credit",
        "is_system_account": true,
        "is_active": true,
        "description": null,
        "default_vat_code": null,
        "default_vat_rate": 0.25,
        "default_vat_treatment": null,
        "sru_code": "7410",
        "sort_order": 0
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

### `POST /api/v1/companies/{companyId}/accounts`

**Add an account to the chart of accounts (kontoplan).**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Adds an account to the company's kontoplan. A BAS 2026 number needs nothing but the number: name, account_type, normal_balance, description and SRU code are prefilled from the catalogue, and anything you send wins. A number outside BAS 2026 must name account_name, account_type and normal_balance. account_class and account_group derive from the number. A default_vat_treatment without a default_vat_rate derives the booking rate. Idempotent. Dry-runnable.

**Use when:** A verifikat needs an account the chart does not carry: a company-specific sub-account, or a BAS account the company has not used yet.
**Do not use for:** Reactivating a deactivated account (PATCH is_active=true, or POST /accounts/activate) or bulk-adding standard BAS accounts (POST /accounts/activate).

**Pitfalls:**
- account_number is a STRING of exactly 4 digits: "5410", not 5410.
- The account_type must fit the class, the first digit: 1 asset; 2 equity, liability or untaxed_reserves (21xx only); 3 revenue; 4-7 expense; 8 revenue or expense. A mismatch returns 400 ACCOUNT_TYPE_CLASS_CONFLICT.
- A number already in the chart returns 409 ACCOUNT_EXISTS, or ACCOUNT_EXISTS_INACTIVE when it was deactivated: reactivate it instead.
- default_vat_rate is a fraction (0, 0.06, 0.12, 0.25), not a percentage.
- vat_box (momsruta override) only fits 26xx VAT accounts other than 2650.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  account_number: string,
  account_name?: string,
  account_type?: "asset" | "equity" | "liability" | "revenue" | "expense" | "untaxed_reserves",
  normal_balance?: "debit" | "credit",
  description?: string,
  default_vat_code?: string,
  default_vat_rate?: 0,
  default_vat_treatment?: "standard_25",
  vat_box?: "10",
  sru_code?: string
}
```

Example request:
```json
{
  "account_number": "5410"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    account_number: string,
    account_name: string,
    account_class: number,
    account_group: string,
    account_type: "asset" | "equity" | "liability" | "revenue" | "expense" | "untaxed_reserves",
    normal_balance: "debit" | "credit",
    plan_type: string | null,
    is_active: boolean,
    is_system_account: boolean,
    description: string | null,
    default_vat_code: string | null,
    default_vat_rate: number | null,
    default_vat_treatment: "standard_25" | "reduced_12" | "reduced_6" | "exempt" | "reverse_charge_domestic" | "reverse_charge_eu_goods" | "reverse_charge_eu_services" | "reverse_charge_non_eu_services" | "export_goods" | "export_services" | "vmb" | "rental_voluntary" | "oss" | "triangulation_eu_goods" | "own_use" | "import_goods" | null,
    vat_box: "10" | "11" | "12" | "30" | "31" | "32" | "48" | "60" | "61" | "62" | null,
    sru_code: string | null,
    sort_order: number | null
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
    "id": "8d0e…",
    "account_number": "5410",
    "account_name": "Förbrukningsinventarier",
    "account_class": 5,
    "account_group": "54",
    "account_type": "expense",
    "normal_balance": "debit",
    "plan_type": "full_bas",
    "is_active": true,
    "is_system_account": false,
    "description": null,
    "default_vat_code": null,
    "default_vat_rate": null,
    "default_vat_treatment": null,
    "vat_box": null,
    "sru_code": "7321",
    "sort_order": 5410
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/accounts/{number}`

**Edit or deactivate an account in the chart of accounts.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Sparse update of one kontoplan account: name, description, VAT defaults (code, booking rate, treatment), momsruta override (vat_box), SRU code and is_active (false deactivates it: history and balances stay, new verifikat cannot use it). An empty string or null clears a text field. The number, class, type and normal balance are fixed: an account that should be something else is a new account. A treatment without a rate derives the booking rate only when none is stored. Idempotent. Dry-runnable.

**Use when:** An account needs a clearer name, other VAT defaults or SRU mapping, or should stop (or start again) being offered for bookings.
**Do not use for:** Removing an unused account (DELETE) or deactivating many at once (POST /accounts/deactivate).

**Pitfalls:**
- The path takes the account number as a STRING, e.g. /accounts/5410.
- At least one field must be sent: an empty body returns 400 ACCOUNT_NOTHING_TO_UPDATE.
- default_vat_treatment must fit the class (400 ACCOUNT_VAT_TREATMENT_CLASS); null restores the BAS mapping.
- vat_box only fits 26xx VAT accounts other than 2650; null restores the BAS momsruta.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `number` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  account_name?: string,
  description?: string,
  default_vat_code?: string,
  default_vat_rate?: 0,
  default_vat_treatment?: "standard_25",
  vat_box?: "10",
  sru_code?: string,
  is_active?: boolean
}
```

Example request:
```json
{
  "account_name": "Verktyg och inventarier"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    account_number: string,
    account_name: string,
    account_class: number,
    account_group: string,
    account_type: "asset" | "equity" | "liability" | "revenue" | "expense" | "untaxed_reserves",
    normal_balance: "debit" | "credit",
    plan_type: string | null,
    is_active: boolean,
    is_system_account: boolean,
    description: string | null,
    default_vat_code: string | null,
    default_vat_rate: number | null,
    default_vat_treatment: "standard_25" | "reduced_12" | "reduced_6" | "exempt" | "reverse_charge_domestic" | "reverse_charge_eu_goods" | "reverse_charge_eu_services" | "reverse_charge_non_eu_services" | "export_goods" | "export_services" | "vmb" | "rental_voluntary" | "oss" | "triangulation_eu_goods" | "own_use" | "import_goods" | null,
    vat_box: "10" | "11" | "12" | "30" | "31" | "32" | "48" | "60" | "61" | "62" | null,
    sru_code: string | null,
    sort_order: number | null
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
    "id": "8d0e…",
    "account_number": "5410",
    "account_name": "Verktyg och inventarier",
    "account_class": 5,
    "account_group": "54",
    "account_type": "expense",
    "normal_balance": "debit",
    "plan_type": "full_bas",
    "is_active": true,
    "is_system_account": false,
    "description": null,
    "default_vat_code": null,
    "default_vat_rate": null,
    "default_vat_treatment": null,
    "vat_box": null,
    "sru_code": "7321",
    "sort_order": 5410
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/accounts/{number}`

**Delete an account nothing has been booked on.**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run`

Removes an account from the kontoplan. Refused for system accounts and for any account with journal lines in this company, on any entry status including drafts (BFL: a verifikat is immutable and its lines must keep resolving to an account). Deactivate those with PATCH is_active=false instead. Idempotent. Dry-runnable.

**Use when:** An account was added by mistake, or an imported chart carries accounts the company never used.
**Do not use for:** Retiring an account that has been used: deactivate it (PATCH is_active=false).

**Pitfalls:**
- An account with any journal line returns 409 ACCOUNT_IN_USE with details.usage_count.
- System accounts (seeded at company creation) return 400 ACCOUNT_SYSTEM_DELETE.
- A standard BAS account can be re-added later with POST /accounts or POST /accounts/activate.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `number` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { deleted: true, account_number: string },
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
    "account_number": "5410"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/accounts/activate`

**Activate BAS accounts in bulk.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Makes each listed account bookable: a standard BAS 2026 number missing from the chart is added from the catalogue, a deactivated account is reactivated, an active one is skipped. Numbers that are neither in the chart nor in BAS 2026 are reported in `unknown`, not refused: add those one at a time with POST /accounts. Idempotent. Dry-runnable.

**Use when:** A booking failed with ACCOUNTS_NOT_IN_CHART, or you want a set of standard BAS accounts available before importing or booking.
**Do not use for:** A company-specific account outside BAS 2026 (POST /accounts with name, type and normal balance).

**Pitfalls:**
- account_numbers are STRINGS: ["5410", "6570"].
- Up to 2000 numbers per call; duplicates are counted once.
- Check `unknown` in the answer: those numbers were not added.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ account_numbers: string[] }
```

Example request:
```json
{
  "account_numbers": [
    "5410",
    "6570"
  ]
}
```

Response `200`:
```ts
{
  data: {
    accounts: { account_number: string }[],
    activated: number,
    reactivated: number,
    skipped: number,
    unknown: string[]
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
    "accounts": [
      {
        "account_number": "5410"
      }
    ],
    "activated": 1,
    "reactivated": 0,
    "skipped": 1,
    "unknown": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/accounts/deactivate`

**Deactivate accounts in bulk.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Deactivates each listed account so it stops being offered for new bookings; history and balances stay. System accounts are always skipped, and accounts with journal lines are skipped unless include_used=true (deactivating a used account hides its balance from the kontoplan). Already inactive numbers are counted, numbers not in the chart reported in `unknown`. Idempotent. Dry-runnable.

**Use when:** Tidying a chart imported from a previous system, where hundreds of accounts were never posted to.
**Do not use for:** Removing accounts for good (DELETE /accounts/{number}, unused accounts only).

**Pitfalls:**
- account_numbers are STRINGS.
- include_used defaults to false: used accounts come back in skipped_used.
- Reactivate with POST /accounts/activate or PATCH is_active=true.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ account_numbers: string[], include_used?: boolean }
```

Example request:
```json
{
  "account_numbers": [
    "6991",
    "7699"
  ]
}
```

Response `200`:
```ts
{
  data: {
    accounts: { account_number: string }[],
    deactivated: number,
    skipped_system: string[],
    skipped_used: string[],
    skipped_inactive: number,
    unknown: string[]
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
    "accounts": [
      {
        "account_number": "6991"
      }
    ],
    "deactivated": 1,
    "skipped_system": [],
    "skipped_used": [
      "7699"
    ],
    "skipped_inactive": 0,
    "unknown": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/compliance/check`

**Run a structured compliance pre-flight check.**
`scope:compliance:read · risk:low · idempotent`

Generalised pre-flight that consolidates the Accounted pre-close validators under one envelope. Supported check types: year_end_readiness (BFNAR 2017:3 + ÅRL 2:1 blockers), voucher_gaps (BFNAR 2013:2 kap 8 § series continuity). vat_close is planned for a follow-up PR (the underlying function currently lives in the MCP extension and core routes cannot import from extensions; it will be extracted into lib/reports/ then exposed here). New types can be added without changing the response shape.

**Use when:** Before committing to an irreversible action (VAT close, year-end close), or as a periodic audit sweep to surface blockers before they become urgent.
**Do not use for:** Executing the underlying action: this is read-only. After a passing check, call the corresponding async endpoint (POST /fiscal-periods/{id}/year-end, etc).

**Pitfalls:**
- year_end_readiness and voucher_gaps require fiscal_period_id (UUID).
- voucher_gaps covers EVERY voucher series registered for the period (A, B, F, ...), not only series A.
- A passing check is a SNAPSHOT: the state can change between the check and the action. The same blocker logic runs again on commit.
- vat_close is documented in the plan but NOT yet supported by this endpoint: call gnubok_vat_close_check via the MCP server until the function is extracted into lib/reports/.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `type` | query | `"year_end_readiness" \| "voucher_gaps"` | yes | Which check to run. |
| `fiscal_period_id` | query | `string` | yes | Fiscal period to check (id from GET /fiscal-periods). Both current check types require it. |

Response `200`:
```ts
{
  data: {
    type: string,
    ready: boolean,
    findings: { severity: "info" | "warning" | "blocker", code: string, message: string, details?: unknown }[],
    summary: string,
    generated_at: string,
    params: Record<string, unknown>
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
    "type": "year_end_readiness",
    "ready": false,
    "findings": [
      {
        "severity": "blocker",
        "code": "YEAR_END_DRAFTS_PRESENT",
        "message": "3 draft journal entries must be committed or cancelled before year-end.",
        "details": {
          "draft_count": 3
        }
      }
    ],
    "summary": "Period is NOT ready (1 blocker(s)).",
    "generated_at": "2026-05-12T14:00:00Z",
    "params": {
      "fiscal_period_id": "a8f1…"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/dimensions`

**List dimensions (kostnadsställe/projekt) with their values.**
`scope:reports:read · risk:low · idempotent`

Returns the company's dimension registry: SIE #DIM entries keyed by sie_dim_no (1 = Kostnadsställe, 6 = Projekt; both always exist): with the registered values (#OBJEKT) nested under each dimension. Dimensions are ordered by sort_order, values by code. Line-level tags on journal entries reference these values as {"<sie_dim_no>":"<code>"} in the `dimensions` map.

**Use when:** You need the valid dimension value codes before tagging journal-entry lines with a cost centre or project, or you are rendering a dimension picker.
**Do not use for:** Filtering reports (pass the dimension filter to the report endpoints once available) or reading which lines carry a tag (read the journal entries themselves).

**Pitfalls:**
- Dimension value codes are STRINGS and case-sensitive: "P001", not 1.
- sie_dim_no is the key used in journal_entry_lines.dimensions, NOT the dimension row id.
- is_active=false values are historical (archived): do not tag new lines with them.
- resets_annually=true (dim 1) means balances reset each fiscal year; dim 6 (projekt) accumulates across years.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    dimensions: { id: string, sie_dim_no: number, name: string, parent_sie_dim_no: number | null, resets_annually: boolean, is_system: boolean, is_active: boolean, sort_order: number, values: { id: string, code: string, name: string, is_active: boolean, start_date: string | null, end_date: string | null }[] }[]
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
    "dimensions": [
      {
        "id": "0e9c…",
        "sie_dim_no": 1,
        "name": "Kostnadsställe",
        "parent_sie_dim_no": null,
        "resets_annually": true,
        "is_system": true,
        "is_active": true,
        "sort_order": 10,
        "values": [
          {
            "id": "a8f1…",
            "code": "BUTIK",
            "name": "Butiken",
            "is_active": true,
            "start_date": null,
            "end_date": null
          }
        ]
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

### `POST /api/v1/companies/{companyId}/dimensions`

**Create a custom dimension (e.g. Avdelning, Kund, Fordon).**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Adds a dimension to the registry (SIE #DIM). Omit sie_dim_no and the next free number from 20 is used: SIE reserves 1-19 for standardized meanings (1 Kostnadsställe, 6 Projekt, 7 Anställd, ...). parent_sie_dim_no declares an #UNDERDIM hierarchy and must name an existing dimension. Add values afterwards with POST /dimensions/{id}/values. Idempotent. Dry-runnable.

**Use when:** The company wants to follow up on something beyond kostnadsställe and projekt, and no existing dimension fits.
**Do not use for:** Adding a cost centre or project code: those are values of the system dimensions 1 and 6 (POST /dimensions/{id}/values).

**Pitfalls:**
- An explicit sie_dim_no that is taken returns 409 DIMENSION_NUMBER_TAKEN; omit it to get the next free number.
- Numbers 1-19 have standardized SIE meanings: only use one when the dimension really is that (e.g. 7 Anställd).
- resets_annually defaults to true (balances reset each fiscal year, like kostnadsställe); set false for things that accumulate, like projekt.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ name: string, sie_dim_no?: number, resets_annually?: boolean, parent_sie_dim_no?: number | null }
```

Example request:
```json
{
  "name": "Avdelning"
}
```

Response `200`:
```ts
{
  data: {
    dimension: { id: string, sie_dim_no: number, name: string, parent_sie_dim_no: number | null, resets_annually: boolean, is_system: boolean, is_active: boolean, sort_order: number }
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
    "dimension": {
      "id": "3c1d…",
      "sie_dim_no": 20,
      "name": "Avdelning",
      "parent_sie_dim_no": null,
      "resets_annually": true,
      "is_system": false,
      "is_active": true,
      "sort_order": 100
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/dimensions/{id}`

**Rename, archive or reorder a dimension.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Sparse update of a dimension: name, is_active (false archives it, hiding it from pickers while history keeps its tags) and sort_order. The system dimensions 1 (Kostnadsställe) and 6 (Projekt) can be archived and reordered but not renamed. sie_dim_no is immutable. Idempotent. Dry-runnable.

**Use when:** A dimension needs a clearer name, should stop being offered for new tags, or should move in the pickers.
**Do not use for:** Changing a value (use PATCH /dimensions/{id}/values/{valueId}) or removing a dimension (DELETE).

**Pitfalls:**
- Renaming a system dimension returns 400 DIMENSION_SYSTEM_RENAME.
- At least one of name, is_active, sort_order must be sent.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ name?: string, is_active?: boolean, sort_order?: number }
```

Example request:
```json
{
  "is_active": false
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    sie_dim_no: number,
    name: string,
    parent_sie_dim_no: number | null,
    resets_annually: boolean,
    is_system: boolean,
    is_active: boolean,
    sort_order: number
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
    "id": "3c1d…",
    "sie_dim_no": 20,
    "name": "Avdelning",
    "parent_sie_dim_no": null,
    "resets_annually": true,
    "is_system": false,
    "is_active": false,
    "sort_order": 100
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/dimensions/{id}`

**Delete a custom dimension nobody has booked on.**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run`

Removes a custom dimension and its values. Refused for the system dimensions and for any dimension whose number is tagged on a posted or reversed verifikat line (BFL 7 kap: booked history is never pulled out from under a verifikat). Archive it with PATCH is_active=false instead. Idempotent. Dry-runnable.

**Use when:** A dimension was created by mistake and nothing has been booked on it.
**Do not use for:** Retiring a dimension that has been used: archive it (PATCH is_active=false).

**Pitfalls:**
- A dimension used on any posted line returns 409 DIMENSION_REFERENCED naming it.
- System dimensions return 400 DIMENSION_SYSTEM_DELETE.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { deleted: true, dimension_id: string },
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
    "dimension_id": "3c1d…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/dimensions/{id}/values`

**Create a dimension value (kostnadsställe/projekt code).**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Registers a new value (SIE #OBJEKT) under a dimension: e.g. a new project code under dimension 6. Requires Idempotency-Key (UUID). Supports ?dry_run=true to validate the code format without committing. The `:id` path segment is the dimension row id (from GET …/dimensions), not the sie_dim_no. Duplicate codes within the dimension return 409 DIMENSION_VALUE_DUPLICATE_CODE.

**Use when:** A voucher or invoice references a cost centre / project code that does not exist yet and the user has confirmed it should be created.
**Do not use for:** Renaming or archiving an existing value (dashboard register in v1). Tagging lines: pass the dimensions map on the journal-entry line instead.

**Pitfalls:**
- Idempotency-Key is mandatory: calls without it return 400 VALIDATION_ERROR.
- The :id segment is the dimension UUID, not the SIE dimension number.
- Codes are limited to the strict Fortnox charset (A-Ö, digits, _, +, -; max 20 chars) even though historical imported codes may be looser.
- code is immutable after creation: there is no rename in v1; create the correct code and archive the wrong one.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  code: string,
  name: string,
  is_active?: boolean,
  start_date?: string | null,
  end_date?: string | null
}
```

Example request:
```json
{
  "code": "P001",
  "name": "Villa Almgren tak"
}
```

Response `200`:
```ts
{
  data: {
    id: string | null,
    dimension_id: string,
    code: string,
    name: string,
    is_active: boolean,
    start_date: string | null,
    end_date: string | null,
    created_at: string | null
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
    "dimension_id": "a8f1…",
    "code": "P001",
    "name": "Villa Almgren tak",
    "is_active": true,
    "start_date": null,
    "end_date": null,
    "created_at": "2026-07-02T12:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/dimensions/{id}/values/{valueId}`

**Update a dimension value (rename, archive, set start/end date).**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Sparse update of a dimension value (SIE #OBJEKT): name, is_active (false = archive), start_date, end_date. `code` is immutable: renaming a code would orphan every journal line tagged with it; create a new value and archive the old one instead. Dates are only allowed on accumulating dimensions (resets_annually=false, e.g. dim 6 Projekt): use end_date to close a finished project. Idempotent (mandatory Idempotency-Key) and dry-runnable.

**Use when:** You need to rename a project/cost-centre, mark a finished project with an end date, or archive (is_active=false) a value that should no longer be used on new lines.
**Do not use for:** Changing the code (immutable: create + archive instead). Removing an unused value entirely (use DELETE). Tagging lines (pass dimensions on the journal-entry line or invoice).

**Pitfalls:**
- Idempotency-Key is mandatory.
- The :id segment is the dimension UUID and :valueId the value UUID (both from GET …/dimensions), not SIE numbers or codes.
- start_date/end_date return 400 DIMENSION_VALUE_DATES_NOT_ALLOWED on resets_annually dimensions (dim 1 Kostnadsställe).
- Archived values (is_active=false) still appear in GET …/dimensions and remain valid on historical lines; they are only blocked for NEW tags.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `valueId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ name?: string, is_active?: boolean, start_date?: string | null, end_date?: string | null }
```

Example request:
```json
{
  "end_date": "2026-08-31",
  "is_active": false
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    dimension_id: string,
    code: string,
    name: string,
    is_active: boolean,
    start_date: string | null,
    end_date: string | null
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
    "dimension_id": "a8f1…",
    "code": "P001",
    "name": "Villa Almgren tak",
    "is_active": false,
    "start_date": null,
    "end_date": "2026-08-31"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/dimensions/{id}/values/{valueId}`

**Delete an unreferenced dimension value.**
`scope:bookkeeping:write · risk:medium · idempotent`

Hard-deletes a dimension value (SIE #OBJEKT) that no journal line references. Values used on posted or reversed verifikat are retained for the BFL 7-year archive and cannot be deleted: the DB trigger blocks it and this endpoint returns 409 DIMENSION_VALUE_REFERENCED. Archive those instead (PATCH is_active=false). Requires Idempotency-Key.

**Use when:** A project/cost-centre code was created by mistake (typo, duplicate) and has never been used on any booking.
**Do not use for:** Retiring a project that has bookings: PATCH is_active=false (and optionally end_date) instead. Deleting a whole dimension (not supported).

**Pitfalls:**
- Idempotency-Key is mandatory.
- 409 DIMENSION_VALUE_REFERENCED means the value is used on booked verifikat: it can never be deleted, only archived.
- Deletion is permanent: the code can be re-created afterwards, but the old row id is gone.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `valueId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { deleted: true, id: string },
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
    "id": "0e9c…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/fiscal-periods`

**List fiscal periods (räkenskapsår).**
`scope:reports:read · risk:low · idempotent`

Returns every fiscal period for the company ordered by period_start DESC. is_closed=true means bokslut has been signed; locked_at non-null means writes are blocked at the DB-trigger level.

**Use when:** You need to find the active period before booking, build a year-selector UI, or audit the period-lock history.
**Do not use for:** Creating, editing, locking or closing periods: use POST /fiscal-periods, PATCH /fiscal-periods/{id}, POST /fiscal-periods/{id}/lock, /unlock, /close and /year-end.

**Pitfalls:**
- previous_period_id chains the bokslut continuity (BFNAR 2013:2). A null value on a non-first period is a data-quality red flag.
- A period can be locked but not closed (löpande bokföring of the new year while bokslut work continues on the prior year: see BFL 5 kap 2 § for the löpande bokföring deadline).
- BFL 3 kap caps a single fiscal period at 18 months. First-year exceptions are allowed.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    fiscal_periods: { id: string, name: string, period_start: string, period_end: string, is_closed: boolean, closed_at: string | null, locked_at: string | null, previous_period_id: string | null, created_at: string, duration_days: number, exceeds_18_months: boolean }[]
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
    "fiscal_periods": [
      {
        "id": "fp_2026",
        "name": "Räkenskapsår 2026",
        "period_start": "2026-01-01",
        "period_end": "2026-12-31",
        "is_closed": false,
        "locked_at": null
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

### `POST /api/v1/companies/{companyId}/fiscal-periods`

**Create a fiscal year (räkenskapsår).**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run`

Creates a räkenskapsår and links it into the continuity chain (previous_period_id, BFNAR 2013:2). The year must be at most 18 months, end on a month end, and start on the 1st unless it becomes the earliest year (BFL 3 kap. 1 and 3 §§). It must be contiguous with its neighbours: appended, it starts the day after the latest year ends; filling a gap, it also ends the day before the next year starts; prepended, it ends the day before the earliest year starts. A still-open prior year does not block: the 201 carries a PRIOR_FISCAL_YEAR_STILL_OPEN warning. Idempotent. Dry-runnable.

**Use when:** The company needs the next räkenskapsår to book in (e.g. January arrives), or an earlier year must exist before its SIE file or opening balances can be imported.
**Do not use for:** Closing the prior year (run the year-end), or changing an existing year (PATCH /fiscal-periods/{id}).

**Pitfalls:**
- A start that does not continue the preceding year answers 400 FISCAL_PERIOD_NOT_CONTIGUOUS with details.expected_start (or details.expected_end): retry with that date.
- Overlapping an existing year answers 409 FISCAL_PERIOD_OVERLAP.
- An enskild firma normally runs the calendar year; a brutet räkenskapsår needs Skatteverket's permission.
- There is no delete: a wrong year can be re-dated with PATCH only while nothing is posted in it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ name: string, period_start: string, period_end: string }
```

Example request:
```json
{
  "name": "Räkenskapsår 2027",
  "period_start": "2027-01-01",
  "period_end": "2027-12-31"
}
```

Response `200`:
```ts
{
  data: {
    fiscal_period: { id: string, name: string, period_start: string, period_end: string, is_closed: boolean, closed_at: string | null, closed_externally: boolean, locked_at: string | null, previous_period_id: string | null, created_at: string }
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
    "fiscal_period": {
      "id": "a8f1…",
      "name": "Räkenskapsår 2027",
      "period_start": "2027-01-01",
      "period_end": "2027-12-31",
      "is_closed": false,
      "closed_at": null,
      "closed_externally": false,
      "locked_at": null,
      "previous_period_id": "5c2e…",
      "created_at": "2026-12-01T09:00:00Z"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/fiscal-periods/{id}`

**Rename or re-date an open fiscal year.**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run · reversible`

Sparse update of an open, unlocked räkenskapsår: name, period_start, period_end. The name can change at any time on an open year; the dates only while no posted or reversed verifikat exist in it. New dates follow the same BFL 3 kap. rules as create (18-month cap, month-end end, 1st-of-month start unless it is the earliest year, calendar year for an enskild firma) and may not overlap another year. Idempotent. Dry-runnable.

**Use when:** A year was created with the wrong dates or name and nothing has been booked in it yet.
**Do not use for:** Moving verifikat between years, changing a locked or closed year, or lengthening a year that already has bookings.

**Pitfalls:**
- Any posted or reversed verifikat in the year answers 409 FISCAL_PERIOD_HAS_POSTED_ENTRIES when dates are sent: send only name to rename.
- A locked year answers 409 FISCAL_PERIOD_UPDATE_LOCKED, a closed one 409 FISCAL_PERIOD_UPDATE_CLOSED.
- Re-dating does not re-chain previous_period_id: keep the years contiguous yourself.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ name?: string, period_start?: string, period_end?: string }
```

Example request:
```json
{
  "period_end": "2027-06-30"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    period_start: string,
    period_end: string,
    is_closed: boolean,
    closed_at: string | null,
    closed_externally: boolean,
    locked_at: string | null,
    previous_period_id: string | null,
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
    "id": "a8f1…",
    "name": "Räkenskapsår 2027",
    "period_start": "2027-01-01",
    "period_end": "2027-06-30",
    "is_closed": false,
    "closed_at": null,
    "closed_externally": false,
    "locked_at": null,
    "previous_period_id": "5c2e…",
    "created_at": "2026-12-01T09:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/fiscal-periods/{id}/close`

**Close a fiscal period (IRREVERSIBLE per BFL 5 kap 8 §).**
`scope:bookkeeping:write · risk:high · idempotent`

Sets is_closed=true + closed_at on the period. Pre-requisites: period must be locked (call /lock first) AND year-end closing must have been executed (call /year-end first). Sync. The DB blocks any subsequent JE inserts.

**Use when:** Final step in the year-end flow: lock → year-end → close. Closing freezes the period for BFL 7 kap retention.
**Do not use for:** Locking a period (use /lock). Running the year-end closing entry (use /year-end). UNDOING a close (not supported, irreversible).

**Pitfalls:**
- Idempotency-Key is mandatory.
- IRREVERSIBLE. Once is_closed=true, the period is read-only forever (BFL 5 kap 8 § + 7 kap).
- Pre-conditions: locked + closing_entry_id present. Otherwise the call returns CONFLICT.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, is_closed: true, closed_at: string },
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
    "is_closed": true,
    "closed_at": "2026-05-12T14:30:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/fiscal-periods/{id}/close-external`

**Mark a migrated fiscal year as closed in the previous system (klarmarkera).**
`scope:bookkeeping:write · risk:high · idempotent · dry-run · reversible`

Closes and locks an imported historical räkenskapsår whose bokslut was done in the previous bookkeeping software, without a closing entry here, and writes the decision to the audit log. Only for migrated years: the year must have ended, have no closing entry in Accounted, and hold imported verifikat, no verifikat, or balance-sheet-only verifikat with the next year's IB already posted. Unbooked bank transactions in the year block it, as for a lock. Undo with reopen-external. Idempotent. Dry-runnable.

**Use when:** After an SIE migration, the earlier years show as pending bokslut although their bokslut was done in the old system.
**Do not use for:** Closing a year bookkept in Accounted: run the year-end (POST /fiscal-periods/{id}/year-end), which transfers the result and carries the balances forward.

**Pitfalls:**
- A year bookkept here with result accounts answers 409 FISCAL_PERIOD_CLOSE_EXTERNAL_NATIVE_BOOKKEEPING: run the year-end instead.
- A running year answers 409 FISCAL_PERIOD_CLOSE_EXTERNAL_NOT_ENDED.
- Unbooked bank transactions answer 400 PERIOD_HAS_UNBOOKED_TRANSACTIONS with the count in details.reason.

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
    name: string,
    period_start: string,
    period_end: string,
    is_closed: boolean,
    closed_at: string | null,
    closed_externally: boolean,
    locked_at: string | null,
    previous_period_id: string | null,
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
    "id": "a8f1…",
    "name": "Räkenskapsår 2024",
    "period_start": "2024-01-01",
    "period_end": "2024-12-31",
    "is_closed": true,
    "closed_at": "2026-09-25T09:00:00Z",
    "closed_externally": true,
    "locked_at": "2026-09-25T09:00:00Z",
    "previous_period_id": "5c2e…",
    "created_at": "2026-12-01T09:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/fiscal-periods/{id}/currency-revaluation`

**Run FX revaluation for the fiscal period.**
`scope:bookkeeping:write · risk:high · idempotent · reversible`

Re-rates open foreign-currency AR (1510) and AP (2440) at the closing date's Riksbanken rate and posts the SEK delta to 3960 (valutakursvinst) / 7960 (valutakursförlust). Returns 202 with operation_id. Idempotent per-period: the engine throws if a revaluation has already been posted for the same fiscal_period_id.

**Use when:** Before /year-end if your books have open foreign-currency receivables or payables. /year-end also runs this internally, so you only need to call it separately when you want the FX-only entry without the full closing.
**Do not use for:** Re-running on the same period (CURRENCY_REVALUATION_ALREADY_EXISTS). Revaluing a closed period (the trigger blocks JE writes to closed periods).

**Pitfalls:**
- Idempotency-Key is mandatory.
- Engine returns null if no open foreign-currency items exist: the operation succeeds with result.revaluation_entry_id=null.
- as_of_date defaults to period_end if omitted.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ as_of_date?: string }
```

Example request:
```json
{
  "as_of_date": "2026-12-31"
}
```

Response `200`:
```ts
{
  data: {
    operation_id: string,
    type: "fiscal_periods.currency_revaluation",
    status: "queued" | "running" | "succeeded" | "failed",
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
    "operation_id": "0e9c…",
    "type": "fiscal_periods.currency_revaluation",
    "status": "succeeded",
    "poll_url": "/api/v1/operations/0e9c…",
    "webhook_event": "operation.completed"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/fiscal-periods/{id}/lock`

**Lock a fiscal period (no new entries can be posted into it).**
`scope:bookkeeping:write · risk:high · idempotent · reversible`

Sets locked_at on the period. Refuses if uncategorised business transactions remain in the period: they must be bokfört first. The DB trigger blocks JE inserts into locked periods; locking is the application-level pre-step before /close. Sync.

**Use when:** Finishing a period and you want to stop new postings. Step 1 of a three-step year-end flow: lock → year-end → close.
**Do not use for:** Locking an already-closed period (no-op). Bypassing the uncategorised-transactions guard: categorise or mark-private first.

**Pitfalls:**
- Idempotency-Key is mandatory.
- A period with uncategorised business transactions cannot be locked; the response surfaces the count.
- Locking is reversible until /close: POST /fiscal-periods/{id}/unlock lifts it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, locked_at: string, is_closed: boolean },
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
    "locked_at": "2026-05-12T14:00:00Z",
    "is_closed": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/fiscal-periods/{id}/opening-balances`

**Generate opening-balance verifikation for the next fiscal period.**
`scope:bookkeeping:write · risk:high · idempotent · reversible`

Reads the closed period's trial balance, filters to BAS class 1-2 accounts with non-zero closing balance, and posts an opening verifikation (status=posted) onto the next_period_id. Sync. The path id is the CLOSED period; body.next_period_id is the target.

**Use when:** After /year-end + /close on a period, generate the IB into the next period so the new year starts with the correct balance sheet.
**Do not use for:** Posting opening balances on a manually-edited basis (use POST /journal-entries with source_type=manual). Re-running on the same target period (will produce duplicate IB entries).

**Pitfalls:**
- Idempotency-Key is mandatory.
- next_period_id must reference the SAME company and must NOT already have an IB entry. The engine throws if it does.
- Only class 1 (assets) and 2 (equity/liabilities) flow into the IB; class 3-8 are zeroed by the closing entry.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ next_period_id: string }
```

Example request:
```json
{
  "next_period_id": "7b3a…"
}
```

Response `200`:
```ts
{
  data: { opening_entry_id: string, voucher_series: string, voucher_number: number, next_period_id: string },
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
    "opening_entry_id": "4d2a…",
    "voucher_series": "A",
    "voucher_number": 1,
    "next_period_id": "7b3a…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/fiscal-periods/{id}/reopen-external`

**Undo klarmarkera: reopen a year marked closed in the previous system.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run · reversible`

Reopens and unlocks a räkenskapsår that close-external closed, and writes the decision to the audit log. Only while that close is still the klarmarkera one: a year closed by a year-end run in Accounted is never reopened. Typical need: the prior-year SIE file was wrong and must be replaced. Idempotent. Dry-runnable.

**Use when:** A year was marked closed in the previous system by mistake, or its imported contents must be replaced.
**Do not use for:** Reopening a year closed by a year-end here (not possible), or unlocking a locked year (POST /fiscal-periods/{id}/unlock).

**Pitfalls:**
- An open year answers 409 PERIOD_REOPEN_NOT_CLOSED.
- A year closed by a year-end run here answers 409 PERIOD_REOPEN_NOT_EXTERNAL.
- The lock is cleared too: lock or klarmarkera the year again once the correction is done.

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
    name: string,
    period_start: string,
    period_end: string,
    is_closed: boolean,
    closed_at: string | null,
    closed_externally: boolean,
    locked_at: string | null,
    previous_period_id: string | null,
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
    "id": "a8f1…",
    "name": "Räkenskapsår 2024",
    "period_start": "2024-01-01",
    "period_end": "2024-12-31",
    "is_closed": false,
    "closed_at": null,
    "closed_externally": false,
    "locked_at": null,
    "previous_period_id": "5c2e…",
    "created_at": "2026-12-01T09:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/fiscal-periods/{id}/unlock`

**Unlock a locked (not closed) fiscal year.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run · reversible`

Clears locked_at so the year accepts postings again, and writes the unlock to the audit log (BFNAR 2013:2 behandlingshistorik). A closed year is never unlocked: past a close, corrections go into an open year as storno. Re-lock with POST /fiscal-periods/{id}/lock after the correction. Idempotent. Dry-runnable.

**Use when:** The user asked to correct something in a locked year, or a year-end must run on a year that was locked beforehand.
**Do not use for:** Getting a booking past a lock without the user asking for that correction, or reopening a closed year (a year marked closed in a previous system: POST /fiscal-periods/{id}/reopen-external).

**Pitfalls:**
- A closed year answers 409 PERIOD_UNLOCK_CLOSED; an unlocked one 409 PERIOD_UNLOCK_NOT_LOCKED.
- The company-wide lock date (bookkeeping_locked_through) is a separate lock this does not touch.

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
    name: string,
    period_start: string,
    period_end: string,
    is_closed: boolean,
    closed_at: string | null,
    closed_externally: boolean,
    locked_at: string | null,
    previous_period_id: string | null,
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
    "id": "a8f1…",
    "name": "Räkenskapsår 2027",
    "period_start": "2027-01-01",
    "period_end": "2027-12-31",
    "is_closed": false,
    "closed_at": null,
    "closed_externally": false,
    "locked_at": null,
    "previous_period_id": "5c2e…",
    "created_at": "2026-12-01T09:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/fiscal-periods/{id}/year-end`

**Execute year-end closing (currency revaluation + closing entry).**
`scope:bookkeeping:write · risk:high · idempotent`

Async-operation endpoint. Runs the year-end closing flow: currency revaluation (FX gains/losses to 3960/7960), then posts the closing entry that zeroes class 3-8 onto årets resultat (2099 for AB, the relevant eget-kapital account in the 2010-2019 range for enskild firma: the engine resolves which based on company.entity_type). Returns 202 with operation_id; subscribe to operation.completed or poll /v1/operations/{id}.

**Use when:** After /lock and a passing /compliance/check?type=year_end_readiness, you want to run the closing entry. This is step 2 of the lock → year-end → close flow.
**Do not use for:** Re-running year-end (per-period idempotent: fails if closing_entry_id is already set). Closing the period (use /close after year-end succeeds).

**Pitfalls:**
- Idempotency-Key is mandatory.
- Period must pass year_end_readiness checks (no drafts, no unexplained voucher gaps, trial balance balanced). The engine re-validates and aborts if not.
- Closing entry is itself a verifikation (posted): the period must NOT already be closed.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    operation_id: string,
    type: "fiscal_periods.year_end",
    status: "queued" | "running" | "succeeded" | "failed",
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
    "operation_id": "0e9c…",
    "type": "fiscal_periods.year_end",
    "status": "succeeded",
    "poll_url": "/api/v1/operations/0e9c…",
    "webhook_event": "operation.completed"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/skatteverket/vat-declarations`

**Read a filed momsdeklaration (submitted and/or decided) from Skatteverket.**
`scope:compliance:read · risk:low · idempotent`

Fetches the momsdeklaration for one period as Skatteverket has it on file: `submitted` is the declaration as filed (SKV /inlamnat), `decided` is Skatteverket's beslut (SKV /beslutat). Either section is null when nothing is on file for the period (or when excluded via ?state=). Query params: period_type (monthly|quarterly|yearly), year, period (1-12 monthly, 1-4 quarterly, 1 yearly), optional state (submitted|decided|both, default both). Requires the company to have an active Skatteverket connection (any member's BankID connection, or a verified ombud grant). Live read against Skatteverket, not a cached copy.

**Use when:** You want to verify what was actually filed for a VAT period, compare a period against last year's filed declaration, or check whether Skatteverket has decided a period.
**Do not use for:** Computing the declaration from the books (use the VAT report), or filing: submission is a separate BankID-signed flow.

**Pitfalls:**
- This is a live Skatteverket read: it fails with SKATTEVERKET_NOT_CONNECTED (401) when the company has neither a member's BankID connection (made under Installningar) nor a verified ombud grant, and the response reflects SKV's state, not the books. Personal BankID sessions expire after ~1 hour by design, so an expired connection is normal: ask the user to reconnect; only a person can, so do not retry until they confirm.
- submitted=null and decided=null with HTTP 200 means "nothing on file for the period": it is not an error.
- A submitted declaration can lack a beslut for days: poll decided separately rather than assuming both appear together.
- redovisningsperiod is SKV's YYYYMM format (the period's LAST month): quarterly period 1 is 03, not 01.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_type` | query | `"monthly" \| "quarterly" \| "yearly"` | yes |  |
| `year` | query | `number` | yes |  |
| `period` | query | `number` | yes |  |
| `state` | query | `"submitted" \| "decided" \| "both"` | no |  |

Response `200`:
```ts
{
  data: { redovisare: string, redovisningsperiod: string, submitted?: unknown, decided?: unknown },
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
    "redovisare": "165560000167",
    "redovisningsperiod": "202603",
    "submitted": {
      "mervardesskattTillfalle": "2026-04-10"
    },
    "decided": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
