export const QUICKSTART_MD = `# Quickstart — send your first invoice

> Five minutes from a fresh sandbox to an emailed invoice. Demonstrates the auth, dry-run, idempotency, and audit-block patterns you'll use everywhere.

## What you'll need

- A test API key (\`gnubok_sk_test_*\`) from the Accounted dashboard at **/settings/api**. Test keys are bound to a deterministic sandbox company seeded with realistic data — safe for evals.
- \`curl\` or any HTTP client.

## 1. List the companies the key can access

Test keys are scoped to a single sandbox company by default; this call confirms the auth works and returns the \`companyId\` you'll use in the rest of the cookbook.

\`\`\`bash
curl https://app.gnubok.se/api/v1/companies \\
  -H "Authorization: Bearer gnubok_sk_test_..."
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

Every write supports \`?dry_run=true\` — the response shows the would-be record without committing. Use it in agent test loops to validate inputs before paying the side-effect cost.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/customers?dry_run=true" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
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

Response (\`X-Dry-Run: true\` header, no row written):

\`\`\`json
{
  "data": {
    "id": null,
    "name": "Acme AB",
    "customer_type": "swedish_business",
    "vat_number_validated": false,
    "default_payment_terms": 30,
    "created_at": null,
    ...
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

Drop \`?dry_run=true\` to commit. The response now carries a real \`id\` and \`created_at\`.

## 3. Draft an invoice

Invoices are typed (B2B, EU-business, individual) and support mixed-rate VAT (per-item \`vat_rate\` overrides). The minimum body:

\`\`\`bash
INVOICE_IDEMP=$(uuidgen)
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/invoices" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $INVOICE_IDEMP" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customer_id": "'$CUSTOMER_ID'",
    "invoice_date": "2026-05-15",
    "due_date": "2026-06-14",
    "items": [
      { "description": "Konsultation, maj 2026", "quantity": 8, "unit_price": 1200, "vat_rate": 25 }
    ]
  }'
\`\`\`

Response includes the auto-allocated invoice number, the computed VAT lines, and the audit block (the verifikation hasn't been posted yet — drafts are not yet räkenskapsinformation):

\`\`\`json
{
  "data": {
    "id": "...",
    "invoice_number": "2026-0001",
    "subtotal": 9600.00,
    "vat_total": 2400.00,
    "total": 12000.00,
    "status": "draft",
    "items": [...]
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12", "audit": {...} }
}
\`\`\`

## 4. Send it

\`POST /invoices/{id}/send\` posts the verifikation, generates the PDF, and emails the customer in a single transaction. Strict-mode: if any step fails, none of them commit.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/invoices/$INVOICE_ID/send" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)"
\`\`\`

Response carries the now-posted voucher number:

\`\`\`json
{
  "data": {
    "id": "...",
    "status": "sent",
    "sent_at": "2026-05-15T12:00:00Z",
    ...
  },
  "meta": {
    "request_id": "req_...",
    "audit": {
      "voucher_number": "F-2026-001",
      "voucher_url": "https://app.gnubok.se/bookkeeping/...",
      "immutable_at": "2026-05-15T12:00:00Z"
    }
  }
}
\`\`\`

## 5. Mark it paid

When the customer pays, mark the invoice paid. The engine generates the payment voucher (debit 1930 bank, credit 1510 AR) and links it to the invoice.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/invoices/$INVOICE_ID/mark-paid" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "payment_date": "2026-05-22", "payment_amount": 12000.00 }'
\`\`\`

## What just happened

You created a customer, drafted an invoice with one mixed-VAT line item, posted the verifikation, sent the PDF, and recorded the payment. Five API calls; the engine handled BAS account selection, voucher numbering, period-lock checks, audit-trail entries, and PDF rendering.

The rendered PDF that the customer received contains every field required by ML 17 kap 24 § (the Swedish faktura mandate) — including \`beskattningsunderlag per skattesats\` (taxable amount per VAT rate; one line per distinct rate on multi-rate invoices), the supplier's organisationsnummer, sequential invoice number, per-line VAT rate, and the supply date. **Pass \`delivery_date\` explicitly** when goods or services are delivered on a different date than the invoice date — ML 17 kap 24 § field 7 requires the supply date and the API does NOT default it to \`invoice_date\`; a faktura with no supply date is non-compliant.

The "Godkänd för F-skatt" note is a **legal requirement** on every faktura issued by a Swedish momsregistrerad seller that holds F-skatt registration. The buyer uses this note to determine whether they must withhold preliminary tax (A-skatt) — omitting it can shift liability onto the buyer and triggers a FATAL Peppol BIS 3.0 validation failure (SE-R-005) on B2G invoices. The requirement applies equally to PDF/paper and Peppol/e-invoice formats; B2G is just where the validation is automated. The PDF includes it automatically when \`company_settings.has_f_skatt\` is true. **The integrator is responsible for keeping \`has_f_skatt\` in sync with the company's live Skatteverket registration status.** Update via \`PATCH /api/v1/companies/{companyId}/settings\` or the settings page — a flag that's false while the company is actually F-skatt-registered produces non-compliant invoices, not merely a missing optional note.

The summary fields in the JSON response (\`subtotal\`, \`vat_total\`, \`total\`) are convenience aggregates for the integration; the binding faktura content is the PDF itself.

## Next steps

- **[Subscribe to invoice events](/docs/api/cookbook/webhooks)** — get notified when invoices are paid via webhooks instead of polling.
- **[Ingest bank transactions](/docs/api/cookbook/ingest-bank-transactions)** — push CAMT/CSV into the engine and auto-categorise.
- **[Run a VAT declaration](/docs/api/cookbook/file-vat-declaration)** — compute momsdeklaration rutor and submit to Skatteverket.
- **[Full Invoices reference](/docs/api/reference/invoices)** — every endpoint, all the optional fields.

## Common pitfalls

- **Idempotency keys must be UUIDs.** Calls with non-UUID keys are rejected with \`VALIDATION_ERROR\`. Generate one per logical action and reuse it across retries of that same action — never on a fresh attempt.
- **Test keys can't email real addresses.** \`gnubok_sk_test_*\` short-circuits external providers — \`/send\` returns success but no email goes out. The PDF is still generated and the voucher posted.
- **Period locks block writes.** If you try to invoice into a closed period (\`invoice_date\` falls inside a locked fiscal period), the response is \`PERIOD_LOCKED\` (400). Use \`GET /fiscal-periods\` to check before backdating.
- **VIES VAT validation runs on commit only.** Dry-run skips the external VIES call; the real commit will block on slow VIES responses (we time out after 5s, but that's still 5s added to the request). Pre-validate via \`POST /api/v1/vat/validate\` if you want a fast first pass.
`
