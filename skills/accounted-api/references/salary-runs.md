<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Salary runs endpoints

Swedish payroll runs: create -> calculate -> approve -> book/mark-paid -> generate-agi (arbetsgivardeklaration), with per-employee payslips and draft-only line edits.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/salary-runs`

**List salary runs.**
`scope:payroll:read · risk:low · idempotent`

Returns salary runs in created-first order with their lifecycle status (draft|review|approved|paid|booked|corrected) and denormalised totals. Filters: ?period_year=YYYY, ?status=draft.

**Use when:** You need an overview of payroll activity: for building a list view, finding the current open run, or resolving a salary_run_id before invoking a lifecycle verb.
**Do not use for:** Per-employee details (those live on the detail endpoint). Salary journal report (use GET /reports/salary-journal in Phase 5 PR-3).

**Pitfalls:**
- A company has at most one salary run per (period_year, period_month). The unique constraint is at the DB layer.
- Totals are denormalised: they are 0 until POST /calculate runs.
- `corrected` status is reached via the internal /correct route (not yet exposed on v1): Phase 5 PR-1 ships create/calculate/approve/mark-paid/book/generate-agi only.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, period_year: number, period_month: number, payment_date: string, status: "draft" | "review" | "approved" | "paid" | "booked" | "corrected", voucher_series: string, total_gross: number, total_tax: number, total_net: number, total_avgifter: number, total_employer_cost: number, agi_generated_at: string, agi_submitted_at: string, approved_at: string, paid_at: string, booked_at: string, created_at: string }[],
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
      "id": "run_a8f1…",
      "period_year": 2026,
      "period_month": 5,
      "payment_date": "2026-05-25",
      "status": "draft",
      "voucher_series": "A",
      "total_gross": 0,
      "total_tax": 0,
      "total_net": 0,
      "total_avgifter": 0,
      "total_employer_cost": 0
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

### `POST /api/v1/companies/{companyId}/salary-runs`

**Create a salary run.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Creates a draft salary run for the given period (period_year, period_month). The run starts empty: add employees via the internal /salary/runs/{id}/employees endpoints, then POST /salary-runs/{id}/calculate. Requires Idempotency-Key. Dry-runnable.

**Use when:** You are starting a new month's payroll. Use dry-run first to validate the period + voucher_series choice without committing.
**Do not use for:** Adding employees to an existing run (that is a separate surface: see internal /salary/runs/{id}/employees for Phase 5 PR-1; promoting it to v1 is deferred to a follow-up).

**Pitfalls:**
- Idempotency-Key is mandatory.
- Duplicate (period_year, period_month) for the same company returns 409 SALARY_RUN_DUPLICATE_PERIOD.
- period_month is 1-12. The DB CHECK enforces this: a 0 or 13 returns 400 VALIDATION_ERROR before reaching the DB.
- voucher_series defaults to "A". If the company uses a dedicated salary voucher series, set it explicitly.
- A newly-created run has no employees: :calculate without employees returns 400 SALARY_RUN_NO_EMPLOYEES.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  period_year: number,
  period_month: number,
  payment_date: string,
  voucher_series?: string,
  notes?: string
}
```

Example request:
```json
{
  "period_year": 2026,
  "period_month": 5,
  "payment_date": "2026-05-25",
  "voucher_series": "L"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    period_year: number,
    period_month: number,
    payment_date: string,
    status: "draft" | "review" | "approved" | "paid" | "booked" | "corrected",
    voucher_series: string,
    total_gross: number,
    total_tax: number,
    total_net: number,
    total_avgifter: number,
    total_employer_cost: number,
    agi_generated_at: string,
    agi_submitted_at: string,
    approved_at: string,
    paid_at: string,
    booked_at: string,
    created_at: string,
    notes: string,
    calculation_params?: unknown,
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
    "id": "run_a8f1…",
    "period_year": 2026,
    "period_month": 5,
    "payment_date": "2026-05-25",
    "status": "draft",
    "voucher_series": "L"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/salary-runs/{id}`

**Get a salary run.**
`scope:payroll:read · risk:low · idempotent`

Returns the salary run's lifecycle state, denormalised totals (gross/tax/net/avgifter/vacation/employer_cost), and references to the journal entries it produced (once :book has run).

**Use when:** You have a salary_run_id and need its current status: typically to decide which lifecycle verb to call next, or to display the run header in a UI.
**Do not use for:** Per-employee breakdown: use GET /salary-runs/{id}/employees (list) or /salary-runs/{id}/employees/{employeeId} (payslip detail). Salary journal report: use GET /reports/salary-journal.

**Pitfalls:**
- salary_entry_id / avgifter_entry_id / vacation_entry_id are null until POST /book has run. They reference the journal_entries table.
- total_* fields are 0 until POST /calculate has run.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    period_year: number,
    period_month: number,
    payment_date: string,
    status: "draft" | "review" | "approved" | "paid" | "booked" | "corrected",
    voucher_series: string,
    total_gross: number,
    total_tax: number,
    total_net: number,
    total_avgifter: number,
    total_vacation_accrual: number,
    total_employer_cost: number,
    salary_entry_id: string,
    avgifter_entry_id: string,
    vacation_entry_id: string,
    agi_generated_at: string,
    agi_submitted_at: string,
    calculation_params?: unknown,
    approved_by: string,
    approved_at: string,
    paid_at: string,
    booked_at: string,
    booked_by: string,
    notes: string,
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
    "id": "run_a8f1…",
    "period_year": 2026,
    "period_month": 5,
    "payment_date": "2026-05-25",
    "status": "approved",
    "total_gross": 105000,
    "total_tax": -28500,
    "total_net": 76500,
    "total_avgifter": 32991,
    "total_employer_cost": 137991
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/salary-runs/{id}`

**Update a draft salary run.**
`scope:payroll:write · risk:low · idempotent · dry-run`

Updates payment_date, voucher_series, or notes on a draft salary run. ONLY allowed when status === "draft": once :calculate has advanced the run to review, these fields are frozen because they feed into the verifikation that :book will eventually post.

**Use when:** You created a draft, then noticed payment_date should be different (e.g. moved from the 25th to the 23rd) before running :calculate.
**Do not use for:** Changing period_year / period_month (immutable: DELETE the draft and create a new one). Modifying employees in the run (not in v1 PR-1 scope).

**Pitfalls:**
- Returns 400 SALARY_RUN_PATCH_NOT_DRAFT if status !== "draft".
- period_year + period_month are immutable post-create.
- payment_date must stay within the run's period month (400 SALARY_RUN_PAYMENT_DATE_OUTSIDE_PERIOD otherwise): the AGI is declared per payment month. A run whose current payment date already sits outside the period month may still be day-adjusted within that same month.
- Supplying payment_date clears every roster row's calculation_breakdown, so an already-calculated run must be recalculated before :approve/:book.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ payment_date?: string, voucher_series?: string, notes?: string }
```

Example request:
```json
{
  "payment_date": "2026-05-23"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    period_year: number,
    period_month: number,
    payment_date: string,
    status: "draft" | "review" | "approved" | "paid" | "booked" | "corrected",
    voucher_series: string,
    total_gross: number,
    total_tax: number,
    total_net: number,
    total_avgifter: number,
    total_vacation_accrual: number,
    total_employer_cost: number,
    salary_entry_id: string,
    avgifter_entry_id: string,
    vacation_entry_id: string,
    agi_generated_at: string,
    agi_submitted_at: string,
    calculation_params?: unknown,
    approved_by: string,
    approved_at: string,
    paid_at: string,
    booked_at: string,
    booked_by: string,
    notes: string,
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
    "id": "run_…",
    "payment_date": "2026-05-23",
    "status": "draft"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/salary-runs/{id}`

**Delete a draft salary run.**
`scope:payroll:write · risk:low · idempotent · dry-run`

Hard-deletes a salary run. ONLY allowed when status === "draft": once the run has calculated numbers or posted a verifikation, BFL 5 kap immutability applies and storno is the only correction path. CASCADE deletes salary_run_employees and salary_line_items.

**Use when:** You created a run by mistake or want to recreate it with different period_month. Only draft runs can be deleted.
**Do not use for:** Reverting a booked run (use the internal /correct flow; v1 promotion deferred). Hiding a run from listings (no soft-delete on this table: drafts are truly removed).

**Pitfalls:**
- Returns 400 SALARY_RUN_DELETE_NOT_DRAFT for any status other than draft.
- Hard delete: the salary_run_employees + salary_line_items rows cascade away.
- Idempotent in the absent-row sense: DELETE on a non-existent id returns 404 SALARY_RUN_NOT_FOUND rather than re-emitting a deletion event.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `204`.

---

### `POST /api/v1/companies/{companyId}/salary-runs/{id}/approve`

**Approve a reviewed salary run.**
`scope:payroll:write · risk:low · idempotent · dry-run`

Advances a salary run from `review` to `approved` after validating every employee has the data required for the payment step (bank account + clearing number for the bank transfer) and the booking step (`calculation_breakdown` proves `:calculate` ran). Records the approving user + timestamp. Strict-mode: validation errors return a complete list rather than failing on the first one.

**Use when:** You have a salary run in `review` status and want to authorize it for payment. This is the human (or agent) signoff step before money moves; the verifikation is still pending and won't exist until `:book` runs.
**Do not use for:** Posting journal entries (use `:book` after `:mark-paid`). Reverting an approval (the lifecycle has no `:unapprove`: call `:correct` once the run is booked if you need to undo).

**Pitfalls:**
- Run must be in `review`: non-`review` runs return 400 SALARY_RUN_APPROVE_NOT_REVIEW.
- Every employee on the run needs a `clearing_number` + `bank_account_number`. Missing bank details return 400 SALARY_RUN_APPROVE_VALIDATION_FAILED with the per-employee list.
- Every employee on the run needs `calculation_breakdown` populated. If you skipped `:calculate` somehow, approve fails.
- Employees without email get a non-blocking warning (lönebesked can't be sent automatically).
- No period-lock check here: that lives on `:book` where the verifikation is posted. An agent can approve a run whose payment date falls in a now-locked period; `:book` will later refuse.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, status: "approved", approved_at: string, approved_by: string, warnings: string[] },
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
    "id": "run_a8f1…",
    "status": "approved",
    "approved_at": "2026-05-14T12:00:00Z",
    "approved_by": "user_b73c…",
    "warnings": [
      "Anna Andersson: E-post saknas, lönebesked kan inte skickas"
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/salary-runs/{id}/book`

**Post the verifikationer for a paid salary run.**
`scope:payroll:write · risk:high · idempotent · dry-run`

Creates 2-4 journal entries (1: salary brutto/tax/net; 2: arbetsgivaravgifter; 3 if applicable: semesterlöneskuld accrual; 4 if applicable: pension + SLP from löneväxling), then advances status `paid` → `booked` with all the entry IDs recorded on the salary_runs row. Strict-mode: any engine failure aborts BEFORE the status flip: the run stays in `paid` so the caller can fix the cause (locked period, missing BAS account, etc.) and retry.

**Use when:** You've marked a salary run as paid and want to post the BFL-required verifikationer. This is the final lifecycle verb before AGI generation; after :book, the run can no longer be edited and corrections must use the (forthcoming) `:correct` verb.
**Do not use for:** Posting salary entries outside the salary-run lifecycle (use POST /journal-entries directly). Re-booking an already-booked run (returns 400 SALARY_RUN_BOOK_NOT_PAID).

**Pitfalls:**
- Run must be in `paid`: non-`paid` runs return 400 SALARY_RUN_BOOK_NOT_PAID.
- payment_date must fall in an open fiscal period: locked period returns 400 PERIOD_LOCKED with `fiscal_period_id` and a hint of what unlock action is needed.
- BFL 5 kap immutability: once `:book` succeeds the verifikationer cannot be edited or deleted. Corrections require `:correct` (Phase 5 PR-3) which does a storno-then-rebook.
- The salary verifikation is the primary one; its voucher_number appears in the response audit block. The avgifter, vacation, and pension entries get separate voucher numbers (returned as `entry_ids`).
- Strict-mode: if the engine fails partway, the salary_runs row stays in `paid`. There is no "partial booking": the engine either commits all entries or the entire booking fails.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    status: "booked",
    booked_at: string,
    booked_by: string,
    salary_entry_id: string,
    avgifter_entry_id: string,
    vacation_entry_id: string,
    pension_entry_id: string,
    entry_ids: string[]
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
    "id": "run_a8f1…",
    "status": "booked",
    "booked_at": "2026-05-26T09:15:00Z",
    "booked_by": "user_b73c…",
    "salary_entry_id": "je_salary…",
    "avgifter_entry_id": "je_avg…",
    "vacation_entry_id": "je_vac…",
    "pension_entry_id": null,
    "entry_ids": [
      "je_salary…",
      "je_avg…",
      "je_vac…"
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12",
    "audit": {
      "voucher_number": "L2026-0023",
      "voucher_url": "/api/v1/companies/.../journal-entries/je_salary…",
      "immutable_at": "2026-05-26T09:15:00Z"
    }
  }
}
```

---

### `POST /api/v1/companies/{companyId}/salary-runs/{id}/calculate`

**Calculate a draft salary run and advance it to review.**
`scope:payroll:write · risk:medium · idempotent · dry-run`

Runs the per-employee payroll calculation (tax withholding, employer contributions, vacation accrual) for every employee on a draft run, persists the line items + run totals + calculation_params snapshot, then promotes status from draft to review in a single atomic verb. Returns the updated run plus a `warnings` array surfacing non-blocking issues (Skatteverket tax-table fallback, läkarintyg day-8 transition, Försäkringskassan day-15 transition, F-skatt not-verified employees). Strict-mode: any failure (validation, tax-table unavailable, DB error) aborts before the status flip: the run stays in draft.

**Use when:** You have a draft salary run with employees added and want to compute the numbers + freeze them for approval. This is the first lifecycle verb after creating a run.
**Do not use for:** re-running a salary run already in review or later (only `draft` is accepted: call POST :correct in Phase 5 PR-3 once that ships to revise a booked run). Adding employees to the run (that surface is not yet on v1; use the dashboard).

**Pitfalls:**
- Run must be in `draft` status: calculate on a non-draft run returns 400 SALARY_RUN_CALCULATE_NOT_DRAFT.
- Salary run must have at least one employee: empty runs return 400 SALARY_RUN_NO_EMPLOYEES.
- If Skatteverket's tax-table API is down and local fallback is missing the required table, calculate returns 503 SALARY_RUN_TAX_TABLE_MISSING. Retry is safe; the operation is idempotent at the helper level.
- F-skatt "not_verified" employees produce a non-blocking warning; an integrator should treat the warning as a hard signal that withholding will be wrong until F-skatt is verified.
- Warnings about tax-table fallback or läkarintyg / FK day-15 transitions are non-blocking; the run still advances to review. Surface them to a human reviewer before calling :approve.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    status: "review",
    period_year: number,
    period_month: number,
    total_gross: number,
    total_tax: number,
    total_net: number,
    total_avgifter: number,
    total_employer_cost: number,
    warnings: string[]
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
    "id": "run_a8f1…",
    "status": "review",
    "period_year": 2026,
    "period_month": 5,
    "total_gross": 105000,
    "total_tax": 28500,
    "total_net": 76500,
    "total_avgifter": 32991,
    "total_employer_cost": 137991,
    "warnings": [
      "Läkarintyg krävs från och med dag 8: Anna Andersson. Kontrollera att läkarintyg finns innan lönekörningen godkänns."
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/salary-runs/{id}/employees`

**List per-employee results of a salary run.**
`scope:payroll:read · risk:low · idempotent`

Returns one row per employee in the run with the calculated aggregates: gross salary, tax withheld, net pay, arbetsgivaravgifter, vacation accrual, and absence day counts. All aggregate fields are 0 until POST /calculate has run. Cursor pagination on (created_at, id).

**Use when:** You need the per-employee outcome of a run: to review before approval, to reconcile against an external system, or to pick an employee_id for the payslip drill-in.
**Do not use for:** Payslip line items or the step-by-step calculation breakdown: use GET /salary-runs/{id}/employees/{employeeId}. The employee master record: use GET /employees/{id}.

**Pitfalls:**
- Aggregates are 0 until POST /calculate has advanced the run to review.
- tax_withheld_override / avgifter_amount_override are review-stage manual adjustments; the effective value is COALESCE(override, calculated).
- personnummer is masked on all payslip-shaped responses (GDPR Art.5(1)(c)); the employee detail endpoint returns the full value.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { salary_run_employee_id: string, employee_id: string, first_name: string, last_name: string, personnummer_masked: string, salary_type: string, employment_degree: number, monthly_salary: number, hours_worked: number, gross_salary: number, taxable_income: number, tax_withheld: number, tax_withheld_override: number, net_salary: number, avgifter_basis: number, avgifter_amount: number, avgifter_amount_override: number, avgifter_category: string, vacation_accrual: number, sick_days: number, vab_days: number, parental_days: number, vacation_days_taken: number, created_at: string, updated_at: string }[],
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
      "salary_run_employee_id": "sre_a8f1…",
      "employee_id": "emp_77b2…",
      "first_name": "Anna",
      "last_name": "Andersson",
      "personnummer_masked": "YYYYMMDDXXXX",
      "salary_type": "monthly",
      "gross_salary": 35000,
      "tax_withheld": -8200,
      "net_salary": 26800,
      "avgifter_amount": 10997
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

### `POST /api/v1/companies/{companyId}/salary-runs/{id}/employees`

**Add an employee to a draft salary run.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Attaches an active employee to a draft run: snapshots their pay configuration (salary, degree, tax table) onto the run and seeds the base salary line (Grundlön/Timlön). For hourly employees, pass hours_worked.

**Use when:** The run was created without this employee (e.g. hired after the run was drafted), or you create runs empty and attach employees one by one from an external system.
**Do not use for:** Changing an attached employee's pay for this month (internal per-run PATCH; not on v1). Re-attaching after removal is fine: the snapshot is retaken.

**Pitfalls:**
- Draft-only: 400 SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run has advanced.
- Attaching twice returns 409 SALARY_RUN_EMPLOYEE_DUPLICATE.
- The snapshot freezes salary/degree/tax-table at attach time: later employee edits do not flow into this run.
- Inactive (soft-deleted) employees cannot be attached: 404 EMPLOYEE_NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ employee_id: string, hours_worked?: number }
```

Example request:
```json
{
  "employee_id": "emp_77b2…"
}
```

Response `200`:
```ts
{
  data: {
    salary_run_employee_id: string,
    employee_id: string,
    salary_type: string,
    employment_degree: number,
    monthly_salary: number,
    hours_worked: number,
    tax_table_number: number,
    tax_column: number
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
    "salary_run_employee_id": "sre_a8f1…",
    "employee_id": "emp_77b2…",
    "salary_type": "monthly",
    "monthly_salary": 35000
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/salary-runs/{id}/employees/{employeeId}`

**Get one employee's payslip in a salary run.**
`scope:payroll:read · risk:low · idempotent`

Returns the full payslip for one employee in a run: gross/tax/net aggregates, arbetsgivaravgifter with category, vacation accrual, YTD accumulators, every payslip line item (grundlön, tillägg, avdrag, förmåner), and the step-by-step calculation_breakdown recorded by the engine.

**Use when:** You need to verify how a specific employee's pay was computed: reviewing a run before approval, answering "why is the tax this amount", or rendering a payslip in an external system.
**Do not use for:** The rendered PDF payslip: use GET /salary-runs/{id}/payslips/{employeeId}/pdf. Editing line items: POST/PATCH/DELETE on the lines endpoints.

**Pitfalls:**
- calculation_breakdown is null and aggregates are 0 until POST /calculate has run.
- line_items include engine-derived rows (absence, benefits) that are regenerated on every :calculate; manual rows survive recalculation.
- The effective tax is COALESCE(tax_withheld_override, tax_withheld); same for avgifter overrides.
- personnummer is masked here (GDPR Art.5(1)(c)); GET /employees/{id} is the identity drill-in.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `employeeId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    salary_run_employee_id: string,
    salary_run_id: string,
    employee_id: string,
    first_name: string,
    last_name: string,
    personnummer_masked: string,
    salary_type: string,
    employment_degree: number,
    monthly_salary: number,
    hours_worked: number,
    gross_salary: number,
    gross_deductions: number,
    benefit_values: number,
    taxable_income: number,
    tax_withheld: number,
    tax_withheld_override: number,
    net_deductions: number,
    net_salary: number,
    avgifter_rate: number,
    avgifter_basis: number,
    avgifter_amount: number,
    avgifter_basis_override: number,
    avgifter_amount_override: number,
    avgifter_category: string,
    override_reason: string,
    vacation_accrual: number,
    vacation_accrual_avgifter: number,
    tax_table_number: number,
    tax_column: number,
    tax_table_year: number,
    sick_days: number,
    vab_days: number,
    parental_days: number,
    vacation_days_taken: number,
    ytd_gross: number,
    ytd_tax: number,
    ytd_net: number,
    calculation_breakdown?: unknown,
    line_items: { salary_line_item_id: string, item_type: string, description: string, quantity: number, unit_price: number, amount: number, is_taxable: boolean, is_avgift_basis: boolean, is_vacation_basis: boolean, is_gross_deduction: boolean, is_net_deduction: boolean, account_number: string, sort_order: number }[],
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
    "salary_run_employee_id": "sre_a8f1…",
    "employee_id": "emp_77b2…",
    "first_name": "Anna",
    "last_name": "Andersson",
    "personnummer_masked": "YYYYMMDDXXXX",
    "gross_salary": 35000,
    "tax_withheld": -8200,
    "net_salary": 26800,
    "line_items": [
      {
        "salary_line_item_id": "sli_31c9…",
        "item_type": "monthly_salary",
        "description": "Grundlön",
        "amount": 35000
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

### `PATCH /api/v1/companies/{companyId}/salary-runs/{id}/employees/{employeeId}`

**Set this run's base salary for one employee.**
`scope:payroll:write · risk:medium · idempotent · dry-run · reversible`

Sets the per-run base salary (salary_run_employees.monthly_salary) that the calculation engine reads for this run. The employee master record is untouched, so each month's gross can differ from the employee's standard pay (variable owner salary). Draft-only; 0 is a valid nollkörning.

**Use when:** The employee's pay this month differs from their configured fixed salary: owners taking salary by need and capacity, one-off adjustments, or a deliberate zero month.
**Do not use for:** Changing the employee's standard salary going forward: PATCH /employees/{id}. Editing individual payslip lines (tillägg/avdrag): the lines endpoints. Tax/avgifter overrides in review: not exposed on v1 yet.

**Pitfalls:**
- Draft-only: 400 SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run has advanced.
- Run POST /calculate afterwards: gross, tax and totals reflect the new salary only after recalculation.
- Do NOT edit the monthly_salary line item instead: recalculation rebuilds base salary lines from this per-run value.
- For hourly employees the value is stored but gross derives from hours worked; the salary_type field in the response tells you which applies.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `employeeId` | path | `string` | yes |  |

Request body:
```ts
{ monthly_salary: number }
```

Example request:
```json
{
  "monthly_salary": 45000
}
```

Response `200`:
```ts
{
  data: {
    salary_run_employee_id: string,
    employee_id: string,
    salary_type: string,
    employment_degree: number,
    previous_monthly_salary: number,
    monthly_salary: number
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
    "salary_run_employee_id": "sre_a8f1…",
    "employee_id": "emp_77b2…",
    "salary_type": "monthly",
    "employment_degree": 100,
    "previous_monthly_salary": 30000,
    "monthly_salary": 45000
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/salary-runs/{id}/employees/{employeeId}`

**Remove an employee from a draft salary run.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Detaches the employee from the run and cascades away their payslip line items. Draft-only. The employee master record is untouched: this only affects the run roster.

**Use when:** An employee should not be paid this period (unpaid leave the whole month, employment ended) but was auto-added when the run was created.
**Do not use for:** Deactivating the employee entirely: DELETE /employees/{id} (soft-delete). Zero-salary months: keep them in the run with a 0 base instead if you want a nollkörning on record.

**Pitfalls:**
- Draft-only: 400 SALARY_RUN_EMPLOYEES_NOT_DRAFT once the run has advanced.
- Cascade-deletes the employee's line items in this run, including manual ones.
- Re-attaching later retakes the pay snapshot from the employee master.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `employeeId` | path | `string` | yes |  |

Response `204`.

---

### `POST /api/v1/companies/{companyId}/salary-runs/{id}/employees/{employeeId}/lines`

**Add a payslip line to an employee in a draft salary run.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Creates a salary_line_items row (bonus, overtime, gross/net deduction, benefit, traktamente, ...) for one employee in a draft run. account_number auto-resolves from item_type when omitted. Amounts are rounded to whole öre.

**Use when:** You need to add a one-off pay component before calculating: a bonus, an expense reimbursement, a union fee, or a manual correction line.
**Do not use for:** Editing the base monthly salary (PATCH the run-employee via the internal surface; not on v1 yet). Absence: register absence days instead (PUT /employees/{id}/absence); the engine derives sick/VAB lines itself.

**Pitfalls:**
- Draft-only: returns 400 SALARY_RUN_LINE_NOT_DRAFT once the run has advanced.
- Line edits do not recompute tax or totals: call POST /salary-runs/{id}/calculate afterwards.
- Engine-derived lines (absence, benefits) are regenerated on every :calculate; manual lines survive.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `employeeId` | path | `string` | yes |  |

Request body:
```ts
{
  item_type: "monthly_salary" | "hourly_salary" | "overtime" | "overtime_50" | "overtime_100" | "ob_weekday_evening" | "ob_weekend" | "ob_night" | "ob_holiday" | "bonus" | "commission" | "gross_deduction_pension" | "gross_deduction_other" | "benefit_car" | "benefit_housing" | "benefit_meals" | "benefit_wellness" | "benefit_bike" | "benefit_other" | "sick_karens" | "sick_day2_14" | "sick_day15_plus" | "vab" | "parental_leave" | "vacation" | "semesterersattning" | "traktamente_taxfree" | "traktamente_taxable" | "mileage_taxfree" | "mileage_taxable" | "net_deduction_advance" | "net_deduction_union" | "net_deduction_benefit_payment" | "net_deduction_other" | "correction" | "other",
  description: string,
  quantity?: number,
  unit_price?: number,
  amount: number,
  is_taxable?: boolean,
  is_avgift_basis?: boolean,
  is_vacation_basis?: boolean,
  is_gross_deduction?: boolean,
  is_net_deduction?: boolean,
  account_number?: string,
  sort_order?: number
}
```

Example request:
```json
{
  "item_type": "bonus",
  "description": "Kvartalsbonus Q2",
  "amount": 5000
}
```

Response `200`:
```ts
{
  data: {
    salary_line_item_id: string,
    salary_run_employee_id: string,
    item_type: string,
    description: string,
    quantity: number,
    unit_price: number,
    amount: number,
    is_taxable: boolean,
    is_avgift_basis: boolean,
    is_vacation_basis: boolean,
    is_gross_deduction: boolean,
    is_net_deduction: boolean,
    account_number: string,
    sort_order: number
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
    "salary_line_item_id": "sli_31c9…",
    "item_type": "bonus",
    "description": "Kvartalsbonus Q2",
    "amount": 5000,
    "account_number": "7210"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/salary-runs/{id}/generate-agi`

**Generate the Skatteverket AGI XML for a salary run.**
`scope:payroll:write · risk:medium · idempotent`

Generates the arbetsgivardeklaration-på-individnivå XML for the run (HU section + per-employee IU + Frånvarouppgift for VAB/parental), upserts the agi_declarations row (correction-aware), stamps salary_runs.agi_generated_at, emits `agi.generated`, and auto-completes the `arbetsgivardeklaration` deadline. Returns the XML as a string field in the v1 envelope: agents extract `data.xml` and forward to Skatteverket directly (Mina Sidor upload or via a connected extension).

**Use when:** You've reviewed (or approved / paid / booked) a salary run and need to file AGI with Skatteverket. The Skatteverket filing deadline is the 12th of the following month (17th in Jan / Aug for companies ≤40 MSEK turnover).
**Do not use for:** Submitting the AGI to Skatteverket: this endpoint only generates and persists the XML. Submission is a separate flow via the (optional) `skatteverket` extension.

**Pitfalls:**
- Run status must be one of review, approved, paid, booked, corrected: `draft` returns 400 AGI_GENERATE_NOT_BOOKABLE.
- Generating AGI from a `review`-status run risks submitting figures that will change at `:approve`. The dashboard allows this for flexibility; agents should prefer `approved+` unless an early-warning workflow specifically wants the preview.
- Subsequent calls for the same period UPDATE the agi_declarations row (is_correction=true) and overwrite the XML. The FK570 specifikationsnummer stays consistent per employee: different number = new record per Skatteverket spec.
- AGI_INCOMPLETE_DATA returns 400 when company contact info is missing (org_number, contact name, phone, email). Fix via /settings/company before retrying.
- The XML content is räkenskapsinformation: BFL 7 kap retention applies. The agi_declarations row is never auto-deleted.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    agi_declaration_id: string,
    period_year: number,
    period_month: number,
    employee_count: number,
    is_correction: boolean,
    totals: { totalTax: number, totalAvgifterBasis: number, totalAvgifterAmount: number, totalSjuklonekostnad: number, avgifterByCategory: Record<string, { basis: number, amount: number }> },
    xml: string,
    xml_filename: string
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
    "agi_declaration_id": "agi_a8f1…",
    "period_year": 2026,
    "period_month": 5,
    "employee_count": 3,
    "is_correction": false,
    "totals": {
      "totalTax": 28500,
      "totalAvgifterBasis": 105000,
      "totalAvgifterAmount": 32991,
      "totalSjuklonekostnad": 0,
      "avgifterByCategory": {
        "standard": {
          "basis": 105000,
          "amount": 32991
        }
      }
    },
    "xml": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Skatteverket omrade=\"Arbetsgivardeklaration\">…</Skatteverket>",
    "xml_filename": "AGI_5566778899_202605.xml"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/salary-runs/{id}/lines/{lineId}`

**Update a payslip line in a draft salary run.**
`scope:payroll:write · risk:low · idempotent · dry-run · reversible`

Updates fields on a salary_line_items row (amount, description, quantity, unit_price, flags, account_number) while the run is a draft. Amounts are rounded to whole öre.

**Use when:** You spotted a wrong amount or description on a manual line before calculating: fix it in place instead of delete + recreate.
**Do not use for:** Post-calculation tax/avgifter adjustments (review-stage overrides are not on v1). Engine-derived lines (absence/benefits): they are regenerated by :calculate, so edits are overwritten.

**Pitfalls:**
- Draft-only: 400 SALARY_RUN_LINE_NOT_DRAFT once the run has advanced.
- A lineId that belongs to a different run returns 404 SALARY_LINE_NOT_FOUND.
- Line edits do not recompute tax or totals: call POST /salary-runs/{id}/calculate afterwards.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `lineId` | path | `string` | yes |  |

Request body:
```ts
{
  item_type?: "monthly_salary" | "hourly_salary" | "overtime" | "overtime_50" | "overtime_100" | "ob_weekday_evening" | "ob_weekend" | "ob_night" | "ob_holiday" | "bonus" | "commission" | "gross_deduction_pension" | "gross_deduction_other" | "benefit_car" | "benefit_housing" | "benefit_meals" | "benefit_wellness" | "benefit_bike" | "benefit_other" | "sick_karens" | "sick_day2_14" | "sick_day15_plus" | "vab" | "parental_leave" | "vacation" | "semesterersattning" | "traktamente_taxfree" | "traktamente_taxable" | "mileage_taxfree" | "mileage_taxable" | "net_deduction_advance" | "net_deduction_union" | "net_deduction_benefit_payment" | "net_deduction_other" | "correction" | "other",
  description?: string,
  quantity?: number,
  unit_price?: number,
  amount?: number,
  is_taxable?: boolean,
  is_avgift_basis?: boolean,
  is_vacation_basis?: boolean,
  is_gross_deduction?: boolean,
  is_net_deduction?: boolean,
  account_number?: string,
  sort_order?: number
}
```

Example request:
```json
{
  "amount": 5500
}
```

Response `200`:
```ts
{
  data: {
    salary_line_item_id: string,
    salary_run_employee_id: string,
    item_type: string,
    description: string,
    quantity: number,
    unit_price: number,
    amount: number,
    is_taxable: boolean,
    is_avgift_basis: boolean,
    is_vacation_basis: boolean,
    is_gross_deduction: boolean,
    is_net_deduction: boolean,
    account_number: string,
    sort_order: number
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
    "salary_line_item_id": "sli_31c9…",
    "amount": 5500
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/salary-runs/{id}/lines/{lineId}`

**Delete a payslip line from a draft salary run.**
`scope:payroll:write · risk:low · idempotent · dry-run`

Removes a salary_line_items row while the run is a draft. Engine-derived lines (absence, benefits) reappear on the next :calculate; delete the underlying absence/benefit record instead.

**Use when:** A manual line (bonus, deduction) was added by mistake and the run has not been calculated/advanced yet.
**Do not use for:** Removing an employee from the run entirely: DELETE /salary-runs/{id}/employees/{employeeId}. Suppressing engine-derived lines: fix the source data (absence days, benefits).

**Pitfalls:**
- Draft-only: 400 SALARY_RUN_LINE_NOT_DRAFT once the run has advanced.
- Deleting an engine-derived line is futile: :calculate regenerates it from source data.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `lineId` | path | `string` | yes |  |

Response `204`.

---

### `POST /api/v1/companies/{companyId}/salary-runs/{id}/mark-paid`

**Mark an approved salary run as paid.**
`scope:payroll:write · risk:low · idempotent · dry-run`

Advances a salary run from `approved` to `paid` and stamps `paid_at`. This is the state-change verb after the bank transfer (or autogiro file) has been processed; it does NOT initiate payment, and does NOT post journal entries (use `:book` after this for that).

**Use when:** You've confirmed the salary payment hit employee bank accounts and want to advance the run's lifecycle so `:book` can post the verifikation.
**Do not use for:** Initiating the actual bank transfer (the v1 API does not yet expose payment-file generation; use the dashboard's payment-file endpoints). Posting journal entries (use `:book`). Reverting a paid run (no `:unpaid` exists: call `:correct` once booked if you need to undo).

**Pitfalls:**
- Run must be in `approved`: non-`approved` runs return 400 SALARY_RUN_MARK_PAID_NOT_APPROVED.
- paid_at is set server-side to the current UTC timestamp; the API does not accept a body-supplied date to keep BFL audit clean.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, status: "paid", paid_at: string },
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
    "id": "run_a8f1…",
    "status": "paid",
    "paid_at": "2026-05-25T08:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/salary-runs/{id}/payslips/{employeeId}/pdf`

**Download one employee's payslip as PDF.**
`scope:payroll:read · risk:low · idempotent`

Returns the rendered payslip (lönespecifikation) as application/pdf, byte-equivalent to the dashboard download. Content-Disposition is attachment with a filename derived from the period and employee name.

**Use when:** You need the payslip document itself: archiving, forwarding to the employee outside the Accounted send flow, or attaching to an external HR system.
**Do not use for:** The payslip DATA (amounts, line items): use GET /salary-runs/{id}/employees/{employeeId}, which is cheaper and structured. Emailing payslips to employees: the send flow is internal-only today.

**Pitfalls:**
- The PDF renders whatever the run currently holds: for a draft run that has not been calculated, amounts are 0.
- PDF rendering takes a few hundred milliseconds; cache on the client if requesting repeatedly.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `employeeId` | path | `string` | yes |  |

Response `200` (`application/pdf`).
