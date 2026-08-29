<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Reports endpoints

Read-only statutory and management reports: trial balance, balance sheet, income statement, general ledger, VAT declaration, AR/AP ledgers, salary journal, and SIE export.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/reports/ar-ledger`

**AR ledger: unpaid customer invoices with aging.**
`scope:reports:read · risk:low · idempotent`

Returns the customer-receivable ledger as of `as_of_date` (defaults to today). Each customer entry includes outstanding invoices grouped into aging buckets (0-30, 31-60, 61-90, 90+ days). Reconciles against BAS 1510.

**Use when:** Cash collection dashboards, dunning workflows, end-of-period reconciliation against the 1510 trial-balance figure.
**Do not use for:** Listing all invoices regardless of status (use /invoices). Sending dunning emails (the v1 surface does not yet expose dunning).

**Pitfalls:**
- `as_of_date` is optional; format `YYYY-MM-DD`. Defaults to today (UTC).
- Only invoices in `sent`/`overdue`/`partially_paid` status appear. Drafts and credited invoices are excluded.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data?: unknown,
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

Response `200`:
```ts
{
  data?: unknown,
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

Response `200`:
```ts
{
  data?: unknown,
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

Response `200` (`application/pdf`).

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

Response `200`:
```ts
{
  data?: unknown,
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

Response `200`:
```ts
{
  data?: unknown,
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

Response `200`:
```ts
{
  data?: unknown,
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

Response `200` (`application/pdf`).

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

Response `200`:
```ts
{
  data?: unknown,
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

Response `200`:
```ts
{
  data?: unknown,
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

Response `200`:
```ts
{
  data?: unknown,
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

Response `200`:
```ts
{
  data?: unknown,
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

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data?: unknown,
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

Response `200`:
```ts
{
  data?: unknown,
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
