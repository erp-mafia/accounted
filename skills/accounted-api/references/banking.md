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

Example response `200`:
```json
{
  "data": {
    "operation_id": "op_a8f1…",
    "type": "import.bank",
    "status": "queued",
    "poll_url": "/api/v1/operations/op_a8f1…",
    "webhook_event": "operation.completed"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
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

Example response `200`:
```json
{
  "data": {
    "operation_id": "op_a8f1…",
    "type": "import.sie",
    "status": "queued",
    "poll_url": "/api/v1/operations/op_a8f1…",
    "webhook_event": "operation.completed"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reconciliation/accounts`

**List the accounts that can be reconciled, with status per account.**
`scope:reconciliation:read · risk:low · idempotent`

Returns one row per reconcilable account (bank:<cash_account_id> for each enabled cash account, skattekonto when configured) with kind, number, currency, source (psd2 / bank_file / skatteverket_api / manual, synced_at, stale), status (reconciled | open | stale | not_configured, unexplained_difference, open_counts) and superseded_by for reconnect duplicates. Optional ?date_from / ?date_to scope the bank bridge (default: the calendar year to date). Pass ?with_status=false for a cheap list without status.

**Use when:** You need the side list of the Avstämning page, a month-end checklist, or to find the account_key to pass to the other reconciliation endpoints.
**Do not use for:** The bridge and rows for one account: use GET /reconciliation/accounts/{accountKey} and .../items.

**Pitfalls:**
- account_key is the identifier every other reconciliation endpoint takes: bank:<cash_account_id> or skattekonto. Do not pass the BAS number.
- status.state = stale means the outside truth is older than 7 days; the numbers are still computed, but judge them accordingly.
- superseded_by is set on an older cash account that shares IBAN + currency with a newer one (reconnect duplicate); it is kept in the list because it may still hold unlinked rows.
- Computing status per account runs one reconciliation per account; with_status=false skips that when you only need the list.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    accounts: { account_key: string, kind: "bank" | "skattekonto" | "manual", account_number: string, name: string, currency: string, logo_url: string, source: { type: "psd2" | "bank_file" | "skatteverket_api" | "skatteverket_file" | "manual", synced_at: string, stale: boolean }, status: { state: "reconciled" | "open" | "stale" | "not_configured", as_of: string, unexplained_difference: number, open_counts: { proposed: number, unmatched_external: number, unmatched_ledger: number } }, superseded_by: string, signed_off_through?: string }[]
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
    "accounts": [
      {
        "account_key": "bank:11111111-1111-4111-8111-111111111111",
        "kind": "bank",
        "account_number": "1930",
        "name": "Swedbank företagskonto",
        "currency": "SEK",
        "logo_url": null,
        "source": {
          "type": "psd2",
          "synced_at": "2026-08-20T06:40:00.000Z",
          "stale": false
        },
        "status": {
          "state": "open",
          "as_of": "2026-08-20T09:00:00.000Z",
          "unexplained_difference": 0,
          "open_counts": {
            "proposed": 0,
            "unmatched_external": 1,
            "unmatched_ledger": 1
          }
        },
        "superseded_by": null
      },
      {
        "account_key": "skattekonto",
        "kind": "skattekonto",
        "account_number": "1630",
        "name": "Skattekonto",
        "currency": "SEK",
        "logo_url": "/logos/skatteverket_color.svg",
        "source": {
          "type": "skatteverket_api",
          "synced_at": "2026-08-20T04:00:12.000Z",
          "stale": false
        },
        "status": {
          "state": "open",
          "as_of": "2026-08-20T04:00:12.000Z",
          "unexplained_difference": 0,
          "open_counts": {
            "proposed": 2,
            "unmatched_external": 3,
            "unmatched_ledger": 1
          }
        },
        "superseded_by": null
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

### `GET /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}`

**The reconciliation bridge for one account.**
`scope:reconciliation:read · risk:low · idempotent`

Returns external_balance (Skatteverket saldo; null for bank accounts until a statement balance exists), ledger_balance (1630 balance at the snapshot for skattekonto; period movement on the bank account), difference, unexplained_difference, is_reconciled, the bridge lines (label, amount, count, items_bucket) that explain the difference row by row, counts per bucket, and a kind block (skattekonto: saldo, fetched_at, history_start, opening_difference, upcoming; bank: today's bank status fields). Optional ?date_from / ?date_to: for skattekonto they scope the item lists only (the bridge is anchored at the snapshot); for bank they scope the bridge window.

**Use when:** You need to know whether an account reconciles and why not: the bridge is the explanation, the buckets are the work.
**Do not use for:** Listing the rows themselves (use .../items) or linking (POST .../links).

**Pitfalls:**
- Judge health on unexplained_difference, never on difference. The difference is expected to be non-zero while rows are unmatched; unexplained_difference is what is left once every bridge line is accounted for, and for skattekonto it is 0,00 whenever the data is consistent (a non-zero value is an integrity finding, not a task).
- stale = true means the outside truth is older than 7 days (Skatteverket connection needing re-consent is the usual cause). is_reconciled can still be true on stale data; read both.
- skattekonto.opening_difference is the gap between the derived saldo at history_start and the ledger before it; it belongs to migrated ledgers and is accepted once at sign-off, not worked down.
- Bank accounts carry the legacy field set in the bank block (bank_transaction_total, gl_1930_period_movement, …) unchanged from /reconciliation/bank/status.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    account_key: string,
    kind: "bank" | "skattekonto" | "manual",
    account_number: string,
    currency: string,
    window: { from: string, to: string },
    as_of: string,
    stale: boolean,
    external_balance: number,
    ledger_balance: number,
    difference: number,
    unexplained_difference: number,
    is_reconciled: boolean,
    bridge: { key: string, label_sv: string, label_en: string, amount: number, count: number, items_bucket: string }[],
    counts: { proposed: number, unmatched_external: number, unmatched_ledger: number, matched: number, ignored: number },
    skattekonto: { saldo_skatteverket: number, fetched_at: string, history_start: string, opening_difference: number, upcoming_count: number, upcoming_total: number, ledger_balance_before_start: number },
    bank: Record<string, unknown>,
    manual?: { period_id: string, period_start: string, period_end: string, opening_balance: number, movement: number, closing_balance: number, specification: { provider: "ar" | "ap" | "vacation", label_sv: string, label_en: string, amount: number, unconverted_fx_count: number } },
    signoff?: { id: string, account_key: string, through_date: string, external_balance: number, ledger_balance: number, unexplained_difference: number, note: string, signed_by: string, signed_at: string, reopened_at: string, reopened_by: string, reopen_reason: string }
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
    "account_key": "skattekonto",
    "kind": "skattekonto",
    "account_number": "1630",
    "currency": "SEK",
    "window": {
      "from": null,
      "to": null
    },
    "as_of": "2026-08-20T04:00:12.000Z",
    "stale": false,
    "external_balance": 53395,
    "ledger_balance": 30342,
    "difference": 23053,
    "unexplained_difference": 0,
    "is_reconciled": false,
    "bridge": [
      {
        "key": "external_balance",
        "label_sv": "Saldo hos Skatteverket",
        "label_en": "Balance at Skatteverket",
        "amount": 53395,
        "count": null,
        "items_bucket": null
      },
      {
        "key": "unmatched_external",
        "label_sv": "Händelser som saknas i bokföringen",
        "label_en": "Events missing from the ledger",
        "amount": -35553,
        "count": 5,
        "items_bucket": "unmatched_external"
      },
      {
        "key": "unmatched_ledger",
        "label_sv": "Rader på 1630 utan händelse hos Skatteverket",
        "label_en": "1630 lines without a Skatteverket event",
        "amount": 12500,
        "count": 1,
        "items_bucket": "unmatched_ledger"
      },
      {
        "key": "ledger_balance",
        "label_sv": "Bokfört på 1630",
        "label_en": "Booked on 1630",
        "amount": 30342,
        "count": null,
        "items_bucket": null
      }
    ],
    "counts": {
      "proposed": 2,
      "unmatched_external": 3,
      "unmatched_ledger": 1,
      "matched": 41,
      "ignored": 0
    },
    "skattekonto": {
      "saldo_skatteverket": 53395,
      "fetched_at": "2026-08-20T04:00:12.000Z",
      "history_start": "2025-01-17",
      "opening_difference": 0,
      "upcoming_count": 3,
      "upcoming_total": -18450,
      "ledger_balance_before_start": 0
    },
    "bank": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/items`

**List the rows behind one account's bridge, bucketed.**
`scope:reconciliation:read · risk:low · idempotent`

Returns reconciliation items for one account. ?bucket selects one of proposed | unmatched_external | unmatched_ledger | matched | ignored | upcoming (default: all open buckets first, then matched). Each item carries its side (external | ledger), a qualified item_id (skattekonto_transaction / transaction / journal_entry), date, description, signed amount, the proposal when one exists (journal_entry_id, voucher, confidence, reasons[]), link_problem when a link points at a reversed or draft entry, awaiting_external for fresh ledger lines, and the actions the row allows. ?date_from / ?date_to scope the lists; rows outside the window are never hidden from the counts (older_unmatched_count).

**Use when:** You are about to link, book or ignore rows and need to see what is open and what is proposed.
**Do not use for:** The totals: those are on GET /reconciliation/accounts/{accountKey}.

**Pitfalls:**
- An item in bucket proposed is NOT linked: it carries a proposal to link. Apply it with POST .../links { use_proposals: true } or explicit pairs.
- actions lists what the row allows right now; an action not listed returns a structured error rather than silently doing nothing.
- Ledger items are one per verifikat: several 1630/1930 lines of the same entry are netted, because a link settles the whole entry.
- Pagination is ?limit (max 200) + ?cursor; next_cursor is null on the last page.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    items: { item_id: string, item_type: "skattekonto_transaction" | "transaction" | "journal_entry", side: "external" | "ledger", bucket: "proposed" | "unmatched_external" | "unmatched_ledger" | "matched" | "ignored" | "upcoming", date: string, description: string, amount: number, currency: string, voucher_number?: number, voucher_series?: string, entry_status?: "draft" | "posted" | "reversed", linked_journal_entry_id?: string, link_problem?: "entry_reversed" | "entry_draft" | "entry_missing", proposal?: { journal_entry_id: string, voucher_number: number, voucher_series: string, entry_date: string, description: string, entry_status: "draft" | "posted" | "reversed", confidence: number, reasons: string[] }, awaiting_external?: boolean, actions: ("match" | "unmatch" | "book" | "ignore" | "unignore" | "review")[] }[],
    count: number,
    total_count: number,
    has_more: boolean,
    next_cursor: string,
    older_unmatched_count: number
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
    "items": [
      {
        "item_id": "33333333-3333-4333-8333-333333333333",
        "item_type": "skattekonto_transaction",
        "side": "external",
        "bucket": "proposed",
        "date": "2026-08-12",
        "description": "Inbetalning bokförd",
        "amount": 30000,
        "currency": "SEK",
        "proposal": {
          "journal_entry_id": "44444444-4444-4444-8444-444444444444",
          "voucher_number": 214,
          "voucher_series": "A",
          "entry_date": "2026-08-11",
          "description": "Inbetalning skattekonto",
          "entry_status": "posted",
          "confidence": 0.95,
          "reasons": [
            "exakt belopp på 1630",
            "1 dagars avstånd"
          ]
        },
        "actions": [
          "match",
          "book",
          "ignore"
        ]
      }
    ],
    "count": 1,
    "total_count": 1,
    "has_more": false,
    "next_cursor": null,
    "older_unmatched_count": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/items/{itemId}/ignore`

**Ignore or restore one outside row.**
`scope:reconciliation:write · risk:low · idempotent · dry-run · reversible`

Sets the ignore flag on one outside row (bank transaction or skattekonto row). Body { ignored: true | false }, default true. An ignored row never has a link; ignoring a linked row is refused (unlink first). Ignored rows are excluded from the unmatched totals and listed on the bridge's exclusion line so they never disappear silently.

**Use when:** A row will never have a counterpart (a duplicate from a reconnect, an event that predates the books) and should stop counting as work.
**Do not use for:** Rows that should be booked or linked; ignoring is triage, not settlement.

**Pitfalls:**
- Ignoring is reversible (ignored: false) and audited through the row itself; nothing is deleted.
- For the skattekonto, an ignored row still counts toward the derived opening balance (it is a real Skatteverket movement); the bridge shows it on its own line.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `itemId` | path | `string` | yes |  |

Request body:
```ts
{ ignored?: boolean }
```

Example request:
```json
{
  "ignored": true
}
```

Response `200`:
```ts
{
  data: { external_id: string, is_ignored: boolean },
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
    "external_id": "33333333-3333-4333-8333-333333333333",
    "is_ignored": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/links`

**Link outside rows to existing verifikat (pairs or proposals).**
`scope:reconciliation:write · risk:medium · dry-run · reversible`

Body: { pairs: [{ external_ids: [id], journal_entry_ids: [id], allocations? }] } and/or { use_proposals: true, confidence_threshold? }. Each pair is validated as the single-link paths validate (row open and not ignored, entry posted and not reversed, the entry's account lines settle the amount, entry not already linked) and applied independently: the response lists applied[] and skipped[{pair, code, message}] so partial success is explicit. On a bank account a pair may also be ONE transaction against SEVERAL verifikat (1:N): allocations[{journal_entry_id, amount}] gives the signed slice per verifikat (omitted: each slice defaults to the voucher's line on the account); the slices must sum to the transaction amount, and each applied link then carries allocated_amount. Codes: UNSUPPORTED_PAIR_SHAPE, ALREADY_LINKED, ENTRY_NOT_FOUND, PAIR_NOT_CLOSED, ROW_IGNORED, NOT_FOUND, LINK_RACE. ?dry_run=true returns the pairs that would be attempted without writing (a 1:N dry run resolves the slices).

**Use when:** An agent or integration has decided which rows explain each other, or wants to apply the proposals the sync already computed.
**Do not use for:** Booking new verifikat for rows that have no counterpart (use the transactions or skattekonto booking endpoints); reconciling across accounts.

**Pitfalls:**
- A pair is one OR MANY outside rows against exactly one verifikat (bank: independent links per transaction; skattekonto: all-or-nothing, the rows must sum to what the verifikat settles), or, on a bank account only, ONE transaction against SEVERAL verifikat (all-or-nothing, the slices must sum to the transaction). Several rows against several verifikat, and a skattekonto row against several verifikat, are UNSUPPORTED_PAIR_SHAPE, never silently reduced.
- A pair must close to the row's amount on the expected side (a single matching line, or the entry's lines on the account netting to it); a fee or rounding difference is PAIR_NOT_CLOSED here and needs a residual booking first.
- Links never touch the ledger, so they succeed in locked periods; unlink with DELETE .../links/{linkId} (linkId = the outside row id).
- Idempotency-Key is required; repeating the same key replays the first response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |

Request body:
```ts
{
  pairs?: { external_ids: string[], journal_entry_ids: string[], allocations?: { journal_entry_id: string, amount: number }[] }[],
  use_proposals?: boolean,
  confidence_threshold?: number
}
```

Example request:
```json
{
  "use_proposals": true,
  "confidence_threshold": 0.9
}
```

Response `200`:
```ts
{
  data: {
    dry_run: boolean,
    considered: number,
    applied: { external_id: string, journal_entry_id: string, via?: "line" | "entry_total", allocated_amount?: number }[],
    skipped: { pair: { external_ids: string[], journal_entry_ids: string[], allocations?: { journal_entry_id: {...}, amount: {...} }[] }, code: string, message: string }[]
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
    "dry_run": false,
    "considered": 2,
    "applied": [
      {
        "external_id": "33333333-3333-4333-8333-333333333333",
        "journal_entry_id": "44444444-4444-4444-8444-444444444444",
        "via": "line"
      }
    ],
    "skipped": [
      {
        "pair": {
          "external_ids": [
            "55555555-5555-4555-8555-555555555555"
          ],
          "journal_entry_ids": [
            "66666666-6666-4666-8666-666666666666"
          ]
        },
        "code": "ALREADY_LINKED",
        "message": "Verifikatet är redan kopplat till en annan skattekonto-transaktion."
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

### `DELETE /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/links/{linkId}`

**Remove a link between an outside row and a verifikat.**
`scope:reconciliation:write · risk:low · idempotent · dry-run · reversible`

Clears the link on one outside row (bank transaction or skattekonto row). The verifikat is never edited or deleted (BFL); only the row's pointer is cleared, so the pair returns to the open buckets and proposals are recomputed on the next sync. Allowed in locked periods. ?dry_run=true reports what would be unlinked.

**Use when:** A link was wrong (a bulk proposal apply that paired the wrong verifikat, a manual mistake).
**Do not use for:** Undoing a booking: a residual or categorization booking is reversed through the journal-entry reverse endpoint, not by unlinking.

**Pitfalls:**
- linkId is the outside row id, not a separate link entity.
- Unlinking a row whose verifikat was stornoed is the expected fix for a link_problem = entry_reversed item; the row then shows under unmatched_external again.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `linkId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { external_id: string, previous_journal_entry_id: string },
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
    "external_id": "33333333-3333-4333-8333-333333333333",
    "previous_journal_entry_id": "44444444-4444-4444-8444-444444444444"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/residual`

**Book the remainder of a bank selection as a fee/interest/rounding verifikat and link the selection.**
`scope:transactions:write · risk:medium · dry-run`

Body: { external_ids: [transaction ids], journal_entry_id, kind: "bank_fee" | "interest_expense" | "interest_income" | "rounding", entry_date?, description? }. Computes the difference between the transactions' sum and the verifikat's net on the bank account, books it on 6570 / 8410 / 8310 / 3740 against the bank account (dated on the latest transaction by default), links the transactions to the main verifikat and anchors the residual verifikat through transaction_voucher_links. Bank accounts only (bank:<cash_account_id>). Refused when the difference is 0 (RESIDUAL_ZERO), above 5000 kr (RESIDUAL_TOO_LARGE: that is a missing booking, not a fee), or when the kind points the wrong way (RESIDUAL_DIRECTION). ?dry_run=true returns would_book without writing.

**Use when:** A manual match misses by a small amount that is genuinely a bank fee, interest or rounding, and you want to close it in one step instead of booking a verifikat and then linking.
**Do not use for:** Skattekonto rows (Skatteverket posts ränta and avgifter as their own rows: link them), or differences that are really a missing booking (book that properly).

**Pitfalls:**
- The kind must match the direction: money that left the bank unbooked is bank_fee / interest_expense; money that arrived unbooked is interest_income; rounding works either way.
- Links are made before the booking and undone if the booking is refused (a locked period), so a refusal leaves nothing half done.
- Idempotency-Key is required; repeating the same key replays the first response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |

Request body:
```ts
{
  external_ids: string[],
  journal_entry_id: string,
  kind: "bank_fee" | "rounding" | "interest_income" | "interest_expense",
  entry_date?: string,
  description?: string
}
```

Example request:
```json
{
  "external_ids": [
    "22222222-2222-4222-8222-222222222222"
  ],
  "journal_entry_id": "44444444-4444-4444-8444-444444444444",
  "kind": "bank_fee"
}
```

Response `200`:
```ts
{
  data: {
    dry_run: boolean,
    residual_journal_entry_id?: string,
    residual_amount?: number,
    applied?: { external_id: string, journal_entry_id: string }[],
    skipped?: { code: string, message: string }[],
    would_book?: { kind: string, counter_account: string, ledger_account: string, currency: string, transactions_total: number, entry_net: number, residual_amount: number, entry_date: string, description: string, lines: { account_number: string, debit_amount: number, credit_amount: number }[] }
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
    "dry_run": false,
    "residual_journal_entry_id": "55555555-5555-4555-8555-555555555555",
    "residual_amount": -10,
    "applied": [
      {
        "external_id": "22222222-2222-4222-8222-222222222222",
        "journal_entry_id": "44444444-4444-4444-8444-444444444444"
      }
    ],
    "skipped": []
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/signoff`

**Sign-off history for one reconcilable account.**
`scope:reconciliation:read · risk:low · idempotent · reversible`

Every "avstämt t.o.m." sign-off on the account, newest first. Active ones by default; ?include_reopened=true adds the reopened (undone) ones with their reopen stamp. The latest active sign-off also rides along on GET .../accounts/{accountKey} as `signoff`.

**Use when:** You need the attestation trail (who signed what through which date) for an account, e.g. for a close checklist or an audit question.
**Do not use for:** Deciding whether the account is reconciled today: read unexplained_difference on the account status for that.

**Pitfalls:**
- A sign-off is an assertion made at a point in time; rows or links added later can make the live bridge differ from the signed numbers. Compare signoff.unexplained_difference with the current status when that matters.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    signoffs: { id: string, account_key: string, through_date: string, external_balance: number, ledger_balance: number, unexplained_difference: number, note: string, signed_by: string, signed_at: string, reopened_at: string, reopened_by: string, reopen_reason: string }[]
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
    "signoffs": [
      {
        "id": "77777777-7777-4777-8777-777777777777",
        "account_key": "skattekonto",
        "through_date": "2026-07-31",
        "external_balance": 12450,
        "ledger_balance": 12450,
        "unexplained_difference": 0,
        "note": null,
        "signed_by": "88888888-8888-4888-8888-888888888888",
        "signed_at": "2026-08-03T09:12:00Z",
        "reopened_at": null,
        "reopened_by": null,
        "reopen_reason": null
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

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/signoff`

**Mark an account reconciled through a date (sign-off).**
`scope:reconciliation:signoff · risk:medium · dry-run · reversible`

Body: { through_date: "YYYY-MM-DD", note?, force?, external_balance? }. Recomputes the bridge through the date and refuses unless unexplained_difference is zero; with force: true and a note it signs anyway and records the difference. Refuses dates in the future, dates past the skattekonto snapshot (NOT_FETCHED_THROUGH), and dates at or before an existing active sign-off (ALREADY_SIGNED_OFF: reopen that one first). For a manual:NNNN account without a system specification (anything but 1510/2440/2920/2940), external_balance is the balance per the signer's underlag in ledger sign (liabilities negative); the difference against the booked balance is recorded, and a non-zero one still needs force + note. On bank, skattekonto and specification accounts external_balance is refused (EXTERNAL_BALANCE_NOT_ALLOWED). ?dry_run=true returns would_sign without writing. Undo with POST .../signoff/{signoffId}/reopen.

**Use when:** The month (or period) is explained and you want the account marked as reconciled through its last day, as a human would in the Avstämning page.
**Do not use for:** Linking rows or booking anything: a sign-off changes no data in the ledger. Use .../links and the booking endpoints first.

**Pitfalls:**
- Refusal codes come back as VALIDATION_ERROR with details.code: INVALID_DATE, DATE_IN_FUTURE, NOT_FETCHED_THROUGH, OUTSIDE_UNKNOWN, NOT_RECONCILED, NOTE_REQUIRED, EXTERNAL_BALANCE_NOT_ALLOWED; ALREADY_SIGNED_OFF and SIGNOFF_RACE come back as CONFLICT.
- force: true without a note is NOTE_REQUIRED: the note is what the next reader sees next to the non-zero difference.
- Idempotency-Key is required; repeating the same key replays the first response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |

Request body:
```ts
{ through_date: string, note?: string, force?: boolean, external_balance?: number }
```

Example request:
```json
{
  "through_date": "2026-07-31"
}
```

Response `200`:
```ts
{
  data: {
    dry_run: boolean,
    signoff?: { id: string, account_key: string, through_date: string, external_balance: number, ledger_balance: number, unexplained_difference: number, note: string, signed_by: string, signed_at: string, reopened_at: string, reopened_by: string, reopen_reason: string },
    would_sign?: { account_key: string, through_date: string, external_balance: number, ledger_balance: number, unexplained_difference: number, is_reconciled: boolean, forced: boolean, previous_through_date: string }
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
    "dry_run": false,
    "signoff": {
      "id": "77777777-7777-4777-8777-777777777777",
      "account_key": "skattekonto",
      "through_date": "2026-07-31",
      "external_balance": 12450,
      "ledger_balance": 12450,
      "unexplained_difference": 0,
      "note": null,
      "signed_by": "88888888-8888-4888-8888-888888888888",
      "signed_at": "2026-08-03T09:12:00Z",
      "reopened_at": null,
      "reopened_by": null,
      "reopen_reason": null
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/reconciliation/accounts/{accountKey}/signoff/{signoffId}/reopen`

**Reopen (undo) a reconciliation sign-off.**
`scope:reconciliation:signoff · risk:low · idempotent · dry-run · reversible`

Body: { reason? }. Stamps the sign-off reopened_at/by/reason; nothing is deleted and the ledger is untouched. After this the account can be signed off again for the same or an earlier date. A sign-off that is already reopened is ALREADY_REOPENED (CONFLICT).

**Use when:** A signed-off period turns out to need more work (a late bank row, a corrected verifikat) and the attestation must be withdrawn before it is redone.
**Do not use for:** Removing a link or un-booking anything: those are separate operations; reopening only withdraws the attestation.

**Pitfalls:**
- Reopening is recorded, not erased: the history endpoint (?include_reopened=true) keeps showing the row with its reopen stamp.
- Idempotency-Key is required; repeating the same key replays the first response.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `accountKey` | path | `string` | yes |  |
| `signoffId` | path | `string` | yes |  |

Request body:
```ts
{ reason?: string }
```

Example request:
```json
{
  "reason": "Sen bankrad 31 juli kom in 3 augusti."
}
```

Response `200`:
```ts
{
  data: {
    signoff: { id: string, account_key: string, through_date: string, external_balance: number, ledger_balance: number, unexplained_difference: number, note: string, signed_by: string, signed_at: string, reopened_at: string, reopened_by: string, reopen_reason: string }
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
    "signoff": {
      "id": "77777777-7777-4777-8777-777777777777",
      "account_key": "skattekonto",
      "through_date": "2026-07-31",
      "external_balance": 12450,
      "ledger_balance": 12450,
      "unexplained_difference": 0,
      "note": null,
      "signed_by": "88888888-8888-4888-8888-888888888888",
      "signed_at": "2026-08-03T09:12:00Z",
      "reopened_at": "2026-08-04T07:30:00Z",
      "reopened_by": "88888888-8888-4888-8888-888888888888",
      "reopen_reason": "Sen bankrad 31 juli kom in 3 augusti."
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
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

Example request:
```json
{
  "date_from": "2026-05-01",
  "date_to": "2026-05-31",
  "confidence_threshold": 0.9
}
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

Example response `200`:
```json
{
  "data": {
    "matches": [],
    "applied": 0,
    "errors": 0,
    "skipped_below_threshold": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
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

Example response `200`:
```json
{
  "data": {
    "bank_transaction_total": 48150,
    "ignored_transaction_total": 0,
    "ignored_transaction_count": 0,
    "gl_1930_balance": 98150,
    "gl_1930_period_movement": 48150,
    "gl_1930_opening_balance": 50000,
    "gl_1930_correction_adjustment": 0,
    "difference": 0,
    "is_reconciled": true,
    "matched_count": 142,
    "unmatched_transaction_count": 3,
    "unmatched_transaction_total": 1250,
    "unmatched_gl_line_count": 2,
    "unmatched_gl_line_total": 1250,
    "unexplained_difference": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
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

Example response `200`:
```json
{
  "data": [
    {
      "id": "a8f1…",
      "date": "2026-05-12",
      "description": "ICA MAXI",
      "amount": -349.5,
      "currency": "SEK",
      "merchant_name": "ICA MAXI",
      "journal_entry_id": null,
      "is_business": null,
      "category": null
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

Example response `200`:
```json
{
  "data": {
    "id": "a8f1…",
    "date": "2026-05-12",
    "amount": -349.5,
    "currency": "SEK",
    "journal_entry_id": null,
    "is_business": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
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

Example request:
```json
{
  "is_business": true,
  "category": "expense_office"
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

Example response `200`:
```json
{
  "data": {
    "success": true,
    "journal_entry_created": true,
    "journal_entry_id": "je_…",
    "category": "expense_office"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/transactions/{id}/ignore`

**Ignore a bank transaction (no verifikat, allowed in locked periods).**
`scope:transactions:write · risk:low · idempotent · dry-run · reversible`

Marks an unbooked bank transaction as ignored so it leaves the "to book" funnels and the reconciliation unmatched totals without creating a verifikat. Nothing is deleted and the flag is reversible with DELETE on the same path. Because no booking is written, a locked or closed fiscal period does not block it: this is the path for clearing rows that are not business events out of a closed period. A booked transaction (directly, via a payment allocation, or via a voucher link) is refused with 409 TX_IGNORE_ALREADY_BOOKED. Idempotent: ignoring an already-ignored row returns already_ignored: true. Dry-runnable.

**Use when:** The row is not an affärshändelse: a PSD2 ghost row, a duplicate from a bank reconnect, a transfer that never executed, rounding noise. Also the answer to TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED from /categorize when the row should not be booked at all.
**Do not use for:** Real purchases, payments or owner withdrawals: those must be booked (categorize, match-invoice, or is_business: false in an open period). Ignoring is triage, not bookkeeping.

**Pitfalls:**
- Idempotency-Key is mandatory.
- A booked row cannot be ignored: reverse it first (POST /transactions/{id}/uncategorize) or unlink the payment/voucher.
- Ignored rows still exist and are listed on the reconciliation bridge's ignored line; they never disappear silently.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { success: boolean, transaction_id: string, is_ignored: true, already_ignored: boolean },
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
    "success": true,
    "transaction_id": "tx_…",
    "is_ignored": true,
    "already_ignored": false
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/transactions/{id}/ignore`

**Restore an ignored bank transaction to the "to book" list.**
`scope:transactions:write · risk:low · idempotent · dry-run · reversible`

Clears the ignore flag set by POST on the same path. The row comes back into the unbooked list and the reconciliation unmatched totals; no verifikat was ever written, so there is nothing to reverse. Idempotent: restoring a row that is not ignored returns was_ignored: false. Dry-runnable.

**Use when:** A row was ignored by mistake and should be booked after all.
**Do not use for:** Undoing a booking: that is a storno via POST /transactions/{id}/uncategorize.

**Pitfalls:**
- Idempotency-Key is mandatory.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { success: boolean, transaction_id: string, is_ignored: false, was_ignored: boolean },
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
    "success": true,
    "transaction_id": "tx_…",
    "is_ignored": false,
    "was_ignored": true
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
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

Example request:
```json
{
  "invoice_id": "inv_…"
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

Example response `200`:
```json
{
  "data": {
    "success": true,
    "invoice_status": "paid",
    "paid_amount": 12500,
    "remaining_amount": 0,
    "journal_entry_id": "je_…",
    "category": null
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
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

Example request:
```json
{
  "supplier_invoice_id": "si_…"
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

Example response `200`:
```json
{
  "data": {
    "success": true,
    "invoice_status": "paid",
    "paid_amount": 5000,
    "remaining_amount": 0,
    "journal_entry_id": "je_…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
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

Example response `200`:
```json
{
  "data": {
    "success": true,
    "reversed_journal_entry_id": "je_…"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
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

Example request:
```json
{
  "items": [
    {
      "transaction_id": "tx_1",
      "categorization": {
        "is_business": true,
        "category": "expense_office"
      }
    }
  ]
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

Example response `200`:
```json
{
  "data": {
    "results": [
      {
        "ok": true,
        "request_index": 0,
        "transaction_id": "tx_1",
        "data": {
          "journal_entry_id": "je_…"
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

Example request:
```json
{
  "transactions": [
    {
      "date": "2026-05-12",
      "description": "ICA MAXI",
      "amount": -349.5,
      "currency": "SEK",
      "external_id": "csv-line-42",
      "merchant_name": "ICA MAXI"
    }
  ]
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

Example response `200`:
```json
{
  "data": {
    "imported": 1,
    "skipped_duplicates": 0
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
