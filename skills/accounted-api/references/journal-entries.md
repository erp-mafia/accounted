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
| `fiscal_period_id` | query | `string` | no | Only entries in this fiscal period (id from GET /fiscal-periods). |
| `status` | query | `"draft" \| "posted" \| "cancelled"` | no | draft, posted or cancelled. Default: every status except cancelled. |
| `date_from` | query | `string` | no | YYYY-MM-DD. Entries whose entry_date (verifikationsdatum) is on or after this date. |
| `date_to` | query | `string` | no | YYYY-MM-DD. Entries whose entry_date is on or before this date. |
| `cursor` | query | `string` | no | Opaque cursor from the previous page's meta.next_cursor. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). Larger values are clamped to 100. |

Response `200`:
```ts
{
  data: { id: string, fiscal_period_id: string, voucher_series: string, voucher_number: number, entry_date: string, description: string, status: "draft" | "posted" | "cancelled", source_type: string, created_at: string }[],
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

Creates a draft journal entry via the engine's createDraftEntry(). The draft has no voucher_number until /commit is called. Idempotent (mandatory Idempotency-Key). Dry-runnable: a dry-run checks the body, the balance, the period lock and the lines' accounts against the chart without inserting any row, so it fails with ACCOUNTS_NOT_IN_CHART for the same accounts the live call would reject.

**Use when:** You're posting an arbitrary verifikation (manual journal entries, accrual reversals, period closing adjustments) outside the invoicing / supplier-invoice / transaction flows.
**Do not use for:** Bookkeeping flows that have a dedicated endpoint (invoices, supplier-invoices, transactions). Editing an existing posted entry: use /correct instead.

**Pitfalls:**
- Idempotency-Key is mandatory.
- Lines must sum to zero (Σ debit = Σ credit). Engine rejects with JOURNAL_ENTRY_NOT_BALANCED on imbalance.
- entry_date must fall within fiscal_period_id's [period_start, period_end]; otherwise ENTRY_DATE_OUTSIDE_FISCAL_PERIOD.
- Every account_number must resolve in the company's chart of accounts: a standard BAS 2026 account that is not in the chart yet is added automatically, but a deactivated account, or a non-BAS number the chart does not contain, fails with ACCOUNTS_NOT_IN_CHART.
- voucher_series defaults to "A" if omitted. Must be a single uppercase letter.
- This creates a DRAFT only: call POST /{id}/commit to assign the voucher_number and post atomically, or DELETE /{id} to discard it. A draft left uncommitted blocks the year-end close (DRAFT_ENTRIES).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  fiscal_period_id: string,
  entry_date: string,
  description: string,
  source_type?: "manual" | "bank_transaction" | "invoice_created" | "invoice_paid" | "invoice_cash_payment" | "credit_note" | "salary_payment" | "opening_balance" | "year_end" | "storno" | "correction" | "import" | "system" | "inbox_item" | "supplier_invoice_registered" | "supplier_invoice_paid" | "supplier_invoice_cash_payment" | "supplier_invoice_privately_paid" | "supplier_credit_note" | "currency_revaluation" | "reminder_fee" | "accrual" | "result_appropriation" | "rot_rut_payout" | "vat_settlement" | "stripe_payout" | "webshop_order" | "expense_claim" | "expense_payout" | "rot_rut_reclaim",
  source_id?: string,
  bank_booking_context?: { transaction_id: string, cash_account_id: string | null, target_cash_account_id?: string, settlement_account: string, date: string, amount: number, currency: string }[],
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
    notes: string | null,
    reverses_id: string | null,
    reversed_by_id: string | null,
    correction_of_id: string | null,
    lines: { id: string, account_number: string, debit_amount: number, credit_amount: number, line_description: string | null, currency: string | null, amount_in_currency: number | null, exchange_rate: number | null, tax_code: string | null, cost_center: string | null, project: string | null }[]
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
    source_id: string | null,
    notes: string | null,
    reverses_id: string | null,
    reversed_by_id: string | null,
    correction_of_id: string | null,
    lines: { id: string, account_number: string, debit_amount: number, credit_amount: number, line_description: string | null, currency: string | null, amount_in_currency: number | null, exchange_rate: number | null, tax_code: string | null, cost_center: string | null, project: string | null, sort_order: number }[],
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

### `PATCH /api/v1/companies/{companyId}/journal-entries/{id}`

**Replace the header and lines of a DRAFT journal entry.**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run · reversible`

Edits a draft verifikat in place (fiscal_period_id, entry_date, description, voucher_series, notes and the full line set, which is replaced). Only drafts: a posted entry is refused with 409 CANNOT_EDIT_NON_DRAFT and is corrected with storno or inline rättelse instead. The draft keeps its source_type and source_id and still has no voucher number: POST /journal-entries/{id}/commit posts it. Idempotent. Dry-runnable: the dry run validates balance, period, lock and accounts and writes nothing.

**Use when:** A draft created with POST /journal-entries (or in the dashboard) needs different lines, date or text before it is committed.
**Do not use for:** Posted verifikat (use /correct, /strike-lines, /correct-metadata or /redate), or only the note (PATCH /journal-entries/{id}/notes).

**Pitfalls:**
- Send the COMPLETE line set: lines are replaced, not merged.
- Lines must balance (sum debit = sum credit > 0): 400 JOURNAL_ENTRY_NOT_BALANCED.
- entry_date must fall inside fiscal_period_id: 400 ENTRY_DATE_OUTSIDE_FISCAL_PERIOD; a locked period answers 400 PERIOD_LOCKED.
- A standard BAS account missing from the chart is added at commit time of this edit; a deactivated or unknown account fails with ACCOUNTS_NOT_IN_CHART.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  fiscal_period_id: string,
  entry_date: string,
  description: string,
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
      "debit_amount": 60,
      "credit_amount": 0
    },
    {
      "account_number": "1930",
      "debit_amount": 0,
      "credit_amount": 60
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    status: string,
    fiscal_period_id: string,
    entry_date: string,
    description: string,
    voucher_series: string,
    voucher_number: number,
    notes: string | null,
    lines: { account_number: string, debit_amount: number, credit_amount: number, line_description: string | null }[]
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
    "status": "draft",
    "fiscal_period_id": "a8f1…",
    "entry_date": "2026-05-12",
    "description": "Bankavgift maj 2026",
    "voucher_series": "A",
    "voucher_number": 0,
    "notes": null,
    "lines": [
      {
        "account_number": "6570",
        "debit_amount": 60,
        "credit_amount": 0,
        "line_description": null
      },
      {
        "account_number": "1930",
        "debit_amount": 0,
        "credit_amount": 60,
        "line_description": null
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

### `DELETE /api/v1/companies/{companyId}/journal-entries/{id}`

**Cancel an uncommitted draft verifikation.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run`

Flips a draft journal entry to status=cancelled through the engine. A draft holds no voucher_number, so cancelling one leaves NO gap in the löpande nummerordning BFL 5 kap 7 § requires, and therefore needs no documented gap explanation. The header row survives as cancelled evidence rather than being deleted; its lines survive with it, and both stay archived for the 7 years BFL 7 kap requires. Posted and reversed entries are refused with 409 CANNOT_CANCEL_NON_DRAFT: a posted verifikation may only be undone through a rättelse that keeps the original visible and records who corrected it and when (BFL 5 kap 5 §), which is what /reverse (storno) does. Idempotent: cancelling an already-cancelled draft returns 200 with the same entry.

**Use when:** A draft created via POST /journal-entries will never be committed: a duplicate, an abandoned import, a draft the agent decided against. Stranded drafts block the year-end close (DRAFT_ENTRIES blocker), so clear them here instead of leaving them for a human in the app.
**Do not use for:** Undoing a posted verifikat (use POST /{id}/reverse for storno, or /{id}/correct to replace it). Editing a draft: there is no v1 draft-edit endpoint; cancel and create a new draft.

**Pitfalls:**
- Only status=draft can be cancelled. Anything posted returns 409 CANNOT_CANCEL_NON_DRAFT with details.currentStatus; storno it instead.
- No voucher number is released or burned: drafts never held one, so the unbroken series BFL 5 kap 7 § requires is untouched and there is no gap to document. The cancelled header stays visible via GET /{id} and via the list endpoint with status=cancelled.
- A draft in a locked or closed period, or behind the company lock date, returns PERIOD_LOCKED: unlock the period first rather than retrying.
- Idempotency-Key is optional here (unlike the other journal-entries writes) because the call is idempotent by construction: a second DELETE returns the same cancelled entry.

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
    fiscal_period_id: string,
    voucher_series: string,
    voucher_number: number,
    entry_date: string,
    description: string,
    status: "cancelled",
    source_type: string,
    source_id: string | null,
    notes: string | null,
    reverses_id: string | null,
    reversed_by_id: string | null,
    correction_of_id: string | null,
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
    "id": "0e9c…",
    "voucher_series": "A",
    "voucher_number": 0,
    "entry_date": "2026-05-12",
    "status": "cancelled"
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

**Use when:** You created a draft via POST /journal-entries and now want to post it to the books. After commit the entry can only be changed through a rättelse that keeps the original visible and records who corrected it and when (BFL 5 kap 5 §): corrections require /reverse or /correct.
**Do not use for:** Re-committing an already-posted entry (returns 409). Committing across companies: the URL companyId must match the draft's company.

**Pitfalls:**
- Idempotency-Key is mandatory.
- Posted entries cannot be edited. Plan the lines carefully or call /correct after commit if you need to change them.
- Voucher numbers are sequential within (fiscal_period_id, voucher_series). A commit failure (e.g. period locked between draft creation and commit) does not advance the sequence.
- If the key has an unattended commit limit, an entry above it returns 403 UNATTENDED_COMMIT_LIMIT_EXCEEDED and stays a draft for a human to commit. Do not split it into smaller entries: one affärshändelse is one verifikat (BFL 5 kap. 6 §).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { id: string, voucher_series: string, voucher_number: number, status: "posted", entry_date: string },
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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

### `POST /api/v1/companies/{companyId}/journal-entries/{id}/correct-metadata`

**Correct the description and/or date of a posted verifikat inside the same verifikat (inline rättelse).**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Metadata rättelse (BFL 5 kap 5 § and 9 §): changes the verifikationstext and/or moves the entry date WITHIN its own fiscal period, without a rättelseverifikation. The correct_entry_metadata RPC writes the old and new values with who and when to the immutable rättelse log (GET /journal-entries/{id}/rattelse-log) before it changes anything. Amounts and accounts are never touched here. Idempotent. Dry-runnable: the dry run checks every rule and shows old and new values without writing.

**Use when:** A posted verifikat in an open, unlocked period has a wrong or unclear description, or a date that is wrong but inside the same fiscal year.
**Do not use for:** Moving the entry to another fiscal year (POST /journal-entries/{id}/redate), wrong amounts or accounts (POST /journal-entries/{id}/strike-lines, or /correct once the period is locked), drafts (PATCH /journal-entries/{id}).

**Pitfalls:**
- Inline rättelse is only for an open, unlocked period after the company lock date: otherwise 409 JOURNAL_RATTELSE_PERIOD_LOCKED, and storno (POST /journal-entries/{id}/correct) is the only lawful path (BFL 5 kap 5 §).
- A new date outside the entry's own fiscal period answers 409 JOURNAL_RATTELSE_REFUSED: use /redate for a cross-period move.
- Storno entries are never corrected; opening-balance, year-end and VAT-settlement entries keep their date (409 JOURNAL_RATTELSE_REFUSED).
- Values equal to the current ones succeed with changed=false and write no log row.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ description?: string, entry_date?: string }
```

Example request:
```json
{
  "description": "Hyra lokal september 2026"
}
```

Response `200`:
```ts
{
  data: {
    changed: boolean,
    log_id: string | null,
    old_description?: string,
    new_description?: string,
    old_entry_date?: string,
    new_entry_date?: string
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
    "changed": true,
    "log_id": "5c1e…",
    "old_description": "Hyra",
    "new_description": "Hyra lokal september 2026",
    "old_entry_date": "2026-09-01",
    "new_entry_date": "2026-09-01"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/journal-entries/{id}/no-document-required`

**Mark a verifikat as "Inget underlag krävs" (no supporting document required).**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run · reversible`

BFL 5 kap 6 § requires a verifikation for every affärshändelse; where no external underlag exists (avskrivning, periodisering, internal transfer) the verifikation itself is the documentation. The flag records that judgement and removes the entry from the missing-underlag worklist. It is stored beside the verifikat, which is not changed, and the audit log records who set it. Setting it again replaces the reason. Idempotent. Dry-runnable.

**Use when:** The user confirms a verifikat has no external underlag by nature (avskrivning, periodisering, bokslutspost, transfer between own accounts) and it should stop showing as missing underlag.
**Do not use for:** Hiding a purchase or sale whose receipt or invoice is simply missing: that underlag must be found and attached (POST /documents), not waived.

**Pitfalls:**
- Only mark what genuinely has no external underlag: a waived receipt is a compliance gap, not a fix.
- Undo with DELETE /journal-entries/{id}/no-document-required.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ reason?: string | null }
```

Example request:
```json
{
  "reason": "Avskrivning enligt plan"
}
```

Response `200`:
```ts
{
  data: { journal_entry_id: string, exempted: true, reason: string | null },
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
    "journal_entry_id": "0e9c…",
    "exempted": true,
    "reason": "Avskrivning enligt plan"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/journal-entries/{id}/no-document-required`

**Remove the "Inget underlag krävs" mark from a verifikat.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

The verifikat shows as missing underlag again until a document is attached. Clearing a mark that is not set succeeds with removed=false. Idempotent. Dry-runnable.

**Use when:** A verifikat was marked by mistake and does need an underlag.
**Do not use for:** Detaching a document (documents have their own endpoints).

**Pitfalls:**
- The mark is company-shared: any member with write access may clear it; the audit log records who did.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Response `200`:
```ts
{
  data: { journal_entry_id: string, exempted: false, removed: boolean },
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
    "journal_entry_id": "0e9c…",
    "exempted": false,
    "removed": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/journal-entries/{id}/notes`

**Set, replace or clear the internal note (anteckning) on a verifikat.**
`scope:bookkeeping:write · risk:low · idempotent · dry-run · reversible`

The note is annotation metadata beside the verifikat, not räkenskapsinformation: it may be edited on posted entries too, while every bookkeeping field stays immutable (the journal_entries trigger allows a notes-only update and nothing else). null or a blank string clears it. Idempotent. Dry-runnable.

**Use when:** Recording context for a verifikat (who approved it, what an odd booking is about) or clearing an outdated note.
**Do not use for:** Changing the verifikationstext (POST /journal-entries/{id}/correct-metadata) or anything that belongs in the books.

**Pitfalls:**
- At most 2000 characters.
- The whole note is replaced, not appended to.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ notes: string | null }
```

Example request:
```json
{
  "notes": "Godkänd av Anna 2026-09-12"
}
```

Response `200`:
```ts
{
  data: {
    journal_entry_id: string,
    voucher_series: string | null,
    voucher_number: number | null,
    notes: string | null
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
    "journal_entry_id": "0e9c…",
    "voucher_series": "A",
    "voucher_number": 142,
    "notes": "Godkänd av Anna 2026-09-12"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/journal-entries/{id}/rattelse-log`

**Read the inline rättelse history of a verifikat, newest first.**
`scope:reports:read · risk:low · idempotent`

The immutable who/when trail behind every metadata rättelse and line strike on the verifikat (BFL 5 kap 5 §): old and new text and date, snapshots of struck and added lines, the actor and when. Rows with source sie_import carry correction history from an imported SIE file (#BTRANS/#RTRANS) and name the corrector in external_signature. Storno corrections are not here: they are separate verifikat linked by reverses_id/correction_of_id.

**Use when:** Explaining how a verifikat came to look as it does, or checking what an inline rättelse changed before correcting it again.
**Do not use for:** Storno chains (read the linked verifikat) or the company-wide change history (behandlingshistorik report).

**Pitfalls:**
- An entry of another company answers 404, never an empty list.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, rattelse_type: string, old_description: string | null, new_description: string | null, old_entry_date: string | null, new_entry_date: string | null, struck_lines: (Record<string, unknown>)[] | null, added_lines: (Record<string, unknown>)[] | null, actor: string | null, actor_label: string | null, created_at: string, source: string | null, external_signature: string | null }[],
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
      "id": "5c1e…",
      "rattelse_type": "lines",
      "old_description": null,
      "new_description": null,
      "old_entry_date": null,
      "new_entry_date": null,
      "struck_lines": [
        {
          "account_number": "5410",
          "debit_amount": 500,
          "credit_amount": 0
        }
      ],
      "added_lines": [
        {
          "account_number": "5420",
          "debit_amount": 500,
          "credit_amount": 0
        }
      ],
      "actor": "9d2b…",
      "actor_label": "Anna Svensson",
      "created_at": "2026-09-12T08:14:00Z",
      "source": null,
      "external_signature": null
    }
  ],
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/journal-entries/{id}/redate`

**Move a posted verifikat to another date, and thereby another period, by storno and re-post.**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Fixes a verifikat booked on the wrong date or year (e.g. 2026-07-03 that should be 2025-07-03). A posted verifikat is immutable, so this is the dashboard's "Flytta till annat datum": a storno of the original is posted on the original date (netting it to zero there) and an identical copy is posted on new_entry_date in the period that covers it, the original is marked reversed, and underlag and bank links follow the copy. The chain original, storno, copy stays linked (BFL 5 kap 5 §). Two voucher numbers are used. Idempotent. Dry-runnable: the dry run shows both verifikat with their lines and posts nothing.

**Use when:** A posted verifikat has the right lines but the wrong date in another fiscal period or year, or the period of its date is past an inline rättelse.
**Do not use for:** A date inside the same open period (POST /journal-entries/{id}/correct-metadata keeps one verifikat), wrong lines (/correct), drafts (PATCH /journal-entries/{id}).

**Pitfalls:**
- The target date must fall in an existing, open, unlocked period: 409 TARGET_PERIOD_CLOSED or TARGET_PERIOD_LOCKED, or 400 NO_OPEN_PERIOD_FOR_DATE (periods are never created here).
- The storno lands on the ORIGINAL date: a locked original period answers 400 PERIOD_LOCKED.
- The same date answers 400 MEANINGLESS_CORRECTION (details.reason no_date_change).
- A chain three or more corrections deep answers 409 CORRECTION_CHAIN_TOO_DEEP; pass allow_deep_chain=true only when another layer is intended.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ new_entry_date: string, allow_deep_chain?: boolean }
```

Example request:
```json
{
  "new_entry_date": "2025-07-03"
}
```

Response `200`:
```ts
{
  data: {
    original_id: string,
    reversal_id: string,
    corrected_id: string,
    voucher_series: string,
    reversal_voucher_number: number,
    corrected_voucher_number: number,
    new_entry_date: string
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
    "original_id": "0e9c…",
    "reversal_id": "4d2a…",
    "corrected_id": "7b3a…",
    "voucher_series": "A",
    "reversal_voucher_number": 144,
    "corrected_voucher_number": 88,
    "new_entry_date": "2025-07-03"
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
**Do not use for:** Cancelling a draft (drafts have no voucher_number: use DELETE /journal-entries/{id}). Reversing an already-reversed entry (returns ENTRY_ALREADY_REVERSED).

**Pitfalls:**
- Idempotency-Key is mandatory.
- reversal_date defaults to today; the reversal is posted in the fiscal period covering that date. If today's period is locked the call returns PERIOD_LOCKED.
- You cannot reverse a draft (status must be posted). Use /correct after commit if the original needs replacing.
- Reversing an entry 3+ links deep in a correction chain returns CORRECTION_CHAIN_TOO_DEEP (409). Book ONE net-effect correction instead, or pass allow_deep_chain=true to override.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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

### `POST /api/v1/companies/{companyId}/journal-entries/{id}/strike-lines`

**Strike lines of a posted verifikat and add replacement lines inside the same verifikat (inline rättelse).**
`scope:bookkeeping:write · risk:high · idempotent · dry-run`

Line rättelse (BFL 5 kap 5 §): removes the listed lines from a posted verifikat and adds replacement lines in the same verifikat, without a rättelseverifikation and without a new voucher number. The correct_entry_lines_inline RPC enforces the envelope (posted, open and unlocked period, after the company lock date, at least two lines left, balanced to the öre, SEK only) and snapshots the struck originals with who and when to the immutable rättelse log, so the original stays readable. Standard BAS accounts missing from the chart are added first. Idempotent. Dry-runnable: the dry run shows the struck, added and resulting lines and writes nothing.

**Use when:** A posted verifikat in an open, unlocked period was booked on the wrong account or with a wrong amount split, e.g. 5410 that should have been 5420, and the user wants it fixed inside the verifikat the way Fortnox "ändra verifikat" does.
**Do not use for:** Locked or closed periods (storno: POST /journal-entries/{id}/correct), foreign-currency lines, lines with a linked underlag, storno/year-end/VAT-settlement entries, drafts (PATCH /journal-entries/{id}), or cancelling a whole verifikat (/reverse).

**Pitfalls:**
- Inline rättelse is only for an open, unlocked period after the company lock date: otherwise 409 JOURNAL_RATTELSE_PERIOD_LOCKED, and storno (POST /journal-entries/{id}/correct) is the only lawful path (BFL 5 kap 5 §).
- The resulting verifikat must balance (sum debit = sum credit > 0): 400 JOURNAL_ENTRY_NOT_BALANCED otherwise. Amounts are SEK with at most two decimals; account numbers are 4-digit strings.
- strike_line_ids must be ids of this verifikat's lines (GET /journal-entries/{id}); a line in foreign currency or with a linked underlag cannot be struck (409 JOURNAL_RATTELSE_REFUSED).
- A verifikat linked to a bank transaction may only change its bank-account net to the linked bank amount; linked customer/supplier payments keep their 15xx/24xx net. The dry run flags bank_anchor_check; the commit is authoritative.
- Striking and re-adding identical lines answers 400 MEANINGLESS_CORRECTION.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  strike_line_ids?: string[],
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, dimensions?: Record<string, string> }[]
}
```

Example request:
```json
{
  "strike_line_ids": [
    "4b1f…"
  ],
  "lines": [
    {
      "account_number": "5420",
      "debit_amount": 500,
      "credit_amount": 0,
      "line_description": "Programvara"
    }
  ]
}
```

Response `200`:
```ts
{
  data: {
    log_id: string,
    struck_count: number,
    added_count: number,
    total_debit: number,
    total_credit: number
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
    "log_id": "5c1e…",
    "struck_count": 1,
    "added_count": 1,
    "total_debit": 625,
    "total_credit": 625
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{
  journal_entries: { fiscal_period_id: string, entry_date: string, description: string, source_type?: "manual" | "bank_transaction" | "invoice_created" | "invoice_paid" | "invoice_cash_payment" | "credit_note" | "salary_payment" | "opening_balance" | "year_end" | "storno" | "correction" | "import" | "system" | "inbox_item" | "supplier_invoice_registered" | "supplier_invoice_paid" | "supplier_invoice_cash_payment" | "supplier_invoice_privately_paid" | "supplier_credit_note" | "currency_revaluation" | "reminder_fee" | "accrual" | "result_appropriation" | "rot_rut_payout" | "vat_settlement" | "stripe_payout" | "webshop_order" | "expense_claim" | "expense_payout" | "rot_rut_reclaim", source_id?: string, bank_booking_context?: { transaction_id: string, cash_account_id: string | null, target_cash_account_id?: string, settlement_account: string, date: string, amount: number, currency: string }[], voucher_series?: string, notes?: string, lines: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string, currency?: string, amount_in_currency?: number, exchange_rate?: number, tax_code?: string, dimensions?: Record<string, string>, cost_center?: string, project?: string }[] }[],
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

### `POST /api/v1/companies/{companyId}/journal-entries/no-document-required`

**Mark many posted verifikat as "Inget underlag krävs" in one call.**
`scope:bookkeeping:write · risk:medium · idempotent · dry-run · reversible`

BFL 5 kap 6 § requires a verifikation for every affärshändelse; where no external underlag exists (avskrivning, periodisering, internal transfer) the verifikation itself is the documentation. The flag records that judgement and removes the entry from the missing-underlag worklist. It is stored beside the verifikat, which is not changed, and the audit log records who set it. Only posted verifikat of this company whose type normally needs an underlag are marked; every other id is returned in skipped_ids, never an error. Already-marked entries keep their existing reason. At most 500 ids. Idempotent. Dry-runnable: the dry run lists what would be marked and what is skipped.

**Use when:** Clearing many entries that by nature have no external underlag (e.g. historical SIE-imported bokslutsposter) out of the missing-underlag worklist after the user has reviewed them.
**Do not use for:** Waiving receipts that are missing: find and attach them instead.

**Pitfalls:**
- Check data.skipped_ids: drafts, reversed entries, other companies' ids and entry types that never need an underlag are skipped.
- data.exempted counts the ids processed, including ones already marked.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

Request body:
```ts
{ journal_entry_ids: string[], reason?: string | null }
```

Example request:
```json
{
  "journal_entry_ids": [
    "0e9c…",
    "7b3a…"
  ],
  "reason": "Bokslutspost, egen handling"
}
```

Response `200`:
```ts
{
  data: { exempted: number, journal_entry_ids: string[], skipped_ids: string[] },
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
    "exempted": 1,
    "journal_entry_ids": [
      "0e9c…"
    ],
    "skipped_ids": [
      "7b3a…"
    ]
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
| `dry_run` | query | `string` | no | true (any case) previews the write without committing it, like the X-Dry-Run: true header. Any other value commits. |

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
