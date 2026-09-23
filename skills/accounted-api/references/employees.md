<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Employees endpoints

The employee register plus absence (frånvaro), worked days (tidrapport for hourly staff and OB), benefits (förmåner), recurring lines (standing monthly rows), vacation balances and year close, payroll cutover opening balances, and the company salary settings (pay day, avvikelseperiod, payment file format). Running payroll itself: salary-runs.md.

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
| `employment_type` | query | `"employee" \| "company_owner" \| "board_member"` | no | Only employees with this employment type. |
| `search` | query | `string` | no | Case-insensitive match anywhere in the first or last name, 1-200 characters. |
| `include_inactive` | query | `"true" \| "false"` | no | true also returns inactive employees. Default: active only. |
| `cursor` | query | `string` | no | Opaque cursor from the previous page's meta.next_cursor. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). Larger values are clamped to 100. |

Response `200`:
```ts
{
  data: { id: string, first_name: string, last_name: string, personnummer_masked: string, employment_type: "employee" | "company_owner" | "board_member", employment_start: string, employment_end: string | null, salary_type: "monthly" | "hourly", monthly_salary: number | null, hourly_rate: number | null, f_skatt_status: "a_skatt" | "f_skatt" | "fa_skatt" | "not_verified", is_active: boolean, created_at: string }[],
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
  vacation_pay_rate?: number | null,
  email?: string,
  phone?: string,
  address_line1?: string,
  postal_code?: string,
  city?: string,
  vaxa_stod_eligible?: boolean,
  vaxa_stod_start?: string,
  vaxa_stod_end?: string,
  jamkning_percentage?: number | null,
  jamkning_valid_from?: string | null,
  jamkning_valid_to?: string | null,
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
    employment_end: string | null,
    employment_degree: number,
    salary_type: "monthly" | "hourly",
    monthly_salary: number | null,
    hourly_rate: number | null,
    tax_table_number: number | null,
    tax_column: number | null,
    tax_municipality: string | null,
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
    employment_end: string | null,
    employment_degree: number,
    hours_per_week: number,
    workdays_per_week: number,
    salary_type: "monthly" | "hourly",
    monthly_salary: number | null,
    hourly_rate: number | null,
    tax_table_number: number | null,
    tax_column: number | null,
    tax_municipality: string | null,
    is_sidoinkomst: boolean,
    f_skatt_status: "a_skatt" | "f_skatt" | "fa_skatt" | "not_verified",
    clearing_number: string | null,
    bank_account_number: string | null,
    vacation_rule: string,
    vacation_days_per_year: number,
    semestertillagg_rate: number,
    vacation_pay_rate: number | null,
    email: string | null,
    phone: string | null,
    address_line1: string | null,
    postal_code: string | null,
    city: string | null,
    vaxa_stod_eligible: boolean,
    vaxa_stod_start: string | null,
    vaxa_stod_end: string | null,
    jamkning_percentage: number | null,
    jamkning_valid_from: string | null,
    jamkning_valid_to: string | null,
    default_dimensions: Record<string, string>,
    is_active: boolean,
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
  vacation_pay_rate?: number | null,
  email?: string,
  phone?: string,
  address_line1?: string,
  postal_code?: string,
  city?: string,
  vaxa_stod_eligible?: boolean,
  vaxa_stod_start?: string,
  vaxa_stod_end?: string,
  jamkning_percentage?: number | null,
  jamkning_valid_from?: string | null,
  jamkning_valid_to?: string | null,
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
    employment_end: string | null,
    employment_degree: number,
    hours_per_week: number,
    workdays_per_week: number,
    salary_type: "monthly" | "hourly",
    monthly_salary: number | null,
    hourly_rate: number | null,
    tax_table_number: number | null,
    tax_column: number | null,
    tax_municipality: string | null,
    is_sidoinkomst: boolean,
    f_skatt_status: "a_skatt" | "f_skatt" | "fa_skatt" | "not_verified",
    clearing_number: string | null,
    bank_account_number: string | null,
    vacation_rule: string,
    vacation_days_per_year: number,
    semestertillagg_rate: number,
    vacation_pay_rate: number | null,
    email: string | null,
    phone: string | null,
    address_line1: string | null,
    postal_code: string | null,
    city: string | null,
    vaxa_stod_eligible: boolean,
    vaxa_stod_start: string | null,
    vaxa_stod_end: string | null,
    jamkning_percentage: number | null,
    jamkning_valid_from: string | null,
    jamkning_valid_to: string | null,
    default_dimensions: Record<string, string>,
    is_active: boolean,
    created_at: string,
    updated_at: string,
    personnummer_masked: string
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
| `from` | query | `string` | yes | YYYY-MM-DD. First day of the range (inclusive). Required. |
| `to` | query | `string` | yes | YYYY-MM-DD. Last day of the range (inclusive), not before from. Required. |
| `type` | query | `"sick" \| "vab" \| "parental" \| "pregnancy" \| "care_relative" \| "study" \| "unpaid_leave" \| "other_leave"` | no | Only days of this absence type. Default: every type. |

Response `200`:
```ts
{
  data: { salary_absence_day_id: string, absence_date: string, absence_type: "sick" | "vab" | "parental" | "pregnancy" | "care_relative" | "study" | "unpaid_leave" | "other_leave", hours: number, notes: string | null, salary_run_employee_id: string | null, created_at: string, updated_at: string }[],
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
- Dates inside the avvikelseperiod (deviation window, deviation_period_start..deviation_period_end, NULL = the pay month) of a run that is already calculated (review), approved, paid or booked are locked: 409 SALARY_REGISTER_DATES_LOCKED_BY_RUN naming the run (details.salary_run_id, details.status, details.locked_dates), nothing written, dry runs included. The way out is to revert that run to draft (dashboard) or, for a booked run, POST /salary-runs/{id}/correct and register the days against the correction run. Draft runs never lock.
- Registering absence does not recompute a draft salary run: call POST /salary-runs/{id}/calculate afterwards.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
    days: { salary_absence_day_id?: string, absence_date: string, absence_type: "sick" | "vab" | "parental" | "pregnancy" | "care_relative" | "study" | "unpaid_leave" | "other_leave", hours: number, notes?: string | null, salary_run_employee_id?: string | null, created_at?: string, updated_at?: string }[]
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
**Do not use for:** Correcting hours on a day: PUT the day again instead. Rows a calculated, approved, paid or booked run has already read: the delete is refused (409 SALARY_REGISTER_DATES_LOCKED_BY_RUN); use the run correction flow.

**Pitfalls:**
- Without ?type, ALL absence types in the range are deleted.
- deleted_count: 0 with a 200 means nothing matched: not an error.
- Dates inside the avvikelseperiod (deviation window, deviation_period_start..deviation_period_end, NULL = the pay month) of a run that is already calculated (review), approved, paid or booked are locked: 409 SALARY_REGISTER_DATES_LOCKED_BY_RUN naming the run (details.salary_run_id, details.status, details.locked_dates), nothing written, dry runs included. The way out is to revert that run to draft (dashboard) or, for a booked run, POST /salary-runs/{id}/correct and register the days against the correction run. Draft runs never lock.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `from` | query | `string` | yes | YYYY-MM-DD. First day of the range (inclusive). Required. |
| `to` | query | `string` | yes | YYYY-MM-DD. Last day of the range (inclusive), not before from. Required. |
| `type` | query | `"sick" \| "vab" \| "parental" \| "pregnancy" \| "care_relative" \| "study" \| "unpaid_leave" \| "other_leave"` | no | Only days of this absence type. Default: every type. |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { deleted_count: number },
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
    "deleted_count": 2
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/employees/{id}/benefits`

**List the benefits (förmåner) registered on an employee.**
`scope:payroll:read · risk:low · idempotent`

Returns every benefit row on the employee, active and inactive, newest validity window first (valid_from descending, then created_at). Optional ?active=true|false filter. No cursor pagination: an employee carries a handful of rows.

**Use when:** You need to see which förmåner the salary engine will derive for an employee (bilförmån, kostförmån, cykelförmån, bostad, friskvård, annat), reconcile against an HR system, or find the employee_benefit_id to update or remove.
**Do not use for:** The derived payslip line and its tax effect: that lives on the salary run after :calculate. Standing deductions (bruttolöneavdrag, fackavgift): the recurring-lines register.

**Pitfalls:**
- The monthly förmånsvärde is added to the tax and arbetsgivaravgift basis when a run is calculated (POST /salary-runs/{id}/calculate); it is never paid out.
- A run picks a row up when is_active is true and valid_from <= payment_date <= valid_to (valid_to null = open-ended). Rows outside that window are listed here but derive nothing.
- annual_market_value is populated for bike benefits only (read from the stored calculation inputs); other types carry null.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `active` | query | `"true" \| "false"` | no | true returns only rows with is_active=true, false only inactive rows. Default: both. |

Response `200`:
```ts
{
  data: { employee_benefit_id: string, benefit_type: "bike" | "car" | "meals" | "housing" | "wellness" | "other", description: string, monthly_value: number, annual_market_value: number | null, valid_from: string, valid_to: string | null, is_active: boolean, metadata: Record<string, unknown>, created_at: string, updated_at: string }[],
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
      "employee_benefit_id": "ben_4f2a…",
      "benefit_type": "car",
      "description": "Bilförmån Volvo XC40",
      "monthly_value": 4275,
      "annual_market_value": null,
      "valid_from": "2026-01-01",
      "valid_to": null,
      "is_active": true,
      "metadata": {},
      "created_at": "2026-01-05T09:12:00Z",
      "updated_at": "2026-01-05T09:12:00Z"
    }
  ],
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/employees/{id}/benefits`

**Register a benefit (förmån) on an employee.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Creates a standing monthly förmånsvärde row. benefit_type is one of bike, car, meals, housing, wellness, other. Every type except bike takes monthly_value: the schablon value you already know. bike takes annual_market_value and the server derives monthly_value = max(0, annual_market_value - 3000) / 12 (Skatteverket schablon, 3 000 kr/year tax-free), storing the inputs in metadata. Mandatory Idempotency-Key. Dry-runnable: the preview is the row that would be inserted, with the derived values.

**Use when:** "Anna gets a company car from January": register the schablon value once and every run inside the window derives the line. Also when migrating an employee register from another payroll system.
**Do not use for:** Computing a bilförmån from the car (nybilspris, miljöbil, fordonsskatt): do that with Skatteverket's calculator and send the result. Standing deductions such as a bruttolöneavdrag for the same car: the recurring-lines register. One-off taxable additions: edit the payslip lines on the run.

**Pitfalls:**
- The förmånsvärde is added to the employee's tax and arbetsgivaravgift basis when the run is calculated (POST /salary-runs/{id}/calculate): skatteavdrag and avgifter go up, nothing is paid out. Registering a benefit does not recompute an open run; call :calculate afterwards.
- car (bilförmån) is supplied as the monthly schablon value you computed (Skatteverket's bilförmånsberäkning, including miljöbil and 30 000 km reductions); the API does not compute it from the car.
- bike takes annual_market_value, not monthly_value: the server derives the monthly value with the 3 000 kr/year tax-free allowance. A monthly_value sent next to annual_market_value on a bike row is ignored.
- valid_from / valid_to gate which runs pick the row up: a run derives the line when valid_from <= payment_date <= valid_to (valid_to omitted = open-ended). Both dates are inclusive; valid_to before valid_from is 400 VALIDATION_ERROR.
- To stop a benefit that already fed a calculated run, PATCH is_active=false or set valid_to; DELETE on such a row keeps and deactivates it rather than removing it. Either way the derived line stays on a draft run until POST /salary-runs/{id}/calculate is called again, which drops it (#2695).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  benefit_type: "bike" | "car" | "meals" | "housing" | "wellness" | "other",
  description: string,
  monthly_value?: number,
  annual_market_value?: number,
  valid_from: string,
  valid_to?: string,
  metadata?: Record<string, unknown>,
  is_active?: boolean
}
```

Example request:
```json
{
  "benefit_type": "bike",
  "description": "Cykelförmån",
  "annual_market_value": 15000,
  "valid_from": "2026-03-01"
}
```

Response `200`:
```ts
{
  data: {
    employee_benefit_id: string,
    benefit_type: "bike" | "car" | "meals" | "housing" | "wellness" | "other",
    description: string,
    monthly_value: number,
    annual_market_value: number | null,
    valid_from: string,
    valid_to: string | null,
    is_active: boolean,
    metadata: Record<string, unknown>,
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
    "employee_benefit_id": "ben_91d2…",
    "benefit_type": "bike",
    "description": "Cykelförmån",
    "monthly_value": 1000,
    "annual_market_value": 15000,
    "valid_from": "2026-03-01",
    "valid_to": null,
    "is_active": true,
    "metadata": {
      "annual_market_value": 15000,
      "annual_taxable": 12000,
      "tax_free_portion": 3000
    },
    "created_at": "2026-02-20T10:00:00Z",
    "updated_at": "2026-02-20T10:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/employees/{id}/benefits/{benefitId}`

**Partially update a benefit (förmån) on an employee.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Patches the supplied fields: description, monthly_value, valid_from, valid_to (null clears it), is_active, metadata, and for bike rows annual_market_value (the server re-derives monthly_value). benefit_type is not patchable: delete and recreate to change the kind. Mandatory Idempotency-Key. Dry-runnable: the preview is the merged row.

**Use when:** The förmånsvärde changes (new schablon for the year, a new bike price), the benefit ends (set valid_to), or you want to pause it without losing the row (is_active=false).
**Do not use for:** Changing the benefit kind (delete + create). Editing the derived line on one specific run: edit the payslip line on that run instead, the register stays as is.

**Pitfalls:**
- Idempotency-Key is mandatory; calls without it return 400.
- valid_from and valid_to are checked against the MERGED stored+patched pair: a valid_to-only patch that predates the stored valid_from is 400 VALIDATION_ERROR (field valid_to).
- annual_market_value is accepted on bike rows only (400 otherwise) and overrides any monthly_value in the same body.
- The förmånsvärde is added to the tax and arbetsgivaravgift basis at :calculate; a change here does not recompute an open run. Call POST /salary-runs/{id}/calculate afterwards.
- To stop a benefit that a calculated run already consumed, set is_active=false or valid_to here; DELETE on such a row also keeps and deactivates it rather than removing it. Either way the derived line stays on a draft run until POST /salary-runs/{id}/calculate is called again, which drops it (#2695).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `benefitId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  description?: string,
  monthly_value?: number,
  annual_market_value?: number,
  valid_from?: string,
  valid_to?: string | null,
  metadata?: Record<string, unknown>,
  is_active?: boolean
}
```

Example request:
```json
{
  "valid_to": "2026-06-30"
}
```

Response `200`:
```ts
{
  data: {
    employee_benefit_id: string,
    benefit_type: "bike" | "car" | "meals" | "housing" | "wellness" | "other",
    description: string,
    monthly_value: number,
    annual_market_value: number | null,
    valid_from: string,
    valid_to: string | null,
    is_active: boolean,
    metadata: Record<string, unknown>,
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
    "employee_benefit_id": "ben_4f2a…",
    "benefit_type": "car",
    "description": "Bilförmån Volvo XC40",
    "monthly_value": 4275,
    "annual_market_value": null,
    "valid_from": "2026-01-01",
    "valid_to": "2026-06-30",
    "is_active": true,
    "metadata": {},
    "created_at": "2026-01-05T09:12:00Z",
    "updated_at": "2026-06-02T14:40:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/employees/{id}/benefits/{benefitId}`

**Remove a benefit (förmån) from an employee.**
`scope:payroll:write · risk:medium · idempotent · dry-run`

Removes the benefit from the employee, the same operation the dashboard performs. A row that no payslip line derives from is hard-deleted; a row that a calculated run already derived a line from is kept and switched off (is_active=false) so the line keeps its provenance. Answers 200 with the outcome, 404 NOT_FOUND when no such row exists on the employee. Mandatory Idempotency-Key. Dry-runnable: the preview is the row that would be removed.

**Use when:** A benefit was registered by mistake, or it ends and you do not need it listed as active any more. If it has been used by a calculated run it is deactivated rather than deleted.
**Do not use for:** Ending a benefit on a date while keeping it active until then: PATCH valid_to. Removing the derived line from one run: edit that run's payslip lines.

**Pitfalls:**
- Idempotency-Key is mandatory.
- Answers 200 with { employee_benefit_id, deleted, deactivated }. A benefit that a payslip line already derives from is never hard-deleted: it is kept and switched off (deleted=false, deactivated=true), so the chain from a booked verifikat back to its förmån stays intact (BFL 5 kap 6-7 §). A second DELETE of a gone id returns 404 NOT_FOUND; a second DELETE of a deactivated row answers deactivated=true again.
- Removing or deactivating a benefit does not recompute an open run: the derived line stays on a draft run until POST /salary-runs/{id}/calculate is called again, which drops it (#2695). A booked run is never changed.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `benefitId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { employee_benefit_id: string, deleted: boolean, deactivated: boolean },
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
    "employee_benefit_id": "ben_9c2e…",
    "deleted": true,
    "deactivated": false
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

Returns the opening balances set for a mid-year migration (YTD gross/tax/net, the five vacation pools Betalda/Sparade per år/Obetalda/Förskott/Extra betalda with their as-of date, opening semesterlöneskuld and förskottsskuld, karens adjustment) plus the lock state: locked=true once the employee has a booked salary run. ytd_net is null when the previous system could not export historical net pay.

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
    employee_opening_balances_id: string | null,
    employee_id: string,
    cutover_date: string,
    ytd_gross: number,
    ytd_tax: number,
    ytd_net: number | null,
    vacation_paid_days_remaining: number,
    vacation_days_taken_this_year: number,
    vacation_saved_days_by_year: Record<string, number>,
    opening_semester_liability: number,
    opening_semester_liability_avgifter: number,
    karens_periods_adjustment: number,
    vacation_as_of_date: string | null,
    vacation_unpaid_days_remaining: number,
    vacation_advance_days_remaining: number,
    vacation_extra_paid_days_remaining: number,
    opening_advance_vacation_debt: number,
    locked: boolean,
    locked_by_run_id: string | null
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

Full-replace upsert of the cutover state: YTD gross/tax/net for the cutover year, the vacation pools in the previous system's own terms (vacation_paid_days_remaining = Betalda, vacation_saved_days_by_year = Sparade per år, vacation_unpaid_days_remaining = Obetalda, vacation_advance_days_remaining = Förskott, vacation_extra_paid_days_remaining = Extra betalda), paid days already taken this vacation year, vacation_as_of_date (the day those pools are struck per), opening semesterlöneskuld SEK (+avgifter), opening_advance_vacation_debt (förskottsskuld SEK), and karens periods not covered by imported absence rows. cutover_date must be the first of a month in the current or previous year, on/after employment_start.

**Use when:** Onboarding one employee during a mid-year migration from Fortnox/Azets/Visma/etc. For whole-company onboarding, prefer the bulk PUT /employees/opening-balances.
**Do not use for:** SIE opening balances on the LEDGER (2920/2940 arrive via the SIE import). Ongoing sick cases: import pre-cutover days via PUT /employees/{id}/absence instead.

**Pitfalls:**
- Full replace: omitted numeric fields reset to 0 (their defaults) and an omitted vacation_as_of_date resets to null. Send the complete state every time.
- vacation_as_of_date defaults to the day before cutover_date. Booked runs whose avvikelseperiod ends on or before it are treated as already inside the balance and not deducted again, so with salary_deviation_period = previous_month send the last day BEFORE the month the first run deducts (cutover 2026-09-01, first run deducts August: send 2026-07-31) or August's leave is never deducted.
- ytd_net: send null when the previous system cannot export historical net pay; the payslip prints "Underlag saknas" instead of a false 0. Never send gross minus tax as net.
- 409 OPENING_BALANCES_LOCKED once the employee has a booked run; correcting that run unlocks.
- The opening liability and the förskottsskuld are NOT booked by Accounted: they only feed the vacation-liability report (the förskottsskuld as its own row, subtracted from the net liability).
- Extra betalda join the paid pool: the ledger's entitled days = Betalda + Extra betalda + days already taken. Obetalda lapse at the vacation-year close; Förskott days taken reduce the next year's entitlement.
- YTD affects payslip display and reports only; per-month tax and avgifter caps never read it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  cutover_date: string,
  ytd_gross?: number,
  ytd_tax?: number,
  ytd_net?: number | null,
  vacation_paid_days_remaining?: number,
  vacation_days_taken_this_year?: number,
  vacation_saved_days_by_year?: Record<string, number>,
  opening_semester_liability?: number,
  opening_semester_liability_avgifter?: number,
  karens_periods_adjustment?: number,
  vacation_as_of_date?: string | null,
  vacation_unpaid_days_remaining?: number,
  vacation_advance_days_remaining?: number,
  vacation_extra_paid_days_remaining?: number,
  opening_advance_vacation_debt?: number
}
```

Example request:
```json
{
  "cutover_date": "2026-09-01",
  "ytd_gross": 280000,
  "ytd_tax": 64000,
  "ytd_net": 216000,
  "vacation_as_of_date": "2026-07-31",
  "vacation_paid_days_remaining": 12.5,
  "vacation_days_taken_this_year": 10,
  "vacation_extra_paid_days_remaining": 2,
  "vacation_saved_days_by_year": {
    "2025": 5
  },
  "vacation_unpaid_days_remaining": 0,
  "vacation_advance_days_remaining": 3,
  "opening_semester_liability": 42000,
  "opening_semester_liability_avgifter": 13196.4,
  "opening_advance_vacation_debt": 4500,
  "karens_periods_adjustment": 1
}
```

Response `200`:
```ts
{
  data: {
    employee_opening_balances_id: string | null,
    employee_id: string,
    cutover_date: string,
    ytd_gross: number,
    ytd_tax: number,
    ytd_net: number | null,
    vacation_paid_days_remaining: number,
    vacation_days_taken_this_year: number,
    vacation_saved_days_by_year: Record<string, number>,
    opening_semester_liability: number,
    opening_semester_liability_avgifter: number,
    karens_periods_adjustment: number,
    vacation_as_of_date: string | null,
    vacation_unpaid_days_remaining: number,
    vacation_advance_days_remaining: number,
    vacation_extra_paid_days_remaining: number,
    opening_advance_vacation_debt: number,
    locked: boolean,
    locked_by_run_id: string | null
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

### `GET /api/v1/companies/{companyId}/employees/{id}/recurring-lines`

**List recurring payslip lines for an employee.**
`scope:payroll:read · risk:low · idempotent`

Returns the employee's standing monthly payslip rows (gross and net deductions such as a benefit bike bruttolöneavdrag, a union fee, or a net deduction for a benefit the employee pays for), newest valid_from first. Both active and deactivated lines are returned unless ?active filters them.

**Use when:** You need to see what the salary engine will derive for an employee every month, to reconcile with an HR system, or to find the employee_recurring_line_id to update or delete.
**Do not use for:** The derived payslip rows of one run: those are on the salary run detail after :calculate. Taxable benefits in kind (bilförmån, kostförmån): use the employee benefits endpoints.

**Pitfalls:**
- Rows are re-derived on every :calculate for runs whose payment_date falls inside valid_from..valid_to (valid_to null = open-ended). Hand edits to a derived payslip row are overwritten by the next :calculate.
- The amount sign follows the item type: every supported type is a deduction and must be negative (e.g. -670.17 for a benefit bike bruttolöneavdrag). The API rejects the wrong sign with 400 VALIDATION_ERROR on field amount.
- account_number overrides the default BAS account for the derived payslip row; null lets the engine use its item-type mapping.
- Draft-only per-run edits (a one-off change on one payslip) still go through the salary-runs lines endpoints, not through recurring lines.
- Deactivated lines (is_active=false) are listed too: a line that a booked run derived from cannot be deleted, only deactivated, so history keeps it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `active` | query | `"true" \| "false"` | no | true returns active lines only, false deactivated lines only. Default: every line. |

Response `200`:
```ts
{
  data: { employee_recurring_line_id: string, item_type: "gross_deduction_pension" | "gross_deduction_other" | "net_deduction_union" | "net_deduction_benefit_payment" | "net_deduction_other", description: string, amount: number, account_number: string | null, valid_from: string, valid_to: string | null, is_active: boolean, metadata: Record<string, unknown>, created_at: string, updated_at: string }[],
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
      "employee_recurring_line_id": "erl_5b1c…",
      "item_type": "gross_deduction_other",
      "description": "Förmånscykel bruttolöneavdrag",
      "amount": -670.17,
      "account_number": null,
      "valid_from": "2026-01-01",
      "valid_to": null,
      "is_active": true,
      "metadata": {}
    }
  ],
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/employees/{id}/recurring-lines`

**Create a recurring payslip line for an employee.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Adds a standing monthly payslip row. From the next :calculate on, every salary run whose payment_date falls inside valid_from..valid_to derives a payslip line from it, with flags (taxable, avgift basis, gross vs net deduction) fixed by item_type. Amounts are kept to whole öre. Requires an Idempotency-Key header.

**Use when:** An employee starts a benefit bike bruttolöneavdrag, a union fee, a monthly net deduction for a benefit they pay for, or any other deduction that repeats every month until further notice.
**Do not use for:** One-off deductions on a single payslip: add a line on the salary run instead. Additions (a monthly allowance paid in cash): not supported as recurring lines; add them per run. Taxable benefits in kind: use the employee benefits endpoints.

**Pitfalls:**
- Rows are re-derived on every :calculate for runs whose payment_date falls inside valid_from..valid_to (valid_to null = open-ended). Hand edits to a derived payslip row are overwritten by the next :calculate.
- The amount sign follows the item type: every supported type is a deduction and must be negative (e.g. -670.17 for a benefit bike bruttolöneavdrag). The API rejects the wrong sign with 400 VALIDATION_ERROR on field amount.
- account_number overrides the default BAS account for the derived payslip row; null lets the engine use its item-type mapping.
- Draft-only per-run edits (a one-off change on one payslip) still go through the salary-runs lines endpoints, not through recurring lines.
- valid_to must be on or after valid_from (inclusive); omit it for an open-ended line.
- Creating a line does not recompute an open salary run: call POST /salary-runs/{id}/calculate afterwards.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  item_type: "gross_deduction_pension" | "gross_deduction_other" | "net_deduction_union" | "net_deduction_benefit_payment" | "net_deduction_other",
  description: string,
  amount: number,
  account_number?: string,
  valid_from: string,
  valid_to?: string,
  metadata?: Record<string, unknown>,
  is_active?: boolean
}
```

Example request:
```json
{
  "item_type": "gross_deduction_other",
  "description": "Förmånscykel bruttolöneavdrag",
  "amount": -670.17,
  "valid_from": "2026-01-01"
}
```

Response `200`:
```ts
{
  data: {
    employee_recurring_line_id: string,
    item_type: "gross_deduction_pension" | "gross_deduction_other" | "net_deduction_union" | "net_deduction_benefit_payment" | "net_deduction_other",
    description: string,
    amount: number,
    account_number: string | null,
    valid_from: string,
    valid_to: string | null,
    is_active: boolean,
    metadata: Record<string, unknown>,
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
    "employee_recurring_line_id": "erl_5b1c…",
    "item_type": "gross_deduction_other",
    "description": "Förmånscykel bruttolöneavdrag",
    "amount": -670.17,
    "account_number": null,
    "valid_from": "2026-01-01",
    "valid_to": null,
    "is_active": true,
    "metadata": {}
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/employees/{id}/recurring-lines/{lineId}`

**Update a recurring payslip line.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Patches description, amount, account_number, valid_from, valid_to, is_active or metadata on a recurring line. The amount sign is re-checked against the stored item_type and the validity period against the merged (stored + patched) dates. item_type cannot change: delete and recreate instead. Requires an Idempotency-Key header.

**Use when:** The monthly deduction changed (new bike lease amount), the line ends on a known date (set valid_to), or it should pause without losing history (is_active=false).
**Do not use for:** Changing the kind of line (gross to net deduction): DELETE and POST a new one. Fixing one payslip only: edit the salary run line instead.

**Pitfalls:**
- Rows are re-derived on every :calculate for runs whose payment_date falls inside valid_from..valid_to (valid_to null = open-ended). Hand edits to a derived payslip row are overwritten by the next :calculate.
- The amount sign follows the item type: every supported type is a deduction and must be negative (e.g. -670.17 for a benefit bike bruttolöneavdrag). The API rejects the wrong sign with 400 VALIDATION_ERROR on field amount.
- account_number overrides the default BAS account for the derived payslip row; null lets the engine use its item-type mapping.
- Draft-only per-run edits (a one-off change on one payslip) still go through the salary-runs lines endpoints, not through recurring lines.
- A patch that leaves valid_to before valid_from on the merged row is rejected with 400 VALIDATION_ERROR on field valid_to; send valid_to: null to make the line open-ended again.
- Runs already calculated keep their derived rows until they are recalculated; booked runs are never touched.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `lineId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  description?: string,
  amount?: number,
  account_number?: string | null,
  valid_from?: string,
  valid_to?: string | null,
  metadata?: Record<string, unknown>,
  is_active?: boolean
}
```

Example request:
```json
{
  "amount": -700,
  "valid_to": "2026-12-31"
}
```

Response `200`:
```ts
{
  data: {
    employee_recurring_line_id: string,
    item_type: "gross_deduction_pension" | "gross_deduction_other" | "net_deduction_union" | "net_deduction_benefit_payment" | "net_deduction_other",
    description: string,
    amount: number,
    account_number: string | null,
    valid_from: string,
    valid_to: string | null,
    is_active: boolean,
    metadata: Record<string, unknown>,
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
    "employee_recurring_line_id": "erl_5b1c…",
    "item_type": "gross_deduction_other",
    "description": "Förmånscykel bruttolöneavdrag",
    "amount": -700,
    "account_number": null,
    "valid_from": "2026-01-01",
    "valid_to": "2026-12-31",
    "is_active": true,
    "metadata": {}
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/employees/{id}/recurring-lines/{lineId}`

**Delete a recurring payslip line, or deactivate it if a run already used it.**
`scope:payroll:write · risk:low · idempotent · dry-run`

Removes the line when no salary run has derived a payslip row from it. Once a run has (the derived row references the line), the database refuses the delete and the line is deactivated instead (is_active=false): the payslip row keeps its provenance, the next :calculate of a draft run drops the derived row, and nothing is re-derived. Returns 200 with deleted: true or deleted: false + deactivated: true so the caller knows which happened. Requires an Idempotency-Key header.

**Use when:** The deduction ends and there is no end date to keep (a union fee stops, the bike lease is returned), or the line was created by mistake.
**Do not use for:** Ending a line on a future date: PATCH valid_to instead, so the remaining months still derive. Removing a derived row from one draft payslip: DELETE the salary run line.

**Pitfalls:**
- Rows are re-derived on every :calculate for runs whose payment_date falls inside valid_from..valid_to (valid_to null = open-ended). Hand edits to a derived payslip row are overwritten by the next :calculate.
- The amount sign follows the item type: every supported type is a deduction and must be negative (e.g. -670.17 for a benefit bike bruttolöneavdrag). The API rejects the wrong sign with 400 VALIDATION_ERROR on field amount.
- account_number overrides the default BAS account for the derived payslip row; null lets the engine use its item-type mapping.
- Draft-only per-run edits (a one-off change on one payslip) still go through the salary-runs lines endpoints, not through recurring lines.
- deleted: false with deactivated: true is a success, not an error: a run already derived from the line, so it is kept for history and switched off.
- A lineId under another employee or company answers 404 NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `lineId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { employee_recurring_line_id: string, deleted: boolean, deactivated?: true },
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
    "employee_recurring_line_id": "erl_5b1c…",
    "deleted": true
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

Returns the open vacation-ledger row (recomputed on every booking): entitled/taken/remaining paid days, sparade dagar still held per origin year (Semesterlagen 5-year rule; saved_days_taken shows what saved vacation lines consumed this year), the unpaid (Obetalda) and advance (Förskott) pools from the cutover import, forced-payout days from expired savings, and a computed SEK estimate of the individual semesterlöneskuld.

**Use when:** Answering "how many vacation days does Anna have left", pre-payroll review, or preparing the year-close.
**Do not use for:** The company-wide liability report: GET /reports/vacation-liability. Closing the year: POST /salary/vacation-year-close.

**Pitfalls:**
- 404 VACATION_BALANCE_NOT_FOUND until the first booking (or year-close) touches the employee: the ledger seeds lazily.
- remaining_days can go negative if more days were taken than entitled: surface it, do not clamp.
- The SEK estimate uses the year-close day valuation (simplified BFNAR 2016:10); the booked 2920 is reconciled only at year-close.
- unpaid_days and advance_days are the cutover pools minus unpaid/advance vacation lines in booked runs; both read 0 for companies that never loaded categorized balances and outside the cutover year (unpaid days lapse at close, förskott is a one-time grant).

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
    saved_days_taken: Record<string, number>,
    unpaid_days: number,
    advance_days: number,
    forced_payout_days: number,
    estimated_liability_sek: number
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

### `GET /api/v1/companies/{companyId}/employees/{id}/worked-days`

**List worked days (hours per date) for an employee in a date range.**
`scope:payroll:read · risk:low · idempotent`

Returns the per-day worked-hours rows (tidrapport) between ?from and ?to (inclusive, max 92 days): hours, optional shift window (start_time/end_time) and notes. No cursor pagination: the bounded range is the page.

**Use when:** You need what is registered for an hourly employee before running payroll, to reconcile with an external time-tracking system, or to verify the hours the salary engine will pick up.
**Do not use for:** Absence (sick, vab, parental): GET /employees/{id}/absence. The derived pay (hourly gross, OB lines): that lives on the run after POST /salary-runs/{id}/calculate.

**Pitfalls:**
- Ranges over 92 days return 400 VALIDATION_ERROR with details.max_days = 92: iterate quarters instead.
- POST /salary-runs/{id}/calculate reads these rows by the run's deviation window (deviation_period_start..deviation_period_end), not the pay month: register hours on the dates they were worked and check the run's window.
- One row per date: an hourly employee with two shifts on the same day has ONE row with the combined hours (and the shift window of the OB-relevant one).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `from` | query | `string` | yes | YYYY-MM-DD. First day of the range (inclusive). Required. |
| `to` | query | `string` | yes | YYYY-MM-DD. Last day of the range (inclusive), not before from. Required. |

Response `200`:
```ts
{
  data: { salary_worked_day_id: string, work_date: string, hours: number, start_time: string | null, end_time: string | null, notes: string | null, created_at: string, updated_at: string }[],
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
      "salary_worked_day_id": "wd_91d2…",
      "work_date": "2026-03-02",
      "hours": 8,
      "start_time": "22:00:00",
      "end_time": "06:00:00",
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

### `PUT /api/v1/companies/{companyId}/employees/{id}/worked-days`

**Register worked hours per day for an employee (bulk upsert).**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Upserts 1..92 explicit per-day rows on the natural key (employee, work_date) in one atomic statement. A date already registered is overwritten with the new hours, shift window and notes (omitted optional fields are cleared, not carried forward). Idempotent by construction: replaying the same PUT converges on the same rows. Each work_date may appear once per request.

**Use when:** An external time-tracking or payroll system pushes an hourly employee's tidrapport for a period, including shift start/end times for OB (obekväm arbetstid) premiums, before the salary run is calculated.
**Do not use for:** Absence: PUT /employees/{id}/absence. Monthly-salaried staff without OB rules: their gross comes from the employee profile, not from this register.

**Pitfalls:**
- POST /salary-runs/{id}/calculate reads these rows by the run's deviation window (deviation_period_start..deviation_period_end), not the pay month: register the hours on the dates they were actually worked, and check the run's window before calculating.
- For hourly employees the run's gross is derived from these rows (hourly_rate x sum(hours)): PATCH /salary-runs/{id}/employees/{employeeId} monthly_salary is irrelevant for them.
- start_time/end_time feed the OB/shift-premium rules: a row without them is priced as an assumed 08:00-17:00 day, so a night or weekend shift earns no premium. Times are HH:MM or HH:MM:SS; end_time before start_time means the shift crosses midnight.
- Worked hours plus absence hours on one date may not exceed 24 (DB trigger, shared with absence): the whole PUT is rejected with 409 ABSENCE_HOURS_CONFLICT, nothing is written.
- Dates inside the avvikelseperiod (deviation window, deviation_period_start..deviation_period_end, NULL = the pay month) of a run that is already calculated (review), approved, paid or booked are locked: 409 SALARY_REGISTER_DATES_LOCKED_BY_RUN naming the run (details.salary_run_id, details.status, details.locked_dates), nothing written, dry runs included. The way out is to revert that run to draft (dashboard) or, for a booked run, POST /salary-runs/{id}/correct and register the days against the correction run. Draft runs never lock.
- Registering hours does not recompute a draft salary run: call POST /salary-runs/{id}/calculate afterwards.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  days: { work_date: string, hours: number, start_time?: string, end_time?: string, notes?: string }[]
}
```

Example request:
```json
{
  "days": [
    {
      "work_date": "2026-03-02",
      "hours": 8,
      "start_time": "22:00",
      "end_time": "06:00"
    },
    {
      "work_date": "2026-03-03",
      "hours": 4,
      "notes": "Halvdag"
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    count: number,
    days: { salary_worked_day_id?: string, work_date: string, hours: number, start_time: string | null, end_time: string | null, notes: string | null, created_at?: string, updated_at?: string }[]
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
    "count": 2,
    "days": [
      {
        "salary_worked_day_id": "wd_91d2…",
        "work_date": "2026-03-02",
        "hours": 8,
        "start_time": "22:00:00",
        "end_time": "06:00:00",
        "notes": null
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

### `DELETE /api/v1/companies/{companyId}/employees/{id}/worked-days`

**Delete worked days for an employee in a date range.**
`scope:payroll:write · risk:low · idempotent · dry-run`

Deletes the per-day worked-hours rows between ?from and ?to (inclusive). Returns deleted_count (200, not 204) so callers can verify how many rows went. Single day = from == to.

**Use when:** Hours were pushed for the wrong employee or the wrong dates, or a time-tracking re-sync needs a clean period before a fresh PUT.
**Do not use for:** Correcting hours on a day: PUT the day again instead. Rows a calculated, approved, paid or booked run has already read: the delete is refused (409 SALARY_REGISTER_DATES_LOCKED_BY_RUN); use the run correction flow.

**Pitfalls:**
- deleted_count: 0 with a 200 means nothing matched: not an error.
- Dates inside the avvikelseperiod (deviation window, deviation_period_start..deviation_period_end, NULL = the pay month) of a run that is already calculated (review), approved, paid or booked are locked: 409 SALARY_REGISTER_DATES_LOCKED_BY_RUN naming the run (details.salary_run_id, details.status, details.locked_dates), nothing written, dry runs included. The way out is to revert that run to draft (dashboard) or, for a booked run, POST /salary-runs/{id}/correct and register the days against the correction run. Draft runs never lock.
- Hours a draft run has already summed stay in the run until POST /salary-runs/{id}/calculate is called again.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `from` | query | `string` | yes | YYYY-MM-DD. First day of the range (inclusive). Required. |
| `to` | query | `string` | yes | YYYY-MM-DD. Last day of the range (inclusive), not before from. Required. |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { deleted_count: number },
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
    "deleted_count": 2
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
- Full replace per employee: resubmitting with fewer fields resets the omitted ones to 0 (vacation_as_of_date to null).
- Duplicate employee_id within items is rejected outright.
- Vacation pools map one to one onto Fortnox/Azets: vacation_paid_days_remaining = Betalda, vacation_saved_days_by_year = Sparade per år, vacation_unpaid_days_remaining = Obetalda, vacation_advance_days_remaining = Förskott, vacation_extra_paid_days_remaining = Extra betalda; opening_advance_vacation_debt is the förskottsskuld in SEK.
- vacation_as_of_date is the day the pools are struck per (default: the day before cutover_date). Under salary_deviation_period = previous_month the first run deducts the month before cutover, so send the last day before that month or its leave is treated as already deducted.
- ytd_net: null when the previous system cannot export historical net pay (payslip prints "Underlag saknas"); never gross minus tax.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  items: { employee_id: string, cutover_date: string, ytd_gross?: number, ytd_tax?: number, ytd_net?: number | null, vacation_paid_days_remaining?: number, vacation_days_taken_this_year?: number, vacation_saved_days_by_year?: Record<string, number>, opening_semester_liability?: number, opening_semester_liability_avgifter?: number, karens_periods_adjustment?: number, vacation_as_of_date?: string | null, vacation_unpaid_days_remaining?: number, vacation_advance_days_remaining?: number, vacation_extra_paid_days_remaining?: number, opening_advance_vacation_debt?: number }[]
}
```

Example request:
```json
{
  "items": [
    {
      "employee_id": "emp_77b2…",
      "cutover_date": "2026-09-01",
      "ytd_gross": 280000,
      "ytd_tax": 64000,
      "ytd_net": null,
      "vacation_as_of_date": "2026-07-31",
      "vacation_paid_days_remaining": 12.5,
      "vacation_days_taken_this_year": 10,
      "vacation_saved_days_by_year": {
        "2025": 5
      },
      "vacation_unpaid_days_remaining": 0,
      "vacation_advance_days_remaining": 3,
      "vacation_extra_paid_days_remaining": 2,
      "opening_advance_vacation_debt": 4500
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    count: number,
    rows: { employee_opening_balances_id: string | null, employee_id: string, cutover_date: string, locked: boolean }[]
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

### `GET /api/v1/companies/{companyId}/salary/settings`

**Get the company payroll settings.**
`scope:payroll:read · risk:low · idempotent`

Returns the payroll settings that drive new salary runs: pay day (salary_pay_day), avvikelseperiod (salary_deviation_period: which month a run reads absence and worked days from), salary payment file format (preferred_payment_format), the bank whose upload instructions are pre-selected (salary_default_bank), öresavrundning of net pay (salary_net_rounding), the calculation conventions (salary_calculation_policy: partial_month, sick_rate, long_leave, leave_context, net_rounding, one_off_tax_rounding, every key always present) and the voucher series salary runs book into (salary_voucher_series). A company that has no settings row yet answers with the defaults the engine would apply (pay day 25, same_month, pain001, no bank, no rounding, every convention at its default, series A).

**Use when:** You are provisioning or auditing a customer for payroll and need to know how new salary runs will be dated, which month their deviations are read from, which calculation conventions the engine applies, which payment file the bank expects, or which voucher series the salary vouchers land in.
**Do not use for:** Invoice payment and contact details (PATCH /api/v1/companies/{companyId}/settings). Per-run values such as payment_date or deviation window (GET /salary-runs/{id}: they are snapshotted on the run). The conventions a calculated run actually used (GET /salary-runs/{id}: calculation_params.salary_calculation_policy). Employee-level pay settings (GET /employees/{id}).

**Pitfalls:**
- salary_deviation_period is snapshotted onto each salary run at creation: changing it never moves a run that already exists. Set it before the first run of a new month. Switching later makes the next run's deviation window overlap the previous run's window, and that run is refused with 409 SALARY_RUN_DEVIATION_PERIOD_OVERLAP (pass explicit deviation_period_start/end on that one run to bridge the switch).
- salary_pay_day only drives the default payment_date of NEW runs (the day of the pay month, 1-28 so it exists in every month). Existing runs keep their payment_date; override per run on POST /salary-runs.
- salary_voucher_series is an alias for company_settings.default_voucher_series_per_source_type.salary_payment. Writes MERGE that one key into the per-source-type map; the other source types keep their letters. The default company layout books salaries on K.
- preferred_payment_format: pain001 (ISO 20022) is the default; bg_lb (Bankgirot Leverantörsbetalningar / Lön) is being retired by the banks during 2026, so only pick it for a customer whose bank still accepts LB files.
- salary_calculation_policy holds the company's calculation conventions (beräkningsprinciper). Every key defaults to the historical Accounted behaviour; a customer migrated from Fortnox usually wants partial_month=annual_calendar_days (månadslön × 12 / 365 per calendar day employed), sick_rate=annual_hourly (timlön = månadslön × 12 / (52 × veckoarbetstid) for sjuklön), long_leave=calendar_after_five_workdays (leave longer than five working days deducted per calendar day at månadslön × 12 / 365, a whole month = the monthly salary) and, with salary_net_rounding, net_rounding=nearest. Compare one historical payslip before switching.
- A PATCH of salary_calculation_policy is merged key by key into the stored policy (omitted keys keep their value); the response and the stored value always carry all six keys. It is not snapshotted onto existing runs at creation: the conventions are read at :calculate and frozen into the run's calculation_params, so a draft recalculated after a change follows the new conventions and a calculated run does not.
- long_leave=calendar_after_five_workdays is a five-day-week rule: :calculate refuses (400 VALIDATION_ERROR) a monthly employee whose workdays_per_week is not 5 while it is on. leave_context only matters under that convention.
- one_off_tax_rounding governs engångsskatt on payslip lines that carry one_off_tax_percent (POST /salary-runs/{id}/employees/{employeeId}/lines); truncate (öretal bortfaller) is the statutory rule, nearest exists to reproduce another system's history.
- A company without a settings row reports series A (the engine fallback). The first PATCH creates the row with the standard series set, where salary_payment is K, unless salary_voucher_series is supplied in that same call: send it explicitly when provisioning so the letter never changes under you.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    company_id: string,
    salary_pay_day: number,
    salary_deviation_period: "same_month" | "previous_month",
    preferred_payment_format: "pain001" | "bg_lb",
    salary_default_bank: "swedbank" | "seb" | "handelsbanken" | "nordea" | "other" | null,
    salary_net_rounding: boolean,
    salary_calculation_policy: { partial_month?: "workdays" | "annual_calendar_days", sick_rate?: "daily_divisor" | "annual_hourly", long_leave?: "workdays" | "calendar_after_five_workdays", leave_context?: "all_registered" | "through_deviation_end", net_rounding?: "up" | "nearest", one_off_tax_rounding?: "truncate" | "nearest" },
    salary_voucher_series: string
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
    "salary_pay_day": 25,
    "salary_deviation_period": "previous_month",
    "preferred_payment_format": "pain001",
    "salary_default_bank": "swedbank",
    "salary_net_rounding": true,
    "salary_calculation_policy": {
      "partial_month": "annual_calendar_days",
      "sick_rate": "annual_hourly",
      "long_leave": "calendar_after_five_workdays",
      "leave_context": "all_registered",
      "net_rounding": "nearest",
      "one_off_tax_rounding": "truncate"
    },
    "salary_voucher_series": "K"
  },
  "meta": {
    "request_id": "req_...",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/salary/settings`

**Partially update the company payroll settings.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Patches the payroll settings: salary_pay_day (1-28), salary_deviation_period (same_month | previous_month), preferred_payment_format (pain001 | bg_lb), salary_default_bank (swedbank | seb | handelsbanken | nordea | other | null), salary_net_rounding (boolean), salary_calculation_policy (an object with any of partial_month: workdays | annual_calendar_days, sick_rate: daily_divisor | annual_hourly, long_leave: workdays | calendar_after_five_workdays, leave_context: all_registered | through_deviation_end, net_rounding: up | nearest, one_off_tax_rounding: truncate | nearest; merged key by key into the stored policy) and salary_voucher_series (one letter A-Z). All fields optional; at least one must be supplied; unknown fields are rejected. Upserts: a company without a settings row gets one created with the supplied values and DB defaults for the rest. Returns the full resource after the write. Idempotent (mandatory Idempotency-Key). Dry-runnable: ?dry_run=true returns the merged resource without writing.

**Use when:** You are onboarding a customer for payroll over the API (set the pay day, avvikelseperiod, calculation conventions, payment file format, bank and voucher series before the first run), a customer changes bank or pay day, or a customer migrated from Fortnox needs the same partial-month, sick-pay and long-leave conventions as their old payslips.
**Do not use for:** Invoice payment and contact details (PATCH /api/v1/companies/{companyId}/settings). Changing the payment date or deviation window of an existing run (PATCH /salary-runs/{id}, or explicit deviation_period_start/end on POST). Changing the conventions of a run that is already calculated (recalculate the draft, or :correct a booked run). Tax and legal profile changes (not on the public API).

**Pitfalls:**
- Idempotency-Key is mandatory; calls without it return 400.
- At least one field must be supplied; an empty body returns 400. Unknown fields return 400 (strict body), also inside salary_calculation_policy.
- salary_deviation_period is snapshotted onto each salary run at creation: changing it never moves a run that already exists. Set it before the first run of a new month. Switching later makes the next run's deviation window overlap the previous run's window, and that run is refused with 409 SALARY_RUN_DEVIATION_PERIOD_OVERLAP (pass explicit deviation_period_start/end on that one run to bridge the switch).
- salary_pay_day only drives the default payment_date of NEW runs (the day of the pay month, 1-28 so it exists in every month). Existing runs keep their payment_date; override per run on POST /salary-runs.
- salary_voucher_series is an alias for company_settings.default_voucher_series_per_source_type.salary_payment. Writes MERGE that one key into the per-source-type map; the other source types keep their letters. The default company layout books salaries on K.
- preferred_payment_format: pain001 (ISO 20022) is the default; bg_lb (Bankgirot Leverantörsbetalningar / Lön) is being retired by the banks during 2026, so only pick it for a customer whose bank still accepts LB files.
- salary_calculation_policy holds the company's calculation conventions (beräkningsprinciper). Every key defaults to the historical Accounted behaviour; a customer migrated from Fortnox usually wants partial_month=annual_calendar_days (månadslön × 12 / 365 per calendar day employed), sick_rate=annual_hourly (timlön = månadslön × 12 / (52 × veckoarbetstid) for sjuklön), long_leave=calendar_after_five_workdays (leave longer than five working days deducted per calendar day at månadslön × 12 / 365, a whole month = the monthly salary) and, with salary_net_rounding, net_rounding=nearest. Compare one historical payslip before switching.
- A PATCH of salary_calculation_policy is merged key by key into the stored policy (omitted keys keep their value); the response and the stored value always carry all six keys. It is not snapshotted onto existing runs at creation: the conventions are read at :calculate and frozen into the run's calculation_params, so a draft recalculated after a change follows the new conventions and a calculated run does not.
- long_leave=calendar_after_five_workdays is a five-day-week rule: :calculate refuses (400 VALIDATION_ERROR) a monthly employee whose workdays_per_week is not 5 while it is on. leave_context only matters under that convention.
- one_off_tax_rounding governs engångsskatt on payslip lines that carry one_off_tax_percent (POST /salary-runs/{id}/employees/{employeeId}/lines); truncate (öretal bortfaller) is the statutory rule, nearest exists to reproduce another system's history.
- salary_default_bank: null clears the bank; omitting the field leaves it unchanged. The bank only pre-selects upload instructions, it does not change the payment file format.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  salary_pay_day?: number,
  salary_deviation_period?: "same_month" | "previous_month",
  preferred_payment_format?: "bg_lb" | "pain001",
  salary_default_bank?: "swedbank" | "seb" | "handelsbanken" | "nordea" | "other" | null,
  salary_net_rounding?: boolean,
  salary_calculation_policy?: {
    partial_month?: "workdays" | "annual_calendar_days",
    sick_rate?: "daily_divisor" | "annual_hourly",
    long_leave?: "workdays" | "calendar_after_five_workdays",
    leave_context?: "all_registered" | "through_deviation_end",
    net_rounding?: "up" | "nearest",
    one_off_tax_rounding?: "truncate" | "nearest"
  },
  salary_voucher_series?: string
}
```

Example request:
```json
{
  "salary_pay_day": 25,
  "salary_deviation_period": "previous_month",
  "salary_default_bank": "swedbank",
  "salary_net_rounding": true,
  "salary_calculation_policy": {
    "partial_month": "annual_calendar_days",
    "sick_rate": "annual_hourly",
    "long_leave": "calendar_after_five_workdays",
    "net_rounding": "nearest"
  },
  "salary_voucher_series": "K"
}
```

Response `200`:
```ts
{
  data: {
    company_id: string,
    salary_pay_day: number,
    salary_deviation_period: "same_month" | "previous_month",
    preferred_payment_format: "pain001" | "bg_lb",
    salary_default_bank: "swedbank" | "seb" | "handelsbanken" | "nordea" | "other" | null,
    salary_net_rounding: boolean,
    salary_calculation_policy: { partial_month?: "workdays" | "annual_calendar_days", sick_rate?: "daily_divisor" | "annual_hourly", long_leave?: "workdays" | "calendar_after_five_workdays", leave_context?: "all_registered" | "through_deviation_end", net_rounding?: "up" | "nearest", one_off_tax_rounding?: "truncate" | "nearest" },
    salary_voucher_series: string
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
    "salary_pay_day": 25,
    "salary_deviation_period": "previous_month",
    "preferred_payment_format": "pain001",
    "salary_default_bank": "swedbank",
    "salary_net_rounding": true,
    "salary_calculation_policy": {
      "partial_month": "annual_calendar_days",
      "sick_rate": "annual_hourly",
      "long_leave": "calendar_after_five_workdays",
      "leave_context": "all_registered",
      "net_rounding": "nearest",
      "one_off_tax_rounding": "truncate"
    },
    "salary_voucher_series": "K"
  },
  "meta": {
    "request_id": "req_...",
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
  data: { vacation_year_closure_id: string, adjustment_entry_id: string | null, report?: unknown },
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
