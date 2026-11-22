<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Reports endpoints

Read-only statutory and management reports: trial balance, balance sheet, income statement, general ledger, VAT declaration, AR/AP ledgers, salary journal, and SIE export. Budgets (GET/POST /budgets, amounts per resultatkonto, month and dimension in the SIE sign, revenue negative, a file read in by POST /budgets/{id}/import from SIE #PBUDGET or Excel/CSV) are compared with the books by GET /reports/budget-vs-actual. Only income-statement, general-ledger, monthly-breakdown, kpi and budget-vs-actual take the dim_no + dim_code filter; every other report answers a dimension filter with 400 VALIDATION_ERROR, never an unfiltered report. Any other query parameter a report does not list is not applied and is named in the X-Ignored-Query-Params response header. Defined measures (GET /measures/{id}) answer one figure equal to its report (moms att betala, kundfordringar, banksaldo, resultat ...) with its definition, caveats and an explain call down to every journal line; they refuse unknown parameters. The unexplained queue (GET /unexplained) runs the checks of differences that should be zero (reskontra against the ledger, bank and skattekonto against the outside balance, declared moms not settled, overdue unbooked bank rows) and explains each down to the records behind it. The liquidity forecast (GET /cash-forecast) projects the bank balance 13 ISO weeks ahead from open invoices, payment orders, salary, taxes and forecast rows; the rows (/cash-forecast-rows) are not bookkeeping and are written directly under forecast:write.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/audit-trail`

**The audit log: every trigger-recorded change to the books and their settings, newest first.**
`scope:reports:read · risk:low · idempotent`

Rows the database triggers write on every insert, update and delete of bookkeeping tables (verifikationer and their lines, kontoplan, fiscal periods, settings, suppliers, imports, ...) and on commits, reversals, corrections and locks: action, table, record id, actor (user, API key, MCP connection, cron), description and the old and new row state. Filter by action, table_name, record_id and a created_at window. Cursor pagination: pass next_cursor back as cursor; next_cursor is null on the last page. Read-only: nothing can write the log except the triggers.

**Use when:** Tracing exactly how one record changed (record_id), or exporting the raw log for an auditor.
**Do not use for:** The readable processing history for a räkenskapsår (GET /reports/behandlingshistorik).

**Pitfalls:**
- old_state / new_state are whole row snapshots and can hold personal data (a sole trader's org number is the owner's personnummer, supplier bank details): only an owner or admin of the company receives them (snapshots_included true). Other callers get old_state/new_state null and changed_fields, the column names that changed.
- from_date / to_date compare against the created_at timestamp: to_date=2026-01-31 stops at 2026-01-31T00:00:00Z. Pass the next day to include all of the 31st.
- The page is in data.entries with data.next_cursor; a cursor that no longer decodes starts from the first page.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `action` | query | `"INSERT" \| "UPDATE" \| "DELETE" \| "COMMIT" \| "REVERSE" \| "CORRECT" \| "LOCK_PERIOD" \| "CLOSE_PERIOD" \| "DOCUMENT_DELETE_BLOCKED" \| "RETENTION_BLOCK" \| "SECURITY_EVENT" \| "INTEGRITY_FAILURE" \| "COMMITTED_AT_OVERRIDE"` | no | Only this action (INSERT, UPDATE, DELETE, COMMIT, REVERSE, CORRECT, LOCK_PERIOD, CLOSE_PERIOD, ...). |
| `table_name` | query | `string` | no | Only rows about this table, e.g. journal_entries. |
| `record_id` | query | `string` | no | Only rows about this record id. |
| `from_date` | query | `string` | no | created_at on or after this date (YYYY-MM-DD). |
| `to_date` | query | `string` | no | created_at on or before this date's midnight (YYYY-MM-DD). |
| `cursor` | query | `string` | no | next_cursor from the previous page. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-200 (default 50). |

Response `200`:
```ts
{
  data: {
    entries: { id: string, handle?: string, action: string, table_name: string | null, record_id: string | null, user_id: string | null, actor_type: string | null, actor_label: string | null, description: string | null, old_state: Record<string, unknown> | null, new_state: Record<string, unknown> | null, changed_fields?: string[], created_at: string }[],
    next_cursor: string | null,
    snapshots_included: boolean
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
    "entries": [
      {
        "id": "0d5e…",
        "action": "COMMIT",
        "table_name": "journal_entries",
        "record_id": "9a0b…",
        "actor_type": "api_key",
        "actor_label": "Integration",
        "description": "Verifikation A12 bokförd",
        "old_state": null,
        "new_state": {
          "status": "posted"
        },
        "created_at": "2026-03-02T09:14:00Z"
      }
    ],
    "next_cursor": "eyJ0cyI6…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/budgets`

**List the budgets (named versions per fiscal year).**
`scope:reports:read · risk:low · idempotent`

Returns the company's budgets, oldest first: each is one named version of a fiscal year's budget, and at most one per year is the default that reports read when no budget is named. Archived budgets are left out unless include_archived is true.

**Use when:** Before reading or changing a budget, to find its budget_id, or to see which version of a year is the default.
**Do not use for:** The amounts themselves (GET /budgets/{id}) or the comparison with the books (GET /reports/budget-vs-actual).

**Pitfalls:**
- A company without budgets gets an empty list.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `fiscal_period_id` | query | `string` | no | The fiscal year (fiscal_period_id). |
| `include_archived` | query | `boolean \| "true" \| "false"` | no | Also list archived budgets. Default false. |

Response `200`:
```ts
{
  data: {
    budgets: { budget_id: string, fiscal_period_id: string, name: string, is_default: boolean, archived: boolean, archived_at: string | null, created_at: string, updated_at: string }[]
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
    "budgets": [
      {
        "budget_id": "7c1d…",
        "fiscal_period_id": "a8f1…",
        "name": "Budget 2027",
        "is_default": true,
        "archived": false,
        "archived_at": null,
        "created_at": "2026-11-02T09:00:00Z",
        "updated_at": "2026-11-02T09:00:00Z"
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

### `POST /api/v1/companies/{companyId}/budgets`

**Create a budget for a fiscal year.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Creates an empty, named budget version for one fiscal year. The name is unique within the year. The first budget of a year becomes its default unless is_default is false; is_default true on a later one moves the default to it. Fill it with POST /budgets/{id}/lines, /copy-actuals or /spread. Dry-runnable.

**Use when:** Starting a year's budget, or a second version of it (a forecast, a scenario).
**Do not use for:** Changing an existing budget (PATCH /budgets/{id}).

**Pitfalls:**
- A name the year already has (case ignored) answers 409 BUDGET_NAME_TAKEN.
- fiscal_period_id must be one of the company's fiscal years: 404 PERIOD_NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ fiscal_period_id: string, name: string, is_default?: boolean }
```

Example request:
```json
{
  "fiscal_period_id": "a8f1…",
  "name": "Budget 2027"
}
```

Response `200`:
```ts
{
  data: {
    budget: { budget_id: string, fiscal_period_id: string, name: string, is_default: boolean, archived: boolean, archived_at: string | null, created_at: string, updated_at: string }
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
    "budget": {
      "budget_id": "7c1d…",
      "fiscal_period_id": "a8f1…",
      "name": "Budget 2027",
      "is_default": true,
      "archived": false,
      "archived_at": null,
      "created_at": "2026-11-02T09:00:00Z",
      "updated_at": "2026-11-02T09:00:00Z"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/budgets/{id}`

**Read one budget and its amounts per account, month and dimension.**
`scope:reports:read · risk:low · idempotent`

Returns the budget and its lines, ordered by account and month, paged (limit, offset; has_more and total_lines say whether more follow). A line is one amount for one resultatkonto, one month and one dimension tag ({} untagged).

**Use when:** To read or check the amounts of a budget, e.g. before changing them.
**Do not use for:** Budget against booked result (GET /reports/budget-vs-actual).

**Pitfalls:**
- Amounts are in the SIE sign, debit positive: a revenue budget on class 3 is NEGATIVE (-1200000 for 1,2 Mkr sales), a cost budget positive.
- A month with no line has no budget (0).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `account_number` | query | `string` | no | A resultatkonto, 3000-8999, as a STRING of 4 digits, never a number. |
| `limit` | query | `number` | no | Lines per page, 1-1000 (default 1000). |
| `offset` | query | `number` | no | Lines to skip (default 0). |

Response `200`:
```ts
{
  data: {
    budget: { budget_id: string, fiscal_period_id: string, name: string, is_default: boolean, archived: boolean, archived_at: string | null, created_at: string, updated_at: string },
    lines: { budget_line_id: string, account_number: string, month: string, dimensions: Record<string, string>, amount: number }[],
    total_lines: number,
    has_more: boolean
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
    "budget": {
      "budget_id": "7c1d…",
      "fiscal_period_id": "a8f1…",
      "name": "Budget 2027",
      "is_default": true,
      "archived": false,
      "archived_at": null,
      "created_at": "2026-11-02T09:00:00Z",
      "updated_at": "2026-11-02T09:00:00Z"
    },
    "lines": [
      {
        "budget_line_id": "0b3e…",
        "account_number": "3010",
        "month": "2027-01",
        "dimensions": {},
        "amount": -100000
      }
    ],
    "total_lines": 1,
    "has_more": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/budgets/{id}`

**Rename a budget, make it the default, or archive or restore it.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Sparse update: name, is_default (true moves the year's default to this budget), archived (true makes it read-only and never the default; false restores it). The fiscal year of a budget never changes. Dry-runnable.

**Use when:** Choosing which version a year's reports read, renaming one, or putting an old version aside.
**Do not use for:** Changing amounts (POST /budgets/{id}/lines).

**Pitfalls:**
- Send at least one of name, is_default, archived.
- An archived budget cannot be the default: 409 BUDGET_ARCHIVED.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{ name?: string, is_default?: boolean, archived?: boolean }
```

Example request:
```json
{
  "is_default": true
}
```

Response `200`:
```ts
{
  data: {
    budget: { budget_id: string, fiscal_period_id: string, name: string, is_default: boolean, archived: boolean, archived_at: string | null, created_at: string, updated_at: string }
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
    "budget": {
      "budget_id": "7c1d…",
      "fiscal_period_id": "a8f1…",
      "name": "Budget 2027",
      "is_default": true,
      "archived": false,
      "archived_at": null,
      "created_at": "2026-11-02T09:00:00Z",
      "updated_at": "2026-11-02T09:00:00Z"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/budgets/{id}`

**Delete a budget and its amounts.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run`

Removes the budget and every amount in it. A budget is planning data, not räkenskapsinformation (BFL 7 kap.), so it can be deleted at any time; the audit log keeps who did it. Archiving keeps it instead (PATCH archived=true). Dry-runnable: the preview counts the lines.

**Use when:** A budget version is no longer wanted.
**Do not use for:** Putting a version aside but keeping it (PATCH archived=true).

**Pitfalls:**
- A budget of another company, or one already deleted, answers 404 BUDGET_NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Response `200`:
```ts
{
  data: { deleted: true, budget_id: string },
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
    "budget_id": "7c1d…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/budgets/{id}/copy-actuals`

**Fill a budget with last year's booked result, optionally scaled.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Reads the booked result per resultatkonto and month of the source year (default: the year before the budget's year), with the resultatrapport's exclusions (no bokslut entries), and writes it into the budget month by month: March to March, scaled by percent_change. Each copied account gets every month of the year, so copying again replaces the earlier copy; accounts without actuals are left alone. With dimensions, only the tagged actuals are copied, into lines with the same tag. Dry-runnable.

**Use when:** Starting a budget from last year's figures, e.g. "last year plus 5 %".
**Do not use for:** A yearly amount for one account (POST /spread).

**Pitfalls:**
- Without a previous fiscal year, name one with source_fiscal_period_id: 404 BUDGET_SOURCE_YEAR_NOT_FOUND.
- Months are matched by calendar month; a source year that holds a month twice (18 months) gives its later one.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  source_fiscal_period_id?: string,
  percent_change?: number,
  dimensions?: Record<string, string>,
  account_numbers?: string[]
}
```

Example request:
```json
{
  "percent_change": 5
}
```

Response `200`:
```ts
{
  data: {
    budget_id: string,
    inserted: number,
    updated: number,
    deleted: number,
    unchanged: number,
    source_fiscal_period_id: string,
    accounts: string[]
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
    "budget_id": "7c1d…",
    "inserted": 24,
    "updated": 0,
    "deleted": 0,
    "unchanged": 0,
    "source_fiscal_period_id": "5c2e…",
    "accounts": [
      "3010",
      "5010"
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/budgets/{id}/import`

**Import a budget file (SIE #PBUDGET, Excel or CSV) into a budget.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Reads a budget file into one budget, all cells or none. A SIE file contributes its #PBUDGET rows (the month's budget per account and object, SIE sign); the rows for months of the budget's fiscal year are read and the file's other years are counted as skipped. A spreadsheet (xlsx, xls, csv, ods) is read in one of two layouts found from its header row: long (konto, månad as YYYY-MM, belopp, optionally dim and kod, or a projekt or kostnadsställe column) or wide (konto and one column per month, headed 2027-01 or jan). Accounts go through the same account mapping as the SIE ledger import, against the company's chart of accounts; an account the chart lacks, a balance account or an object the dimension registry lacks is skipped and named in details.skipped, never guessed. Dry-runnable: the dry run is the preview (what would be read, what is skipped and why, the budget per class and the result).

**Use when:** Moving a budget from Fortnox (its SIE export carries #PBUDGET) or from a spreadsheet, before following it up with GET /reports/budget-vs-actual.
**Do not use for:** A few cells (POST /budgets/{id}/lines), or the bookkeeping itself (POST /imports/sie).

**Pitfalls:**
- Send the file bytes base64-encoded in content_base64, up to about 3 MB of file; the filename's extension decides SIE or spreadsheet.
- A spreadsheet's sign is read from its class 3 rows unless sign is sent: revenue positive means revenue_positive. sign_suspect true in the answer means revenue reads as a cost or costs as revenue: check the sign before saving.
- replace true removes the budget's cells the file leaves out; without it the file is written over the budget and other cells stay.
- Nothing for the budget's year answers 400 BUDGET_IMPORT_NOTHING_TO_IMPORT with the skipped lists in details.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  sign?: "debit_positive" | "revenue_positive",
  replace?: boolean,
  filename: string,
  content_base64: string
}
```

Example request:
```json
{
  "filename": "budget-2027.xlsx",
  "content_base64": "UEsDBBQ…",
  "replace": true
}
```

Response `200`:
```ts
{
  data: {
    budget_id: string,
    inserted: number,
    updated: number,
    deleted: number,
    unchanged: number,
    format: "sie" | "long" | "wide",
    sign: "debit_positive" | "revenue_positive",
    detected_sign: "debit_positive" | "revenue_positive" | null,
    replace: boolean,
    rows_read: number,
    cells: number,
    accounts: number,
    mapped_accounts: { source: string, target: string }[],
    skipped: { accounts_not_in_chart: string[], balance_accounts: string[], unknown_objects: { dim_no: string, code: string }[], rows: number, months_outside_year: number, unreadable: { line: number, reason: "record" | "amount" | "month" | "dimension" }[], unreadable_count: number },
    file_years: { year_index: number, start: string, end: string }[],
    class_totals: { account_class: number, amount: number }[],
    result: number,
    sign_suspect: boolean
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
    "budget_id": "7c1d…",
    "inserted": 240,
    "updated": 0,
    "deleted": 0,
    "unchanged": 0,
    "format": "wide",
    "sign": "revenue_positive",
    "detected_sign": "revenue_positive",
    "replace": true,
    "rows_read": 240,
    "cells": 240,
    "accounts": 20,
    "mapped_accounts": [],
    "skipped": {
      "accounts_not_in_chart": [],
      "balance_accounts": [],
      "unknown_objects": [],
      "rows": 0,
      "months_outside_year": 0,
      "unreadable": [],
      "unreadable_count": 0
    },
    "file_years": [],
    "class_totals": [
      {
        "account_class": 3,
        "amount": 1200000
      }
    ],
    "result": 150000,
    "sign_suspect": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/budgets/{id}/lines`

**Save amounts in a budget (account, month, dimension cells).**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Writes each cell: one resultatkonto (3000-8999), one month (YYYY-MM) and one dimension tag ({} or omitted for untagged). A cell that exists gets the new amount, a new one is added, and amount 0 removes the cell. Every cell is saved or none is. The answer counts inserted, updated, deleted and unchanged cells. Dry-runnable.

**Use when:** Entering or adjusting budget amounts by hand, or loading a budget prepared elsewhere.
**Do not use for:** Last year's figures (POST /copy-actuals) or a yearly amount spread over the months (POST /spread).

**Pitfalls:**
- Amounts are in the SIE sign, debit positive: a revenue budget on class 3 is NEGATIVE (-1200000 for 1,2 Mkr sales), a cost budget positive.
- The account must be in the chart of accounts: 404 BUDGET_ACCOUNT_NOT_FOUND lists the missing ones.
- Months must lie in the budget's fiscal year: 400 BUDGET_MONTH_OUTSIDE_YEAR.
- One cell once per call: 400 BUDGET_LINES_DUPLICATE.
- An archived budget is read-only: 409 BUDGET_ARCHIVED.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  lines: { account_number: string, month: string, dimensions?: Record<string, string>, amount: number }[]
}
```

Example request:
```json
{
  "lines": [
    {
      "account_number": "3010",
      "month": "2027-01",
      "amount": -100000
    },
    {
      "account_number": "5010",
      "month": "2027-01",
      "dimensions": {
        "6": "P001"
      },
      "amount": 12000
    }
  ]
}
```

Response `200`:
```ts
{
  data: { budget_id: string, inserted: number, updated: number, deleted: number, unchanged: number },
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
    "budget_id": "7c1d…",
    "inserted": 2,
    "updated": 0,
    "deleted": 0,
    "unchanged": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/budgets/{id}/spread`

**Spread a yearly amount over the months of a budget.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Writes one account's yearly amount into every month of the budget's fiscal year: evenly (method even), or in proportion to the account's booked months last year (method last_year, so a seasonal account keeps its season). Each month is whole öre and the last month takes the remainder, so the months add up to the amount exactly. A last year that sums to zero falls back to even (fell_back_to_even). Dry-runnable: the preview shows the months.

**Use when:** The budget for an account is known per year ("3010: 1,2 Mkr").
**Do not use for:** Different amounts per month (POST /lines).

**Pitfalls:**
- Amounts are in the SIE sign, debit positive: a revenue budget on class 3 is NEGATIVE (-1200000 for 1,2 Mkr sales), a cost budget positive.
- The account's earlier months in the budget (same tag) are replaced.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  account_number: string,
  amount: number,
  method?: "even" | "last_year",
  dimensions?: Record<string, string>,
  source_fiscal_period_id?: string
}
```

Example request:
```json
{
  "account_number": "3010",
  "amount": -1200000,
  "method": "last_year"
}
```

Response `200`:
```ts
{
  data: {
    budget_id: string,
    inserted: number,
    updated: number,
    deleted: number,
    unchanged: number,
    account_number: string,
    method: "even" | "last_year",
    fell_back_to_even: boolean,
    months: { month: string, amount: number }[]
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
    "budget_id": "7c1d…",
    "inserted": 12,
    "updated": 0,
    "deleted": 0,
    "unchanged": 0,
    "account_number": "3010",
    "method": "last_year",
    "fell_back_to_even": false,
    "months": [
      {
        "month": "2027-01",
        "amount": -80000
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

### `GET /api/v1/companies/{companyId}/cash-forecast`

**The 13-week liquidity forecast: where the bank balance is heading, by day and by ISO week.**
`scope:reports:read · risk:low · idempotent`

Projects the bank balance from today: the opening balance (the banks' last reported balance, or the booked bank balance when no bank reports one, labelled), then every expected flow: open customer and supplier invoices on their due dates, the bank payment queue on its dates, salary runs as net pay, taxes through the skattekonto (Skatteverket's own debits, F-skatt, VAT and AGI), recurring invoices not created yet, and forecast rows. Answers 30 days by day and 13 ISO weeks (weeks, at most 26) as opening + in - out = closing, the lowest point flagged, and overdue invoices listed apart. Each flow is tagged known, derived or forecast; estimates say so. Read-only.

**Use when:** To answer "will we have money for X", find the week the balance is lowest, or plan payments.
**Do not use for:** The historical cash flow (GET /reports/kassaflodesanalys) or what is booked on the bank accounts (GET /measures/bank_balance).

**Pitfalls:**
- Each krona counts once: an invoice inside a payment order counts at the order's date; a salary run as net pay, its tax and avgifter through the skattekonto on the AGI's due date; a forecast row linked to an invoice yields to it.
- Overdue invoices are listed under overdue, not projected: nothing says when they will be paid.
- complete=false means a source could not be read; its caveat (SOURCE_UNAVAILABLE) names it.
- Estimates are flagged: VAT for a period not yet declared is the books so far; salary for a month without a run repeats the latest run.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `weeks` | query | `number` | no | ISO weeks to project, the current week first. Default 13. |

Response `200`:
```ts
{
  data: {
    currency: "SEK",
    today: string,
    horizon: { start: string, end: string, weeks: number },
    opening: { amount: number, source: "bank" | "booked" | "unknown", as_of: string | null, age_days: number | null, accounts: { cash_account_id: string | null, ledger_account: string, name: string | null, balance: number, balance_updated_at: string | null }[] },
    days: { date: string, opening: number, inflow: number, outflow: number, closing: number, lowest: boolean }[],
    weeks: { iso_week: string, start: string, end: string, opening: number, inflow: number, outflow: number, closing: number, min_closing: number, lowest: boolean }[],
    lowest: { date: string, closing: number, iso_week: string },
    closing: number,
    flows: { date: string, direction: "in" | "out", amount: number, kind: "known" | "derived" | "forecast", source: "customer_invoice" | "supplier_invoice" | "payment_order" | "salary_run" | "salary_estimate" | "skattekonto" | "vat" | "agi" | "f_skatt" | "recurring_invoice" | "forecast_row", estimate: boolean, counterparty: string | null, reference: string | null, ref: { type: "invoice" | "supplier_invoice" | "payment_order" | "salary_run" | "recurring_invoice_schedule" | "cash_forecast_row" | "skattekonto" | "vat_period" | "agi_period", id: string } | null, confidence: "firm" | "likely" | "possible" | null }[],
    overdue: { receivables: { total: number, invoices: { invoice_id: string, invoice_number: string, customer_name: string, due_date: string, days_overdue: number, amount: number }[] }, payables: { total: number, invoices: { supplier_invoice_id: string, supplier_invoice_number: string | null, supplier_name: string, due_date: string, days_overdue: number, amount: number }[] } },
    complete: boolean,
    caveats: { code: string, message_sv: string, message_en: string }[]
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
    "currency": "SEK",
    "today": "2026-10-28",
    "horizon": {
      "start": "2026-10-28",
      "end": "2027-01-24",
      "weeks": 13
    },
    "opening": {
      "amount": 412500,
      "source": "bank",
      "as_of": "2026-10-28T05:02:11Z",
      "age_days": 0,
      "accounts": []
    },
    "days": [
      {
        "date": "2026-10-28",
        "opening": 412500,
        "inflow": 0,
        "outflow": 18750,
        "closing": 393750,
        "lowest": false
      }
    ],
    "weeks": [
      {
        "iso_week": "2026-W44",
        "start": "2026-10-26",
        "end": "2026-11-01",
        "opening": 412500,
        "inflow": 62000,
        "outflow": 18750,
        "closing": 455750,
        "min_closing": 393750,
        "lowest": false
      }
    ],
    "lowest": {
      "date": "2026-11-25",
      "closing": 121300,
      "iso_week": "2026-W48"
    },
    "closing": 286400,
    "flows": [
      {
        "date": "2026-10-28",
        "direction": "out",
        "amount": 18750,
        "kind": "known",
        "source": "payment_order",
        "estimate": false,
        "counterparty": "Städbolaget AB",
        "reference": "F-2026-118",
        "ref": {
          "type": "payment_order",
          "id": "5c2a…"
        },
        "confidence": null
      }
    ],
    "overdue": {
      "receivables": {
        "total": 0,
        "invoices": []
      },
      "payables": {
        "total": 0,
        "invoices": []
      }
    },
    "complete": true,
    "caveats": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/cash-forecast-rows`

**The forecast rows: money expected in or out that the books do not hold yet.**
`scope:reports:read · risk:low · idempotent`

Lists the company's forecast rows by expected date: amount, direction, category, confidence, the outside key (external_source, external_id) and status (open, realised, superseded, cancelled). Filter by status, date range and outside system. Paginated with limit and offset; total is the full count. Read-only.

**Use when:** To see what has been added to the liquidity forecast, or to find a row to change or cancel.
**Do not use for:** The projection itself (GET /cash-forecast).

**Pitfalls:**
- Amounts are SEK and always positive; direction (in or out) says which way. Other currencies are not accepted yet.
- A row dated before today leaves the projection: cancel it, or move its date if the money is still expected.
- Link a row to its invoice (invoice_id or supplier_invoice_id) once the invoice exists: the invoice then counts and the row does not, so the money is never counted twice.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"open" \| "realised" \| "superseded" \| "cancelled"` | no | Only rows with this status. Default: every status. |
| `from` | query | `string` | no | First expected date, inclusive. |
| `to` | query | `string` | no | Last expected date, inclusive. |
| `external_source` | query | `string` | no | Only rows from this outside system, e.g. "boom". |
| `limit` | query | `number` | no | Rows per page, default 100. |
| `offset` | query | `number` | no |  |

Response `200`:
```ts
{
  data: {
    rows: { cash_forecast_row_id: string, expected_date: string, amount: number, direction: "in" | "out", currency: string, category: "revenue" | "payroll" | "tax" | "rent" | "loan" | "other", source: "manual" | "api" | "mcp" | "pms", external_source: string | null, external_id: string | null, confidence: "firm" | "likely" | "possible", dimension_value_id: string | null, invoice_id: string | null, supplier_invoice_id: string | null, status: "open" | "realised" | "superseded" | "cancelled", matched_transaction_id: string | null, note: string | null, created_at: string, updated_at: string }[],
    total: number
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
    "rows": [
      {
        "cash_forecast_row_id": "7b0e…",
        "expected_date": "2026-11-20",
        "amount": 48000,
        "direction": "in",
        "currency": "SEK",
        "category": "revenue",
        "source": "pms",
        "external_source": "boom",
        "external_id": "booking-48213",
        "confidence": "likely",
        "dimension_value_id": null,
        "invoice_id": null,
        "supplier_invoice_id": null,
        "status": "open",
        "matched_transaction_id": null,
        "note": "Bokning vecka 47",
        "created_at": "2026-10-28T09:12:00Z",
        "updated_at": "2026-10-28T09:12:00Z"
      }
    ],
    "total": 1
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/cash-forecast-rows`

**Add or update forecast rows by your own key, up to 500 at a time.**
`scope:forecast:write · risk:low · idempotent · dry-run · reversible`

Writes rows to the liquidity forecast, each named by your system and its id (external_source, external_id): a key not seen before creates a row, a key seen before updates that row while it is open. A row that is realised, superseded or cancelled is left as it is and listed under skipped. Not bookkeeping: rows never reach the books, so they are written directly (no approval) under forecast:write. Up to 500 rows per call. Dry-runnable.

**Use when:** A system that knows future money (bookings in a property management system, a loan plan, planned purchases) feeds the forecast, or an agent adds an expected payment.
**Do not use for:** Booking anything: a forecast row is never a verifikat. Customer and supplier invoices already count on their own.

**Pitfalls:**
- Amounts are SEK and always positive; direction (in or out) says which way. Other currencies are not accepted yet.
- A row dated before today leaves the projection: cancel it, or move its date if the money is still expected.
- Link a row to its invoice (invoice_id or supplier_invoice_id) once the invoice exists: the invoice then counts and the row does not, so the money is never counted twice.
- Sending the same batch again changes nothing: the key names the row. A cancelled row is not reopened by a later upsert.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  rows: { external_source: string, external_id: string, expected_date: string, amount: number, direction: "in" | "out", category: "revenue" | "payroll" | "tax" | "rent" | "loan" | "other", confidence?: "firm" | "likely" | "possible", note?: string | null, dimension_value_id?: string | null, invoice_id?: string | null, supplier_invoice_id?: string | null }[],
  source?: "api" | "mcp" | "pms"
}
```

Example request:
```json
{
  "rows": [
    {
      "external_source": "boom",
      "external_id": "booking-48213",
      "expected_date": "2026-11-20",
      "amount": 48000,
      "direction": "in",
      "category": "revenue",
      "note": "Bokning vecka 47"
    }
  ],
  "source": "pms"
}
```

Response `200`:
```ts
{
  data: {
    rows: { cash_forecast_row_id: string, expected_date: string, amount: number, direction: "in" | "out", currency: string, category: "revenue" | "payroll" | "tax" | "rent" | "loan" | "other", source: "manual" | "api" | "mcp" | "pms", external_source: string | null, external_id: string | null, confidence: "firm" | "likely" | "possible", dimension_value_id: string | null, invoice_id: string | null, supplier_invoice_id: string | null, status: "open" | "realised" | "superseded" | "cancelled", matched_transaction_id: string | null, note: string | null, created_at: string, updated_at: string }[],
    created: number,
    updated: number,
    skipped: { cash_forecast_row_id: string, external_source: string, external_id: string, status: "open" | "realised" | "superseded" | "cancelled" }[]
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
    "rows": [
      {
        "cash_forecast_row_id": "7b0e…",
        "expected_date": "2026-11-20",
        "amount": 48000,
        "direction": "in",
        "currency": "SEK",
        "category": "revenue",
        "source": "pms",
        "external_source": "boom",
        "external_id": "booking-48213",
        "confidence": "likely",
        "dimension_value_id": null,
        "invoice_id": null,
        "supplier_invoice_id": null,
        "status": "open",
        "matched_transaction_id": null,
        "note": "Bokning vecka 47",
        "created_at": "2026-10-28T09:12:00Z",
        "updated_at": "2026-10-28T09:12:00Z"
      }
    ],
    "created": 1,
    "updated": 0,
    "skipped": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/cash-forecast-rows/cancel`

**Cancel a forecast row: it leaves the forecast and stays on record.**
`scope:forecast:write · risk:low · idempotent · dry-run`

Sets an open row's status to cancelled; rows are never deleted. Name the row by cash_forecast_row_id, or by your own external_source and external_id. Cancelling a cancelled row changes nothing; a realised or superseded row cannot be cancelled. Not bookkeeping: written directly under forecast:write. Dry-runnable.

**Use when:** Money that was expected will not come or go: a booking cancelled, a purchase dropped.
**Do not use for:** Changing a row's amount or date (upsert it with the same key).

**Pitfalls:**
- A cancelled row is not reopened by a later upsert of the same key: write a new key if the money is expected again.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ cash_forecast_row_id?: string, external_source?: string, external_id?: string }
```

Example request:
```json
{
  "external_source": "boom",
  "external_id": "booking-48213"
}
```

Response `200`:
```ts
{
  data: {
    row: { cash_forecast_row_id: string, expected_date: string, amount: number, direction: "in" | "out", currency: string, category: "revenue" | "payroll" | "tax" | "rent" | "loan" | "other", source: "manual" | "api" | "mcp" | "pms", external_source: string | null, external_id: string | null, confidence: "firm" | "likely" | "possible", dimension_value_id: string | null, invoice_id: string | null, supplier_invoice_id: string | null, status: "open" | "realised" | "superseded" | "cancelled", matched_transaction_id: string | null, note: string | null, created_at: string, updated_at: string }
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
    "row": {
      "cash_forecast_row_id": "7b0e…",
      "expected_date": "2026-11-20",
      "amount": 48000,
      "direction": "in",
      "currency": "SEK",
      "category": "revenue",
      "source": "pms",
      "external_source": "boom",
      "external_id": "booking-48213",
      "confidence": "likely",
      "dimension_value_id": null,
      "invoice_id": null,
      "supplier_invoice_id": null,
      "status": "cancelled",
      "matched_transaction_id": null,
      "note": "Bokning vecka 47",
      "created_at": "2026-10-28T09:12:00Z",
      "updated_at": "2026-10-28T09:12:00Z"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/measures`

**The defined measures: id, name, precise definition, parameters and the report each equals.**
`scope:reports:read · risk:low · idempotent`

Lists every defined measure (moms att betala, kundfordringar, leverantörsskulder, banksaldo, likvida medel, resultat hittills i år, omsättning, kostnader, obetalda kund- och leverantörsfakturor) with its Swedish and English name, a precise definition, the dimension it is measured over (period, as_of or vat_period), the parameters it takes and the report it equals. Static: no company data is read.

**Use when:** Before GET /measures/{id}, to pick the measure that answers a question and see which parameters it takes.
**Do not use for:** The values themselves (GET /measures/{id}).

**Pitfalls:**
- Measure ids are stable; new measures may be added, so treat an unknown id in this list as valid.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    measures: { measure_id: string, name_sv: string, name_en: string, definition: string, definition_sv: string, unit: "SEK", dimension: "period" | "as_of" | "vat_period", parameters: string[], equals: { report: string, figure: string, v1_path: string, mcp_tool: string } }[]
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
    "measures": [
      {
        "measure_id": "accounts_receivable",
        "name_sv": "Kundfordringar",
        "name_en": "Accounts receivable",
        "definition": "Booked balance (debit minus credit) of the receivables control account ...",
        "definition_sv": "Bokfört saldo (debet minus kredit) på kundfordringskontot ...",
        "unit": "SEK",
        "dimension": "as_of",
        "parameters": [
          "as_of_date"
        ],
        "equals": {
          "report": "Balansräkning",
          "figure": "...",
          "v1_path": "/reports/balance-sheet",
          "mcp_tool": "accounted_get_balance_sheet"
        }
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

### `GET /api/v1/companies/{companyId}/measures/{measureId}`

**One defined measure: the value, its definition, what it covers, caveats and an explain handle.**
`scope:reports:read · risk:low · idempotent`

Answers one defined figure, computed by the report a person sees (equals names the report and figure; the value is always that figure), with its definition, the date it holds at, the range it covers, caveats that qualify it and the report trust signals (data_status). explain is the call that lists what this exact figure adds. A figure that cannot be computed answers a MEASURE_* error with a Swedish message: a missing momsperiod, no fiscal period for the date, a parameter the measure does not take, an account role the company's country has no account for, or a report that could not be read. Never a zero in place of an answer.

**Use when:** An agent or dashboard needs one figure (moms att betala, kundfordringar, banksaldo, resultat ...) defined once and equal to the report, instead of rebuilding it from reports or journal lines.
**Do not use for:** The full report (GET /reports/...), or a figure that is not in the list (GET /measures).

**Pitfalls:**
- Period measures take period_id/from_date/to_date, balance and register measures as_of_date, vat_payable period_type/year/period. Any other parameter is refused with MEASURE_PARAMETER_NOT_ACCEPTED, never ignored.
- vat_payable has no default period: without period_type, year and period it answers MEASURE_PERIOD_REQUIRED.
- accounts_receivable is the booked balance; unpaid_customer_invoices is the invoice register. They differ when invoices exist only as journal entries (a caveat says so).
- Read caveats and data_status before presenting a figure as final.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `measureId` | path | `string` | yes |  |
| `period_id` | query | `string` | no | Period measures: the fiscal period (default: the one containing today). vat_payable: yearly only, a broken räkenskapsår. |
| `from_date` | query | `string` | no | Period measures: range start inside the fiscal period. |
| `to_date` | query | `string` | no | Period measures: range end inside the fiscal period. |
| `as_of_date` | query | `string` | no | Balance and register measures: the balance date (default today). |
| `period_type` | query | `"monthly" \| "quarterly" \| "yearly"` | no | vat_payable: the momsperiod length. |
| `year` | query | `number` | no | vat_payable: year of the momsperiod. |
| `period` | query | `number` | no | vat_payable: 1-12 monthly, 1-4 quarterly, 1 yearly. |

Response `200`:
```ts
{
  data: {
    measure_id: string,
    name_sv: string,
    name_en: string,
    definition: string,
    unit: "SEK",
    value: number,
    count: number | null,
    as_of: string,
    period: { start: string, end: string, fiscal_period_id: string | null },
    vat_period: { period_type: string, year: number, period: number } | null,
    equals: { report: string, figure: string, v1_path: string, mcp_tool: string },
    caveats: { code: string, message_sv: string, message_en: string }[],
    data_status?: unknown,
    explain: { tool: "accounted_explain_measure", arguments: Record<string, unknown>, v1_path: string }
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
    "measure_id": "vat_payable",
    "name_sv": "Moms att betala eller få tillbaka",
    "name_en": "VAT payable or refundable",
    "definition": "Ruta 49 of the momsdeklaration (SKV 4700) for one momsperiod: ...",
    "unit": "SEK",
    "value": 18750,
    "count": null,
    "as_of": "2026-09-30",
    "period": {
      "start": "2026-07-01",
      "end": "2026-09-30",
      "fiscal_period_id": "7c2b…"
    },
    "vat_period": {
      "period_type": "quarterly",
      "year": 2026,
      "period": 3
    },
    "equals": {
      "report": "Momsdeklaration (SKV 4700)",
      "figure": "rutor.ruta49, same period_type/year/period",
      "v1_path": "/reports/vat-declaration",
      "mcp_tool": "accounted_get_vat_report"
    },
    "caveats": [],
    "data_status": null,
    "explain": {
      "tool": "accounted_explain_measure",
      "arguments": {
        "measure_id": "vat_payable",
        "period_type": "quarterly",
        "year": 2026,
        "period": 3
      },
      "v1_path": "/api/v1/companies/9f1e…/measures/vat_payable/explain?period_type=quarterly&year=2026&period=3"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/measures/{measureId}/explain`

**What a defined measure adds: contributors and the journal lines or invoices behind it, paged.**
`scope:reports:read · risk:low · idempotent`

Explains one measure value: the same value as GET /measures/{id}, the complete list of what it adds (accounts with their amount and opening balance, the ruta of each VAT account, or the customers and suppliers of an invoice measure) and, paged, the journal lines or open invoices behind them, each with its typed handle (je_, inv_, sinv_). reconciles says whether contributors add up to the value and each to its drill-down; reconciliation_note names any gap. Send the explain.arguments a GET /measures/{id} answered to explain that exact figure.

**Use when:** An agent must show why a figure is what it is, or find the vouchers or invoices behind it.
**Do not use for:** The value alone (GET /measures/{id} is lighter).

**Pitfalls:**
- drilldown is paged: limit (1-500, default 50) and offset; next_offset is null on the last page.
- Takes the same parameters as GET /measures/{id}; a default (today, the current fiscal year) is resolved again on every call, so pass the explain handle's pinned arguments.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `measureId` | path | `string` | yes |  |
| `period_id` | query | `string` | no | Period measures: the fiscal period (default: the one containing today). vat_payable: yearly only, a broken räkenskapsår. |
| `from_date` | query | `string` | no | Period measures: range start inside the fiscal period. |
| `to_date` | query | `string` | no | Period measures: range end inside the fiscal period. |
| `as_of_date` | query | `string` | no | Balance and register measures: the balance date (default today). |
| `period_type` | query | `"monthly" \| "quarterly" \| "yearly"` | no | vat_payable: the momsperiod length. |
| `year` | query | `number` | no | vat_payable: year of the momsperiod. |
| `period` | query | `number` | no | vat_payable: 1-12 monthly, 1-4 quarterly, 1 yearly. |
| `limit` | query | `number` | no | Drill-down page size, 1-500 (default 50). |
| `offset` | query | `number` | no | Drill-down rows to skip (next_offset of the previous page). |

Response `200`:
```ts
{
  data: {
    measure_id: string,
    name_sv: string,
    unit: "SEK",
    value: number,
    count: number | null,
    as_of: string,
    period: { start: string, end: string, fiscal_period_id: string | null },
    equals: { report: string, figure: string, v1_path: string, mcp_tool: string },
    contributors: { kind: "account" | "customer" | "supplier", account_number?: string, customer_id?: string, supplier_id?: string, handle?: string, name: string, amount: number, ruta?: string, role?: string, cash_account_id?: string, opening_balance?: number }[],
    drilldown: { kind: "journal_lines" | "invoices" | "supplier_invoices", items: { journal_entry_id?: string, invoice_id?: string, supplier_invoice_id?: string, handle: string | null }[], total: number, offset: number, next_offset: number | null },
    reconciles: boolean,
    reconciliation_note: string | null
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
    "measure_id": "accounts_receivable",
    "name_sv": "Kundfordringar",
    "unit": "SEK",
    "value": 45000,
    "count": null,
    "as_of": "2026-10-16",
    "period": {
      "start": "2026-01-01",
      "end": "2026-10-16",
      "fiscal_period_id": "7c2b…"
    },
    "equals": {
      "report": "Balansräkning",
      "figure": "...",
      "v1_path": "/reports/balance-sheet",
      "mcp_tool": "accounted_get_balance_sheet"
    },
    "contributors": [
      {
        "kind": "account",
        "account_number": "1510",
        "name": "Kundfordringar",
        "amount": 45000,
        "opening_balance": 12000,
        "role": "accounts_receivable"
      }
    ],
    "drilldown": {
      "kind": "journal_lines",
      "items": [
        {
          "journal_entry_id": "0e9c41d2-…",
          "handle": "je_0e9c41d2…",
          "voucher_series": "A",
          "voucher_number": 12,
          "date": "2026-03-02",
          "account_number": "1510",
          "description": "Faktura 1004",
          "debit": 33000,
          "credit": 0
        }
      ],
      "total": 1,
      "offset": 0,
      "next_offset": null
    },
    "reconciles": true,
    "reconciliation_note": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/ar-ledger`

**AR ledger: unpaid customer invoices with aging.**
`scope:reports:read · risk:low · idempotent`

Returns the customer-receivable ledger as of `as_of_date` (defaults to today). Each customer entry includes outstanding invoices grouped into aging buckets (0-30, 31-60, 61-90, 90+ days). Reconciles against BAS 1510.

**Use when:** Cash collection dashboards, dunning workflows, end-of-period reconciliation against the 1510 trial-balance figure.
**Do not use for:** Listing all invoices regardless of status (use /invoices). Sending dunning emails (the v1 surface does not yet expose dunning).

**Pitfalls:**
- `as_of_date` is optional; format `YYYY-MM-DD`. Defaults to today (UTC).
- Only invoices in `sent`/`overdue`/`partially_paid` status appear. Drafts and credited invoices are excluded.
- The ledger is built from the invoice register only. `data.register_coverage` ({ covers_from, has_pre_register_invoices }) gives covers_from, the date from which the register is complete: invoices registered from the books before it are included, other receivables before it may exist only as journal entries (migrated or backfilled invoice history) and are NOT in this ledger. When has_pre_register_invoices is true, treat periods before covers_from as unanswered here and query journal entries on 1510/1513 instead.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `as_of_date` | query | `string` | no | YYYY-MM-DD, a real calendar date between 2000 and next year. Default: today (UTC). |

Response `200`:
```ts
{
  data?: unknown,
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
    "as_of_date": "2026-05-31",
    "customers": [],
    "totals": {}
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/avgifter-basis`

**The year's declared arbetsgivaravgifter per month and sats.**
`scope:payroll:read · risk:low · idempotent`

Returns the arbetsgivaravgifter the booked salary runs of `year` declare, one row per AGI period and sats: `periodMonth`, `category`, the whole-krona `basis` and `amount`, computed as the AGI computes them (stored category, youth cap split, overrides, F-skatt and borttag). `totals.totalAmount` is the year's FK487, after any regional support. Reconciles to the monthly AGI filings.

**Use when:** Annual reconciliation between the AGI declarations and the bookkeeping (BAS 7510). Year-end audit prep.
**Do not use for:** Real-time AGI generation (POST /salary-runs/{id}/generate-agi). Per-run breakdown (use /reports/salary-journal).

**Pitfalls:**
- `year` is required.
- Only `booked` runs are included.
- A run belongs to the AGI period of its payment date: a December run paid in January counts in the next year.
- An exempt employee (born 1937 or earlier) has no row: the AGI declares no avgift for them.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `year` | query | `number` | yes | Year, 2020-2100. Required. |

Response `200`:
```ts
{
  data?: unknown,
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
    "year": 2026,
    "rows": [
      {
        "periodYear": 2026,
        "periodMonth": 9,
        "category": "standard",
        "categoryLabel": "Standard (31,42%)",
        "rate": 0.3142,
        "basis": 30000,
        "amount": 9426,
        "employeeCount": 1
      }
    ],
    "totals": {
      "totalBasis": 30000,
      "totalAmount": 9426,
      "regionalSupportDeduction": 0
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/balance-sheet`

**Balance sheet (balansräkning) for a fiscal period or as of a custom date.**
`scope:reports:read · risk:low · idempotent`

Returns assets / liabilities / equity grouped into BAS sections, with the period's opening and closing balances. Optional `as_of` (alias for `to_date`, YYYY-MM-DD inside the fiscal period) returns the balance position at that date, e.g. the latest month-end for bank reporting. Sums match the income statement for the same period; the closing equity flows into next period's opening balance.

**Use when:** You need the company's balance position at period end or at a custom date: typically management reporting, year-end review, or the K2/K3 årsredovisning uppställningsform.
**Do not use for:** Per-account drill-down (use /reports/general-ledger). Net result for the period (use /reports/income-statement).

**Pitfalls:**
- `period_id` is required; `as_of` (alias: `to_date`, pass at most one) is optional and must lie within that fiscal period. `from_date` is not accepted: a balance sheet is a cumulative position, not a flow over a window.
- Unknown query parameters are rejected with VALIDATION_ERROR, not silently ignored.
- Balance sheet equity includes the period's computed result: recalculation happens on every call, so a freshly-posted entry is reflected immediately (no caching).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |
| `to_date` | query | `string` | no | YYYY-MM-DD inside the fiscal period: the position as of this date. Default: the period end. |
| `as_of` | query | `string` | no | Alias for to_date. Pass one or the other, not both. |

Response `200`:
```ts
{
  data?: unknown,
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
    "period": {
      "start": "2026-01-01",
      "end": "2026-12-31"
    },
    "sections": [],
    "totals": {}
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/balance-sheet/pdf`

**Balance sheet (balansräkning) as a PDF.**
`scope:reports:read · risk:low · idempotent`

Renders the balansräkning as application/pdf, byte-equivalent to the dashboard export. Optional `as_of` (alias for `to_date`, YYYY-MM-DD inside the fiscal period) returns the balance position at that date, e.g. the latest month-end for bank reporting. Refuses to render when tillgångar and eget kapital + skulder differ by a full krona or more.

**Use when:** You need a presentable PDF of the balance position at period end or a custom date: bank requests, board packs, or sharing outside Accounted.
**Do not use for:** Machine-readable figures (use the JSON endpoint without /pdf). The formal K2/K3 årsredovisning document (use the year-end flow).

**Pitfalls:**
- `period_id` is required; `as_of` (alias: `to_date`, pass at most one) is optional and must lie within that fiscal period. `from_date` is not accepted: a balance sheet is a cumulative position, not a flow over a window.
- Unknown query parameters are rejected with VALIDATION_ERROR, not silently ignored.
- An unbalanced balansräkning (>= 1 kr difference) returns REPORT_GENERATION_FAILED instead of a PDF: fix the imbalance first.
- The PDF is marked "utkast": it is a working report, not a fastställd årsredovisning.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |
| `to_date` | query | `string` | no | YYYY-MM-DD inside the fiscal period: the position as of this date. Default: the period end. |
| `as_of` | query | `string` | no | Alias for to_date. Pass one or the other, not both. |

Response `200` (`application/pdf`).

---

### `GET /api/v1/companies/{companyId}/reports/behandlingshistorik`

**Behandlingshistorik (BFL 5 kap. 11 §): who changed what in the books, and when, for a räkenskapsår.**
`scope:reports:read · risk:low · idempotent`

The processing history the system documentation must include (BFNAR 2013:2 p. 9.16): verifikationer posted, corrected and reversed, chart of accounts and settings changes, period locks and closings, imports, access changes and program versions, and decisions on bank lines and underlag (category beslut: the suggestions on offer, the one booked, who decided and which agent proposed it), each with time, actor (user, API key, MCP connection, cron) and detail lines. Filter by from_date / to_date inside the period and by one category, as the dashboard report. For an enskild firma the owner's personnummer is masked. Read-only.

**Use when:** An auditor or Skatteverket asks how the books were processed, or you need to know who posted or changed something.
**Do not use for:** The raw row-level audit log (GET /audit-trail) or the verifikationslista (GET /reports/journal-register).

**Pitfalls:**
- from_date and to_date must lie inside the fiscal period (400 VALIDATION_ERROR otherwise).
- Bursts of identical changes are collapsed into one event with count > 1.
- The statutory PDF, CSV and Excel exports are in the dashboard; this is the same report as JSON.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |
| `from_date` | query | `string` | no | YYYY-MM-DD inside the period. Omit for the whole period. |
| `to_date` | query | `string` | no | YYYY-MM-DD inside the period, not before from_date. |
| `category` | query | `"verifikation" \| "kontoplan" \| "installningar" \| "period" \| "import" \| "atkomst" \| "arkiv" \| "beslut" \| "ovrigt"` | no | Only events of this category. |

Response `200`:
```ts
{
  data: {
    company: { name: string, org_number: string | null },
    period: { fiscal_period_id: string, name: string, start: string, end: string },
    range: { from: string, to: string },
    mode: "fiscal_year" | "date_range",
    generated_at: string,
    app_version: string | null,
    total_events: number,
    by_category: Record<string, number>,
    events: (Record<string, unknown>)[]
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
    "company": {
      "name": "Testbolaget AB",
      "org_number": "5566778899"
    },
    "period": {
      "fiscal_period_id": "7c2b…",
      "name": "2026",
      "start": "2026-01-01",
      "end": "2026-12-31"
    },
    "range": {
      "from": "2026-01-01",
      "to": "2026-12-31"
    },
    "mode": "fiscal_year",
    "total_events": 1,
    "events": [
      {
        "event_id": "entry:9a0b…",
        "occurred_at": "2026-03-02T09:14:00Z",
        "category": "verifikation",
        "code": "journal_entry.committed",
        "event": "Verifikation bokförd",
        "object": "A12",
        "actor": {
          "type": "api_key",
          "user_id": null,
          "label": "Integration"
        },
        "details": [],
        "source": "journal_entries",
        "count": 1
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

### `GET /api/v1/companies/{companyId}/reports/bokslutsbilagor`

**Bokslutsbilagor: every balance account at the balansdag with its specification, sign-off and underlag.**
`scope:reports:read · risk:low · idempotent`

The bokslutsbilagor pärm for one räkenskapsår: each balance account as of the balansdag with its balance, specification or stated balance, who signed it off and when, the attached underlag files with their SHA-256, and the year-end checklist with its state. For an enskild firma the owner's personnummer is masked. Read-only.

**Use when:** Checking which balance accounts are specified and signed off before bokslut, or handing the specification to an auditor.
**Do not use for:** The balance sheet figures alone (GET /reports/balance-sheet) or the account reconciliation work itself.

**Pitfalls:**
- summary.unsigned counts accounts nobody has signed off; signed_other_date were signed against another date than the balansdag.
- The PDF of the pärm is in the dashboard; this is the same report as JSON.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |

Response `200`:
```ts
{
  data: {
    company: { name: string, org_number: string | null },
    period: { fiscal_period_id: string, name: string, start: string, end: string },
    generated_at: string,
    app_version: string | null,
    checklist: { items: (Record<string, unknown>)[], summary: Record<string, number> },
    accounts: (Record<string, unknown>)[],
    summary: Record<string, number>
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
    "company": {
      "name": "Testbolaget AB",
      "org_number": "5566778899"
    },
    "period": {
      "fiscal_period_id": "7c2b…",
      "name": "2025",
      "start": "2025-01-01",
      "end": "2025-12-31"
    },
    "summary": {
      "accounts": 14,
      "signed_on_balansdag": 12,
      "signed_other_date": 0,
      "unsigned": 2,
      "attachments": 9
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/budget-vs-actual`

**Budget against booked result per account and month.**
`scope:reports:read · risk:low · idempotent`

For every resultatkonto with a budget or a booked amount in the window: budget, actual, deviation (actual minus budget) and deviation_percent per month and in total, plus the result over all accounts. Figures are in the resultatrapport's sign (revenue positive, costs negative), so a positive deviation is always a better result than budgeted. Actuals leave out the bokslut entries, as the resultatrapport does. The window is whole months (from_month..to_month, default the whole year). dim_no + dim_code compare one dimension value: actuals and budget lines tagged with it.

**Use when:** Following up a budget: year to date, one month, or one project or cost centre.
**Do not use for:** The budget's raw amounts (GET /budgets/{id}).

**Pitfalls:**
- Without budget_id the year's default budget is read: 404 BUDGET_NONE_FOR_YEAR when there is none.
- Months outside the budget's fiscal year answer 400 BUDGET_MONTH_OUTSIDE_YEAR.
- Without a dimension filter every budget line counts, tagged or not.
- deviation_percent is null where nothing is budgeted.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `budget_id` | query | `string` | no | The budget (budget_id from the budget list). |
| `fiscal_period_id` | query | `string` | no | The fiscal year (fiscal_period_id). |
| `from_month` | query | `string` | no | A month as YYYY-MM, inside the budget's fiscal year. |
| `to_month` | query | `string` | no | A month as YYYY-MM, inside the budget's fiscal year. |
| `dim_no` | query | `string` | no | SIE dimension number to filter on (with dim_code). |
| `dim_code` | query | `string` | no | The dimension value code to filter on (with dim_no). |

Response `200`:
```ts
{
  data: {
    budget: { budget_id: string, fiscal_period_id: string, name: string, is_default: boolean, archived: boolean, archived_at: string | null, created_at: string, updated_at: string },
    fiscal_period: { fiscal_period_id: string, name: string, period_start: string, period_end: string },
    from_month: string,
    to_month: string,
    dimension_filter: Record<string, string> | null,
    months: string[],
    rows: { account_number: string, account_name: string | null, months: { budget: number, actual: number, deviation: number, deviation_percent: number | null, month: string }[], total: { budget: number, actual: number, deviation: number, deviation_percent: number | null } }[],
    totals: { months: { budget: number, actual: number, deviation: number, deviation_percent: number | null, month: string }[], total: { budget: number, actual: number, deviation: number, deviation_percent: number | null } }
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
    "budget": {
      "budget_id": "7c1d…",
      "fiscal_period_id": "a8f1…",
      "name": "Budget 2027",
      "is_default": true,
      "archived": false,
      "archived_at": null,
      "created_at": "2026-11-02T09:00:00Z",
      "updated_at": "2026-11-02T09:00:00Z"
    },
    "fiscal_period": {
      "fiscal_period_id": "a8f1…",
      "name": "Räkenskapsår 2027",
      "period_start": "2027-01-01",
      "period_end": "2027-12-31"
    },
    "from_month": "2027-01",
    "to_month": "2027-03",
    "dimension_filter": null,
    "months": [
      "2027-01",
      "2027-02",
      "2027-03"
    ],
    "rows": [],
    "totals": {
      "months": [],
      "total": {
        "budget": 0,
        "actual": 0,
        "deviation": 0,
        "deviation_percent": null
      }
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/continuity-check`

**IB/UB continuity check: opening balances match prior closing.**
`scope:reports:read · risk:low · idempotent`

Validates that the target period's opening balances (IB) equal the prior period's closing balances (UB). The requirement derives from BFL 5 kap (löpande bokföring), BFNAR 2013:2 (systemdokumentation/behandlingshistorik), and the SIE4 spec's core invariant that #IB(year N) must equal #UB(year N-1). Returns per-account discrepancies so an operator can rectify them before period close.

**Use when:** Before locking or closing a period, or as part of an automated year-end readiness gate. Any discrepancy is a hard data-integrity issue.
**Do not use for:** Computing balances (use /reports/balance-sheet or /reports/trial-balance). Closing the period (POST /fiscal-periods/{id}/close).

**Pitfalls:**
- `period_id` is required.
- A non-zero discrepancy means IB ≠ prior UB and indicates the opening-balance entry was edited or the prior period was changed after close. Investigate before posting any new entries.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |

Response `200`:
```ts
{
  data?: unknown,
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
    "valid": true,
    "period_name": "FY 2025",
    "previous_period_name": "FY 2024",
    "discrepancies": [],
    "checked_accounts": 42
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/dimension-cross`

**Result across two dimensions: one dimension's values as rows, another's as columns, one amount per cell.**
`scope:reports:read · risk:low · idempotent`

A matrix over two SIE dimensions tagged on the same journal lines: rows are dim_a's values, columns dim_b's, each cell the result (or the accounts account_from to account_to) of the lines carrying both tags, with row and column totals. "(Utan dimension)" rows and columns (code null) hold the lines without that tag, and total equals the resultatrapport for the same window and accounts. Read the lines behind a cell with GET /reports/dimension-cross/lines. Read-only.

**Use when:** Following up result per region and channel, per project and cost centre, or any two dimensions the books tag, for the year or one quarter or month.
**Do not use for:** One dimension (GET /reports/dimension-pnl, accounts as rows) or one value only (GET /reports/income-statement with dim_no and dim_code).

**Pitfalls:**
- dim_a and dim_b must be two different dimensions; both are tags on the same line. A property of a dimension value (a home's region kept on the home) is not a tag and is not read.
- Amounts are credit minus debit, as in the resultatrapport: revenue positive, costs negative.
- Lines without a tag on a dimension land in its "(Utan dimension)" row or column (code null); the untagged x untagged cell is the remainder of the resultatrapport, so the cells sum to total.
- What the bokslut run posts (source year_end) and the IB verifikat are left out, as in the resultatrapport.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |
| `dim_a` | query | `string` | yes | The row dimension, an SIE dimension number: "1" kostnadsställe, "6" projekt, or a custom one. |
| `dim_b` | query | `string` | yes | The column dimension, a different SIE dimension number. |
| `account_from` | query | `string` | no | First account of the measure, 3000-8999, sent with account_to. Default: the whole result. |
| `account_to` | query | `string` | no | Last account of the measure (inclusive), 3000-8999. |
| `from_date` | query | `string` | no | YYYY-MM-DD inside the period. Default: the period start. |
| `to_date` | query | `string` | no | YYYY-MM-DD inside the period, not before from_date. Default: the period end. |

Response `200`:
```ts
{
  data: {
    dim_a: { sie_dim_no: string, name: string },
    dim_b: { sie_dim_no: string, name: string },
    accounts: { from: string, to: string },
    rows: { code: string | null, name: string | null }[],
    columns: { code: string | null, name: string | null }[],
    cells: number[][],
    row_totals: number[],
    column_totals: number[],
    total: number,
    period: { start: string, end: string }
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
    "dim_a": {
      "sie_dim_no": "1",
      "name": "Kostnadsställe"
    },
    "dim_b": {
      "sie_dim_no": "6",
      "name": "Projekt"
    },
    "accounts": {
      "from": "3000",
      "to": "8999"
    },
    "rows": [
      {
        "code": "NORR",
        "name": "Region Norr"
      },
      {
        "code": null,
        "name": null
      }
    ],
    "columns": [
      {
        "code": "WEB",
        "name": "Webb"
      },
      {
        "code": null,
        "name": null
      }
    ],
    "cells": [
      [
        120000,
        15000
      ],
      [
        0,
        -40000
      ]
    ],
    "row_totals": [
      135000,
      -40000
    ],
    "column_totals": [
      120000,
      -25000
    ],
    "total": 95000,
    "period": {
      "start": "2026-01-01",
      "end": "2026-12-31"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/dimension-cross/lines`

**The journal lines behind one cell of the two-dimension result, a page at a time.**
`scope:reports:read · risk:low · idempotent`

The lines one cell of GET /reports/dimension-cross sums: same period, window, accounts and entry set, the lines whose dim_a tag is code_a and dim_b tag is code_b (codes compared trimmed; leave a code out for the "(Utan dimension)" row or column). In date and voucher order, at most limit (default 200, at most 1000); pass next.after_date, next.after_voucher and next.after_line back for the next page. Each line names its verifikat (journal_entry_id, voucher_series, voucher_number). Read-only.

**Use when:** Checking what makes up one cell of the two-dimension report.
**Do not use for:** All lines of an account (GET /reports/general-ledger).

**Pitfalls:**
- Send the same dim_a, dim_b, account range and window as the report, or the lines will not add up to the cell.
- A code left out means "no tag on that dimension", not "any value".

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |
| `dim_a` | query | `string` | yes | The row dimension, an SIE dimension number: "1" kostnadsställe, "6" projekt, or a custom one. |
| `dim_b` | query | `string` | yes | The column dimension, a different SIE dimension number. |
| `account_from` | query | `string` | no | First account of the measure, 3000-8999, sent with account_to. Default: the whole result. |
| `account_to` | query | `string` | no | Last account of the measure (inclusive), 3000-8999. |
| `from_date` | query | `string` | no | YYYY-MM-DD inside the period. Default: the period start. |
| `to_date` | query | `string` | no | YYYY-MM-DD inside the period, not before from_date. Default: the period end. |
| `code_a` | query | `string` | no | The value of dim_a; leave out for the "(Utan dimension)" row. |
| `code_b` | query | `string` | no | The value of dim_b; leave out for the "(Utan dimension)" column. |
| `after_date` | query | `string` | no | next.after_date from the previous page. |
| `after_voucher` | query | `number` | no | next.after_voucher from the previous page. |
| `after_line` | query | `string` | no | next.after_line from the previous page. |
| `limit` | query | `number` | no | Page size, 1-1000 (default 200). |

Response `200`:
```ts
{
  data: {
    lines: (Record<string, unknown>)[],
    has_more: boolean,
    next: { after_date: string, after_voucher: number, after_line: string } | null
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
    "lines": [
      {
        "line_id": "5d1e…",
        "journal_entry_id": "9a0b…",
        "entry_date": "2026-03-02",
        "voucher_series": "A",
        "voucher_number": 12,
        "description": "Bokning 1042",
        "line_description": null,
        "account_number": "3010",
        "debit_amount": 0,
        "credit_amount": 4800,
        "dimensions": {
          "1": "NORR",
          "6": "WEB"
        }
      }
    ],
    "has_more": true,
    "next": {
      "after_date": "2026-03-02",
      "after_voucher": 12,
      "after_line": "5d1e…"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/dimension-pnl`

**Resultat per projekt or kostnadsställe: the income statement with one column per dimension value.**
`scope:reports:read · risk:low · idempotent`

A value-as-column P&L matrix over one SIE dimension (dim_no 6 projekt by default, 1 kostnadsställe, or a custom dimension): each result account's amount per dimension value, an "(Utan dimension)" column for untagged amounts, and a Totalt column that equals the resultatrapport for the same window. The window is from_date to to_date (defaults: the period start and end), so one quarter per project is one call. Read-only.

**Use when:** Following up profitability per project or cost centre, for the year or for one quarter or month.
**Do not use for:** One value only (GET /reports/income-statement with dim_no and dim_code) or balance accounts (dimensions are P&L-side).

**Pitfalls:**
- from_date and to_date must lie inside the period. Amounts are the activity inside that window, not balances accumulated from the period start.
- Amounts booked without a tag on the dimension land in "(Utan dimension)", not spread over the values.
- What the bokslut run posts (source year_end: tax, bokslut depreciation, dispositions, resultatavslut) is left out, tagged or not, exactly as in the resultatrapport.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |
| `dim_no` | query | `string` | no | SIE dimension number. Default "6" (projekt). |
| `from_date` | query | `string` | no | YYYY-MM-DD inside the period. Default: the period start. |
| `to_date` | query | `string` | no | YYYY-MM-DD inside the period, not before from_date. Default: the period end. |

Response `200`:
```ts
{
  data: {
    dimension: { sie_dim_no: string, name: string },
    columns: (Record<string, unknown>)[],
    groups: (Record<string, unknown>)[],
    net_per_column: number[],
    net_total: number,
    period: { start: string, end: string }
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
      "sie_dim_no": "6",
      "name": "Projekt"
    },
    "columns": [
      {
        "code": "P001",
        "name": "Projekt Alfa"
      }
    ],
    "net_total": 184200,
    "period": {
      "start": "2026-07-01",
      "end": "2026-09-30"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/forenklat-arsbokslut`

**Förenklat årsbokslut (ideell förening, BFNAR 2010:1): resultaträkning and balansräkning for a räkenskapsår.**
`scope:reports:read · risk:low · idempotent`

The förenklat årsbokslut an ideell förening closes its books with (BFL 6 kap. 3 § andra stycket, 6 §), in the uppställningsform of BFNAR 2010:1 bilaga 2: the resultaträkning from the books before the resultatavslut and the balansräkning after it, each row with the comparison year, empty rows left out, plus the accounts behind each post. blockers say why the document cannot be made yet (the year not closed, an avsättning or another form's equity account booked, a balansräkning that does not balance, årets över-/underskott not equal to 2069, the eligibility not confirmed); warnings flag what needs a look (förutbetalda or invoiced medlemsavgifter, nettoomsättning above three million kronor, the comparison year). The PDF for the styrelse to sign is served by GET /reports/forenklat-arsbokslut/pdf; pdf_file names that path. Read-only.

**Use when:** An ideell förening's year is closed and its förenklat årsbokslut is to be checked, prepared or signed.
**Do not use for:** An aktiebolag or ekonomisk förening (the årsredovisning), an enskild firma (GET /reports/ne-bilaga), INK3, or confirming the eligibility (a person does that in the app).

**Pitfalls:**
- Only for a form that prepares one (ideell förening): another form answers 400 FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM.
- Amounts are kronor with öre. In the resultaträkning an income is positive and a cost negative, as in BFN's example; in the balansräkning every side is positive.
- A non-empty blockers list means GET .../pdf answers 422 FORENKLAT_ARSBOKSLUT_BLOCKED: correct the books or confirm the eligibility in the app, do not retry.
- The mapping of BAS accounts to bilaga 2 posts is the product's own (BAS publishes none for K1 föreningar) and awaits an accountant's review.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |

Response `200`:
```ts
{
  data: {
    regelverk: "BFNAR 2010:1",
    company: { name: string, org_number: string | null },
    fiscal_period: { fiscal_period_id: string, name: string, period_start: string, period_end: string, is_closed: boolean },
    previous_period: { fiscal_period_id: string, name: string, period_start: string, period_end: string } | null,
    resultatrakning: { kind: "rubrik" | "post" | "summa", key: string, label: string, current: number | null, previous: number | null, accounts?: { account_number: string, account_name: string, current: number, previous: number | null }[] }[],
    balansrakning: { kind: "rubrik" | "post" | "summa", key: string, label: string, current: number | null, previous: number | null, accounts?: { account_number: string, account_name: string, current: number, previous: number | null }[] }[],
    totals: { aretsOverUnderskott: { current: number, previous: number | null }, summaTillgangar: { current: number, previous: number | null }, summaEgetKapitalOchSkulder: { current: number, previous: number | null }, nettoomsattning: { current: number, previous: number | null } },
    eligibility: { confirmed: boolean, confirmed_at: string | null },
    notes: string | null,
    signatories: { name: string, role: string | null }[],
    blockers: { code: string, message: string }[],
    warnings: { code: string, message: string }[],
    pdf_file: { download: string, content_type: "application/pdf" }
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
    "regelverk": "BFNAR 2010:1",
    "company": {
      "name": "Föreningen",
      "org_number": "8020001234"
    },
    "fiscal_period": {
      "fiscal_period_id": "7c2b…",
      "name": "2026",
      "period_start": "2026-01-01",
      "period_end": "2026-12-31",
      "is_closed": true
    },
    "previous_period": {
      "fiscal_period_id": "5a1d…",
      "name": "2025",
      "period_start": "2025-01-01",
      "period_end": "2025-12-31"
    },
    "resultatrakning": [
      {
        "kind": "rubrik",
        "key": "intakter",
        "label": "Intäkter",
        "current": null,
        "previous": null
      },
      {
        "kind": "post",
        "key": "medlemsavgifter",
        "label": "Medlemsavgifter",
        "current": 210000,
        "previous": 205000
      }
    ],
    "totals": {
      "aretsOverUnderskott": {
        "current": -23000,
        "previous": 92000
      }
    },
    "eligibility": {
      "confirmed": true,
      "confirmed_at": "2027-03-01T10:00:00Z"
    },
    "blockers": [],
    "warnings": [],
    "pdf_file": {
      "download": "/api/v1/companies/…/reports/forenklat-arsbokslut/pdf?period_id=7c2b…",
      "content_type": "application/pdf"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/forenklat-arsbokslut/pdf`

**Förenklat årsbokslut (ideell förening, BFNAR 2010:1) as a PDF for the styrelse to sign.**
`scope:reports:read · risk:low · idempotent`

The ideell förening's förenklat årsbokslut in the BFNAR 2010:1 bilaga 2 layout: resultaträkning and balansräkning with comparatives, the tilläggsupplysningar, and a "Beslutat" date line with one signature and date line per styrelseledamot. Byte-identical to the dashboard download. Signing happens on the printed or exported document; nothing is filed anywhere: the document is kept with the books for seven years (BFL 7 kap. 2 §).

**Use when:** The figures are reviewed (GET /reports/forenklat-arsbokslut has no blockers) and the document is to be signed.
**Do not use for:** Reading the figures (GET /reports/forenklat-arsbokslut), or an aktiebolag or ekonomisk förening (the årsredovisning).

**Pitfalls:**
- Refused with 422 FORENKLAT_ARSBOKSLUT_BLOCKED while the report has blockers (details.reason names them): correct the books or confirm the eligibility in the app, do not retry.
- Only for an ideell förening: another legal form answers 400 FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM.
- Refused while an SIE import is unfinished: complete or undo it first.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id. |

Response `200` (`application/pdf`).

---

### `GET /api/v1/companies/{companyId}/reports/general-ledger`

**General ledger (huvudbok) for a fiscal period.**
`scope:reports:read · risk:low · idempotent`

Returns every posted journal line in the period grouped by account, with opening / running / closing balances. Supports optional `account_from` and `account_to` query parameters to limit the report to an account range (e.g. ?account_from=3000&account_to=3999 for revenue-only), `from_date` and `to_date` to limit it to a date window inside the period, and `dim_no` + `dim_code` to keep only the lines tagged with one dimension value (the answer then carries `dimension_filter` and `partial_view`).

**Use when:** You're reconciling a specific account or range (bank account drilldown, revenue audit, expense investigation) and need every voucher-line that hit the account.
**Do not use for:** Period totals only (use /reports/trial-balance). Specific transaction lookup (use /journal-entries/{id}).

**Pitfalls:**
- `period_id` is required.
- Account ranges are inclusive on both bounds. `account_from=3000` includes 3000; `account_to=3999` includes 3999.
- Lines with `status != 'posted'` (drafts, reversed) are excluded.
- With `dim_no` + `dim_code` (always together) the opening_balance is scoped to the filter too: the IB lines tagged with that value (`partial_view.opening_balances` is `dimension_scoped`, and `partial_view.opening_balances_included` is true). A project (dimension 6) opens at its carried balance; a dimension that resets annually (e.g. kostnadsställe, dimension 1) opens at 0, and so do the VAT accounts (26xx), whose IB is never split per project. Running and closing balances are that IB plus the tagged lines' movements.
- With `from_date`, the lines before it roll into each account's opening_balance, so the running balance at the window start equals the full-period ledger's. `period` in the answer is the window, not the fiscal year. The window must lie inside the fiscal period: a range spanning two räkenskapsår is two calls.
- A query parameter it does not document (e.g. from, a misspelled from_date) is not applied: the answer names it in the X-Ignored-Query-Params header. A dimension filter is always applied or refused, never ignored.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |
| `account_from` | query | `string` | no | Lowest account number to include (inclusive), 3-8 digits, e.g. 3000. |
| `account_to` | query | `string` | no | Highest account number to include (inclusive), 3-8 digits, e.g. 3999. |
| `from_date` | query | `string` | no | YYYY-MM-DD, inside the fiscal period. Omit with to_date for the whole period. |
| `to_date` | query | `string` | no | YYYY-MM-DD, inside the fiscal period and not before from_date. |
| `dim_no` | query | `string` | no | SIE dimension number to filter on: "1" kostnadsställe, "6" projekt, 20+ custom. Send with dim_code. |
| `dim_code` | query | `string` | no | The dimension value code, e.g. "P001". Send with dim_no. |

Response `200`:
```ts
{
  data?: unknown,
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
    "period": {},
    "accounts": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/income-statement`

**Income statement (resultatrapport) for a fiscal period or a custom date range.**
`scope:reports:read · risk:low · idempotent`

Returns the period's revenue and expenses grouped by BAS class with subtotals (gross margin, operating result, net result). Optional `from_date` / `to_date` (YYYY-MM-DD, inside the fiscal period) narrow the report to a custom range, e.g. January 1 to July 31 for month-end bank reporting. Optional `dim_no` + `dim_code` narrow it to the lines tagged with one dimension value (a project, a cost centre): the answer then carries `dimension_filter` and `partial_view`. The net result flows into the balance-sheet equity for the same period.

**Use when:** You need the company's profit/loss for a period or partial period: month-end management reporting, K2/K3 årsredovisning resultaträkning, or feeding KPI dashboards.
**Do not use for:** Per-account drill (use /reports/general-ledger). VAT figures (use /reports/vat-declaration). Balance position (use /reports/balance-sheet).

**Pitfalls:**
- Revenue is `nettoomsattning` (BAS 3000-3799, the årsredovisning line); `total_revenue` is all of class 3 and also includes aktiverat arbete (38xx) and övriga rörelseintäkter (39xx). `definitions` lists the accounts behind every figure.
- Every figure is before bokslut: year-end entries (skatt, bokslutsdispositioner, year-end avskrivningar, kontantmetod cut-off) are excluded, so once they are booked the figures differ from the filed årsredovisning. `definitions.basis` says so in the response.
- `period_id` is required; `from_date`/`to_date` are optional and must lie within that fiscal period.
- Unknown query parameters are rejected with VALIDATION_ERROR, not silently ignored.
- Net result on the income statement equals the period's equity-line delta on the balance sheet: they're derived from the same posted entries.
- With `dim_no` + `dim_code` (always together) the figures cover only lines tagged with that value, `partial_view.complete` is false: never present them as the company's result. Statutory reports (balance sheet, VAT, INK2, NE, SIE) refuse the pair with 400.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |
| `from_date` | query | `string` | no | YYYY-MM-DD, inside the fiscal period. Omit with to_date for the whole period. |
| `to_date` | query | `string` | no | YYYY-MM-DD, inside the fiscal period and not before from_date. |
| `dim_no` | query | `string` | no | SIE dimension number to filter on: "1" kostnadsställe, "6" projekt, 20+ custom. Send with dim_code. |
| `dim_code` | query | `string` | no | The dimension value code, e.g. "P001". Send with dim_no. |

Response `200`:
```ts
{
  data?: unknown,
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
    "period": {
      "start": "…",
      "end": "…"
    },
    "sections": [],
    "grossMargin": 0,
    "netResult": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/income-statement/pdf`

**Income statement (resultaträkning) as a PDF.**
`scope:reports:read · risk:low · idempotent`

Renders the resultaträkning as application/pdf, byte-equivalent to the dashboard export. Optional `from_date` / `to_date` (YYYY-MM-DD, inside the fiscal period) narrow the report to a custom range. The filename carries the effective date range and an "utkast" suffix (the document is a working report, not a signed årsredovisning).

**Use when:** You need a presentable PDF of the profit/loss for a period or partial period: bank requests, board packs, or sharing outside Accounted.
**Do not use for:** Machine-readable figures (use the JSON endpoint without /pdf). The formal K2/K3 årsredovisning document (use the year-end flow).

**Pitfalls:**
- `period_id` is required; `from_date`/`to_date` are optional and must lie within that fiscal period.
- Unknown query parameters are rejected with VALIDATION_ERROR, not silently ignored.
- The PDF is marked "utkast": it is a working report, not a fastställd årsredovisning.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |
| `from_date` | query | `string` | no | YYYY-MM-DD, inside the fiscal period. Omit with to_date for the whole period. |
| `to_date` | query | `string` | no | YYYY-MM-DD, inside the fiscal period and not before from_date. |

Response `200` (`application/pdf`).

---

### `GET /api/v1/companies/{companyId}/reports/ink2`

**INK2 inkomstdeklaration (aktiebolag): INK2, INK2R and INK2S fields for a räkenskapsår.**
`scope:reports:read · risk:low · idempotent`

Computes the aktiebolag income tax return from the books, keyed by SRU field code: ink2 (page 1: 7104 överskott / 7114 underskott, 7132/7133 underlag för särskild löneskatt på pensionskostnader from 7410-7419), ink2r (räkenskapsschema: balance sheet and income statement, the balance sheet from the closed books and the income statement before the resultatavslut) and ink2s (skattemässiga justeringar, including the adjustments saved in the year-end flow), with the per-code account breakdown, totals and warnings. The SRU files for upload at skatteverket.se are served by GET /reports/ink2/sru; sru_file names that path. Read-only.

**Use when:** Preparing or checking the aktiebolag income tax return after bokslut, or reconciling INK2R figures against the årsredovisning.
**Do not use for:** Enskild firma (GET /reports/ne-bilaga), the årsredovisning itself, or submitting to Skatteverket (upload the SRU files at skatteverket.se; nothing is sent from here).

**Pitfalls:**
- Only for aktiebolag: another legal form answers 400 TAX_DECL_INK2_WRONG_LEGAL_FORM.
- Amounts are whole kronor as Skatteverket takes them; codes with no amount are 0.
- Run it after the year-end closing: before bokslut the tax (8910) and bokslutsdispositioner are missing, and warnings say so.
- ink2s is not the whole INK2S. Computed: 7650/7750 (4.1/4.2), 7651 (4.3a), 7652 (4.3b, write-downs of financial assets), 7653 (4.3c), 7753 (4.5b, dividends) and 7754 (4.5c) from the year-end adjustments, 7673 (4.6d, the 6 % or 4 % uppräkning on periodiseringsfonder set aside before 2021 and återförda this year, oldest first; 0 with a warning when a fond names no year or its year cannot be told), 7654 (4.6a, schablonintäkt on the opening periodiseringsfonder: statslåneräntan of 30 November the year before the calendar year the räkenskapsår ends in, at least 0.5 %, times whole months / 12, so brutet, short and long years are covered; a year that starts or ends mid-month, or whose rate is not published yet, gets 0 with a warning naming the opening fonder), 7666/7765 (4.9), 7763 (4.14a) and 7670/7770 (4.15/4.16). 7763 is the deficit saved in the year-end flow or the underskottsregister, never read from last year's return: 0 means none was entered, not that none exists. Every other INK2S row and the upplysningar about the årsredovisning (8040/8041 uppdragstagare, 8044/8045 revision) are neither computed nor in the SRU file; they are entered in Skatteverket's e-tjänst.
- A period id from another company answers 404 FISCAL_PERIOD_NOT_FOUND.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |

Response `200`:
```ts
{
  data: {
    fiscalYear: { fiscal_period_id: string, name: string, start: string, end: string, isClosed: boolean },
    ink2: Record<string, number | string>,
    ink2r: Record<string, number | string>,
    ink2s: Record<string, number | string>,
    breakdown: Record<string, { accounts: { accountNumber: string, accountName: string, amount: number }[], total: number }>,
    totals: { totalAssets: number, totalEquityLiabilities: number, operatingResult: number, aretsResultat: number },
    companyInfo: { companyName: string, orgNumber: string | null, entityType: string, addressLine1: string | null, postalCode: string | null, city: string | null, email: string | null },
    warnings: string[],
    sru_file: { download: string, content_type: "application/zip", files: string[] }
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
    "fiscalYear": {
      "fiscal_period_id": "7c2b…",
      "name": "2025",
      "start": "2025-01-01",
      "end": "2025-12-31",
      "isClosed": true
    },
    "ink2": {
      "7011": "20250101",
      "7012": "20251231",
      "7104": 184200,
      "7114": 0
    },
    "ink2r": {
      "7251": 250000,
      "7410": 1200000
    },
    "ink2s": {
      "7650": 146000,
      "7651": 38200,
      "7670": 184200
    },
    "totals": {
      "totalAssets": 910000,
      "totalEquityLiabilities": 910000,
      "operatingResult": 190000,
      "aretsResultat": 146000
    },
    "warnings": [],
    "sru_file": {
      "download": "/api/v1/companies/…/reports/ink2/sru?period_id=7c2b…",
      "content_type": "application/zip",
      "files": [
        "INFO.SRU",
        "BLANKETTER.SRU"
      ]
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/ink2/sru`

**INK2 SRU files (INFO.SRU + BLANKETTER.SRU) as a zip, for upload at skatteverket.se.**
`scope:reports:read · risk:low · idempotent`

The aktiebolag income tax return as the two SRU files Skatteverket's filöverföring takes, ISO 8859-1 encoded and zipped, byte-identical to the dashboard download. The figures are those of GET /reports/ink2 for the same period. Nothing is sent to Skatteverket: the user uploads the files, reviews and signs there.

**Use when:** The INK2 figures are reviewed and the files are to be uploaded at skatteverket.se (Filöverföring).
**Do not use for:** Reading the figures (GET /reports/ink2), or an enskild firma (GET /reports/ne-bilaga/sru).

**Pitfalls:**
- Unzip and upload INFO.SRU and BLANKETTER.SRU under exactly those names; do not re-encode them to UTF-8.
- Only for aktiebolag: another legal form answers 400 TAX_DECL_INK2_WRONG_LEGAL_FORM.
- Refused while an SIE import is unfinished: complete or undo it first.
- A declaration with sruBlockers (an account without an SRU field, a balance sheet that does not tie, a closed year whose declared result is not the booked 2099) answers 422 TAX_DECL_INK2_SRU_BLOCKED with the reason in details.reason: correct the books, do not retry.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id. |

Response `200` (`application/zip`).

---

### `GET /api/v1/companies/{companyId}/reports/ink3`

**INK3 underlag (ideell förening): INK3R, INK3S and INK3SUF values per ruta for a räkenskapsår.**
`scope:reports:read · risk:low · idempotent`

The figures an ideell förening types into Skatteverket's e-tjänst Inkomstdeklaration 2, 3 och 4, by field code: INK3R (balance sheet from the closed books; income statement in two columns, enligt redovisningen from the books before the resultatavslut and som ska tas upp/dras av from the company's per-account treatment), INK3S (7.1/7.2, 7.5a and 7.9/7.10 computed, the rest entered) and INK3SUF (entered; part of filing only when the company states the förening is allmännyttig). Overrides the company saved replace the computed figure. filing holds every field with a value. Only beskattningsperiod 2026P4 is pinned. Read-only: nothing is filed and no SRU file exists; the user signs the first page in the e-tjänst.

**Use when:** Preparing or checking an ideell förening's INK3 after bokslut, or answering what goes in a ruta.
**Do not use for:** Aktiebolag or ekonomisk förening (GET /reports/ink2), enskild firma (GET /reports/ne-bilaga), deciding whether the förening is allmännyttig (the company states it), or submitting anything to Skatteverket.

**Pitfalls:**
- Only for ideell förening: another legal form answers 400 TAX_DECL_INK3_WRONG_LEGAL_FORM.
- Only räkenskapsår in a pinned beskattningsperiod (2026P4: ending 2026-09-01 to 2026-12-31); others answer 422 TAX_DECL_INK3_PERIOD_NOT_SUPPORTED.
- A field with needsInput true has no final figure yet: a shared or unclassified account feeds it. The treatments and overrides are set in the app, not over v1 or MCP.
- allmannyttig null means the company has not stated it; INK3SUF is left out of filing until it says yes.
- Amounts are whole kronor with öre dropped.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |

Response `200`:
```ts
{
  data: {
    fiscalYear: { fiscal_period_id: string, name: string, start: string, end: string, isClosed: boolean },
    beskattningsperiod: string,
    fieldTable: { beskattningsperiod: string, files: string[] },
    companyInfo: { companyName: string, orgNumber: string | null },
    allmannyttig: boolean | null,
    sufApplicable: boolean,
    fields: { code: string, blankett: "INK3R" | "INK3S" | "INK3SUF", ruta: string | null, label: string, column: "bokforing" | "skattepliktig" | null, sign: "+" | "-" | "*" | null, datatyp: string, value: number | boolean | string | null, computed: number | null, source: "books" | "computed" | "input" | "override", overridable: boolean, needsInput: boolean, needsInputReason: "shared_account" | "unclassified_account" | "not_computable" | null, accounts: { accountNumber: string, accountName: string, amount: number, treatment: "exempt" | "taxable" | "shared" | null }[] }[],
    filing: Record<string, number | string>,
    accounts: { accountNumber: string, accountName: string, ruta: string, amount: number, treatment: "exempt" | "taxable" | "shared" | null }[],
    totals: { totalAssets: number, totalEquityLiabilities: number, bookkeepingResult: number, taxableResult: number, taxableSurplus: number },
    complete: boolean,
    warnings: string[]
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
    "fiscalYear": {
      "fiscal_period_id": "7c2b…",
      "name": "2026",
      "start": "2026-01-01",
      "end": "2026-12-31",
      "isClosed": true
    },
    "beskattningsperiod": "2026P4",
    "allmannyttig": true,
    "sufApplicable": true,
    "filing": {
      "8650": 42000,
      "8653": 120000,
      "8663": 18000,
      "8673": 120000,
      "8685": 9000,
      "8686": 9000,
      "8695": 9000,
      "8822": "X"
    },
    "totals": {
      "totalAssets": 310000,
      "totalEquityLiabilities": 310000,
      "bookkeepingResult": 18000,
      "taxableResult": 9000,
      "taxableSurplus": 9000
    },
    "complete": true,
    "warnings": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/journal-register`

**Journal register (verifikationsregister) for a fiscal period.**
`scope:reports:read · risk:low · idempotent`

Returns every committed journal entry in the period with its voucher number, date, description, and complete debit/credit line set. The canonical compliance report: what an accountant or Skatteverket audit would pull as proof of every booking.

**Use when:** You need the BFL-required register of all verifikationer for a period: typically for an audit, year-end review, or feeding an external accountant's tooling.
**Do not use for:** Per-account drilldown (use /reports/general-ledger). Aggregate totals only (use /reports/trial-balance).

**Pitfalls:**
- `period_id` is required.
- Output includes every line of every entry: large periods produce large responses. Consider paginating client-side or filtering by date range via /journal-entries list if you only need a slice.
- Reversed entries appear with status `reversed`; the original they reversed also remains.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |

Response `200`:
```ts
{
  data?: unknown,
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
    "period": {},
    "entries": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/kassaflodesanalys`

**Kassaflödesanalys (cash flow statement, indirect method) for a räkenskapsår.**
`scope:reports:read · risk:low · idempotent`

Derives the cash flow statement from the trial balance, with every account in exactly one line: löpande verksamhet (result after financial items, avskrivningar and other non-cash items, changes in receivables, inventory and short-term liabilities, tax paid, koncernbidrag), investeringsverksamhet (acquisitions, disposals at their proceeds, kortfristiga placeringar) and finansieringsverksamhet, reconciled against the actual change in cash (19xx). `statement` holds the same year laid out to K3 chapter 7 (from rörelseresultat; interest and dividends received and paid as separate cash lines; investments per kind and loans gross; the exchange difference on likvida medel apart) with the previous year as `statement.previous`. Bokslut entries are included, only the resultatavslut is left out. Read-only.

**Use when:** Preparing the årsredovisning for a K3 company (or a larger K2 one that includes it), or analysing where the year's cash went.
**Do not use for:** Liquidity forecasts or bank balances (GET /reports/trial-balance for 19xx).

**Pitfalls:**
- lopande.ovriga_poster is the change on accounts outside every BAS range the analysis classifies, named in unclassified_accounts. reconciliation.is_reconciled false means the period's postings do not balance.
- A year whose income tax cannot be separated from other taxes answers 422 CASH_FLOW_TAX_ALLOCATION_REQUIRED.
- statement.current.amounts is keyed by line (rorelseresultat, erlagd_ranta, upptagna_lan, ...); statement.previous is null when there is no earlier year with activity, and statement.previous_status says why.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |

Response `200`:
```ts
{
  data: {
    fiscal_period_id: string,
    period_start: string,
    period_end: string,
    lopande: Record<string, number>,
    investerings: Record<string, number>,
    finansierings: Record<string, number>,
    total_cash_flow: number,
    unclassified_accounts: string[],
    reconciliation: Record<string, number | boolean>
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
    "fiscal_period_id": "7c2b…",
    "period_start": "2025-01-01",
    "period_end": "2025-12-31",
    "lopande": {
      "total": 212000
    },
    "investerings": {
      "total": -45000
    },
    "finansierings": {
      "total": -50000
    },
    "total_cash_flow": 117000,
    "unclassified_accounts": [],
    "reconciliation": {
      "is_reconciled": true,
      "mismatch_amount": 0
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/kpi`

**Business KPIs (nyckeltal) for a fiscal period, as the dashboard shows them.**
`scope:reports:read · risk:low · idempotent`

Net result, cash position, outstanding and overdue receivables, VAT liability, revenue and expenses, gross margin, expense ratio, average payment days, the monthly trend, the expense composition by BAS class 4-7, the five largest expense accounts and the largest suppliers in SEK. The company's KPI preferences (account overrides for cash and VAT) apply. dim_no + dim_code filter the P&L-side figures to one cost centre or project; balance-side figures stay company-wide. Read-only.

**Use when:** A dashboard or monthly summary needs the same nyckeltal the Accounted overview shows.
**Do not use for:** The full income statement or balance sheet (GET /reports/income-statement, /reports/balance-sheet).

**Pitfalls:**
- With a dimension filter, cashPosition, receivables, vatLiability and topSuppliers are still company-wide: do not present them as the dimension's.
- topSuppliersUnconvertedFxCount counts foreign-currency invoices left out of topSuppliers for lack of a SEK amount.
- dim_no and dim_code must be sent together.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |
| `dim_no` | query | `string` | no | SIE dimension number, e.g. "6" projekt, "1" kostnadsställe. |
| `dim_code` | query | `string` | no | The dimension value code, e.g. "P001". Sent with dim_no. |

Response `200`:
```ts
{
  data: {
    netResult: number,
    cashPosition: number,
    outstandingReceivables: number,
    overdueReceivables: number,
    vatLiability: number,
    totalRevenue: number,
    totalExpenses: number,
    grossMargin: number | null,
    expenseRatio: number | null,
    avgPaymentDays: number | null,
    periodComplete: boolean,
    months: (Record<string, unknown>)[],
    period: { start: string, end: string }
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
    "netResult": 184200,
    "cashPosition": 312000,
    "outstandingReceivables": 45000,
    "overdueReceivables": 5000,
    "vatLiability": 18750,
    "totalRevenue": 980000,
    "totalExpenses": 795800,
    "grossMargin": 0.62,
    "expenseRatio": 0.81,
    "avgPaymentDays": 24,
    "periodComplete": false,
    "period": {
      "start": "2026-01-01",
      "end": "2026-12-31"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/monthly-breakdown`

**Income statement broken down by month for a fiscal period.**
`scope:reports:read · risk:low · idempotent`

Returns revenue + expenses + net result per calendar month inside the fiscal period. The sum across all months equals the period's full income-statement totals. Optional `dim_no` + `dim_code` keep only the lines tagged with one dimension value (the answer then carries `dimension_filter` and `partial_view`).

**Use when:** Building a trend chart, computing rolling KPIs, or producing a månadsrapport for management.
**Do not use for:** Single-month snapshot only (call /reports/income-statement with a month-sized period). Cash flow analysis (a dedicated cash-flow report is not yet on v1).

**Pitfalls:**
- `period_id` is required.
- With `dim_no` + `dim_code` (always together) the months cover only the tagged lines: they sum to the filtered income statement, not the company's.
- A query parameter it does not document is not applied: the answer names it in the X-Ignored-Query-Params header.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |
| `dim_no` | query | `string` | no | SIE dimension number to filter on: "1" kostnadsställe, "6" projekt, 20+ custom. Send with dim_code. |
| `dim_code` | query | `string` | no | The dimension value code, e.g. "P001". Send with dim_no. |

Response `200`:
```ts
{
  data?: unknown,
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
    "period": {},
    "months": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/ne-bilaga`

**NE-bilaga (enskild firma): balansräkning B1-B16 and rutor R1-R11 for a räkenskapsår.**
`scope:reports:read · risk:low · idempotent`

Computes the NE-bilaga rutor R1-R11 from the books before the resultatavslut (försäljning, momsfria intäkter, varuinköp, övriga kostnader, lönekostnader, räntor, avskrivningar, årets resultat) and the balansräkning B1-B16 at the year's end (balans, per BAS kopplingstabell NE_EJ_K1; B10 eget kapital is tillgångar minus skulder), with the per-ruta account breakdown and warnings. The owner's personnummer (the enskild firma's org number) is masked in this JSON; the SRU files, served by GET /reports/ne-bilaga/sru, carry it in full and hold B1-B16, R1-R11 and sida 2 R12-R14 (R13 and R14 are the tax adjustments, as in sida2). Read-only.

**Use when:** Preparing or checking the enskild firma's NE-bilaga after bokslut.
**Do not use for:** Aktiebolag (GET /reports/ink2), the egenavgifter / räntefördelning / periodiseringsfond adjustments (MCP accounted_preview_ef_declaration), or submitting (the owner imports blanketter.sru in Skatteverket's Inkomstdeklaration 1 e-tjänst, Bilagor, Enskild näringsverksamhet (NE), and completes sida 2 there).

**Pitfalls:**
- Only for enskild firma: another legal form answers 400 TAX_DECL_NE_WRONG_LEGAL_FORM.
- companyInfo.orgNumber is masked (last four digits XXXX): take the full number from the SRU file or the company settings, never from this JSON.
- R11 (årets resultat) is the booked result; the declaration-only adjustments (egenavgifter, räntefördelning, periodiseringsfond, expansionsfond) are not in it.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |

Response `200`:
```ts
{
  data: {
    fiscalYear: { fiscal_period_id: string, name: string, start: string, end: string, isClosed: boolean },
    rutor: Record<string, number>,
    balans: Record<string, number>,
    breakdown: Record<string, { accounts: { accountNumber: string, accountName: string, amount: number }[], total: number }>,
    companyInfo: { companyName: string, orgNumber: string | null, entityType: string, addressLine1: string | null, postalCode: string | null, city: string | null, email: string | null },
    warnings: string[],
    sru_file: { download: string, content_type: "application/zip", files: string[] }
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
    "fiscalYear": {
      "fiscal_period_id": "7c2b…",
      "name": "2025",
      "start": "2025-01-01",
      "end": "2025-12-31",
      "isClosed": true
    },
    "rutor": {
      "R1": 480000,
      "R2": 0,
      "R3": 0,
      "R4": 0,
      "R5": 120000,
      "R6": 95000,
      "R7": 0,
      "R8": 0,
      "R9": 0,
      "R10": 12000,
      "R11": 253000
    },
    "balans": {
      "B4": 36000,
      "B7": 40000,
      "B9": 210000,
      "B10": 238000,
      "B16": 48000
    },
    "companyInfo": {
      "companyName": "Anna Svensson Konsult",
      "orgNumber": "19800101-XXXX",
      "entityType": "enskild_firma",
      "addressLine1": null,
      "postalCode": null,
      "city": null,
      "email": null
    },
    "warnings": [],
    "sru_file": {
      "download": "/api/v1/companies/…/reports/ne-bilaga/sru?period_id=7c2b…",
      "content_type": "application/zip",
      "files": [
        "INFO.SRU",
        "BLANKETTER.SRU"
      ]
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/ne-bilaga/sru`

**NE-bilaga SRU files (INFO.SRU + BLANKETTER.SRU) as a zip, for upload at skatteverket.se.**
`scope:reports:read · risk:low · idempotent`

The enskild firma's NE-bilaga as the two SRU files Skatteverket's filöverföring takes, ISO 8859-1 encoded and zipped, byte-identical to the dashboard download. The figures are those of GET /reports/ne-bilaga for the same period. The file carries the owner's full personnummer (the identifier Skatteverket files it under). Nothing is sent to Skatteverket: the user uploads the files, reviews and signs there.

**Use when:** The NE figures are reviewed and the files are to be uploaded at skatteverket.se.
**Do not use for:** Reading the figures (GET /reports/ne-bilaga), or an aktiebolag (GET /reports/ink2/sru).

**Pitfalls:**
- The zip and its file name contain the owner's personnummer: store and forward it as personal data.
- Unzip and upload INFO.SRU and BLANKETTER.SRU under exactly those names; do not re-encode them to UTF-8.
- Only for enskild firma: another legal form answers 400 TAX_DECL_NE_WRONG_LEGAL_FORM.
- A declaration with sruBlockers (an account without a ruta, R11 not the booked result, a booked periodiseringsfond or skatt) answers 422 TAX_DECL_NE_SRU_BLOCKED with the reason in details.reason: correct the books, do not retry.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id. |

Response `200` (`application/zip`).

---

### `GET /api/v1/companies/{companyId}/reports/periodisk-sammanstallning`

**Periodisk sammanställning (EU sales list): per-customer EU sales of goods, services and triangulation.**
`scope:reports:read · risk:low · idempotent`

Builds the periodisk sammanställning for a month or quarter: one row per EU customer VAT number with varor, tjänster and trepartshandel amounts, plus warnings (missing or invalid VAT numbers, Swedish customers, credit notes), reconciled against the momsdeklaration (rutor 35, 38, 39) for the same dates. The SKV 574008 CSV for upload is served by GET /reports/periodisk-sammanstallning/csv. Read-only.

**Use when:** Before filing the periodisk sammanställning, or checking EU sales per customer against the momsdeklaration.
**Do not use for:** The momsdeklaration itself (GET /reports/vat-declaration) or domestic sales.

**Pitfalls:**
- Warnings with level error block the CSV download (PS_REPORT_CSV_BLOCKED_BY_ERRORS): fix them first.
- Amounts are whole kronor, as the CSV takes them.
- The CSV also needs the tax contact (name, phone, email) on the company settings.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_type` | query | `"monthly" \| "quarterly"` | yes | monthly (varor above the threshold) or quarterly. |
| `year` | query | `number` | yes | Calendar year, 2000-2100. |
| `period` | query | `number` | yes | 1-12 for monthly, 1-4 for quarterly. |

Response `200`:
```ts
{
  data: {
    period: { type: string, year: number, period: number },
    rows: (Record<string, unknown>)[],
    warnings: (Record<string, unknown>)[]
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
    "period": {
      "type": "quarterly",
      "year": 2026,
      "period": 2,
      "start": "2026-04-01",
      "end": "2026-06-30",
      "label": "Kvartal 2 2026"
    },
    "rows": [
      {
        "country": "DE",
        "vatNumber": "123456789",
        "services": 42000,
        "goods": 0,
        "triangulation": 0,
        "customerId": "4f1a…",
        "customerName": "Beispiel GmbH",
        "hasBlockingIssue": false
      }
    ],
    "warnings": [],
    "totals": {
      "services": 42000,
      "goods": 0,
      "triangulation": 0,
      "grand": 42000,
      "rowCount": 1
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/periodisk-sammanstallning/csv`

**Periodisk sammanställning as the SKV 574008 CSV file, for upload at skatteverket.se.**
`scope:reports:read · risk:low · idempotent`

The EU sales list for a month or quarter in the file format Skatteverket's e-tjänst takes (SKV 574008): a header with the org number, period code and tax contact, then one row per customer VAT number with varor, trepartshandel and tjänster in whole kronor. Refused while the report has blocking warnings or the tax contact is incomplete. Nothing is sent to Skatteverket.

**Use when:** The periodisk sammanställning is reviewed and is to be uploaded at skatteverket.se.
**Do not use for:** Reading the rows and warnings (GET /reports/periodisk-sammanstallning).

**Pitfalls:**
- Blocking warnings answer 400 PS_REPORT_CSV_BLOCKED_BY_ERRORS: fix them (read the JSON) first.
- A missing tax contact (name, phone, email on the company settings) answers 400 PS_REPORT_MISSING_FILER_INFO.
- Refused while an SIE import is unfinished.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_type` | query | `"monthly" \| "quarterly"` | yes | monthly (varor above the threshold) or quarterly. |
| `year` | query | `number` | yes | Calendar year, 2000-2100. |
| `period` | query | `number` | yes | 1-12 for monthly, 1-4 for quarterly. |

Response `200` (`text/csv`).

---

### `GET /api/v1/companies/{companyId}/reports/salary-journal`

**Salary journal (lönejournal) for a year and optional month range.**
`scope:payroll:read · risk:low · idempotent`

Returns per-employee salary figures (gross / tax / net / avgifter / vacation accrual) summed across booked salary runs in `year`. Optional `month_from` and `month_to` limit the window. The output mirrors the dashboard's lönejournal export. ⚠️ KU (kontrolluppgift) preparation requires the FULL annual paid amount per employee: if any salary runs are in paid-but-unbooked state at KU time, generating KU from this report will understate wages (an SFL obligation breach). Confirm all paid runs are booked before using this report for KU.

**Use when:** Year-end KU preparation, employee comp reviews, reconciliation against the 7xxx wage accounts.
**Do not use for:** Per-run drill-down (use /salary-runs/{id} once the per-employee endpoint ships). AGI declarations (POST /salary-runs/{id}/generate-agi).

**Pitfalls:**
- `year` is required (integer 2020-2100).
- Only `booked` salary runs are included: `draft`/`review`/`approved`/`paid` runs are excluded as they aren't legally final.
- `paid`-but-unbooked runs are EXCLUDED. This means the report reconciles cleanly against BAS 7xxx (the ledger), but an AGI-vs-ledger cross-check will show a gap until the run is booked. The AGI is filed at `approved`/`paid` (Phase 5 PR-2 allows it from `review`), so reconciling AGI against this report requires waiting until every paid run is also booked.
- month_from/month_to are 1-12 inclusive.
- Each row carries personnelCategory (arbetare or tjansteman; null for owners and board members), the category the run was booked with. groupTotals sums the period per group (arbetare, tjansteman, company_owner, board_member): the arbetare and tjänstemän totals the collective-agreement insurers ask for.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `year` | query | `number` | yes | Payroll year, 2020-2100. Required. |
| `month_from` | query | `number` | no | First month to include, 1-12 (inclusive). |
| `month_to` | query | `number` | no | Last month to include, 1-12 (inclusive). |

Response `200`:
```ts
{
  data?: unknown,
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
    "rows": [],
    "totals": {},
    "groupTotals": [],
    "period": {
      "year": 2026
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/sie-export`

**SIE4 export (.se file) for a fiscal period.**
`scope:reports:read · risk:low · idempotent`

Returns the period's SIE4 export as text/plain UTF-8. Includes #FNAMN / #ORGNR header, #KONTO chart, #IB/#UB opening + closing balances, #RES result-account totals, and every #VER + #TRANS verifikation in the period. The byte stream matches what the dashboard's `/api/reports/sie-export` produces.

**Use when:** Year-end accountant handoff, migration to another bookkeeping system, audit archival, BFL 7 kap räkenskapsinformation backup.
**Do not use for:** JSON drilldown of period entries (use /reports/journal-register). Full archive including documents (use /reports/full-archive: not yet on v1).

**Pitfalls:**
- `period_id` is required.
- The response is text/plain with Content-Disposition: attachment: clients should treat as a binary download. Filename uses the pattern `export_{period_id}.se`.
- The compulsory #FORMAT PC8 tag is always present, but default byte encoding is UTF-8 (the de-facto cloud convention; importers detect encoding from the bytes). Pass `encoding=cp437` for actual CP437 bytes, required by some legacy desktop bookkeeping software.
- Only `posted` entries are exported; drafts and reversed entries' originals are included but marked accordingly.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |
| `exclude_closing` | query | `string` | no | true leaves the year-end closing verifikat (source_type year_end) out of the #VER records, for importing into a system that books its own closing. Default: included. Archive the default, complete export. |
| `encoding` | query | `string` | no | cp437 returns CP437 bytes for legacy desktop importers. Default: UTF-8. |

Response `200` (`text/plain`).

---

### `GET /api/v1/companies/{companyId}/reports/supplier-ledger`

**Supplier ledger: unpaid supplier invoices with aging.**
`scope:reports:read · risk:low · idempotent`

Returns the supplier-payable ledger as of `as_of_date` (defaults to today). Each supplier entry includes outstanding invoices grouped into aging buckets. Reconciles against BAS 2440.

**Use when:** AP workflow dashboards, due-date prioritisation, reconciliation against the 2440 trial-balance figure.
**Do not use for:** Listing all supplier invoices regardless of status (use /supplier-invoices). Initiating payment (the v1 surface does not expose payment files yet).

**Pitfalls:**
- `as_of_date` is optional; format `YYYY-MM-DD`. Defaults to today (UTC).
- Only invoices with outstanding `remaining_amount > 0` appear. Credited and fully-paid invoices are excluded.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `as_of_date` | query | `string` | no | YYYY-MM-DD, a real calendar date between 2000 and next year. Default: today (UTC). |

Response `200`:
```ts
{
  data?: unknown,
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
    "as_of_date": "2026-05-31",
    "suppliers": [],
    "totals": {}
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/trial-balance`

**Trial balance (huvudboksrapport) for a fiscal period.**
`scope:reports:read · risk:low · idempotent`

Returns per account the opening (IB), period and closing (UB) debit and credit, each side gross (closing = opening + period on that side; the balance is closing_debit - closing_credit), plus totalDebit/totalCredit (sums of closing_debit and closing_credit) and an `isBalanced` flag. The numbers come from the same `lib/reports/trial-balance.ts` generator the dashboard uses.

**Use when:** You need a snapshot of every active account's movement during a period: typically the first report an accountant checks before running balance sheet or income statement.
**Do not use for:** Reconciliation against AR/AP (use /reports/ar-ledger or /supplier-ledger). Specific account drill-in (use /reports/general-ledger with account_from/account_to filters).

**Pitfalls:**
- `period_id` is required as a query parameter.
- `isBalanced=false` means the period has unbalanced postings: a data-integrity red flag. The lib generator rounds at the source so a true imbalance is rare; investigate immediately.
- Closed/locked periods are still queryable: the report is read-only.
- No dimension filter: the saldobalans is company-wide, so dim_no/dim_code answer 400 VALIDATION_ERROR rather than an unfiltered report. For one project or cost centre use /reports/income-statement or /reports/general-ledger with dim_no + dim_code.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |

Response `200`:
```ts
{
  data: {
    rows: { account_number: string, account_name: string, account_class: number, opening_debit: number, opening_credit: number, period_debit: number, period_credit: number, closing_debit: number, closing_credit: number }[],
    totalDebit: number,
    totalCredit: number,
    isBalanced: boolean
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
    "rows": [
      {
        "account_number": "1930",
        "account_name": "Företagskonto",
        "account_class": 1,
        "opening_debit": 100000,
        "opening_credit": 0,
        "period_debit": 7000,
        "period_credit": 3000,
        "closing_debit": 107000,
        "closing_credit": 3000
      },
      {
        "account_number": "2081",
        "account_name": "Aktiekapital",
        "account_class": 2,
        "opening_debit": 0,
        "opening_credit": 100000,
        "period_debit": 0,
        "period_credit": 0,
        "closing_debit": 0,
        "closing_credit": 100000
      },
      {
        "account_number": "2611",
        "account_name": "Utgående moms på försäljning inom Sverige, 25 %",
        "account_class": 2,
        "opening_debit": 0,
        "opening_credit": 0,
        "period_debit": 0,
        "period_credit": 1400,
        "closing_debit": 0,
        "closing_credit": 1400
      },
      {
        "account_number": "3001",
        "account_name": "Försäljning inom Sverige, 25 % moms",
        "account_class": 3,
        "opening_debit": 0,
        "opening_credit": 0,
        "period_debit": 0,
        "period_credit": 5600,
        "closing_debit": 0,
        "closing_credit": 5600
      },
      {
        "account_number": "5010",
        "account_name": "Lokalhyra",
        "account_class": 5,
        "opening_debit": 0,
        "opening_credit": 0,
        "period_debit": 3000,
        "period_credit": 0,
        "closing_debit": 3000,
        "closing_credit": 0
      }
    ],
    "totalDebit": 110000,
    "totalCredit": 110000,
    "isBalanced": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/vacation-liability`

**Vacation liability (semesterlöneskuld) per employee at year-end.**
`scope:payroll:read · risk:low · idempotent`

Returns per-employee semesterlöneskuld balances as of year-end based on their vacation_rule (procentregeln / sammaloneregeln) and accrued days. For employees on procentregeln or sammaloneregeln the row total contributes to the BAS 2920 closing balance. Employees on `none` or `semesterersattning` are excluded because their cost is expensed immediately (no balance-sheet accrual): the BAS 2920 reconciliation against this report is therefore CORRECT whether or not the company has semesterersättning employees, since those employees contribute zero to both the report and the 2920 balance. Feeds the K2/K3 årsredovisning notes.

**Use when:** Year-end reconciliation between the accrued liability on 2920 and the per-employee detail. Audit prep.
**Do not use for:** Real-time accrual posting (handled per salary run). Vacation request management (not in scope for v1).

**Pitfalls:**
- `year` is required. The report is as of December 31 of that year.
- Amounts specify what is booked on 2920/2940: the latest closed vacation year's computed liability plus every accrual booked after its year end (before any close: the cutover opening liability plus every accrual booked so far). Day columns describe the vacation year containing December 31 under the company's vacation-year basis.
- computedLiability and computedAvgifter (per row and in totals) are the day-valued liability on the date: unpaid vacation pay for days earned and not taken, valued per employee (sammalöneregeln at the company's vacation_day_value convention, procentregeln on the earning year's pay), avgifter at each employee's age-tier rate. accruedAmount/accruedAvgifter specify what is booked. Their difference is what POST /salary/vacation-liability/reconcile books.
- Employees with vacation_rule = none or semesterersattning are excluded: they have no semesterlöneskuld liability.
- advanceVacationDebt (per row and in totals) is the förskottsskuld loaded as a cutover opening balance (SemL 29 a §): a receivable on the employee. totalLiability stays the booked 2920 + 2940 liability and is what bokslut and reconciliation use; netLiability subtracts the förskottsskuld for information only.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `year` | query | `number` | yes | Year, 2020-2100. Required. |

Response `200`:
```ts
{
  data?: unknown,
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
    "year": 2026,
    "employees": [],
    "total_liability": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/vat-declaration`

**Swedish VAT declaration (momsdeklaration) for a period.**
`scope:reports:read · risk:low · idempotent`

Computes momsdeklaration rutor for the given period_type / year / period. The result includes ruta 05 (domestic taxable sales), 10-12 (output VAT 25/12/6%), 20-24 (EU acquisitions of goods + tax on services from EU/non-EU), 30-32 (reverse-charge output VAT 25/12/6%), 39 (export), 40 (EU-services / momsfri försäljning), 48 (input VAT), 50 (import beskattningsunderlag), 60-62 (calculated output VAT on imports 25/12/6%), and 49 (moms att betala/återfå: the bottom line). Mapping rules match SKV 4700.

**Use when:** Submitting momsdeklaration to Skatteverket, reconciling VAT balances at month/quarter end, or building a VAT-payable dashboard.
**Do not use for:** Specific transaction VAT lookups (use /transactions/{id}). Period-mismatch reconciliation (use /reports/general-ledger filtered to 26xx accounts).

**Pitfalls:**
- `period_type` (monthly|quarterly|yearly), `year`, and `period` are all required.
- For monthly: period is 1-12. For quarterly: period is 1-4. For yearly: period is 1.
- `accounting_method` is accepted for backward compatibility but has no effect on the figures: the declaration is a pure ledger projection, and the method (faktureringsmetoden vs kontantmetoden per ML 15 kap 8-11 §§, ML 2023:200) is already reflected in when VAT-bearing journal entries are posted.
- Output ruta 49 = (10+11+12+30+31+32+60+61+62) − 48. Positive = pay; negative = refund.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_type` | query | `"monthly" \| "quarterly" \| "yearly"` | yes | Declaration period length. Required. |
| `year` | query | `number` | yes | Calendar year of the period, 2000-2100. Required. |
| `period` | query | `number` | yes | Period number within the year: 1-12 for monthly, 1-4 for quarterly, 1 for yearly. Required. |
| `accounting_method` | query | `"accrual" \| "cash"` | no | Accepted for backward compatibility; has no effect on the figures. |

Response `200`:
```ts
{
  data?: unknown,
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
    "period_type": "monthly",
    "year": 2026,
    "period": 4,
    "rutor": {
      "ruta05": 0,
      "ruta10": 0,
      "ruta11": 0,
      "ruta12": 0,
      "ruta20": 0,
      "ruta21": 0,
      "ruta22": 0,
      "ruta23": 0,
      "ruta24": 0,
      "ruta30": 0,
      "ruta31": 0,
      "ruta32": 0,
      "ruta39": 0,
      "ruta40": 0,
      "ruta48": 0,
      "ruta50": 0,
      "ruta60": 0,
      "ruta61": 0,
      "ruta62": 0,
      "ruta49": 0
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/vat-declaration/eskd`

**Momsdeklaration as an eSKD XML file, for "Deklarera via fil" at skatteverket.se.**
`scope:reports:read · risk:low · idempotent`

The momsdeklaration for a period as the eSKDUpload v6.0 XML (ISO 8859-1) that Skatteverket's e-tjänst accepts as a file upload, computed purely from the bookkeeping: the same rutor as GET /reports/vat-declaration. No Skatteverket connection is needed and nothing is sent: the user uploads the file, reviews, signs and submits there.

**Use when:** The momsdeklaration is reviewed and the user files it by uploading a file rather than through the Skatteverket connection.
**Do not use for:** Reading the rutor (GET /reports/vat-declaration) or submitting through the Skatteverket API connection.

**Pitfalls:**
- A missing or invalid org number on the company settings answers 400 VAT_ESKD_ORG_NUMBER_INVALID: the file would be rejected at upload.
- fiscal_period_id is for yearly (helårsmoms) with a broken räkenskapsår; it is ignored for monthly and quarterly.
- Refused while an SIE import is unfinished.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_type` | query | `"monthly" \| "quarterly" \| "yearly"` | yes | The momsperiod length. |
| `year` | query | `number` | yes | Calendar year of the period; for yearly, the year the räkenskapsår ends. |
| `period` | query | `number` | yes | 1-12 monthly, 1-4 quarterly, 1 yearly. |
| `fiscal_period_id` | query | `string` | no | Yearly (helårsmoms) only: the räkenskapsår whose bounds the period takes, for a broken fiscal year. |

Response `200` (`application/xml`).

---

### `GET /api/v1/companies/{companyId}/reports/vat-declaration/filings`

**List the VAT periods the company has recorded as filed.**
`scope:reports:read · risk:low · idempotent`

Returns every monthly, quarterly or yearly momsdeklaration period the company has on record as filed, newest first, with the dates each period covers (`period_start`, `period_end`). `source` is `skatteverket` when the filing was confirmed by a Skatteverket kvittens through the connection, `manual` when a person or an API caller recorded it (POST on this path, or completing the period's moms deadline). `reference` is the Skatteverket reference typed at manual marking, if any. `changed_after_filing` says what verifikat posted, corrected or re-dated after the filing moved in the declared period (per ruta, signed as filed, with the verifikat), or null when the books still read as filed. Local state: not a Skatteverket read.

**Use when:** Deciding which VAT period is next to prepare, checking whether a period was already filed before recomputing it, or reconciling a filing calendar against the books.
**Do not use for:** Reading what Skatteverket actually has on file (use /skatteverket/vat-declarations) or computing the declaration figures (use /reports/vat-declaration).

**Pitfalls:**
- An empty list means nothing is recorded, not that nothing was filed: companies that file on skatteverket.se by hand only get records when they mark the period (POST here or in the app).
- Yearly (helårsmoms) is the räkenskapsår: `year` is the year it ends in, `period` is 1, and a broken fiscal year ends in its own month (tax_period `2025/2026`, period_end `2026-06-30`), placed from the company's fiscal-year settings.
- A non-null `changed_after_filing` does not reach Skatteverket by itself: the filed declaration and the books now differ by `rutor_change`.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { deadline_id: string, period_type: "monthly" | "quarterly" | "yearly", year: number, period: number, tax_period: string, period_start: string, period_end: string, filed_on: string, source: "skatteverket" | "manual", reference: string | null, changed_after_filing: { changed_after: string, rutor_change: Record<string, number>, verifikat: { journal_entry_id: string, voucher: string, entry_date: string, changed_at: string, kind: "posted" | "rattelse" | "redated", rutor_change: Record<string, number> }[] } | null }[],
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
      "deadline_id": "11111111-1111-4111-8111-111111111111",
      "period_type": "quarterly",
      "year": 2026,
      "period": 2,
      "tax_period": "2026-Q2",
      "period_start": "2026-04-01",
      "period_end": "2026-06-30",
      "filed_on": "2026-08-10",
      "source": "manual",
      "reference": null,
      "changed_after_filing": null
    }
  ],
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reports/vat-declaration/filings`

**Record that a VAT period was filed outside the Skatteverket connection.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Marks a monthly, quarterly or yearly momsdeklaration period as filed on `filed_on` (Swedish calendar date), optionally with Skatteverket's `reference` (kvittensnummer). Completes the period's moms deadline with status `submitted`, creating the deadline row when the company has none for the period. Nothing is sent to Skatteverket. Idempotent: marking an already-marked period updates its date and reference; a period already confirmed at Skatteverket is returned unchanged (`changed: false`). Dry-runnable: the dry run applies the same rules and answers `would_mark`, `effect` (create, update or unchanged) and the `current` record.

**Use when:** The declaration was filed on skatteverket.se by hand, by an ombud, or from another system, and the books should know the period is done so the next period opens by default.
**Do not use for:** Filing the declaration itself: that is the BankID-signed flow (accounted_vat_declaration_submit / the Skatteverket panel).

**Pitfalls:**
- The period must have ended and `filed_on` must fall after the period's last day and no later than today (Swedish date): otherwise 400 with VAT_FILING_PERIOD_NOT_ENDED, VAT_FILING_DATE_BEFORE_PERIOD_END or VAT_FILING_DATE_IN_FUTURE.
- Yearly (helårsmoms) is the räkenskapsår: `year` is the year it ends in, `period` is 1, and a broken fiscal year ends in its own month (tax_period `2025/2026`, period_end `2026-06-30`), placed from the company's fiscal-year settings.
- Omitting `reference` keeps a previously stored reference; pass null to clear it.
- This records a fact about the books, it does not verify anything at Skatteverket. Use /skatteverket/vat-declarations to check what was actually received.
- A 409 CONFLICT means the deadline row changed while it was being marked (for example a deadline regeneration ran at the same moment). Nothing was written; retry the same request.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  period_type: "monthly" | "quarterly" | "yearly",
  year: number,
  period: number,
  filed_on: string,
  reference?: string | null
}
```

Example request:
```json
{
  "period_type": "quarterly",
  "year": 2026,
  "period": 2,
  "filed_on": "2026-08-10",
  "reference": "ABC123"
}
```

Response `200`:
```ts
{
  data: {
    deadline_id: string,
    period_type: "monthly" | "quarterly" | "yearly",
    year: number,
    period: number,
    tax_period: string,
    period_start: string,
    period_end: string,
    filed_on: string,
    source: "skatteverket" | "manual",
    reference: string | null,
    created: boolean,
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
    "deadline_id": "11111111-1111-4111-8111-111111111111",
    "period_type": "quarterly",
    "year": 2026,
    "period": 2,
    "tax_period": "2026-Q2",
    "period_start": "2026-04-01",
    "period_end": "2026-06-30",
    "filed_on": "2026-08-10",
    "source": "manual",
    "reference": "ABC123",
    "created": false,
    "changed": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/reports/vat-declaration/filings`

**Undo a manual "filed" mark on a VAT period.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

Puts the period's moms deadline back to pending and removes the stored reference. Query params: period_type (monthly|quarterly|yearly), year, period. A period confirmed at Skatteverket through the connection is refused with 409 VAT_FILING_CONFIRMED_BY_SKATTEVERKET; a period with no filing record answers 404 VAT_FILING_NOT_FOUND. Dry-runnable: the dry run gives the same refusals and otherwise answers `would_unmark` and the `current` record.

**Use when:** A period was marked as filed by mistake.
**Do not use for:** Withdrawing or correcting a declaration at Skatteverket: that is a new declaration for the same period, filed through the ordinary flow.

**Pitfalls:**
- Only manual marks can be undone; a Skatteverket kvittens is a fact this endpoint does not erase.
- Yearly (helårsmoms) is the räkenskapsår: `year` is the year it ends in, `period` is 1, and a broken fiscal year ends in its own month (tax_period `2025/2026`, period_end `2026-06-30`), placed from the company's fiscal-year settings.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_type` | query | `"monthly" \| "quarterly" \| "yearly"` | yes | The momsperiod length; yearly is helårsmoms, one period per räkenskapsår. |
| `year` | query | `number` | yes | Calendar year of the period; for yearly, the year the räkenskapsår ends. |
| `period` | query | `number` | yes | 1-12 monthly, 1-4 quarterly, 1 yearly. |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { deadline_id: string, unmarked: true },
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
    "deadline_id": "11111111-1111-4111-8111-111111111111",
    "unmarked": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reports/vat-declaration/settlement-proposal`

**The proposed momsredovisning verifikat for a VAT period: clear 26xx to 2650 or 1650.**
`scope:reports:read · risk:low · idempotent`

Builds the settlement entry for a momsperiod from the same ledger totals as the momsdeklaration: every output VAT account (261x-263x, reverse charge and import included) debited and every input VAT account (264x) credited by its period balance at exact öre, the net to 2650 (att betala, credit) or 1650 (att återfå, debit) at the whole-krona amount the declaration is filed with (ruta 49), and the öre gap on 3740. Dated the period's last day, or the first open day after it when that day is closed or locked (entry_date_reason says why). existing_entries lists the settlements already booked or drafted for the period: dated inside it (tagged vat_settlement or recognised by shape) unless it clears exactly the previous period's balances instead, or dated after it and clearing exactly this period's balances (late_settlement set); booking_status sums them up. Every posted one is listed, since each gates booking. When the posted ones no longer clear the period's VAT exactly (a settlement that came with an import mid-period, a verifikat added after the period was settled, a credit note that lowered an account after they cleared it), partly_settled is true and lines hold only what is left on the accounts (what they cleared past an account's balance, a krona or more, is taken back when no other balance stands on that side of it), with the net less what they already moved, on 2650, debit or credit; a claim they put on 1650 that 1650 still holds exactly moves to 2650 with it, so the period's later charges, refunds and corrections all land on 2650. fingerprint identifies these exact lines. Read-only.

**Use when:** Before booking the VAT for a period (POST /vat/settlement), to review what will be posted.
**Do not use for:** The declaration rutor themselves (GET /reports/vat-declaration) or paying the VAT (the skattekonto payment is booked separately).

**Pitfalls:**
- booking_status booked means a posted settlement exists: booking again is refused; reverse every posted one in existing_entries first if the period must be re-booked.
- is_empty true means the period has no VAT to clear and its posted settlements left nothing on the accounts.
- lines clear the WHOLE period, also when booking_status is booked and the period is settled in full. Only with partly_settled true are they what is left after the settlements already posted: booking is still refused then (booking_status booked), so the rest is posted as an ordinary verifikat, or every posted settlement in existing_entries is reversed and the period booked whole.
- An ordinary verifikat stays out of the declaration rutor as a momsredovisning only when it has a 2650 or 1650 line (or is a pure 26xx movement against 1630): two 26xx accounts against each other count as VAT of the period.
- An existing_entries row recognised by shape can be a correction, not a momsredovisning (e.g. output VAT moved to 1650 next to a sales correction): once the user confirms, it is marked as one on the Moms page or with accounted_mark_not_momsredovisning; the rutor then read it and it no longer counts as a momsredovisning.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_type` | query | `"monthly" \| "quarterly" \| "yearly"` | yes | The momsperiod length. |
| `year` | query | `number` | yes | Calendar year of the period; for yearly, the year the räkenskapsår ends. |
| `period` | query | `number` | yes | 1-12 monthly, 1-4 quarterly, 1 yearly. |
| `fiscal_period_id` | query | `string` | no | Yearly (helårsmoms) only: the räkenskapsår whose bounds the period takes, for a broken fiscal year. |

Response `200`:
```ts
{
  data: {
    period: { type: "monthly" | "quarterly" | "yearly", year: number, period: number, start: string, end: string },
    period_label: string,
    entry_date: string,
    entry_date_reason: "period_closed" | "period_locked" | "company_lock_date" | null,
    description: string,
    lines: { account_number: string, debit_amount: number, credit_amount: number, line_description?: string }[],
    filed_net: number,
    rounding_amount: number,
    is_empty: boolean,
    partly_settled: boolean,
    existing_entries: { journal_entry_id: string, status: string, entry_date: string, source_type: string | null, voucher_series: string | null, voucher_number: number | null, late_settlement?: { cleared: number, net: number, via: "net_account" | "tax_account" } }[],
    booking_status: "booked" | "draft" | "none",
    fingerprint: string
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
    "period": {
      "type": "quarterly",
      "year": 2026,
      "period": 1,
      "start": "2026-01-01",
      "end": "2026-03-31"
    },
    "period_label": "Kvartal 1 2026",
    "entry_date": "2026-03-31",
    "entry_date_reason": null,
    "description": "Momsredovisning Kvartal 1 2026",
    "lines": [
      {
        "account_number": "2611",
        "debit_amount": 25000,
        "credit_amount": 0
      },
      {
        "account_number": "2641",
        "debit_amount": 0,
        "credit_amount": 6250.4
      },
      {
        "account_number": "2650",
        "debit_amount": 0,
        "credit_amount": 18749,
        "line_description": "Moms att betala"
      },
      {
        "account_number": "3740",
        "debit_amount": 0,
        "credit_amount": 0.6,
        "line_description": "Öres- och kronutjämning"
      }
    ],
    "filed_net": 18749,
    "rounding_amount": 0.6,
    "is_empty": false,
    "partly_settled": false,
    "existing_entries": [],
    "booking_status": "none",
    "fingerprint": "3f9a…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/unexplained`

**The unexplained queue: every expected-zero check run for the company, differences first.**
`scope:reports:read · risk:low · idempotent`

Runs every check of a difference that should be zero and lists one row per result: kundreskontra against booked receivables, leverantörsreskontra against booked payables, each bank account's booked balance against the balance the bank reported, the skattekonto account against Skatteverket's saldo, declared momsperioder whose VAT accounts were never moved to the settlement account, and bank transactions still unbooked past the BFNAR 2013:2 booking deadline. Each row has its status (ok, unexplained, cannot_check with a typed reason), the signed difference, the date it holds at, one Swedish sentence, what fixes it, and the explain call that names the items behind it. Both figures of every check come from the report a person sees. Read-only.

**Use when:** At the start of a session or before a close: what in the books does not add up, and what to do about it.
**Do not use for:** A single figure (GET /measures/{id}) or the full reconciliation of one account (GET /reconciliation/accounts/{accountKey}).

**Pitfalls:**
- cannot_check is not ok: the check could not run (refusal_code says why: kontantmetoden, no bank balance, not connected to Skatteverket, ...).
- Live: every check reads today's state. The bank and skattekonto rows compare on the date the outside balance was fetched (as_of).
- difference is in unit: SEK, or a count for unbooked_bank_lines_overdue.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    as_of: string,
    counts: { unexplained: number, cannot_check: number, ok: number },
    items: { check_id: string, name_sv: string, status: "ok" | "unexplained" | "cannot_check", subject: { kind: "company" | "bank_account" | "vat_period", cash_account_id?: string, handle?: string | null, account_number?: string, name?: string, period_type?: string, year?: number, period?: number, start?: string, end?: string, label?: string }, difference: number | null, unit: "SEK" | "count", as_of: string, summary_sv: string, refusal_code: string | null, next: { tool: string, arguments?: Record<string, unknown>, screen: string } | null, explain: { tool: "accounted_explain_unexplained", arguments: Record<string, unknown>, v1_path: string } }[],
    truncated: number
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
    "as_of": "2026-10-16",
    "counts": {
      "unexplained": 1,
      "cannot_check": 2,
      "ok": 4
    },
    "items": [
      {
        "check_id": "receivables_vs_ledger",
        "name_sv": "Kundreskontran mot bokförda kundfordringar",
        "status": "unexplained",
        "subject": {
          "kind": "company"
        },
        "difference": 3000,
        "unit": "SEK",
        "as_of": "2026-10-16",
        "summary_sv": "Kundreskontran visar 15 500,00 kr men de bokförda kundfordringarna är 12 500,00 kr: differens 3 000,00 kr.",
        "refusal_code": null,
        "next": {
          "tool": "accounted_link_invoice_to_voucher",
          "screen": "/reports/kundreskontra"
        },
        "explain": {
          "tool": "accounted_explain_unexplained",
          "arguments": {
            "check_id": "receivables_vs_ledger"
          },
          "v1_path": "/api/v1/companies/9f1e…/unexplained/receivables_vs_ledger/explain"
        }
      }
    ],
    "truncated": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/unexplained/{checkId}`

**One expected-zero check: its definition and basis, the figures it compares, and every result.**
`scope:reports:read · risk:low · idempotent`

Runs one check and answers its definition (which figure minus which, read how), the rule it rests on, the tolerance, the reports the two figures come from, the action that fixes a difference, and one result per subject (the company, each bank account, each declared momsperiod) with both figures, the difference, a Swedish sentence, any refusal and the explain call.

**Use when:** An agent must say exactly what a queue row compares, or show both figures with where a person reads them.
**Do not use for:** The items behind a difference (GET /unexplained/{checkId}/explain).

**Pitfalls:**
- An unknown check_id answers 404 UNEXPLAINED_CHECK_NOT_FOUND with the valid ids in details.valid.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `checkId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    check_id: string,
    name_sv: string,
    name_en: string,
    definition: string,
    definition_sv: string,
    basis: string,
    unit: "SEK" | "count",
    tolerance: number,
    subject_kind: "company" | "bank_account" | "vat_period",
    compares: { report: string, v1_path: string | null, mcp_tool: string, screen: string | null }[],
    next_action: { message_sv: string, tool: string, arguments?: Record<string, unknown>, screen: string },
    status: "ok" | "unexplained" | "cannot_check",
    results: { status: "ok" | "unexplained" | "cannot_check", subject: { kind: "company" | "bank_account" | "vat_period", cash_account_id?: string, handle?: string | null, account_number?: string, name?: string, period_type?: string, year?: number, period?: number, start?: string, end?: string, label?: string }, difference: number | null, as_of: string, summary_sv: string, sides: { key: string, label_sv: string, label_en: string, amount: number | null, source: { report: string, v1_path: string | null, mcp_tool: string, screen: string | null } }[], refusal: { code: string, message_sv: string, message_en: string, retryable?: boolean, details?: Record<string, unknown> } | null, facts: Record<string, unknown> | null, next_action: { message_sv: string, tool: string, arguments?: Record<string, unknown>, screen: string } | null, explain: { tool: "accounted_explain_unexplained", arguments: Record<string, unknown>, v1_path: string } }[]
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
    "check_id": "receivables_vs_ledger",
    "name_sv": "Kundreskontran mot bokförda kundfordringar",
    "name_en": "Customer ledger against booked receivables",
    "definition": "Open customer invoices in the invoice register now ... minus the booked balance of the receivables accounts ...",
    "definition_sv": "Öppna kundfakturor i fakturaregistret just nu ... minus bokfört saldo på kundfordringskontona ...",
    "basis": "Every balance sheet account is reconciled against its underlag ...",
    "unit": "SEK",
    "tolerance": 0.005,
    "subject_kind": "company",
    "compares": [
      {
        "report": "Kundreskontra (öppna kundfakturor)",
        "v1_path": "/reports/ar-ledger",
        "mcp_tool": "accounted_get_ar_ledger",
        "screen": "/reports/kundreskontra"
      },
      {
        "report": "Huvudbok, kundfordringskontona",
        "v1_path": "/reports/general-ledger",
        "mcp_tool": "accounted_get_general_ledger",
        "screen": "/reports/huvudbok"
      }
    ],
    "next_action": {
      "message_sv": "Öppna förklaringen ...",
      "tool": "accounted_link_invoice_to_voucher",
      "screen": "/reports/kundreskontra"
    },
    "status": "unexplained",
    "results": [
      {
        "status": "unexplained",
        "subject": {
          "kind": "company"
        },
        "difference": 3000,
        "as_of": "2026-10-16",
        "summary_sv": "Kundreskontran visar 15 500,00 kr men de bokförda kundfordringarna är 12 500,00 kr: differens 3 000,00 kr.",
        "sides": [
          {
            "key": "register",
            "label_sv": "Öppna kundfakturor i reskontran",
            "label_en": "Open customer invoices in the register",
            "amount": 15500,
            "source": {
              "report": "Kundreskontra (öppna kundfakturor)",
              "v1_path": "/reports/ar-ledger",
              "mcp_tool": "accounted_get_ar_ledger",
              "screen": "/reports/kundreskontra"
            }
          },
          {
            "key": "ledger",
            "label_sv": "Bokförda kundfordringar",
            "label_en": "Booked receivables",
            "amount": 12500,
            "source": {
              "report": "Huvudbok, kundfordringskontona",
              "v1_path": "/reports/general-ledger",
              "mcp_tool": "accounted_get_general_ledger",
              "screen": "/reports/huvudbok"
            }
          }
        ],
        "refusal": null,
        "facts": {
          "fiscal_period_id": "7c2b…"
        },
        "next_action": {
          "message_sv": "Öppna förklaringen ...",
          "tool": "accounted_link_invoice_to_voucher",
          "screen": "/reports/kundreskontra"
        },
        "explain": {
          "tool": "accounted_explain_unexplained",
          "arguments": {
            "check_id": "receivables_vs_ledger"
          },
          "v1_path": "/api/v1/companies/9f1e…/unexplained/receivables_vs_ledger/explain"
        }
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

### `GET /api/v1/companies/{companyId}/unexplained/{checkId}/explain`

**What a difference in the queue consists of: its parts and the items behind them, with typed handles.**
`scope:reports:read · risk:low · idempotent`

Explains one result of a check: the same difference as the queue, broken into parts (open invoices without a verifikat and verifikat on the control account without an invoice; unbooked bank transactions; Skatteverket events missing from the books and verifikat Skatteverket does not know; the VAT accounts not yet cleared; the overdue bank rows) and, paged, the items behind each part with their typed handles (inv_, sinv_, je_, txn_). residual is what the items do not name and note says what it usually is. For a check with several results (bank accounts, momsperioder), send the subject: cash_account_id, or period_type, year and period, as the explain handle of the row gives them.

**Use when:** An agent must show why a queue row is not zero, or find the records to fix.
**Do not use for:** The queue itself (GET /unexplained).

**Pitfalls:**
- items is paged: limit (1-200, default 25) and offset; next_offset is null on the last page.
- A check with several results and no subject answers 400 UNEXPLAINED_SUBJECT_REQUIRED with the subjects in details.subjects.
- cash_account_id on a company-wide check answers 400 UNEXPLAINED_PARAMETER_NOT_ACCEPTED.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `checkId` | path | `string` | yes |  |
| `cash_account_id` | query | `string` | no | bank_balance_vs_bank: the bank account (cash account id or cash_ handle). |
| `period_type` | query | `"monthly" \| "quarterly" \| "yearly"` | no | vat_declared_not_settled: the momsperiod length. |
| `year` | query | `number` | no | vat_declared_not_settled: year of the momsperiod. |
| `period` | query | `number` | no | vat_declared_not_settled: 1-12 monthly, 1-4 quarterly, 1 yearly. |
| `limit` | query | `number` | no | Item page size, 1-200 (default 25). |
| `offset` | query | `number` | no | Items to skip (next_offset of the previous page). |

Response `200`:
```ts
{
  data: {
    check_id: string,
    name_sv: string,
    status: "ok" | "unexplained" | "cannot_check",
    subject: { kind: "company" | "bank_account" | "vat_period", cash_account_id?: string, handle?: string | null, account_number?: string, name?: string, period_type?: string, year?: number, period?: number, start?: string, end?: string, label?: string },
    difference: number | null,
    unit: "SEK" | "count",
    as_of: string,
    summary_sv: string,
    sides: { key: string, label_sv: string, label_en: string, amount: number | null, source: { report: string, v1_path: string | null, mcp_tool: string, screen: string | null } }[],
    refusal: { code: string, message_sv: string, message_en: string, retryable?: boolean, details?: Record<string, unknown> } | null,
    parts: { key: string, label_sv: string, label_en: string, amount: number, count: number }[],
    residual: number | null,
    reconciles: boolean,
    note: string | null,
    items: { list: { part: string, item_type: "invoice" | "supplier_invoice" | "journal_line" | "transaction" | "skattekonto_transaction" | "vat_account", invoice_id?: string, supplier_invoice_id?: string, journal_entry_id?: string, transaction_id?: string, skattekonto_transaction_id?: string, account_number?: string, handle: string | null, date: string | null, label: string, amount: number, currency?: string, record_amount?: number, days_past_deadline?: number }[], total: number, offset: number, next_offset: number | null },
    next_action: { message_sv: string, tool: string, arguments?: Record<string, unknown>, screen: string } | null
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
    "check_id": "receivables_vs_ledger",
    "name_sv": "Kundreskontran mot bokförda kundfordringar",
    "status": "unexplained",
    "subject": {
      "kind": "company"
    },
    "difference": 3000,
    "unit": "SEK",
    "as_of": "2026-10-16",
    "summary_sv": "Kundreskontran visar 15 500,00 kr men de bokförda kundfordringarna är 12 500,00 kr: differens 3 000,00 kr.",
    "sides": [],
    "refusal": null,
    "parts": [
      {
        "key": "register_without_voucher",
        "label_sv": "Öppna kundfakturor utan verifikat",
        "label_en": "Open customer invoices without a verifikat",
        "amount": 3000,
        "count": 1
      },
      {
        "key": "ledger_without_invoice",
        "label_sv": "Verifikat på kundfordringskontona utan faktura i reskontran",
        "label_en": "Vouchers on the receivables accounts without an invoice in the register",
        "amount": 0,
        "count": 0
      }
    ],
    "residual": 0,
    "reconciles": true,
    "note": null,
    "items": {
      "list": [
        {
          "part": "register_without_voucher",
          "item_type": "invoice",
          "invoice_id": "a1b2…",
          "handle": "inv_a1b2…",
          "date": "2026-10-01",
          "label": "Faktura 1002, Beta HB",
          "amount": 3000,
          "currency": "SEK"
        }
      ],
      "total": 1,
      "offset": 0,
      "next_offset": null
    },
    "next_action": {
      "message_sv": "Öppna förklaringen ...",
      "tool": "accounted_link_invoice_to_voucher",
      "screen": "/reports/kundreskontra"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/vat/settlement`

**Book the momsredovisning verifikat for a VAT period, exactly as the proposal gives it.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Posts the settlement proposal of GET /reports/vat-declaration/settlement-proposal as a verifikat (source_type vat_settlement) through the bookkeeping engine: 26xx cleared, the net on 2650 or 1650 at the filed whole-krona amount, the öre gap on 3740, dated the proposal's entry_date (the period's last day, or the first open day after it). The lines are the server's, never the caller's. Refused when a settlement is already posted for the period (also one dated after it that clears exactly its balances), when there is nothing to clear, when expected_fingerprint no longer matches, or when the date is locked. The declaration projection excludes vat_settlement entries, so the momsdeklaration does not change. Idempotent. Dry-runnable: the dry run previews the verifikat and writes nothing.

**Use when:** The VAT period is reviewed (and usually filed) and the 26xx accounts should be cleared to the skattekonto liability.
**Do not use for:** Filing the momsdeklaration with Skatteverket (the eSKD file or the Skatteverket connection), booking the payment to the skattekonto, or custom settlement lines (post an ordinary verifikat with POST /journal-entries).

**Pitfalls:**
- A posted settlement in the period answers 409 VAT_SETTLEMENT_ALREADY_BOOKED with details.journal_entry_id and, when the refusal read them, details.posted_settlements (every posted one, each gates): reverse them all first if the period must be re-booked. When such a verifikat is a correction the shapes caught, not a momsredovisning, and the user confirms it, mark it as one instead (the Moms page, or accounted_mark_not_momsredovisning).
- Pass expected_fingerprint from the proposal you reviewed: if the ledger changed since, 409 VAT_SETTLEMENT_PROPOSAL_CHANGED instead of booking different lines.
- A locked or closed period, or a date on or before the company lock date, answers 400 PERIOD_LOCKED; no voucher number is spent.
- A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |
| `stage` | query | `string` | no | true stages the write for approval instead of committing it: 202 with the pending operation to approve via POST /pending-operations/{id}/approve. Absent or false commits; other values are 400. A `reason` in the body (why you propose it, at most 500 characters) is shown to the approver as agent_reason and kept with the decision. |

Request body:
```ts
{
  period_type: "monthly" | "quarterly" | "yearly",
  year: number,
  period: number,
  fiscal_period_id?: string,
  expected_fingerprint?: string
}
```

Example request:
```json
{
  "period_type": "quarterly",
  "year": 2026,
  "period": 1,
  "expected_fingerprint": "3f9a…"
}
```

Response `200`:
```ts
{
  data: {
    journal_entry_id: string,
    voucher_series: string | null,
    voucher_number: number | null,
    entry_date: string,
    period_label: string,
    filed_net: number,
    rounding_amount: number
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
    "journal_entry_id": "9a0b…",
    "voucher_series": "A",
    "voucher_number": 57,
    "entry_date": "2026-03-31",
    "period_label": "Kvartal 1 2026",
    "filed_net": 18749,
    "rounding_amount": 0.6
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
