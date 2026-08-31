<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Journal entries endpoints

The ledger itself: journal entries follow draft -> commit -> immutable. There is no edit or delete after commit; undo via reverse (storno) or correct. Voucher numbers are server-assigned and gapless; explain unavoidable gaps via voucher-gap-explanations.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/journal-entries`

**List journal entries (verifikationer).**
`scope:reports:read · risk:low · idempotent`

Cursor-paginated list of journal entries ordered by created_at DESC, id ASC (newest-booked first; the `entry_date` column is the verifikationsdatum and is filterable via ?date_from / ?date_to but is not the sort key). Filters: fiscal_period_id, status, date_from, date_to. Excludes status=cancelled by default; pass status=cancelled to inspect storno-cancelled drafts.

**Use when:** You need to walk the verifikationsserie for a period (audit, SIE export, gap detection) or list recent activity for a UI.
**Do not use for:** Reading a single verifikation (use GET /{id}). Reading lines without the header (no separate endpoint: they ride in /{id}).

**Pitfalls:**
- Cancelled drafts are hidden by default. They are NOT a löpnummer gap (no voucher_number is allocated for drafts); the filter is for noise reduction.
- voucher_number=0 indicates a draft that has not been committed. Posted entries always have voucher_number > 0.
- Ordering is by created_at (when the verifikat was booked), not entry_date. A backdated verifikat appears where it was booked: filter on ?date_from / ?date_to when you need entry_date ranges, and walk the whole cursor chain when you need a full period.
- Cursor pagination: pass ?cursor=<next_cursor> from the previous response. A stale or tampered cursor is ignored and the first page is returned again.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, fiscal_period_id: string, voucher_series: string, voucher_number: number, entry_date: string, description: string, status: "draft" | "posted" | "cancelled", source_type: string, created_at: string }[],
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
      "id": "0e9c…",
      "fiscal_period_id": "a8f1…",
      "voucher_series": "A",
      "voucher_number": 142,
      "entry_date": "2026-05-12",
      "description": "Levfaktura 2026-1234, Office Depot AB (ankomstnr 42)",
      "status": "posted",
      "source_type": "supplier_invoice_registered",
      "created_at": "2026-05-13T15:00:00Z"
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

### `POST /api/v1/companies/{companyId}/journal-entries`

**Create a draft journal entry (verifikation).**
`scope:bookkeeping:write · risk:high · idempotent · dry-run · reversible`

Creates a draft journal entry via the engine's createDraftEntry(). The draft has no voucher_number until /commit is called. Idempotent (mandatory Idempotency-Key). Dry-runnable: a dry-run validates balance + account-chart membership + period date constraints without inserting any row.

**Use when:** You're posting an arbitrary verifikation (manual journal entries, accrual reversals, period closing adjustments) outside the invoicing / supplier-invoice / transaction flows.
**Do not use for:** Bookkeeping flows that have a dedicated endpoint (invoices, supplier-invoices, transactions). Editing an existing posted entry: use /correct instead.

**Pitfalls:**
- Idempotency-Key is mandatory.
- Lines must sum to zero (Σ debit = Σ credit). Engine rejects with JOURNAL_ENTRY_NOT_BALANCED on imbalance.
- entry_date must fall within fiscal_period_id's [period_start, period_end]; otherwise ENTRY_DATE_OUTSIDE_FISCAL_PERIOD.
- All account_numbers must be active in the chart_of_accounts; otherwise ACCOUNTS_NOT_IN_CHART.
- voucher_series defaults to "A" if omitted. Must be a single uppercase letter.
- This creates a DRAFT only: call POST /{id}/commit to assign the voucher_number and post atomically.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  fiscal_period_id: string,
  entry_date: string,
  description: string,
  source_type?: "manual" | "bank_transaction" | "invoice_created" | "invoice_paid" | "invoice_cash_payment" | "credit_note" | "salary_payment" | "opening_balance" | "year_end" | "storno" | "correction" | "import" | "system" | "inbox_item" | "supplier_invoice_registered" | "supplier_invoice_paid" | "supplier_invoice_cash_payment" | "supplier_invoice_privately_paid" | "supplier_credit_note" | "currency_revaluation" | "reminder_fee" | "accrual" | "result_appropriation" | "rot_rut_payout" | "vat_settlement" | "stripe_payout" | "webshop_order",
  source_id?: string,
  voucher_series?: string,
  notes?: string,
  lines: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, currency?: string, amount_in_currency?: number, exchange_rate?: number, tax_code?: string, dimensions?: Record<string, string>, cost_center?: string, project?: string }[]
}
```

Example request:
```json
{
  "fiscal_period_id": "a8f1…",
  "entry_date": "2026-05-12",
  "description": "Bankavgift maj 2026",
  "lines": [
    {
      "account_number": "6570",
      "debit_amount": 50,
      "credit_amount": 0,
      "line_description": "Bankavgift"
    },
    {
      "account_number": "1930",
      "debit_amount": 0,
      "credit_amount": 50,
      "line_description": "Företagskonto"
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    fiscal_period_id: string,
    voucher_series: string,
    voucher_number: number,
    entry_date: string,
    description: string,
    status: "draft" | "posted" | "cancelled",
    source_type: string,
    created_at: string,
    notes: string,
    reverses_id: string,
    reversed_by_id: string,
    correction_of_id: string,
    lines: { id: string, account_number: string, debit_amount: number, credit_amount: number, line_description: string, currency: string, amount_in_currency: number, exchange_rate: number, tax_code: string, cost_center: string, project: string }[]
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
    "id": "0e9c…",
    "status": "draft",
    "voucher_series": "A",
    "voucher_number": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/journal-entries/{id}`

**Retrieve a single verifikation by id.**
`scope:reports:read · risk:low · idempotent`

Returns the full journal entry including all lines, dimensions, and the storno chain (reverses_id, reversed_by_id, correction_of_id).

**Use when:** You need the full verifikation for audit / reconciliation, or to display the line-by-line breakdown.
**Do not use for:** Listing entries (use the list endpoint with filters).

**Pitfalls:**
- Cancelled drafts are returned (no filter on status here); inspect status before assuming the entry is posted.
- Lines are sorted by sort_order; the order matters for display but not for accounting (the sum across lines is the meaningful quantity).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    fiscal_period_id: string,
    voucher_series: string,
    voucher_number: number,
    entry_date: string,
    description: string,
    status: "draft" | "posted" | "cancelled",
    source_type: string,
    source_id: string,
    notes: string,
    reverses_id: string,
    reversed_by_id: string,
    correction_of_id: string,
    lines: { id: string, account_number: string, debit_amount: number, credit_amount: number, line_description: string, currency: string, amount_in_currency: number, exchange_rate: number, tax_code: string, cost_center: string, project: string, sort_order: number }[],
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
    "id": "0e9c…",
    "voucher_series": "A",
    "voucher_number": 142,
    "entry_date": "2026-05-12",
    "status": "posted",
    "lines": [
      {
        "account_number": "6570",
        "debit_amount": 50,
        "credit_amount": 0,
        "sort_order": 0
      },
      {
        "account_number": "1930",
        "debit_amount": 0,
        "credit_amount": 50,
        "sort_order": 1
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

### `POST /api/v1/companies/{companyId}/journal-entries/{id}/commit`

**Commit a draft journal entry.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run · reversible`

Atomically advances the voucher series and flips the draft to posted. The voucher_number is the smallest integer not yet used in (fiscal_period_id, voucher_series); a failed commit does NOT burn the number.

**Use when:** You created a draft via POST /journal-entries and now want to post it to the books. After commit the entry is immutable per BFL 5 kap 2 §; corrections require /reverse or /correct.
**Do not use for:** Re-committing an already-posted entry (returns 409). Committing across companies: the URL companyId must match the draft's company.

**Pitfalls:**
- Idempotency-Key is mandatory.
- Posted entries cannot be edited. Plan the lines carefully or call /correct after commit if you need to change them.
- Voucher numbers are sequential within (fiscal_period_id, voucher_series). A commit failure (e.g. period locked between draft creation and commit) does not advance the sequence.
- If the key has an unattended commit limit, an entry above it returns 403 UNATTENDED_COMMIT_LIMIT_EXCEEDED and stays a draft for a human to commit. Do not split it into smaller entries: one affarshandelse is one verifikat (BFL 5 kap. 6 §).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, voucher_series: string, voucher_number: number, status: "posted", entry_date: string },
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
    "id": "0e9c…",
    "voucher_series": "A",
    "voucher_number": 143,
    "status": "posted",
    "entry_date": "2026-05-12"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/journal-entries/{id}/correct`

**Correct a posted journal entry (BFL 5:5 storno-then-replace).**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Per Bokföringslagen 5 kap 5 §, posted entries cannot be modified. This endpoint creates the canonical correction trail: a storno reversing the original, then a new entry with the corrected lines. All three are visible in the verifikationsserie and linked via reverses_id / reversed_by_id / correction_of_id. Idempotent. Dry-runnable.

**Use when:** You need to amend a posted verifikation. Use this rather than /reverse when the entry is being REPLACED with new lines: /reverse just nullifies.
**Do not use for:** Drafts (no voucher_number: cancel via dashboard). Already-corrected entries (the chain only supports one correction; correct the latest in the chain).

**Pitfalls:**
- Idempotency-Key is mandatory.
- The new lines must balance. JOURNAL_ENTRY_NOT_BALANCED if not.
- The original's entry_date and fiscal_period_id are inherited. If the original's period has been locked since posting, the call returns PERIOD_LOCKED.
- Three voucher numbers are advanced in this call: the original (already burned), the reversal, and the corrected. The series stays unbroken.
- A chain 3+ corrections deep returns CORRECTION_CHAIN_TOO_DEEP (409). Compute the net effect of the whole chain and book ONE correction, or pass allow_deep_chain=true to override.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  description?: string,
  lines: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, currency?: string, amount_in_currency?: number, exchange_rate?: number, tax_code?: string, dimensions?: Record<string, string>, cost_center?: string, project?: string }[],
  allow_deep_chain?: boolean
}
```

Example request:
```json
{
  "lines": [
    {
      "account_number": "6570",
      "debit_amount": 75,
      "credit_amount": 0,
      "line_description": "Bankavgift (rättad)"
    },
    {
      "account_number": "1930",
      "debit_amount": 0,
      "credit_amount": 75,
      "line_description": "Företagskonto"
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    reversal_id: string,
    corrected_id: string,
    original_id: string,
    voucher_series: string,
    reversal_voucher_number: number,
    corrected_voucher_number: number
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
    "reversal_id": "4d2a…",
    "corrected_id": "7b3a…",
    "original_id": "0e9c…",
    "voucher_series": "A",
    "reversal_voucher_number": 144,
    "corrected_voucher_number": 145
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/journal-entries/{id}/reverse`

**Storno a posted journal entry.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Creates a reversing journal entry that nullifies the original. The original remains posted and visible: the reversal links via reverses_id and the original is annotated reversed_by_id. The reversal carries its own voucher_number in the same series so the löpnummer chain stays unbroken (BFL 5 kap 5-7 §§).

**Use when:** A posted entry needs to be cancelled and there is no replacement coming: e.g. a duplicate booking, an entry posted to the wrong period. Use /correct instead when you need to replace the entry with corrected lines.
**Do not use for:** Cancelling a draft (drafts have no voucher_number; cancel via the dashboard). Reversing an already-reversed entry (returns ENTRY_ALREADY_REVERSED).

**Pitfalls:**
- Idempotency-Key is mandatory.
- reversal_date defaults to today; the reversal is posted in the fiscal period covering that date. If today's period is locked the call returns PERIOD_LOCKED.
- You cannot reverse a draft (status must be posted). Use /correct after commit if the original needs replacing.
- Reversing an entry 3+ links deep in a correction chain returns CORRECTION_CHAIN_TOO_DEEP (409). Book ONE net-effect correction instead, or pass allow_deep_chain=true to override.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ reversal_date?: string, allow_deep_chain?: boolean }
```

Example request:
```json
{
  "reversal_date": "2026-05-13"
}
```

Response `200`:
```ts
{
  data: {
    reversal_id: string,
    original_id: string,
    voucher_series: string,
    voucher_number: number,
    entry_date: string,
    status: "posted"
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
    "reversal_id": "4d2a…",
    "original_id": "0e9c…",
    "voucher_series": "A",
    "voucher_number": 144,
    "entry_date": "2026-05-13",
    "status": "posted"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/journal-entries/batch-create`

**Create up to 50 draft journal entries (partial-success).**
`scope:bookkeeping:write · risk:high · idempotent · dry-run · reversible`

Bulk-create endpoint mirroring /invoices/bulk-create and /suppliers/bulk-create. Each entry is validated and inserted independently: per-item failures do not roll back items that succeeded. Returns DRAFTS only; commit each separately. Idempotent over the whole batch. Dry-runnable.

**Use when:** You're replaying historical bookkeeping from another system, or batching a set of manual verifikationer from a spreadsheet. Use dry-run first to validate the batch.
**Do not use for:** Committing posted entries: use POST /{id}/commit per entry. Transactional all-or-nothing imports: passing all_or_nothing: true returns 501 NOT_IMPLEMENTED.

**Pitfalls:**
- Idempotency-Key is mandatory and covers the WHOLE batch.
- all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist.
- Each entry must balance independently. Per-item JOURNAL_ENTRY_NOT_BALANCED appears in the results array.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  journal_entries: { fiscal_period_id: string, entry_date: string, description: string, source_type?: "manual" | "bank_transaction" | "invoice_created" | "invoice_paid" | "invoice_cash_payment" | "credit_note" | "salary_payment" | "opening_balance" | "year_end" | "storno" | "correction" | "import" | "system" | "inbox_item" | "supplier_invoice_registered" | "supplier_invoice_paid" | "supplier_invoice_cash_payment" | "supplier_invoice_privately_paid" | "supplier_credit_note" | "currency_revaluation" | "reminder_fee" | "accrual" | "result_appropriation" | "rot_rut_payout" | "vat_settlement" | "stripe_payout" | "webshop_order", source_id?: string, voucher_series?: string, notes?: string, lines: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, currency?: string, amount_in_currency?: number, exchange_rate?: number, tax_code?: string, dimensions?: Record<string, string>, cost_center?: string, project?: string }[] }[],
  all_or_nothing?: boolean
}
```

Example request:
```json
{
  "journal_entries": [
    {
      "fiscal_period_id": "a8f1…",
      "entry_date": "2026-05-12",
      "description": "Bankavgift",
      "lines": [
        {
          "account_number": "6570",
          "debit_amount": 50,
          "credit_amount": 0
        },
        {
          "account_number": "1930",
          "debit_amount": 0,
          "credit_amount": 50
        }
      ]
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    results: { ok: boolean, request_index: number, data?: unknown, error?: { code: string, message: string, details?: unknown } }[],
    summary: { total: number, succeeded: number, failed: number }
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
    "results": [
      {
        "ok": true,
        "request_index": 0,
        "data": {
          "id": "0e9c…",
          "status": "draft"
        }
      }
    ],
    "summary": {
      "total": 1,
      "succeeded": 1,
      "failed": 0
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/voucher-gap-explanations`

**Document a gap in the verifikationsserie (BFL 5 kap 6-7 §§).**
`scope:bookkeeping:write · risk:low · idempotent · dry-run`

Records an explanation for one or more missing voucher numbers in a series. Required when a number is unaccounted for during audit. Statutory basis: BFL 5 kap 6-7 §§ (verifikationsnummer i löpande följd utan luckor); BFNAR 2013:2 kap 8 § governs the systemdokumentation that surfaces the gap. Idempotent. Dry-runnable.

**Use when:** You're responding to a voucher-gap audit finding and need to document the cause. Also used by migration flows that claim numbers without filling them.
**Do not use for:** Falsifying a series: every gap MUST have a genuine explanation. The dashboard surfaces these for auditor review.

**Pitfalls:**
- Idempotency-Key is mandatory.
- gap_end must be >= gap_start; a single-number gap has gap_start = gap_end.
- voucher_series is a single uppercase letter (A-Z); the same series + period + numeric range must not already exist.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  fiscal_period_id: string,
  voucher_series: string,
  gap_start: number,
  gap_end: number,
  explanation: string
}
```

Example request:
```json
{
  "fiscal_period_id": "a8f1…",
  "voucher_series": "A",
  "gap_start": 142,
  "gap_end": 145,
  "explanation": "Migration from previous bookkeeping system on 2026-05-12: series A148-onwards corresponds to the new Accounted numbering; numbers A142-A145 were assigned in the legacy system to manual paper vouchers archived offline (BFL 7 kap retention applies). Paper vouchers are stored in the company archive under reference 2026-PAPER-Q2."
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    fiscal_period_id: string,
    voucher_series: string,
    gap_start: number,
    gap_end: number,
    explanation: string,
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

Example response `200`:
```json
{
  "data": {
    "id": "0e9c…",
    "voucher_series": "A",
    "gap_start": 142,
    "gap_end": 145
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
