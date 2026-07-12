export const QUICKSTART_MD = `# Quickstart: send your first invoice

> Five minutes from a fresh sandbox to an emailed invoice. Demonstrates the auth, dry-run, and idempotency patterns you'll use everywhere.

## What you'll need

- A **live** API key (\`gnubok_sk_*\`, no \`test_\` infix) from the Accounted dashboard at **/settings/api**. Run the whole walkthrough with this one key: the create→send→pay sequence chains on real IDs (the customer's \`id\`, then the invoice's \`id\`) that only committed writes return. A **test** key (\`gnubok_sk_test_*\`) is useful to validate request *shapes* first — it's bound to a deterministic sandbox company and the wrapper forces every write into dry-run — but because a forced dry-run never persists (\`id: null\`, no emails), it can't complete the stateful flow, and its sandbox \`companyId\` differs from your live one. So: **use one key throughout.** If you validate with a test key first, re-run step 1 with your live key before step 3 so \`COMPANY_ID\` matches the company you're actually writing to.
- \`curl\` or any HTTP client.

## 1. List the companies the key can access

This call confirms your key works and returns the \`companyId\` you'll use throughout. Run it with the **same key you'll use for the committing steps** so the \`companyId\` matches — a live key resolves to the real companies it can access; a test key resolves to its sandbox company.

\`\`\`bash
curl https://app.gnubok.se/api/v1/companies \\
  -H "Authorization: Bearer gnubok_sk_..."
\`\`\`

Response (truncated):

\`\`\`json
{
  "data": [{ "id": "00000000-0000-0000-0000-000000000001", "name": "Sandbox AB", "org_number": "556677-8899", ... }],
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

Save the \`id\` as \`COMPANY_ID\` for the next steps.

## 2. Create a customer (dry-run first)

Most writes support \`?dry_run=true\`: the response shows the would-be record without committing. (Bank/SIE imports are the exception: they run for real or not at all.) Use it in agent test loops to validate inputs before paying the side-effect cost.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/customers?dry_run=true" \\
  -H "Authorization: Bearer gnubok_sk_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Acme AB",
    "customer_type": "swedish_business",
    "email": "ap@acme.test",
    "org_number": "556677-8899",
    "default_payment_terms": 30
  }'
\`\`\`

Response (\`X-Dry-Run: true\` header, no row written). The would-be record is nested under \`data.preview\`, with \`data.dry_run: true\` so agents can branch on it without reading headers:

\`\`\`json
{
  "data": {
    "dry_run": true,
    "preview": {
      "id": null,
      "name": "Acme AB",
      "customer_type": "swedish_business",
      "vat_number_validated": false,
      "default_payment_terms": 30,
      "created_at": null,
      ...
    }
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

With a **live** key, dropping \`?dry_run=true\` commits the row: the response drops the \`dry_run\`/\`preview\` wrapper and returns the record directly under \`data\` with a real \`id\` and \`created_at\`. Save that committed \`data.id\` as \`CUSTOMER_ID\` for the next step. With a **test** key the write is forced to dry-run either way, so you keep getting this preview (\`id\`/\`created_at\` stay \`null\`) — which is why the create→send→pay steps below need a live key to produce IDs to chain on.

## 3. Draft an invoice

Invoices are typed (B2B, EU-business, individual) and support mixed-rate VAT (per-item \`vat_rate\` overrides). The minimum body:

\`\`\`bash
INVOICE_IDEMP=$(uuidgen)
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/invoices" \\
  -H "Authorization: Bearer gnubok_sk_..." \\
  -H "Idempotency-Key: $INVOICE_IDEMP" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customer_id": "'$CUSTOMER_ID'",
    "invoice_date": "2026-05-15",
    "due_date": "2026-06-14",
    "delivery_date": "2026-05-15",
    "currency": "SEK",
    "items": [
      { "description": "Konsultation, maj 2026", "quantity": 8, "unit": "tim", "unit_price": 1200, "vat_rate": 25 }
    ]
  }'
\`\`\`

A fresh draft has \`invoice_number: null\`: the F-series löpnummer is allocated atomically on the first \`/send\`, not at create time (ML 17 kap 24§ p.2 requires an unbroken series covering only issued invoices, so abandoned drafts must not burn a number). The response carries the computed VAT lines and totals; there is no audit block, because the verifikation hasn't been posted yet (drafts are not yet räkenskapsinformation):

\`\`\`json
{
  "data": {
    "id": "...",
    "invoice_number": null,
    "status": "draft",
    "subtotal": 9600.00,
    "vat_amount": 2400.00,
    "total": 12000.00,
    "items": [...]
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

(With a test key this call returns the dry-run preview shape instead: \`data: { "dry_run": true, "preview": { ... } }\`. The committed shape above is what a live key returns.)

## 4. Send it

\`POST /invoices/{id}/send\` runs a sequential pipeline: preflight PDF render (validates rendering before a number is burned) → allocate the F-series number atomically → final PDF render → email the customer via Resend (PDF attached, copy to the company). Any hard failure up to and including the email rolls nothing forward. Once the email is delivered the pipeline hits a **point of no return**: the status flip to \`sent\`, the journal entry (accrual + real invoices), PDF archival as underlag, and the \`invoice.sent\` event are best-effort, and any of their failures surface as \`warnings\` on the response rather than unwinding the send. It is not a single atomic transaction.

\`\`\`bash
# Generate the key ONCE and reuse it on every retry of this same send, so a
# timeout-then-retry replays the original result instead of sending twice.
SEND_IDEMP=$(uuidgen)
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/invoices/$INVOICE_ID/send" \\
  -H "Authorization: Bearer gnubok_sk_..." \\
  -H "Idempotency-Key: $SEND_IDEMP"
\`\`\`

Response carries the allocated invoice number and the id of the posted journal entry (there is no \`meta.audit\` block on this endpoint: use \`data.journal_entry_id\` and \`data.invoice_number\` as the posting reference):

\`\`\`json
{
  "data": {
    "id": "...",
    "invoice_number": "2026-0042",
    "status": "sent",
    "total": 12000.00,
    "message_id": "re_abc123",
    "sent_to": "ap@acme.test",
    "cc": "billing@gnubok-user.test",
    "journal_entry_id": "7b3a..."
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

If any post-email step degraded, \`data.warnings\` is present (e.g. \`JOURNAL_ENTRY_NOT_POSTED\`); the invoice is marked \`sent\` regardless.

## 5. Mark it paid

When the customer pays, mark the invoice paid. The engine generates the payment voucher (debit 1930 bank, credit 1510 AR) and links it to the invoice. There is no \`payment_amount\` field: the default books the full remaining amount (\`remaining_amount\`). For a partial payment, pass a custom \`lines\` array (at least two balanced rows).

\`\`\`bash
# One key per logical payment; reuse it across retries of this mark-paid.
PAY_IDEMP=$(uuidgen)
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/invoices/$INVOICE_ID/mark-paid" \\
  -H "Authorization: Bearer gnubok_sk_..." \\
  -H "Idempotency-Key: $PAY_IDEMP" \\
  -H "Content-Type: application/json" \\
  -d '{ "payment_date": "2026-05-22" }'
\`\`\`

## What just happened

This flow creates a customer, drafts a single-line invoice, posts the verifikation on \`/send\`, emails the PDF, and records the payment. That's **five committing calls** — list companies, create customer, create invoice, send, mark-paid — plus the optional \`?dry_run=true\` preview in step 2 if you run it. The engine handles BAS account selection, voucher numbering, period-lock checks, audit-trail entries, and PDF rendering. Run the committing calls with a live key; a test key can validate request shapes via dry-run first but never persists, so it can't chain the real IDs each step needs.

The rendered PDF that the customer received contains every field required by ML 17 kap 24 § (the Swedish faktura mandate): including \`beskattningsunderlag per skattesats\` (taxable amount per VAT rate; one line per distinct rate on multi-rate invoices), the supplier's organisationsnummer, sequential invoice number, per-line VAT rate, and the supply date. **Pass \`delivery_date\` explicitly** when goods or services are delivered on a different date than the invoice date: ML 17 kap 24 § field 7 requires the supply date and the API does NOT default it to \`invoice_date\`; a faktura with no supply date is non-compliant.

The "Godkänd för F-skatt" note is a **legal requirement** on every faktura issued by a Swedish momsregistrerad seller that holds F-skatt registration. The buyer uses this note to determine whether they must withhold preliminary tax (A-skatt): omitting it can shift liability onto the buyer and triggers a FATAL Peppol BIS 3.0 validation failure (SE-R-005) on B2G invoices. The requirement applies equally to PDF/paper and Peppol/e-invoice formats; B2G is just where the validation is automated. The PDF includes it automatically when \`company_settings.has_f_skatt\` is true. **The integrator is responsible for keeping \`has_f_skatt\` in sync with the company's live Skatteverket registration status.** Keep it in sync from the settings page in the dashboard (there is no v1 settings endpoint today): a flag that's false while the company is actually F-skatt-registered produces non-compliant invoices, not merely a missing optional note.

The summary fields in the JSON response (\`subtotal\`, \`vat_amount\`, \`total\`) are convenience aggregates for the integration; the binding faktura content is the PDF itself.

## Next steps

- **[Subscribe to invoice events](/docs/api/cookbook/webhooks)**: get notified when invoices are paid via webhooks instead of polling.
- **[Ingest bank transactions](/docs/api/cookbook/ingest-bank-transactions)**: push CAMT/CSV into the engine and auto-categorise.
- **[Run a VAT declaration](/docs/api/cookbook/file-vat-declaration)**: compute momsdeklaration rutor and submit to Skatteverket.
- **[Full Invoices reference](/docs/api/reference/invoices)**: every endpoint, all the optional fields.

## Common pitfalls

- **Use one idempotency key per logical action.** The key is treated as an opaque string (UUIDs are recommended, but any unique value works). Generate one per logical action and reuse it across retries of that same action: never on a fresh attempt. Reusing a key with a different request body is rejected with \`IDEMPOTENCY_KEY_REUSE\`.
- **Test keys never send or post.** \`gnubok_sk_test_*\` keys are simulation-only: every write is forced to dry-run, so \`/send\` never emails the customer, never allocates an F-series number, and never posts a voucher. On top of that the sandbox company they're bound to blocks outbound email outright (403 \`sandbox_blocked\`). Use a live key on a real company to actually deliver an invoice.
- **Period locks block writes.** If you try to invoice into a closed period (\`invoice_date\` falls inside a locked fiscal period), the response is \`PERIOD_LOCKED\` (400). Use \`GET /fiscal-periods\` to check before backdating.
- **VIES VAT validation runs on commit only.** It only fires when you create an \`eu_business\` customer with a \`vat_number\` (Swedish customers like the one above never trigger it). Dry-run skips the external VIES call; the real commit blocks on slow VIES responses (we time out after 10s, but that's still up to 10s added to the request). There is no v1 pre-validation endpoint today: rely on dry-run to check the rest of the payload first.
`
