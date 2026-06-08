export const COOKBOOK_INGEST_BANK_MD = `# Cookbook — ingest and categorise bank transactions

> Push a bank statement file into Accounted, get AI-assisted category suggestions, commit the categorisations, and match payments against open invoices. End-to-end transaction-to-booking pipeline.

This is the operational companion to the [Transactions reference](/docs/api/reference/transactions) and the [Imports reference](/docs/api/reference/imports). Use it for the first integration where transactions enter the system from a bank source.

## What you'll need

- A test API key with \`transactions:write\`, \`transactions:read\`, and \`imports:write\` scopes.
- A bank statement file in one of the supported formats: CSV (SEB / Swedbank / Handelsbanken / Nordea / Danske / ICA / Lendo / Ålandsbanken / SBAB / Marginalen / others auto-detected), CAMT.053 XML, or a plain account-statement CSV with at minimum date + amount + description columns.
- The settlement account for the bank — typically \`'1930'\` for an SEK business account. Check via \`GET /accounts\`.

## 1. Upload the bank file

\`POST /imports/bank\` accepts multipart upload. Format detection is automatic; the response includes the matched parser. The endpoint kicks off an async operation — you'll poll for the result.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/imports/bank" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -F "file=@statement-2026-04.csv" \\
  -F 'settlement_account="1930"'
\`\`\`

Response is a 202 with the operation handle:

\`\`\`json
{
  "data": {
    "operation_id": "op_a8f1...",
    "status": "queued",
    "poll_url": "/api/v1/operations/op_a8f1...",
    "webhook_event": "operation.completed"
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

## 2. Poll until the import completes

Polling is the simplest pattern; subscribe to the \`operation.completed\` event ([cookbook](/docs/api/cookbook/webhooks)) for the push variant. The operation lifecycle is \`queued → running → succeeded | failed | cancelled\`.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/operations/$OPERATION_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

On \`succeeded\`:

\`\`\`json
{
  "data": {
    "operation_id": "op_a8f1...",
    "type": "import.bank",
    "status": "succeeded",
    "progress": { "current": 187, "total": 187, "phase": "complete" },
    "result": {
      "rows_inserted": 165,
      "rows_skipped_duplicate": 22,
      "format_detected": "seb_csv",
      "earliest_date": "2026-04-01",
      "latest_date": "2026-04-30"
    },
    "started_at": "2026-05-01T08:00:00Z",
    "completed_at": "2026-05-01T08:00:04Z"
  }
}
\`\`\`

Note the dedup: rows that match an existing transaction on \`(date, amount, description_hash)\` are skipped, not inserted twice. Re-uploading the same file is safe.

## 3. List uncategorised transactions

After ingest the rows are in \`transactions\` but uncategorised (\`account_number: null\`, \`category: null\`). List them:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/transactions?status=uncategorized&period=2026-04&limit=50" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

Response (cursor-paginated, oldest-first):

\`\`\`json
{
  "data": [
    {
      "id": "tx_...",
      "transaction_date": "2026-04-03",
      "description": "SEB CARD - SJ 25-...",
      "amount": -487.00,
      "currency": "SEK",
      "category": null,
      "account_number": null,
      "vat_treatment": null,
      "document_id": null,
      "journal_entry_id": null
    },
    ...
  ],
  "meta": { "request_id": "req_...", "next_cursor": "eyJ0cyI6Ij..." }
}
\`\`\`

## 4. Get category suggestions

\`POST /transactions/{id}/suggest-categories\` returns ranked guesses based on the description, counterparty history, and your booking-template library:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/transactions/$TX_ID/suggest-categories" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

\`\`\`json
{
  "data": {
    "suggestions": [
      {
        "category": "expense_travel",
        "account_number": "5800",
        "vat_treatment": "standard_25",
        "confidence": 0.92,
        "reason": "Counterparty 'SJ' matched booking template 'Tågresor' (12 prior matches)"
      },
      {
        "category": "expense_representation",
        "account_number": "6071",
        "vat_treatment": "standard_25",
        "confidence": 0.15,
        "reason": "Fallback — SJ has occasionally been booked as kund-representation"
      }
    ]
  }
}
\`\`\`

Confidence ≥ 0.85 is generally safe to auto-apply; below that surface to the user.

## 5. Commit the categorisation

\`POST /transactions/{id}/categorize\` stages the booking. Dry-run first to see the verifikation preview:

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/transactions/$TX_ID/categorize?dry_run=true" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "category": "expense_travel",
    "account_number": "5800",
    "vat_treatment": "standard_25"
  }'
\`\`\`

Response includes the would-be journal entry lines:

\`\`\`json
{
  "data": {
    "staged_operation_id": "po_...",
    "preview": {
      "journal_lines": [
        { "account": "5800", "debit": 389.60, "credit": 0, "label": "Reskostnader" },
        { "account": "2641", "debit": 97.40, "credit": 0, "label": "Ingående moms 25%" },
        { "account": "1930", "debit": 0, "credit": 487.00, "label": "Företagskonto" }
      ],
      "voucher_number_assigned_on_commit": "auto",
      "account_deltas": { "5800": -389.60, "2641": -97.40, "1930": +487.00 }
    }
  }
}
\`\`\`

Drop \`?dry_run=true\` and reuse the same \`Idempotency-Key\` to commit. The response carries the audit block with the now-posted voucher number.

## 6. Batch categorise

For a backlog, use \`POST /transactions/batch-categorize\` (up to 100 transactions per call, dry-runnable, partial-success on commit):

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/transactions/batch-categorize" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "items": [
      { "transaction_id": "tx_1", "category": "expense_travel", "account_number": "5800", "vat_treatment": "standard_25" },
      { "transaction_id": "tx_2", "category": "income_services", "account_number": "3001", "vat_treatment": "standard_25" },
      ...
    ]
  }'
\`\`\`

Response shape — every item has its own \`ok\` flag:

\`\`\`json
{
  "data": {
    "results": [
      { "ok": true,  "request_index": 0, "data": { "voucher_number": "A2026-0042" } },
      { "ok": false, "request_index": 1, "error": { "code": "PERIOD_LOCKED", "message": "Perioden är låst." } }
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
  -d '{ "invoice_id": "inv_...", "payment_date": "2026-04-15" }'
\`\`\`

For supplier-invoice payments use \`POST /transactions/{id}/match-supplier-invoice\` — same shape, different counterparty side.

## Multicurrency

Bank statements that include non-SEK transactions are imported with the foreign amount preserved in \`amount_foreign\` + \`currency_foreign\`. When you categorise, the engine looks up the Riksbanken FX rate for the transaction date and books the SEK equivalent on the GL side. The FX delta (rate at booking vs rate at month-end revaluation) is later picked up by the currency-revaluation job.

If you import a multi-currency statement, ensure the company has \`base_currency\` set (defaults to SEK) and that the relevant FX rates are available — fetch via \`GET /currency/rate?date=...&from=...&to=...\` or rely on the cached daily snapshot.

## Common pitfalls

- **Re-running the same file is safe; date-only overlap is also safe.** The dedup keys on \`(date, amount, description_hash)\` so partial overlap of two statements doesn't double-import.
- **Settlement account selection matters.** Importing into the wrong settlement account silently breaks bank reconciliation later. \`1930\` (företagskonto) is the default for SEK; a foreign-currency bank account uses its own asset account (e.g. \`1932\` for USD).
- **Cash-method companies and partial payments don't mix.** If \`company_settings.accounting_method = 'cash'\` and you try to match a partial payment, the response is \`VALIDATION_ERROR\` rather than booking accrual entries — cash-method cannot model the per-installment moms event correctly (ML 13 kap 8 §). Either book the partial payment as a separate categorisation or switch to accrual.
- **Batch-categorize is partial-success by default.** If one item hits a locked period, the others still commit. The summary block tells you the totals; check per-item \`ok\` flags.

## Next steps

- **[Set up webhooks](/docs/api/cookbook/webhooks)** — get notified of \`transaction.categorized\` events without polling.
- **[File a VAT declaration](/docs/api/cookbook/file-vat-declaration)** — compute the rutor 05–62 from your now-categorised transactions.
- **[Transactions reference](/docs/api/reference/transactions)** — every parameter, every filter.
- **[Imports reference](/docs/api/reference/imports)** — full bank-file format coverage.
`
