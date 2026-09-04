<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Employees endpoints

The employee register plus absence (frånvaro), vacation balances and year close, and payroll cutover opening balances. Running payroll itself: salary-runs.md.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/employees`

**List employees for a company.**
`scope:payroll:read · risk:low · idempotent`

Returns active employees in created-first order. Pass ?include_inactive=true to include soft-deleted (is_active=false) rows. Use ?search to match against first or last name. Personnummer is masked (birthdate visible, last-4 hidden); use GET /employees/{id} for the full value.

**Use when:** You need a roster: for building a UI picker, resolving employee_id before adding to a salary run, or syncing an external HR system.
**Do not use for:** Fetching a single employee you already know the id of: use GET /api/v1/companies/{companyId}/employees/{id}. Salary calculations live on /salary-runs/{id}.

**Pitfalls:**
- Inactive employees are hidden by default; soft-delete via DELETE sets is_active=false (BFL 7 kap retention).
- personnummer is masked in the list response (GDPR Art.5(1)(c) data minimisation). The detail endpoint returns the full value.
- salary_type drives which field is meaningful: monthly_salary for monthly, hourly_rate for hourly. The other is null.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, first_name: string, last_name: string, personnummer_masked: string, employment_type: "employee" | "company_owner" | "board_member", employment_start: string, employment_end: string, salary_type: "monthly" | "hourly", monthly_salary: number, hourly_rate: number, f_skatt_status: "a_skatt" | "f_skatt" | "fa_skatt" | "not_verified", is_active: boolean, created_at: string }[],
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
      "first_name": "Anna",
      "last_name": "Andersson",
      "personnummer_masked": "YYYYMMDDXXXX",
      "employment_type": "employee",
      "employment_start": "2024-01-15",
      "employment_end": null,
      "salary_type": "monthly",
      "monthly_salary": 35000,
      "hourly_rate": null,
      "f_skatt_status": "a_skatt",
      "is_active": true,
      "created_at": "2024-01-15T08:00:00Z"
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

### `POST /api/v1/companies/{companyId}/employees`

**Create an employee.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Creates a new employee for the company. Requires Idempotency-Key (UUID). Supports ?dry_run=true for input validation without committing. The personnummer in the request body must be 12 digits (ÅÅÅÅMMDDNNNN); the response echoes a masked form (birthdate + XXXX): GDPR Art.5(1)(c).

**Use when:** You need to register a new employee before adding them to a salary run. Use dry-run first to catch validation errors (missing tax table, salary amount, F-skatt mismatch) before committing.
**Do not use for:** Updating an existing employee (PATCH instead). Soft-deactivating (DELETE: sets is_active=false). Hard-deleting (the API does not expose hard delete; BFL 7 kap retention).

**Pitfalls:**
- Idempotency-Key is mandatory: calls without it return 400 VALIDATION_ERROR.
- personnummer must be exactly 12 digits with the YYYYMMDD prefix (not the short 10-digit form).
- Duplicate personnummer within a company returns 409 EMPLOYEE_DUPLICATE_PERSONNUMMER. Personnummer is unique per (company_id, personnummer).
- For A-skatt employees who are not sidoinkomst, tax_table_number is required (29-42).
- salary_type drives which salary field is required: monthly_salary for monthly, hourly_rate for hourly.
- The response masks personnummer; never echo back the supplied value. Detail endpoint (deliberate drill-in) returns the full value.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  first_name: string,
  last_name: string,
  personnummer: string,
  employment_type?: "employee" | "company_owner" | "board_member",
  employment_start: string,
  employment_end?: string,
  employment_degree?: number,
  hours_per_week?: number,
  workdays_per_week?: number,
  salary_type?: "monthly" | "hourly",
  monthly_salary?: number,
  hourly_rate?: number,
  tax_table_number?: number,
  tax_column?: number,
  tax_municipality?: string,
  is_sidoinkomst?: boolean,
  f_skatt_status?: "a_skatt" | "f_skatt" | "fa_skatt" | "not_verified",
  clearing_number?: string,
  bank_account_number?: string,
  vacation_rule?: "procentregeln" | "sammaloneregeln" | "none" | "semesterersattning",
  vacation_days_per_year?: number,
  semestertillagg_rate?: number,
  email?: string,
  phone?: string,
  address_line1?: string,
  postal_code?: string,
  city?: string,
  vaxa_stod_eligible?: boolean,
  vaxa_stod_start?: string,
  vaxa_stod_end?: string,
  jamkning_percentage?: number,
  jamkning_valid_from?: string,
  jamkning_valid_to?: string,
  default_dimensions?: Record<string, string>
}
```

Example request:
```json
{
  "first_name": "Anna",
  "last_name": "Andersson",
  "personnummer": "YYYYMMDDNNNN",
  "employment_type": "employee",
  "employment_start": "2024-01-15",
  "salary_type": "monthly",
  "monthly_salary": 35000,
  "tax_table_number": 33,
  "tax_column": 1,
  "tax_municipality": "Stockholm"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    first_name: string,
    last_name: string,
    personnummer_masked: string,
    employment_type: "employee" | "company_owner" | "board_member",
    employment_start: string,
    employment_end: string,
    employment_degree: number,
    salary_type: "monthly" | "hourly",
    monthly_salary: number,
    hourly_rate: number,
    tax_table_number: number,
    tax_column: number,
    tax_municipality: string,
    is_sidoinkomst: boolean,
    f_skatt_status: "a_skatt" | "f_skatt" | "fa_skatt" | "not_verified",
    vacation_rule: string,
    vacation_days_per_year: number,
    is_active: boolean,
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
    "id": "a8f1…",
    "first_name": "Anna",
    "last_name": "Andersson",
    "personnummer_masked": "YYYYMMDDXXXX",
    "employment_type": "employee",
    "employment_start": "2024-01-15",
    "employment_end": null,
    "employment_degree": 100,
    "salary_type": "monthly",
    "monthly_salary": 35000,
    "hourly_rate": null,
    "tax_table_number": 33,
    "tax_column": 1,
    "tax_municipality": "Stockholm",
    "is_sidoinkomst": false,
    "f_skatt_status": "a_skatt",
    "vacation_rule": "procentregeln",
    "vacation_days_per_year": 25,
    "is_active": true,
    "created_at": "2024-01-15T08:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/employees/{id}`

**Get a single employee.**
`scope:payroll:read · risk:low · idempotent`

Returns the full employee record including the 12-digit personnummer, bank details, tax configuration, and contact info. This is the deliberate drill-in for an id you already know: list calls mask personnummer.

**Use when:** You have an employee id and need every field (tax table, bank account, vacation rule): typically to render an edit form or to construct a payroll calculation input.
**Do not use for:** Rosters or pickers (use the list endpoint: personnummer is masked there).

**Pitfalls:**
- The response includes the full personnummer. Treat it as a national identifier (GDPR Art.5(1)(c)): do not propagate it to logs or external systems beyond what your integration strictly requires.
- Inactive (soft-deleted) employees are returned by the detail endpoint; check `is_active` if your flow should skip them.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    first_name: string,
    last_name: string,
    personnummer: string,
    employment_type: "employee" | "company_owner" | "board_member",
    employment_start: string,
    employment_end: string,
    employment_degree: number,
    hours_per_week: number,
    workdays_per_week: number,
    salary_type: "monthly" | "hourly",
    monthly_salary: number,
    hourly_rate: number,
    tax_table_number: number,
    tax_column: number,
    tax_municipality: string,
    is_sidoinkomst: boolean,
    f_skatt_status: "a_skatt" | "f_skatt" | "fa_skatt" | "not_verified",
    clearing_number: string,
    bank_account_number: string,
    vacation_rule: string,
    vacation_days_per_year: number,
    semestertillagg_rate: number,
    email: string,
    phone: string,
    address_line1: string,
    postal_code: string,
    city: string,
    vaxa_stod_eligible: boolean,
    vaxa_stod_start: string,
    vaxa_stod_end: string,
    jamkning_percentage: number,
    jamkning_valid_from: string,
    jamkning_valid_to: string,
    default_dimensions: Record<string, string>,
    is_active: boolean,
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
    "first_name": "Anna",
    "last_name": "Andersson",
    "personnummer": "YYYYMMDDNNNN",
    "employment_type": "employee",
    "employment_start": "2024-01-15",
    "employment_end": null,
    "salary_type": "monthly",
    "monthly_salary": 35000,
    "f_skatt_status": "a_skatt",
    "is_active": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/employees/{id}`

**Update an employee.**
`scope:payroll:write · risk:low · idempotent · dry-run`

Partial update of an employee. Only the fields supplied in the body are changed. Supports ?dry_run=true to validate the merged record without committing. Personnummer changes are NOT permitted via this endpoint: the natural-person identity is immutable post-creation.

**Use when:** You need to change tax configuration, bank details, salary amount, or contact info on an existing employee.
**Do not use for:** Changing personnummer (not supported: create a new employee if the natural-person identity changes, which is a rare edge case). Soft-deleting (use DELETE).

**Pitfalls:**
- personnummer in the body is ignored by this endpoint. To change it you must DELETE and recreate.
- salary_type changes require the matching salary field in the same request: switching to monthly without monthly_salary returns 400.
- tax_table_number changes only take effect on future salary runs; runs already in `review` or beyond use a frozen snapshot.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  first_name?: string,
  last_name?: string,
  personnummer?: string,
  employment_type?: "employee" | "company_owner" | "board_member",
  employment_start?: string,
  employment_end?: string,
  employment_degree?: number,
  hours_per_week?: number,
  workdays_per_week?: number,
  salary_type?: "monthly" | "hourly",
  monthly_salary?: number,
  hourly_rate?: number,
  tax_table_number?: number,
  tax_column?: number,
  tax_municipality?: string,
  is_sidoinkomst?: boolean,
  f_skatt_status?: "a_skatt" | "f_skatt" | "fa_skatt" | "not_verified",
  clearing_number?: string,
  bank_account_number?: string,
  vacation_rule?: "procentregeln" | "sammaloneregeln" | "none" | "semesterersattning",
  vacation_days_per_year?: number,
  semestertillagg_rate?: number,
  email?: string,
  phone?: string,
  address_line1?: string,
  postal_code?: string,
  city?: string,
  vaxa_stod_eligible?: boolean,
  vaxa_stod_start?: string,
  vaxa_stod_end?: string,
  jamkning_percentage?: number,
  jamkning_valid_from?: string,
  jamkning_valid_to?: string,
  default_dimensions?: Record<string, string>
}
```

Example request:
```json
{
  "monthly_salary": 38000,
  "tax_municipality": "Göteborg"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    first_name: string,
    last_name: string,
    employment_type: "employee" | "company_owner" | "board_member",
    employment_start: string,
    employment_end: string,
    employment_degree: number,
    hours_per_week: number,
    workdays_per_week: number,
    salary_type: "monthly" | "hourly",
    monthly_salary: number,
    hourly_rate: number,
    tax_table_number: number,
    tax_column: number,
    tax_municipality: string,
    is_sidoinkomst: boolean,
    f_skatt_status: "a_skatt" | "f_skatt" | "fa_skatt" | "not_verified",
    clearing_number: string,
    bank_account_number: string,
    vacation_rule: string,
    vacation_days_per_year: number,
    semestertillagg_rate: number,
    email: string,
    phone: string,
    address_line1: string,
    postal_code: string,
    city: string,
    vaxa_stod_eligible: boolean,
    vaxa_stod_start: string,
    vaxa_stod_end: string,
    jamkning_percentage: number,
    jamkning_valid_from: string,
    jamkning_valid_to: string,
    default_dimensions: Record<string, string>,
    is_active: boolean,
    created_at: string,
    updated_at: string,
    personnummer_masked: string
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
    "monthly_salary": 38000
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/employees/{id}`

**Soft-delete an employee.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Sets `is_active=false`. The row is preserved because past salary runs reference it via salary_run_employees and those verifikationer are räkenskapsinformation under BFL 7 kap (BFL retention attaches to the verifikationer themselves, not strictly to the personnummer attribute on the master row). Hard delete is never exposed.

**Use when:** An employee has left the company and should no longer appear in active rosters or default to new salary runs.
**Do not use for:** Reactivating later (PATCH `is_active=true` instead). Hard-deleting (not supported: retention).

**Pitfalls:**
- Idempotent: deleting an already-inactive employee returns 204 No Content (the same as the first call).
- The row is NOT removed from the database: re-creating with the same personnummer returns 409 EMPLOYEE_DUPLICATE_PERSONNUMMER even after soft-delete.
- Past salary runs still reference this employee; their data continues to surface in GET /salary-runs/{id} and SIE exports.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `204`.

---

### `GET /api/v1/companies/{companyId}/employees/{id}/absence`

**List absence days for an employee in a date range.**
`scope:payroll:read · risk:low · idempotent`

Returns per-day absence rows (sick, vab, parental, ...) between ?from and ?to (inclusive, max 92 days). No cursor pagination: the bounded range is the page. Optional ?type filter.

**Use when:** You need an employee's registered absence: to reconcile with an external time-tracking system, to verify what the salary engine will derive, or to display a calendar.
**Do not use for:** The derived pay impact (karensavdrag, sjuklön lines): that lives on the payslip detail after :calculate. Worked hours for hourly staff: separate register, not on v1 yet.

**Pitfalls:**
- Ranges over 92 days return 400 ABSENCE_RANGE_TOO_LARGE: iterate quarters instead.
- A day can carry multiple rows with different absence_type values (e.g. half-day sick + half-day vab).
- Rows may reference the salary run that consumed them via salary_run_employee_id.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { salary_absence_day_id: string, absence_date: string, absence_type: "sick" | "vab" | "parental" | "pregnancy" | "care_relative" | "study" | "unpaid_leave" | "other_leave", hours: number, notes: string, salary_run_employee_id: string, created_at: string, updated_at: string }[],
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
      "salary_absence_day_id": "abs_91d2…",
      "absence_date": "2026-03-03",
      "absence_type": "sick",
      "hours": 8,
      "notes": null
    }
  ],
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PUT /api/v1/companies/{companyId}/employees/{id}/absence`

**Register absence for an employee over a date range.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Expands [from, to] (max 92 days) to per-day rows and upserts them on the natural key (employee, date, type). Weekends are skipped unless include_weekends=true. Single day = from == to. Idempotent by construction: replaying the same PUT converges on the same rows.

**Use when:** "Anna was sick 3-7 March": one call registers the whole event. Also for pre-cutover history backfill when migrating from another payroll system (any past date is legal; imported sick days feed the karensavdrag lookback).
**Do not use for:** Vacation day REQUESTS/approval workflows (out of scope). Editing hours on one existing day inside a range: PUT the single day (from == to) with the new hours.

**Pitfalls:**
- Weekends are skipped by default: pass include_weekends=true for schedules that span them.
- Upsert REPLACES the (date, type) rows in the range: hours/notes are overwritten, not merged.
- A day whose combined absence + worked hours exceed 24h returns 409 ABSENCE_HOURS_CONFLICT and the whole range is rejected (atomic).
- Registering absence does not recompute an open salary run: call POST /salary-runs/{id}/calculate afterwards.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  from: string,
  to: string,
  absence_type: "sick" | "vab" | "parental" | "pregnancy" | "care_relative" | "study" | "unpaid_leave" | "other_leave",
  hours_per_day?: number,
  notes?: string,
  include_weekends?: boolean
}
```

Example request:
```json
{
  "from": "2026-03-03",
  "to": "2026-03-07",
  "absence_type": "sick"
}
```

Response `200`:
```ts
{
  data: {
    count: number,
    days: { salary_absence_day_id?: string, absence_date: string, absence_type: "sick" | "vab" | "parental" | "pregnancy" | "care_relative" | "study" | "unpaid_leave" | "other_leave", hours: number, notes?: string, salary_run_employee_id?: string, created_at?: string, updated_at?: string }[]
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
    "count": 5,
    "days": [
      {
        "absence_date": "2026-03-03",
        "absence_type": "sick",
        "hours": 8
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

### `DELETE /api/v1/companies/{companyId}/employees/{id}/absence`

**Delete absence days for an employee in a date range.**
`scope:payroll:write · risk:low · idempotent · dry-run`

Deletes per-day absence rows between ?from and ?to (inclusive), optionally filtered by ?type. Returns deleted_count (200, not 204) so callers can verify how many rows went.

**Use when:** An absence event was registered by mistake or ended early: "Anna came back Thursday, delete Thu-Fri sick days".
**Do not use for:** Correcting hours on a day: PUT the day again instead. Rows already consumed by a BOOKED run: deleting them does not un-book the run; use the run correction flow.

**Pitfalls:**
- Without ?type, ALL absence types in the range are deleted.
- deleted_count: 0 with a 200 means nothing matched: not an error.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { deleted_count: number },
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
    "deleted_count": 2
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/employees/{id}/opening-balances`

**Get an employee's payroll cutover opening balances.**
`scope:payroll:read · risk:low · idempotent`

Returns the opening balances set for a mid-year migration (YTD gross/tax/net, vacation balances, opening semesterlöneskuld, karens adjustment) plus the lock state: locked=true once the employee has a booked salary run.

**Use when:** Verifying cutover state before the first calculated run, or checking whether balances can still be edited (locked=false).
**Do not use for:** The live vacation liability (GET /reports/vacation-liability includes the opening terms). Pre-cutover absence history: GET /employees/{id}/absence.

**Pitfalls:**
- 404 NOT_FOUND when no opening balances have been set: distinct from an all-zeros row.
- locked_by_run_id names the booked run that froze the row; correcting that run unlocks it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    employee_opening_balances_id: string,
    employee_id: string,
    cutover_date: string,
    ytd_gross: number,
    ytd_tax: number,
    ytd_net: number,
    vacation_paid_days_remaining: number,
    vacation_days_taken_this_year: number,
    vacation_saved_days_by_year: Record<string, number>,
    opening_semester_liability: number,
    opening_semester_liability_avgifter: number,
    karens_periods_adjustment: number,
    locked: boolean,
    locked_by_run_id: string
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
    "employee_id": "emp_77b2…",
    "cutover_date": "2026-07-01",
    "ytd_gross": 210000,
    "vacation_paid_days_remaining": 12.5,
    "locked": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PUT /api/v1/companies/{companyId}/employees/{id}/opening-balances`

**Set an employee's payroll cutover opening balances.**
`scope:payroll:write · risk:medium · idempotent · dry-run · reversible`

Full-replace upsert of the cutover state: YTD gross/tax/net for the cutover year, paid vacation days remaining, paid days already taken this vacation year, sparade dagar keyed by origin year (5-year rule), opening semesterlöneskuld SEK (+avgifter), and karens periods not covered by imported absence rows. cutover_date must be the first of a month in the current or previous year, on/after employment_start.

**Use when:** Onboarding one employee during a mid-year migration from Fortnox/Visma/etc. For whole-company onboarding, prefer the bulk PUT /employees/opening-balances.
**Do not use for:** SIE opening balances on the LEDGER (2920/2940 arrive via the SIE import). Ongoing sick cases: import pre-cutover days via PUT /employees/{id}/absence instead.

**Pitfalls:**
- Full replace: omitted numeric fields reset to 0 (their defaults). Send the complete state every time.
- 409 OPENING_BALANCES_LOCKED once the employee has a booked run; correcting that run unlocks.
- The opening liability is NOT booked by Accounted: it only feeds the vacation-liability report.
- YTD affects payslip display and reports only; per-month tax and avgifter caps never read it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  cutover_date: string,
  ytd_gross?: number,
  ytd_tax?: number,
  ytd_net?: number,
  vacation_paid_days_remaining?: number,
  vacation_days_taken_this_year?: number,
  vacation_saved_days_by_year?: Record<string, number>,
  opening_semester_liability?: number,
  opening_semester_liability_avgifter?: number,
  karens_periods_adjustment?: number
}
```

Example request:
```json
{
  "cutover_date": "2026-07-01",
  "ytd_gross": 210000,
  "ytd_tax": 48000,
  "ytd_net": 162000,
  "vacation_paid_days_remaining": 12.5,
  "vacation_saved_days_by_year": {
    "2025": 5
  },
  "opening_semester_liability": 42000,
  "opening_semester_liability_avgifter": 13196.4,
  "karens_periods_adjustment": 1
}
```

Response `200`:
```ts
{
  data: {
    employee_opening_balances_id: string,
    employee_id: string,
    cutover_date: string,
    ytd_gross: number,
    ytd_tax: number,
    ytd_net: number,
    vacation_paid_days_remaining: number,
    vacation_days_taken_this_year: number,
    vacation_saved_days_by_year: Record<string, number>,
    opening_semester_liability: number,
    opening_semester_liability_avgifter: number,
    karens_periods_adjustment: number,
    locked: boolean,
    locked_by_run_id: string
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
    "employee_id": "emp_77b2…",
    "cutover_date": "2026-07-01",
    "locked": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/employees/{id}/vacation-balance`

**Get an employee's current vacation balance.**
`scope:payroll:read · risk:low · idempotent`

Returns the open vacation-ledger row (recomputed on every booking): entitled/taken/remaining days, sparade dagar keyed by origin year (Semesterlagen 5-year rule), forced-payout days from expired savings, and a computed SEK estimate of the individual semesterlöneskuld.

**Use when:** Answering "how many vacation days does Anna have left", pre-payroll review, or preparing the year-close.
**Do not use for:** The company-wide liability report: GET /reports/vacation-liability. Closing the year: POST /salary/vacation-year-close.

**Pitfalls:**
- 404 VACATION_BALANCE_NOT_FOUND until the first booking (or year-close) touches the employee: the ledger seeds lazily.
- remaining_days can go negative if more days were taken than entitled: surface it, do not clamp.
- The SEK estimate uses the year-close day valuation (simplified BFNAR 2016:10); the booked 2920 is reconciled only at year-close.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    employee_vacation_balance_id: string,
    employee_id: string,
    vacation_year_start: string,
    entitled_days: number,
    accrued_days: number,
    taken_days: number,
    remaining_days: number,
    saved_days: Record<string, number>,
    saved_days_total: number,
    forced_payout_days: number,
    estimated_liability_sek: number
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
    "employee_id": "emp_77b2…",
    "vacation_year_start": "2026-01-01",
    "entitled_days": 25,
    "taken_days": 10,
    "remaining_days": 15,
    "saved_days": {
      "2025": 5
    },
    "saved_days_total": 5,
    "estimated_liability_sek": 31151.4
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PUT /api/v1/companies/{companyId}/employees/opening-balances`

**Bulk-set payroll cutover opening balances (atomic).**
`scope:payroll:write · risk:medium · idempotent · dry-run · reversible`

Upserts opening balances for up to 200 employees in one call. Validation is all-or-nothing: any invalid item (unknown/inactive employee, cutover before employment_start, locked by a booked run) fails the WHOLE request with a per-item error list and zero writes.

**Use when:** Onboarding a whole company mid-year from another payroll system: one call per migration file instead of N sequential PUTs.
**Do not use for:** Single-employee corrections after go-live: PUT /employees/{id}/opening-balances. Ledger opening balances (SIE import).

**Pitfalls:**
- Atomic: one bad item fails everything. The error details carry item_errors[{index, employee_id, code, message}]: fix and resubmit the full set.
- Full replace per employee: resubmitting with fewer fields resets the omitted ones to 0.
- Duplicate employee_id within items is rejected outright.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  items: { employee_id: string, cutover_date: string, ytd_gross?: number, ytd_tax?: number, ytd_net?: number, vacation_paid_days_remaining?: number, vacation_days_taken_this_year?: number, vacation_saved_days_by_year?: Record<string, number>, opening_semester_liability?: number, opening_semester_liability_avgifter?: number, karens_periods_adjustment?: number }[]
}
```

Example request:
```json
{
  "items": [
    {
      "employee_id": "emp_77b2…",
      "cutover_date": "2026-07-01",
      "ytd_gross": 210000,
      "ytd_tax": 48000,
      "ytd_net": 162000
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    count: number,
    rows: { employee_opening_balances_id: string, employee_id: string, cutover_date: string, locked: boolean }[]
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
    "count": 1,
    "rows": [
      {
        "employee_id": "emp_77b2…",
        "cutover_date": "2026-07-01",
        "locked": false
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

### `POST /api/v1/companies/{companyId}/salary/vacation-year-close`

**Close a vacation year (semesterberedning + arsavslut).**
`scope:payroll:write · risk:high · idempotent · dry-run`

Rolls every active employee's vacation balances into the next year (only days above the 20-day must-take floor are saved; saved days older than 5 years become forced payouts) and reconciles the day-valued semesterlöneskuld against the booked 2920/2940, posting one adjustment verifikation when drift exceeds 1 kr. The frozen report is stored with the closure (BFL 7 kap).

**Use when:** Once per year after the vacation year ends (Jan for calendar basis, Apr for statutory). ALWAYS dry-run first and review the report: the close is not reversible via API.
**Do not use for:** Mid-year balance corrections (fix the source: absence days, opening balances, or run corrections). Paying out expired days (create a semesterersattning line in the next salary run: the close only flags them).

**Pitfalls:**
- dry_run=true returns the full review report with zero writes: treat it as mandatory before the live call.
- 409 VACATION_YEAR_ALREADY_CLOSED on replay: the closure row is the idempotency anchor.
- 423-style PERIOD_LOCKED when the adjustment date falls in a locked period: unlock or close without adjustment (book_adjustment=false) and post manually.
- Untaken days at or below the 20-day floor are flagged in the report, NOT auto-saved (Semesterlagen 18 §).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{ vacation_year_start?: string, book_adjustment?: boolean }
```

Example request:
```json
{
  "book_adjustment": true
}
```

Response `200`:
```ts
{
  data: { vacation_year_closure_id: string, adjustment_entry_id: string, report?: unknown },
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
    "vacation_year_closure_id": "vyc_a1b2…",
    "adjustment_entry_id": "je_c3d4…",
    "report": {
      "vacation_year_start": "2025-01-01",
      "rows": [],
      "sek": {
        "drift_2920": 8690.84
      }
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
