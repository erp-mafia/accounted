<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Banking endpoints

Bank transactions (ingest, categorize, match against invoices), bank reconciliation runs, and file imports (SIE, bank statements).

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `POST /api/v1/companies/{companyId}/imports/bank`

**Import a bank-file (CSV / XML / CAMT053).**
`scope:transactions:write · risk:medium · idempotent`

Accepts a bank statement file (UTF-8 / UTF-16 / Windows-1252, up to 10 MB) as multipart/form-data. Auto-detects the bank format (SEB, Swedbank, Handelsbanken, Nordea, Nordea Business, Lansforsakringar, Lunar, ICA Banken, Skandia, Wise transaction history, Wise balance statement, CAMT053, generic CSV) or honors a `format` override. Parses transactions, ingests them into the `transactions` table (NOT into journal entries: see BFL note in pitfalls), and emits `transaction.synced` events. Returns operation_id for polling.

**Use when:** Importing a bank statement export for a period. Common with PSD2 bank connections that don't auto-sync, or for legacy bank accounts.
**Do not use for:** SIE bookkeeping import (use /imports/sie). Auto-bank sync (use the enable-banking extension). Single-transaction creation (use POST /transactions/ingest with a 1-element array).

**Pitfalls:**
- File size cap: 10 MB. Larger files require splitting client-side.
- `format` query parameter is optional; auto-detection works for all supported banks. Pass `format` only to force a specific format. Accepted values: seb, swedbank, handelsbanken, nordea, nordea_business, lansforsakringar, ica_banken, skandia, lunar, northmill, wise, wise_statement, generic_csv, camt053.
- Wise transaction-history rows with refunded or unknown statuses, unknown directions, or different source and target currencies are rejected instead of guessed. Import the matching per-currency Wise balance statements.
- Duplicate detection is by external_id (composed from format + date + description + amount + row index, or the camt.053 entry reference / Wise transfer id where the file carries one); a re-import of the same file typically deduplicates rather than creating doubles.
- BFL 5 kap 6-7 §§ note: this endpoint creates `transactions` rows (the underlag for a verifikation), NOT verifikationer themselves. The verifikation content requirements are in BFL 5 kap 6-7 §§; until each transaction is matched to an invoice/supplier-invoice (POST /transactions/{id}/match-*) or categorised (POST /transactions/{id}/categorize), the bookkeeping obligation isn't discharged. A successful import here means the data is ingested: not booked.
- A successful import returns operation_id; poll /operations/{id} for the final ingested/duplicates/errors counts.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { operation_id: string, type: "import.bank", status: "queued", poll_url: string },
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

### `POST /api/v1/companies/{companyId}/imports/sie`

**Import a SIE4 file.**
`scope:bookkeeping:write · risk:high · idempotent`

Accepts a SIE4 file (CP437 / Windows-1252 / UTF-8 auto-detected, up to 50 MB) as the request body, parses it, checks for duplicate imports by file-hash, and replays every #VER + #TRANS into the company's bookkeeping. Returns an `operation_id` immediately: poll `GET /api/v1/operations/{id}` for status + final result. The byte-equivalent dashboard route at /api/import/sie/execute backs the same lib helper, so a SIE imported via v1 matches what the dashboard would produce.

**Use when:** Migrating bookkeeping data from another system (Fortnox, Bokio, Visma) into Accounted, restoring from a backup .se file, or recreating a period from an archive.
**Do not use for:** Bank transaction CSV/XML imports (use POST /imports/bank). Single-voucher creation (use POST /journal-entries). Importing into a period that already has posted entries: SIE imports run on a fresh period.

**Pitfalls:**
- Body content-type must be multipart/form-data with a `file` field carrying the .se / .sie file (or a JSON body with `file_base64` for agents that can't do multipart).
- File size cap: 50 MB. Larger files require chunking client-side or a future streaming import endpoint.
- Duplicate-file detection is by SHA-256 hash: re-importing the same file returns 409 SIE_IMPORT_DUPLICATE without re-running the import.
- The operation can take 1-5 minutes for multi-year files. The HTTP response returns immediately with operation_id; poll /operations/{id} every ~2s for status.
- BFL 7 kap räkenskapsinformation: once a SIE import completes, the resulting verifikationer are immutable. Cancellation midway is not supported.
- Account mappings are generated server-side from the file's #KONTO records (plus stored per-company overrides). By default the file's account names are carried into the chart, renaming existing accounts whose names differ: pass options.updateAccountNames=false to keep BAS default names.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { operation_id: string, type: "import.sie", status: "queued", poll_url: string },
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

### `POST /api/v1/companies/{companyId}/reconciliation/bank/run`

**Run the bank-reconciliation matcher.**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Walks all unbooked bank transactions in the requested date range and pairs them with open GL lines (1930-side) by amount + date proximity. Applies confirmed matches by setting transactions.journal_entry_id (the GL row already exists). Dry-runnable.

**Use when:** You want to auto-match outstanding bank transactions against existing journal entries: typically as the closing step of a sync. Dry-run first to inspect proposed matches.
**Do not use for:** Creating new journal entries: this only links bank transactions to existing GL lines. Matching to invoices: use `:match-invoice` or `:match-supplier-invoice` for explicit invoice payments.

**Pitfalls:**
- date_from / date_to default to the company's full bank history if omitted. Specify a window for predictable performance.
- account_number defaults to 1930. Multi-account companies must pass the BAS code of the account they are reconciling (e.g. 1932 for a EUR account), or it silently reconciles 1930.
- Idempotency-Key is mandatory.
- Without confidence_threshold, a non-dry run applies EVERY match found, including fuzzy ones at confidence 0.75. Pass confidence_threshold (0.9 recommended, matching gnubok_auto_match_period) for unattended runs, or dry-run first and review matches.confidence before applying. Matches below the threshold are returned but not applied (skipped_below_threshold counts them).
- The 366-day window bound only applies when BOTH date_from and date_to are set; a single-sided or absent window scans full history.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{ date_from?: string, date_to?: string, account_number?: string, confidence_threshold?: number }
```

Response `200`:
```ts
{
  data: {
    matches: { transaction_id: string, transaction_date: string, transaction_description: string, transaction_amount: number, journal_entry_id: string, voucher_number: number, voucher_series: string, entry_date: string, entry_description: string, method: string, confidence: number }[],
    applied: number,
    errors: number,
    skipped_below_threshold: number
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

### `GET /api/v1/companies/{companyId}/reconciliation/bank/status`

**Bank-reconciliation health snapshot.**
`scope:transactions:read · risk:low · idempotent`

Returns matched / unmatched counts and the balance delta between the bank ledger and the GL for the requested window. Optional ?date_from / ?date_to (default: company history).

**Use when:** You're building a dashboard widget, an audit report, or a pre-close check that needs to know how many bank transactions are still unbooked.
**Do not use for:** Running the matcher: that's POST `/reconciliation/bank/run`. Per-transaction detail: use the transaction list with `?status=unbooked`.

**Pitfalls:**
- A non-zero difference is normal between sync runs (uncleared cheques, in-flight transfers). Investigate only if it persists across reconciliations.
- difference compares against gl_1930_period_movement (movement excl. opening balance), NOT gl_1930_balance. Do not display gl_1930_balance next to difference.
- is_reconciled means |difference| < 0.01 for the window, an aggregate check, not a per-transaction guarantee.
- Judge health on unexplained_difference, NOT on difference. difference is just the gap between the two sides and is expected to be large mid-year; it is fully explained while every krona of it sits in unmatched_transaction_total or unmatched_gl_line_total. A non-zero unexplained_difference is the real finding: a matched pair disagreeing in amount, a voucher with several lines on the account, or a storno/correction line the candidate list hides.
- Ignored transactions are excluded from bank_transaction_total and difference (they never get a ledger counterpart); their count and sum are reported separately.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    bank_transaction_total: number,
    ignored_transaction_total: number,
    ignored_transaction_count: number,
    gl_1930_balance: number,
    gl_1930_period_movement: number,
    gl_1930_opening_balance: number,
    gl_1930_correction_adjustment: number,
    difference: number,
    is_reconciled: boolean,
    matched_count: number,
    unmatched_transaction_count: number,
    unmatched_transaction_total: number,
    unmatched_gl_line_count: number,
    unmatched_gl_line_total: number,
    unexplained_difference: number
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

### `GET /api/v1/companies/{companyId}/transactions`

**List transactions for a company.**
`scope:transactions:read · risk:low · idempotent`

Cursor-paginated transaction list ordered by created_at DESC, id ASC (newest-imported first; the `date` column is the transaction date and is filterable but not the sort key). Filter by ?status=booked|unbooked, ?currency, ?date_from / ?date_to, ?search (description ilike).

**Use when:** You need to walk a company's bank ledger: building a categorization queue, reconciling against external statements, or sampling for audit.
**Do not use for:** Looking up one transaction by id (use the detail endpoint). Reconciliation status (use /reconciliation/bank/status).

**Pitfalls:**
- Default page size is 50. Pass ?limit=100 for the maximum. Cursor pagination: pass ?cursor=<next_cursor> from the previous response.
- A booked transaction has a non-null journal_entry_id. is_business / category live on the transaction row even before booking.
- reverse-charge or storno entries can leave a transaction with journal_entry_id pointing at a cancelled JE: check status on the JE separately.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, date: string, description: string, amount: number, currency: string, reference: string, merchant_name: string, journal_entry_id: string, invoice_id: string, supplier_invoice_id: string, is_business: boolean, category: string, import_source: string, cash_account_id: string, created_at: string }[],
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

### `GET /api/v1/companies/{companyId}/transactions/{id}`

**Retrieve a single transaction by id.**
`scope:transactions:read · risk:low · idempotent`

Returns the full transaction record including match state, booking state, and import metadata.

**Use when:** You have a transaction id (from the list or a webhook) and need the full record before deciding to categorize, match, or attach a document.
**Do not use for:** Walking the ledger: use the list endpoint with a cursor. Fetching the linked invoice/journal entry: separate endpoints.

**Pitfalls:**
- Both invoice_id (matched) and potential_invoice_id (suggested) can be set independently. The matched id is authoritative for accounting.
- reconciliation_method is null for transactions that have never been auto-reconciled. journal_entry_id may still be set via manual categorize.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    date: string,
    description: string,
    amount: number,
    currency: string,
    amount_sek: number,
    reference: string,
    merchant_name: string,
    counterparty_account: string,
    journal_entry_id: string,
    invoice_id: string,
    supplier_invoice_id: string,
    potential_invoice_id: string,
    is_business: boolean,
    category: string,
    receipt_id: string,
    document_id: string,
    external_id: string,
    import_source: string,
    reconciliation_method: string,
    cash_account_id: string,
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

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/categorize`

**Categorize a transaction and create the journal entry.**
`scope:transactions:write · risk:medium · idempotent · dry-run · reversible`

Resolves the BAS account mapping for the transaction (via category, booking template, or counterparty template), creates the corresponding verifikation, and updates the transaction with is_business / category / journal_entry_id. Idempotent on (transaction, key). Dry-runnable.

**Use when:** You're categorizing a bank transaction. Pass `is_business: true` plus either `category`, `template_id` (booking template), `counterparty_template_id`, or `account_override`. For private transactions, `is_business: false` is enough.
**Do not use for:** Matching a payment to an invoice: use `:match-invoice` or `:match-supplier-invoice`, which storno any conflicting JE first. Uncategorizing: `:uncategorize`.

**Pitfalls:**
- A bank payment that looks like an invoice payment will be flagged via TX_CATEGORIZE_SUGGEST_SI_MATCH: pass `confirm_no_match: true` to override and force-categorize as direct expense (e.g. when the supplier invoice was already booked).
- Already-categorized fast path: if the transaction already has a journal_entry_id, only flags get updated. The JE is immutable post-commit.
- account_override must exist in the chart of accounts; an unknown account returns TX_CATEGORIZE_INVALID_ACCOUNT.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  is_business: boolean,
  category?: "income_services" | "income_products" | "income_other" | "expense_equipment" | "expense_software" | "expense_travel" | "expense_office" | "expense_marketing" | "expense_professional_services" | "expense_education" | "expense_representation" | "expense_consumables" | "expense_vehicle" | "expense_telecom" | "expense_bank_fees" | "expense_card_fees" | "expense_currency_exchange" | "expense_other" | "private" | "uncategorized",
  template_id?: string,
  vat_treatment?: "standard_25" | "reduced_12" | "reduced_6" | "reverse_charge" | "export" | "exempt",
  account_override?: string,
  counterparty_template_id?: string,
  dimensions?: Record<string, string>,
  user_description?: string,
  inbox_item_id?: string,
  confirm_no_match?: boolean,
  force?: boolean,
  expected_duplicate_transaction_id?: string,
  expected_duplicate_journal_entry_id?: string
}
```

Response `200`:
```ts
{
  data: {
    success: boolean,
    journal_entry_created: boolean,
    journal_entry_id: string,
    journal_entry_error: string,
    document_link_warning?: string,
    category: string,
    already_had_journal_entry?: boolean
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

### `POST /api/v1/companies/{companyId}/transactions/{id}/match-invoice`

**Match a positive bank transaction to a customer invoice.**
`scope:transactions:write · risk:high · idempotent`

Confirms an invoice match for a transaction. Storno any conflicting auto-categorization JE, create the payment journal entry, update the invoice status (paid / partially_paid), insert into invoice_payments, and link the transaction. Idempotent.

**Use when:** You have a bank receipt and a known open invoice it pays. The transaction must be positive (income) and unlinked.
**Do not use for:** Categorizing a transaction without an invoice: use `:categorize`. Matching to a supplier invoice: use `:match-supplier-invoice`. Bulk auto-match: use `POST /reconciliation/bank/run`.

**Pitfalls:**
- Proforma + delivery notes are rejected (MATCH_INVOICE_NOT_INVOICE_TYPE): only document_type='invoice' can be matched.
- Transaction must be positive (amount > 0): negative transactions return MATCH_INVOICE_NOT_INCOME.
- Invoice must be in sent / overdue / partially_paid status: paid or draft invoices return MATCH_INVOICE_NOT_OPEN.
- Idempotency-Key is mandatory.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  invoice_id: string,
  force?: boolean,
  expected_journal_entry_id?: string,
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string }[],
  manual_exchange_rate?: number
}
```

Response `200`:
```ts
{
  data: {
    success: boolean,
    invoice_status: string,
    paid_at: string,
    paid_amount: number,
    remaining_amount: number,
    journal_entry_id: string,
    category: string
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

### `POST /api/v1/companies/{companyId}/transactions/{id}/match-supplier-invoice`

**Match a negative bank transaction to a supplier invoice.**
`scope:transactions:write · risk:high · idempotent`

Confirms a supplier invoice payment match. Creates the payment journal entry (accrual: 2440 debit, credit on the transaction's own settlement account, 1930 when unlinked; cash-method: collapsed registration+payment), updates supplier_invoices, inserts a supplier_invoice_payments row, and links the transaction. Handles FX differences for cross-currency payments (7960 gain / 3960 loss).

**Use when:** You have a bank payment and a known open supplier invoice. The transaction must be negative (expense) and unlinked.
**Do not use for:** Categorizing a direct supplier expense without an invoice: use `:categorize`. Matching to a customer invoice: use `:match-invoice`. Bulk auto-match: `POST /reconciliation/bank/run`.

**Pitfalls:**
- Cash-method companies can settle a foreign invoice in full (booked at the payment-date rate); only a PARTIAL cash-method payment across currencies is rejected (MATCH_SI_CASH_FX_UNSUPPORTED): pay in full, switch to accrual, or book manually.
- Transaction must be negative (amount < 0). Positive returns MATCH_SI_NOT_EXPENSE.
- Supplier invoice must NOT be paid/credited already. paid/credited returns MATCH_SI_ALREADY_PAID; registered/approved/partially_paid/overdue are matchable.
- Idempotency-Key is mandatory.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  supplier_invoice_id: string,
  lines?: { account_number: string, debit_amount?: number, credit_amount?: number, line_description?: string }[]
}
```

Response `200`:
```ts
{
  data: {
    success: boolean,
    invoice_status: string,
    paid_amount: number,
    remaining_amount: number,
    journal_entry_id: string
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

### `POST /api/v1/companies/{companyId}/transactions/{id}/uncategorize`

**Reverse the categorization of a transaction (storno + reset).**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Storno the transaction's journal entry (BFL 5 kap 5 §: posted entries are never deleted, only cancelled via a reversing entry) and reset is_business / category / journal_entry_id on the transaction row. Idempotent: a second call on an already-uncategorized transaction returns 400 TX_UNCATEGORIZE_NOT_BOOKED. Dry-runnable.

**Use when:** You categorized a transaction by mistake and want to redo it from scratch. The storno keeps the audit trail intact.
**Do not use for:** Changing the categorization of an already-booked transaction: categorize again instead (the second call sees journal_entry_id and only updates flags). Reversing a payment match: there is no v1 verb for that yet.

**Pitfalls:**
- Idempotency-Key is mandatory.
- The storno creates a new (cancelling) journal entry. The original entry stays in the ledger marked as cancelled: voucher gaps are documented automatically.
- A transaction without a journal_entry_id returns 400 TX_UNCATEGORIZE_NOT_BOOKED: there is nothing to reverse.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { success: boolean, reversed_journal_entry_id: string },
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

### `POST /api/v1/companies/{companyId}/transactions/batch-categorize`

**Categorize up to 100 transactions in one call (partial-success).**
`scope:transactions:write · risk:medium · idempotent · dry-run · reversible`

Per-item categorization mirroring the single :categorize endpoint. Same `{ results, summary }` shape as the other bulk endpoints. all_or_nothing: true returns 501 NOT_IMPLEMENTED. Idempotent over the whole batch.

**Use when:** You have many transactions to categorize with the same logic (e.g. apply a booking template across a queue, mark a batch as private, override accounts on a series).
**Do not use for:** Categorizing transactions with mixed logic: make multiple :categorize calls. Auto-categorization via templates: handled inside `ingest` for matching rows, no separate endpoint needed.

**Pitfalls:**
- Max 100 items per call. Sequential processing.
- Idempotency-Key covers the WHOLE batch: replays return the cached full response.
- all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  items: { transaction_id: string, categorization: { is_business: boolean, category?: "income_services" | "income_products" | "income_other" | "expense_equipment" | "expense_software" | "expense_travel" | "expense_office" | "expense_marketing" | "expense_professional_services" | "expense_education" | "expense_representation" | "expense_consumables" | "expense_vehicle" | "expense_telecom" | "expense_bank_fees" | "expense_card_fees" | "expense_currency_exchange" | "expense_other" | "private" | "uncategorized", template_id?: string, vat_treatment?: "standard_25" | "reduced_12" | "reduced_6" | "reverse_charge" | "export" | "exempt", account_override?: string, counterparty_template_id?: string, dimensions?: Record<string, string>, user_description?: string, inbox_item_id?: string, confirm_no_match?: boolean, force?: boolean, expected_duplicate_transaction_id?: string, expected_duplicate_journal_entry_id?: string } }[],
  all_or_nothing?: boolean
}
```

Response `200`:
```ts
{
  data: {
    results: { ok: boolean, request_index: number, transaction_id: string, data?: unknown, error?: { code: string, message: string, details?: unknown } }[],
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

---

### `POST /api/v1/companies/{companyId}/transactions/ingest`

**Bulk-ingest transactions (up to 500 per call).**
`scope:transactions:write · risk:medium · idempotent · dry-run`

Runs the same ingest pipeline as the dashboard CSV importer and the PSD2 bank sync: dedup, insert, invoice match, mapping-rule auto-categorize, auto-JE for high-confidence matches. Idempotent over the whole batch via Idempotency-Key. Dry-runnable.

**Use when:** You're importing transactions from a CSV, a custom bank feed, or an external accounting system. Each item must have a stable external_id: this is the primary dedup key.
**Do not use for:** Single ad-hoc transactions (use the dashboard). Documents/receipts (use the documents endpoint). Manually-created journal entries (Phase 4).

**Pitfalls:**
- external_id is the primary dedup key: make it stable for the same physical transaction across reruns.
- Content-based dedup runs in addition: a row matching an already-booked transaction by date, amount AND description (prefix-containment, to survive PSD2 title enrichment) is skipped even if external_id differs.
- raw_insert_only=true skips ALL post-insert pipeline steps (matching, categorization). Use for viewer-only imports.
- Max 500 items per call. For larger imports, split into pages of 500.
- Dry-run previews external_id + content dedup against BOOKED rows only; the live pipeline also dedups against unbooked bank-synced rows, so preview skips are a lower bound on the live skip count.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  transactions: { date: string, description: string, amount: number, currency: string, external_id: string, mcc_code?: number, merchant_name?: string, reference?: string, import_source?: string }[],
  skip_auto_categorization?: boolean,
  settlement_account?: string,
  raw_insert_only?: boolean
}
```

Response `200`:
```ts
{
  data: {
    imported: number,
    duplicates: number,
    reconciled: number,
    auto_categorized: number,
    auto_matched_invoices: number,
    errors: number,
    transaction_ids: string[]
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
