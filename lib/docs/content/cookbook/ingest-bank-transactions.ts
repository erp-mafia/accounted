export const COOKBOOK_INGEST_BANK_MD = `# Cookbook: ingest and categorise bank transactions

> Push a bank statement file into Accounted, get AI-assisted category suggestions, commit the categorisations, and match payments against open invoices. End-to-end transaction-to-booking pipeline.

This is the operational companion to the [Transactions reference](/docs/api/reference/transactions) and the [Imports reference](/docs/api/reference/imports). Use it for the first integration where transactions enter the system from a bank source.

## What you'll need

- A test API key with \`transactions:write\`, \`transactions:read\`, and \`operations:read\` scopes. (There is no \`imports:write\` scope: the bank import runs under \`transactions:write\`, and polling the operation needs \`operations:read\`.)
- A bank statement file in one of the supported formats: CSV (SEB / Swedbank / Handelsbanken / Nordea / Nordea Business / Länsförsäkringar / ICA Banken / Skandia / Lunar / Northmill / generic CSV auto-detected), CAMT.053 XML, or a generic account-statement CSV with at minimum date + amount + description columns.
- The settlement account for the bank: typically \`1930\` for an SEK business account (check via \`GET /accounts\`). \`/imports/bank\` resolves the settlement account automatically; \`settlement_account\` is an explicit parameter of \`POST /transactions/ingest\`, not of the file upload.

## 1. Upload the bank file

\`POST /imports/bank\` accepts multipart upload. Format detection is automatic; the detected format is reported in the polled operation result (\`result.format\`), not in the upload response. The endpoint kicks off an async operation: you'll poll for the result.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/imports/bank" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -F "file=@statement-2026-04.csv"
\`\`\`

Response is a 202 with the operation handle:

\`\`\`json
{
  "data": {
    "operation_id": "3f2a9c8e-...",
    "type": "import.bank",
    "status": "queued",
    "poll_url": "/api/v1/operations/3f2a9c8e-...",
    "webhook_event": "operation.completed"
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

## 2. Poll until the import completes

Polling is currently the way to detect import completion. \`operation.completed\` is named in the response as the intended push signal but is not yet a deliverable webhook event, so poll for now; the categorisation events (\`transaction.categorized\` / \`transaction.reconciled\`) that fire later in this flow are subscribable today ([cookbook](/docs/api/cookbook/webhooks)). The operation lifecycle is \`queued → running → succeeded | failed | cancelled\`.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/operations/$OPERATION_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

On \`succeeded\`:

\`\`\`json
{
  "data": {
    "operation_id": "3f2a9c8e-...",
    "type": "import.bank",
    "status": "succeeded",
    "progress": { "current": 187, "total": 187, "phase": "complete" },
    "result": {
      "format": "seb",
      "file_hash": "e3b0c44298fc...",
      "transactions_imported": 165,
      "transactions_duplicates": 22,
      "transactions_reconciled": 0,
      "transactions_auto_categorized": 0,
      "transactions_errors": 0,
      "date_from": "2026-04-01",
      "date_to": "2026-04-30"
    },
    "started_at": "2026-05-01T08:00:00Z",
    "completed_at": "2026-05-01T08:00:04Z"
  }
}
\`\`\`

Note the dedup: each row gets a stable \`external_id\` (composed from date + amount + counterparty) as the primary dedup key, and a secondary content match on \`(date, amount, description)\` against already-booked rows also skips duplicates. Re-uploading the same file is safe.

## 3. List uncategorised transactions

After ingest the rows are in \`transactions\` but unbooked (\`journal_entry_id: null\`, \`category: null\`). The list \`status\` filter takes \`booked\` | \`unbooked\` (\`unbooked\` filters on \`journal_entry_id IS NULL\`), and date filtering uses \`date_from\` / \`date_to\` (there is no \`period\` param). List them:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/transactions?status=unbooked&date_from=2026-04-01&date_to=2026-04-30&limit=50" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

Response (cursor-paginated, newest-imported first — ordered by \`created_at\` DESC):

\`\`\`json
{
  "data": [
    {
      "id": "tx_...",
      "date": "2026-04-03",
      "description": "SEB CARD - SJ 25-...",
      "amount": -487.00,
      "currency": "SEK",
      "reference": null,
      "merchant_name": "SJ",
      "journal_entry_id": null,
      "invoice_id": null,
      "supplier_invoice_id": null,
      "is_business": null,
      "category": null,
      "import_source": "bank_file",
      "created_at": "2026-05-01T08:00:04Z"
    },
    ...
  ],
  "meta": { "request_id": "req_...", "next_cursor": "eyJ0cyI6Ij..." }
}
\`\`\`

## 4. Decide the category

There is no category-suggestion endpoint in the v1 REST API. Ranked suggestions (from the description, counterparty history, and your booking-template library) are surfaced by the dashboard and by the MCP tool \`gnubok_suggest_categories\` — not over REST.

In a REST integration you supply the category yourself: choose a \`category\`, or pass an explicit \`account_override\` / \`template_id\` / \`counterparty_template_id\`, based on your own mapping logic. When categorising interactively, use the dry-run in the next step to preview the resolved verifikation before you commit.

## 5. Commit the categorisation

\`POST /transactions/{id}/categorize\` books the transaction (creates the verifikation directly — it is not staged for approval). \`is_business\` is required. Then supply a mapping: a \`template_id\` or \`counterparty_template_id\` (these take precedence), or a \`category\` for the default mapping. \`account_override\` is an optional posting-account override that **combines with \`category\`** — it applies only when neither \`template_id\` nor \`counterparty_template_id\` is present (as in the example below). Dry-run first to preview the resolved mapping:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/transactions/$TX_ID/categorize?dry_run=true" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "is_business": true,
    "category": "expense_travel",
    "account_override": "5800",
    "vat_treatment": "standard_25"
  }'
\`\`\`

The dry-run returns the resolved mapping (debit / credit accounts + VAT lines) under \`{ dry_run: true, preview }\` — not a full posted journal, and no voucher number is burned:

\`\`\`json
{
  "data": {
    "dry_run": true,
    "preview": {
      "category": "expense_travel",
      "mapping": {
        "debit_account": "5800",
        "credit_account": "1930",
        "vat_lines": [
          { "account_number": "2641", "debit_amount": 97.40, "credit_amount": 0, "description": "Ingående moms 25%" }
        ],
        "all_lines_complete": false
      },
      "would_create_journal_entry": true,
      "already_had_journal_entry": false
    }
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

Drop \`?dry_run=true\` and reuse the same \`Idempotency-Key\` to commit. The commit response returns \`journal_entry_id\` (plus \`journal_entry_created\` and \`category\`); it does not include a voucher number or audit block — fetch the voucher via the journal entry if you need it.

## 6. Batch categorise

For a backlog, use \`POST /transactions/batch-categorize\` (up to 100 transactions per call, dry-runnable, partial-success on commit):

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/transactions/batch-categorize" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "items": [
      { "transaction_id": "tx_1", "categorization": { "is_business": true, "category": "expense_travel", "account_override": "5800", "vat_treatment": "standard_25" } },
      { "transaction_id": "tx_2", "categorization": { "is_business": true, "category": "income_services", "account_override": "3001", "vat_treatment": "standard_25" } },
      ...
    ]
  }'
\`\`\`

Response shape: every item carries its own \`ok\` flag and \`transaction_id\`:

\`\`\`json
{
  "data": {
    "results": [
      { "ok": true,  "request_index": 0, "transaction_id": "tx_1", "data": { "journal_entry_created": true, "journal_entry_id": "je_...", "category": "expense_travel" } },
      { "ok": false, "request_index": 1, "transaction_id": "tx_2", "error": { "code": "PERIOD_LOCKED", "message": "Period is locked or closed; cannot post journal entry." } }
    ],
    "summary": { "total": 2, "succeeded": 1, "failed": 1 }
  }
}
\`\`\`

## 7. Match a payment against an invoice

When a transaction is a customer payment, match it to the open invoice via \`POST /transactions/{id}/match-invoice\` instead of \`categorize\`. The engine posts the payment voucher (debit 1930, credit 1510) AND marks the invoice paid in a single transaction.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/transactions/$TX_ID/match-invoice" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "invoice_id": "inv_..." }'
\`\`\`

There is no \`payment_date\` field: the payment date is taken from the transaction's own \`date\`. For supplier-invoice payments use \`POST /transactions/{id}/match-supplier-invoice\` — same shape, but the body field is \`supplier_invoice_id\` and the transaction must be negative (expense).

## Multicurrency

Bank statements that include non-SEK transactions are imported with the foreign amount preserved in \`amount\` + \`currency\`; the booked SEK value is stored in \`amount_sek\`. When you categorise, the engine looks up the Riksbanken FX rate for the transaction date and books the SEK equivalent on the GL side. The FX delta (rate at booking vs rate at month-end revaluation) is later picked up by the currency-revaluation job.

The ledger is SEK-denominated; foreign amounts are converted to SEK automatically from the cached daily Riksbanken snapshot. There is no public FX-rate endpoint — rates are applied by the engine at categorisation time. (For cross-currency invoice settlement where no rate is published for a date, \`match-invoice\` accepts a \`manual_exchange_rate\`.)

## Common pitfalls

- **Re-running the same file is safe; date-only overlap is also safe.** Dedup is primarily by a stable \`external_id\` (date + amount + counterparty); a secondary content match on \`(date, amount, description)\` against already-booked rows also skips, so partial overlap of two statements doesn't double-import.
- **Settlement account selection matters.** The wrong settlement account silently breaks bank reconciliation later. \`1930\` (företagskonto) is the SEK default; a foreign-currency bank account uses its own asset account (e.g. \`1932\` for USD). \`/imports/bank\` resolves the settlement account automatically — to set it explicitly, ingest via \`POST /transactions/ingest\` with \`settlement_account\`.
- **Cash-method companies and partial payments don't mix.** If \`company_settings.accounting_method = 'cash'\` and you try to match a partial payment, the response is \`VALIDATION_ERROR\` rather than booking accrual entries: cash-method cannot model the per-installment moms event correctly (ML 13 kap 8 §). Either book the partial payment as a separate categorisation or switch to accrual.
- **Batch-categorize is partial-success by default.** If one item hits a locked period, the others still commit. The summary block tells you the totals; check per-item \`ok\` flags.

## Next steps

- **[Set up webhooks](/docs/api/cookbook/webhooks)**: get notified of \`transaction.categorized\` events without polling.
- **[File a VAT declaration](/docs/api/cookbook/file-vat-declaration)**: compute the rutor 05-62 from your now-categorised transactions.
- **[Transactions reference](/docs/api/reference/transactions)**: every parameter, every filter.
- **[Imports reference](/docs/api/reference/imports)**: full bank-file format coverage.
`
