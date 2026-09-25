<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Reports endpoints

Read-only statutory and management reports: trial balance, balance sheet, income statement, general ledger, VAT declaration, AR/AP ledgers, salary journal, and SIE export.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/audit-trail`

**The audit log: every trigger-recorded change to the books and their settings, newest first.**
`scope:reports:read · risk:low · idempotent`

Rows the database triggers write on every insert, update and delete of bookkeeping tables (verifikationer and their lines, kontoplan, fiscal periods, settings, suppliers, imports, ...) and on commits, reversals, corrections and locks: action, table, record id, actor (user, API key, MCP connection, cron), description and the old and new row state. Filter by action, table_name, record_id and a created_at window. Cursor pagination: pass next_cursor back as cursor; next_cursor is null on the last page. Read-only: nothing can write the log except the triggers.

**Use when:** Tracing exactly how one record changed (record_id), or exporting the raw log for an auditor.
**Do not use for:** The readable processing history for a räkenskapsår (GET /reports/behandlingshistorik).

**Pitfalls:**
- old_state / new_state are whole row snapshots and can hold personal data (a sole trader's org number is the owner's personnummer, supplier bank details): treat the response as confidential.
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
    entries: { id: string, action: string, table_name: string | null, record_id: string | null, user_id: string | null, actor_type: string | null, actor_label: string | null, description: string | null, old_state: Record<string, unknown> | null, new_state: Record<string, unknown> | null, created_at: string }[],
    next_cursor: string | null
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

### `GET /api/v1/companies/{companyId}/reports/ar-ledger`

**AR ledger: unpaid customer invoices with aging.**
`scope:reports:read · risk:low · idempotent`

Returns the customer-receivable ledger as of `as_of_date` (defaults to today). Each customer entry includes outstanding invoices grouped into aging buckets (0-30, 31-60, 61-90, 90+ days). Reconciles against BAS 1510.

**Use when:** Cash collection dashboards, dunning workflows, end-of-period reconciliation against the 1510 trial-balance figure.
**Do not use for:** Listing all invoices regardless of status (use /invoices). Sending dunning emails (the v1 surface does not yet expose dunning).

**Pitfalls:**
- `as_of_date` is optional; format `YYYY-MM-DD`. Defaults to today (UTC).
- Only invoices in `sent`/`overdue`/`partially_paid` status appear. Drafts and credited invoices are excluded.
- The ledger is built from the invoice register only. `data.register_coverage` ({ covers_from, has_pre_register_invoices }) discloses when posted AR verifikat predate the register's earliest invoice (migrated or backfilled invoice history): those receivables are NOT in this ledger. When has_pre_register_invoices is true, treat periods before covers_from as unanswered here and query journal entries on 1510/1513 instead.

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

**Annual arbetsgivaravgifter basis per employee.**
`scope:payroll:read · risk:low · idempotent`

Returns the annual avgifter basis per employee for `year`, summed across booked salary runs. Each row shows the basis, applied rate, and computed avgifter amount: useful for reconciling against monthly AGI filings (HU sum across the year).

**Use when:** Annual reconciliation between the AGI declarations and the bookkeeping (BAS 7510). Year-end audit prep.
**Do not use for:** Real-time AGI generation (POST /salary-runs/{id}/generate-agi). Per-run breakdown (use /reports/salary-journal).

**Pitfalls:**
- `year` is required.
- Only `booked` runs are included.

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
    "totals": {}
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

The processing history the system documentation must include (BFNAR 2013:2 p. 9.16): verifikationer posted, corrected and reversed, chart of accounts and settings changes, period locks and closings, imports, access changes and program versions, each with time, actor (user, API key, MCP connection, cron) and detail lines. Filter by from_date / to_date inside the period and by one category, as the dashboard report. For an enskild firma the owner's personnummer is masked. Read-only.

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
| `category` | query | `"verifikation" \| "kontoplan" \| "installningar" \| "period" \| "import" \| "atkomst" \| "arkiv" \| "ovrigt"` | no | Only events of this category. |

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
    "is_continuous": true,
    "discrepancies": []
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

A value-as-column P&L matrix over one SIE dimension (dim_no 6 projekt by default, 1 kostnadsställe, or a custom dimension): each result account's amount per dimension value, an "(Utan dimension)" column for untagged amounts, and a Totalt column that equals the resultatrapport. Cumulative from the period start to to_date (default the period end). Read-only.

**Use when:** Following up profitability per project or cost centre.
**Do not use for:** One value only (GET /reports/income-statement with a dimension filter) or balance accounts (dimensions are P&L-side).

**Pitfalls:**
- No from_date: the matrix uses closing-balance semantics so its Totalt reconciles with the resultatrapport.
- Amounts booked without a tag on the dimension land in "(Utan dimension)", not spread over the values.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id, from GET /fiscal-periods. |
| `dim_no` | query | `string` | no | SIE dimension number. Default "6" (projekt). |
| `to_date` | query | `string` | no | YYYY-MM-DD inside the period. Default: the period end. |

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

### `GET /api/v1/companies/{companyId}/reports/general-ledger`

**General ledger (huvudbok) for a fiscal period.**
`scope:reports:read · risk:low · idempotent`

Returns every posted journal line in the period grouped by account, with opening / running / closing balances. Supports optional `account_from` and `account_to` query parameters to limit the report to an account range (e.g. ?account_from=3000&account_to=3999 for revenue-only).

**Use when:** You're reconciling a specific account or range (bank account drilldown, revenue audit, expense investigation) and need every voucher-line that hit the account.
**Do not use for:** Period totals only (use /reports/trial-balance). Specific transaction lookup (use /journal-entries/{id}).

**Pitfalls:**
- `period_id` is required.
- Account ranges are inclusive on both bounds. `account_from=3000` includes 3000; `account_to=3999` includes 3999.
- Lines with `status != 'posted'` (drafts, reversed) are excluded.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |
| `account_from` | query | `string` | no | Lowest account number to include (inclusive), 3-8 digits, e.g. 3000. |
| `account_to` | query | `string` | no | Highest account number to include (inclusive), 3-8 digits, e.g. 3999. |

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

Returns the period's revenue and expenses grouped by BAS class with subtotals (gross margin, operating result, net result). Optional `from_date` / `to_date` (YYYY-MM-DD, inside the fiscal period) narrow the report to a custom range, e.g. January 1 to July 31 for month-end bank reporting. The net result flows into the balance-sheet equity for the same period.

**Use when:** You need the company's profit/loss for a period or partial period: month-end management reporting, K2/K3 årsredovisning resultaträkning, or feeding KPI dashboards.
**Do not use for:** Per-account drill (use /reports/general-ledger). VAT figures (use /reports/vat-declaration). Balance position (use /reports/balance-sheet).

**Pitfalls:**
- `period_id` is required; `from_date`/`to_date` are optional and must lie within that fiscal period.
- Unknown query parameters are rejected with VALIDATION_ERROR, not silently ignored.
- Net result on the income statement equals the period's equity-line delta on the balance sheet: they're derived from the same posted entries.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |
| `from_date` | query | `string` | no | YYYY-MM-DD, inside the fiscal period. Omit with to_date for the whole period. |
| `to_date` | query | `string` | no | YYYY-MM-DD, inside the fiscal period and not before from_date. |

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

Computes the aktiebolag income tax return from the books, keyed by SRU field code: ink2 (page 1: 7104 överskott / 7114 underskott), ink2r (räkenskapsschema: balance sheet and income statement, the balance sheet from the closed books and the income statement before the resultatavslut) and ink2s (skattemässiga justeringar, including the adjustments saved in the year-end flow), with the per-code account breakdown, totals and warnings. The SRU files for upload at skatteverket.se are served by GET /reports/ink2/sru; sru_file names that path. Read-only.

**Use when:** Preparing or checking the aktiebolag income tax return after bokslut, or reconciling INK2R figures against the årsredovisning.
**Do not use for:** Enskild firma (GET /reports/ne-bilaga), the årsredovisning itself, or submitting to Skatteverket (upload the SRU files at skatteverket.se; nothing is sent from here).

**Pitfalls:**
- Only for aktiebolag: another legal form answers 400 TAX_DECL_INK2_WRONG_LEGAL_FORM.
- Amounts are whole kronor as Skatteverket takes them; codes with no amount are 0.
- Run it after the year-end closing: before bokslut the tax (8910) and bokslutsdispositioner are missing, and warnings say so.
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
    companyInfo: { companyName: string, orgNumber: string | null, addressLine1: string | null, postalCode: string | null, city: string | null, email: string | null },
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

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id. |

Response `200` (`application/zip`).

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

Derives the cash flow statement from the trial balance: löpande verksamhet (result after financial items, avskrivningar, changes in receivables, inventory and short-term liabilities, tax paid), investeringsverksamhet and finansieringsverksamhet, with a reconciliation of the calculated change against the actual change in cash (1xxx liquid funds). Read-only.

**Use when:** Preparing the årsredovisning for a K3 company (or a larger K2 one that includes it), or analysing where the year's cash went.
**Do not use for:** Liquidity forecasts or bank balances (GET /reports/trial-balance for 19xx).

**Pitfalls:**
- reconciliation.is_reconciled false means an account the analysis cannot classify moved; it does not by itself mean the books are wrong.
- A year whose income tax cannot be separated from other taxes answers 422 CASH_FLOW_TAX_ALLOCATION_REQUIRED.

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

Returns revenue + expenses + net result per calendar month inside the fiscal period. The sum across all months equals the period's full income-statement totals.

**Use when:** Building a trend chart, computing rolling KPIs, or producing a månadsrapport for management.
**Do not use for:** Single-month snapshot only (call /reports/income-statement with a month-sized period). Cash flow analysis (a dedicated cash-flow report is not yet on v1).

**Pitfalls:**
- `period_id` is required.

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

**NE-bilaga (enskild firma): rutor R1-R11 for a räkenskapsår.**
`scope:reports:read · risk:low · idempotent`

Computes the NE-bilaga rutor R1-R11 from the books before the resultatavslut (försäljning, momsfria intäkter, varuinköp, övriga kostnader, lönekostnader, räntor, avskrivningar, årets resultat), with the per-ruta account breakdown and warnings. The owner's personnummer (the enskild firma's org number) is masked in this JSON; the SRU files for upload at skatteverket.se, served by GET /reports/ne-bilaga/sru, carry it in full. Read-only.

**Use when:** Preparing or checking the enskild firma's NE-bilaga after bokslut.
**Do not use for:** Aktiebolag (GET /reports/ink2), the egenavgifter / räntefördelning / periodiseringsfond adjustments (MCP gnubok_preview_ef_declaration), or submitting (upload the SRU files at skatteverket.se).

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
    breakdown: Record<string, { accounts: { accountNumber: string, accountName: string, amount: number }[], total: number }>,
    companyInfo: { companyName: string, orgNumber: string | null, addressLine1: string | null, postalCode: string | null, city: string | null, email: string | null },
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
    "companyInfo": {
      "companyName": "Anna Svensson Konsult",
      "orgNumber": "19800101-XXXX",
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

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | The fiscal period (räkenskapsår) id. |

Response `200` (`application/zip`).

---

### `GET /api/v1/companies/{companyId}/reports/periodisk-sammanstallning`

**Periodisk sammanställning (EU sales list): per-customer EU sales of goods, services and triangulation.**
`scope:reports:read · risk:low · idempotent`

Builds the periodisk sammanställning for a month or quarter: one row per EU customer VAT number with varor, tjänster and trepartshandel amounts, plus warnings (missing or invalid VAT numbers, Swedish customers, credit notes), reconciled against the momsdeklaration (rutor 35, 38, 39) when the periods coincide. The SKV 574008 CSV for upload is served by GET /reports/periodisk-sammanstallning/csv. Read-only.

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
    "year": 2026,
    "employees": [],
    "totals": {}
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

Returns the per-account opening balance + period debit/credit + closing balance plus run-level totals and an `isBalanced` flag. The numbers come from the same `lib/reports/trial-balance.ts` generator the dashboard uses.

**Use when:** You need a snapshot of every active account's movement during a period: typically the first report an accountant checks before running balance sheet or income statement.
**Do not use for:** Reconciliation against AR/AP (use /reports/ar-ledger or /supplier-ledger). Specific account drill-in (use /reports/general-ledger with account_from/account_to filters).

**Pitfalls:**
- `period_id` is required as a query parameter.
- `isBalanced=false` means the period has unbalanced postings: a data-integrity red flag. The lib generator rounds at the source so a true imbalance is rare; investigate immediately.
- Closed/locked periods are still queryable: the report is read-only.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_id` | query | `string` | yes | Fiscal period id (from GET /fiscal-periods). Required. |

Response `200`:
```ts
{
  data: {
    rows: { account: string, account_name: string, opening_balance: number, period_debit: number, period_credit: number, closing_balance: number }[],
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
        "account": "1930",
        "account_name": "Företagskonto",
        "opening_balance": 100000,
        "period_debit": 25000,
        "period_credit": 18000,
        "closing_balance": 107000
      }
    ],
    "totalDebit": 25000,
    "totalCredit": 25000,
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
- `year` is required.
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

**List the calendar VAT periods the company has recorded as filed.**
`scope:reports:read · risk:low · idempotent`

Returns every monthly or quarterly momsdeklaration period the company has on record as filed, newest first. `source` is `skatteverket` when the filing was confirmed by a Skatteverket kvittens through the connection, `manual` when a person or an API caller recorded it (POST on this path, or completing the period's moms deadline). `reference` is the Skatteverket reference typed at manual marking, if any. Local state: not a Skatteverket read.

**Use when:** Deciding which VAT period is next to prepare, checking whether a period was already filed before recomputing it, or reconciling a filing calendar against the books.
**Do not use for:** Reading what Skatteverket actually has on file (use /skatteverket/vat-declarations) or computing the declaration figures (use /reports/vat-declaration).

**Pitfalls:**
- Helårsmoms (yearly) periods are not listed: their deadline is labelled per räkenskapsår and is completed from the calendar.
- An empty list means nothing is recorded, not that nothing was filed: companies that file on skatteverket.se by hand only get records when they mark the period (POST here or in the app).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { deadline_id: string, period_type: "monthly" | "quarterly", year: number, period: number, tax_period: string, filed_on: string, source: "skatteverket" | "manual", reference: string | null }[],
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
      "filed_on": "2026-08-10",
      "source": "manual",
      "reference": null
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

Marks a monthly or quarterly momsdeklaration period as filed on `filed_on` (Swedish calendar date), optionally with Skatteverket's `reference` (kvittensnummer). Completes the period's moms deadline with status `submitted`, creating the deadline row when the company has none for the period. Nothing is sent to Skatteverket. Idempotent: marking an already-marked period updates its date and reference; a period already confirmed at Skatteverket is returned unchanged (`changed: false`). Dry-runnable.

**Use when:** The declaration was filed on skatteverket.se by hand, by an ombud, or from another system, and the books should know the period is done so the next period opens by default.
**Do not use for:** Filing the declaration itself: that is the BankID-signed flow (accounted_vat_declaration_submit / the Skatteverket panel). Yearly (helårsmoms) periods: complete the calendar deadline instead.

**Pitfalls:**
- The period must have ended and `filed_on` must fall after the period's last day and no later than today (Swedish date): otherwise 400 with VAT_FILING_PERIOD_NOT_ENDED, VAT_FILING_DATE_BEFORE_PERIOD_END or VAT_FILING_DATE_IN_FUTURE.
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
  period_type: "monthly" | "quarterly",
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
    period_type: "monthly" | "quarterly",
    year: number,
    period: number,
    tax_period: string,
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

Puts the period's moms deadline back to pending and removes the stored reference. Query params: period_type (monthly|quarterly), year, period. A period confirmed at Skatteverket through the connection is refused with 409 VAT_FILING_CONFIRMED_BY_SKATTEVERKET; a period with no filing record answers 404 VAT_FILING_NOT_FOUND. Dry-runnable.

**Use when:** A period was marked as filed by mistake.
**Do not use for:** Withdrawing or correcting a declaration at Skatteverket: that is a new declaration for the same period, filed through the ordinary flow.

**Pitfalls:**
- Only manual marks can be undone; a Skatteverket kvittens is a fact this endpoint does not erase.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `period_type` | query | `"monthly" \| "quarterly"` | yes |  |
| `year` | query | `number` | yes |  |
| `period` | query | `number` | yes |  |
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

Builds the settlement entry for a momsperiod from the same ledger totals as the momsdeklaration: every output VAT account (261x-263x, reverse charge and import included) debited and every input VAT account (264x) credited by its period balance at exact öre, the net to 2650 (att betala, credit) or 1650 (att återfå, debit) at the whole-krona amount the declaration is filed with (ruta 49), and the öre gap on 3740. Dated the period's last day. existing_entries lists settlements already booked or drafted in the period (tagged vat_settlement or recognised by shape); booking_status sums them up. fingerprint identifies these exact lines. Read-only.

**Use when:** Before booking the VAT for a period (POST /vat/settlement), to review what will be posted.
**Do not use for:** The declaration rutor themselves (GET /reports/vat-declaration) or paying the VAT (the skattekonto payment is booked separately).

**Pitfalls:**
- booking_status booked means a posted settlement exists: booking again is refused; reverse that verifikat first if the period must be re-booked.
- is_empty true means the period has no VAT to clear.
- The proposal clears the WHOLE period, not the change since an earlier settlement.

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
    description: string,
    lines: { account_number: string, debit_amount: number, credit_amount: number, line_description?: string }[],
    filed_net: number,
    rounding_amount: number,
    is_empty: boolean,
    existing_entries: { journal_entry_id: string, status: string, entry_date: string, source_type: string | null, voucher_series: string | null, voucher_number: number | null }[],
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

### `POST /api/v1/companies/{companyId}/vat/settlement`

**Book the momsredovisning verifikat for a VAT period, exactly as the proposal gives it.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Posts the settlement proposal of GET /reports/vat-declaration/settlement-proposal as a verifikat (source_type vat_settlement) through the bookkeeping engine: 26xx cleared, the net on 2650 or 1650 at the filed whole-krona amount, the öre gap on 3740, dated the period's last day. The lines are the server's, never the caller's. Refused when a settlement is already posted in the period, when there is nothing to clear, when expected_fingerprint no longer matches, or when the date is locked. The declaration projection excludes vat_settlement entries, so the momsdeklaration does not change. Idempotent. Dry-runnable: the dry run previews the verifikat and writes nothing.

**Use when:** The VAT period is reviewed (and usually filed) and the 26xx accounts should be cleared to the skattekonto liability.
**Do not use for:** Filing the momsdeklaration with Skatteverket (the eSKD file or the Skatteverket connection), booking the payment to the skattekonto, or custom settlement lines (post an ordinary verifikat with POST /journal-entries).

**Pitfalls:**
- A posted settlement in the period answers 409 VAT_SETTLEMENT_ALREADY_BOOKED with details.journal_entry_id: reverse it first if the period must be re-booked.
- Pass expected_fingerprint from the proposal you reviewed: if the ledger changed since, 409 VAT_SETTLEMENT_PROPOSAL_CHANGED instead of booking different lines.
- A locked or closed period, or a date on or before the company lock date, answers 400 PERIOD_LOCKED; no voucher number is spent.
- A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.

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
