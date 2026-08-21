<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Periods and registers endpoints

Fiscal periods and their lock/close/year-end lifecycle (async operations), the BAS chart of accounts, cost-center/project dimensions, the compliance pre-flight check, and reading filed VAT declarations (and beslut) from Skatteverket.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/accounts`

**List chart-of-accounts entries (BAS chart).**
`scope:reports:read · risk:low · idempotent`

Returns every account in the company's chart of accounts, ordered by sort_order (the BAS canonical sequence). Filter by ?class=<1..8> (BAS account class: 1=assets, 2=equity/liabilities, 3=revenue, 4=cost of goods sold, 5=övriga externa kostnader (rents, supplies, services), 6=övriga externa kostnader (marketing, professional services, IT), 7=labour, 8=financial). Note: BAS 5xxx and 6xxx are both övriga externa kostnader but cover distinct subgroups; see the BAS chart for the canonical mapping. Pass ?active=false to include archived accounts.

**Use when:** You need account numbers and names to render verifikation tables, build a custom report, or look up the canonical BAS label for an account.
**Do not use for:** Fetching balances: use the trial-balance report. Creating new accounts: this endpoint is read-only in v1 (use the dashboard).

**Pitfalls:**
- account_number is a STRING: "1930", not 1930. The leading character can be 0 in non-BAS plans.
- is_system_account=true means the account was seeded by Accounted and cannot be archived or renamed.
- Default filter excludes archived accounts; pass ?active=false to include them.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    accounts: { account_number: string, account_name: string, account_class: number, account_group: string, account_type: string, normal_balance: string, is_system_account: boolean, is_active: boolean, description: string, default_vat_code: string, default_vat_rate: number, default_vat_treatment: string, sru_code: string, sort_order: number }[]
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
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
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
    dimensions: { id: string, sie_dim_no: number, name: string, resets_annually: boolean, is_system: boolean, is_active: boolean, sort_order: number, values: { id: string, code: string, name: string, is_active: boolean, start_date: string, end_date: string }[] }[]
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

Request body:
```ts
{ code: string, name: string, is_active?: boolean, start_date?: string, end_date?: string }
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
    start_date: string,
    end_date: string,
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

Request body:
```ts
{ name?: string, is_active?: boolean, start_date?: string, end_date?: string }
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
    start_date: string,
    end_date: string
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
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```

---

### `GET /api/v1/companies/{companyId}/fiscal-periods`

**List fiscal periods (räkenskapsår).**
`scope:reports:read · risk:low · idempotent`

Returns every fiscal period for the company ordered by period_start DESC. is_closed=true means bokslut has been signed; locked_at non-null means writes are blocked at the DB-trigger level.

**Use when:** You need to find the active period before booking, build a year-selector UI, or audit the period-lock history.
**Do not use for:** Creating, locking, or closing periods: those land in Phase 4 (`POST /fiscal-periods/{id}/lock`, `:close`, `:year-end`). Use the dashboard or wait for Phase 4.

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
    fiscal_periods: { id: string, name: string, period_start: string, period_end: string, is_closed: boolean, closed_at: string, locked_at: string, previous_period_id: string, created_at: string, duration_days: number, exceeds_18_months: boolean }[]
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
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
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
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
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
- Locking is reversible until /close. The unlock endpoint is not in v1; use the dashboard.

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
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
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

Response `200`:
```ts
{
  data: { opening_entry_id: string, voucher_series: string, voucher_number: number, next_period_id: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
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
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
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
- This is a live Skatteverket read: it fails with SKATTEVERKET_NOT_CONNECTED (401) until someone in the company has connected with BankID under Installningar, and the response reflects SKV's state, not the books.
- submitted=null and decided=null with HTTP 200 means "nothing on file for the period": it is not an error.
- A submitted declaration can lack a beslut for days: poll decided separately rather than assuming both appear together.
- redovisningsperiod is SKV's YYYYMM format (the period's LAST month): quarterly period 1 is 03, not 01.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { redovisare: string, redovisningsperiod: string, submitted?: unknown, decided?: unknown },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[]
  }
}
```
